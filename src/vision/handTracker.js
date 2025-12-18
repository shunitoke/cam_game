import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}
function avg(points) {
    const s = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: s.x / points.length, y: s.y / points.length };
}
function handedLabelOf(result, i) {
    const handedness = result?.handedness ?? result?.handednesses;
    const first = handedness?.[i]?.[0];
    const score = typeof first?.score === "number" ? first.score : 0;
    const labelRaw = (typeof first?.categoryName === "string" && first.categoryName) ||
        (typeof first?.displayName === "string" && first.displayName) ||
        (typeof first?.label === "string" && first.label) ||
        (typeof first?.name === "string" && first.name) ||
        "";
    if (labelRaw === "Left" || labelRaw === "Right")
        return { label: labelRaw, score };
    return { label: "Unknown", score };
}
export class HandTracker {
    cfg;
    handLandmarker = null;
    result = null;
    workerResult = null;
    worker = null;
    useWorker = true;
    workerReady = false;
    workerInitInFlight = false;
    workerError = null;
    vision = null;
    wasmUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
    modelUrl = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
    restartInFlight = null;
    prevCenters = new Map();
    filtered = new Map();
    filteredLandmarkBuf = new Map();
    targets = new Map();
    landmarkBuf = new Map();
    stream = null;
    video = null;
    videoTrack = null;
    lastVideoTime = -1;
    useVideoFrameCallback = true;
    vfcActive = false;
    vfcInFlight = false;
    vfcLastSentMediaTime = -1;
    targetFps = 15;
    minIntervalMs = 1000 / 15;
    lastInferT = -Infinity;
    safeMode = false;
    inferMsEma = 0;
    lastInferMs = 0;
    dynamicMinIntervalMs = this.minIntervalMs;
    smoothTauSec = 0.10;
    wantLandmarks = true;
    inferEnabled = true;
    inferPauseUntilMs = 0;
    lastSpikeAtMs = -Infinity;
    currentNumHands = 0;
    overBudgetMs = 0;
    underBudgetMs = 0;
    updateInferBudget(inferMs) {
        const a = 0.12;
        this.inferMsEma = this.inferMsEma ? this.inferMsEma + (inferMs - this.inferMsEma) * a : inferMs;
        const budgetMs = this.safeMode ? 14 : 11;
        const over = Math.max(0, inferMs - budgetMs);
        const under = Math.max(0, budgetMs - inferMs);
        this.overBudgetMs = Math.min(3000, this.overBudgetMs + over);
        this.underBudgetMs = Math.min(3000, this.underBudgetMs + under);
        const target = Math.max(0, this.inferMsEma);
        const mul = this.safeMode ? 3.2 : 2.8;
        const desired = Math.max(this.minIntervalMs, target * mul);
        const maxInterval = this.safeMode ? 140 : 120;
        const clamped = Math.max(this.minIntervalMs, Math.min(maxInterval, desired));
        const k = this.overBudgetMs > 60 ? 0.22 : this.underBudgetMs > 160 ? 0.12 : 0.16;
        this.dynamicMinIntervalMs = this.dynamicMinIntervalMs + (clamped - this.dynamicMinIntervalMs) * k;
    }
    constructor(cfg) {
        this.cfg = cfg;
    }
    setWantLandmarks(on) {
        this.wantLandmarks = on;
    }
    setInferEnabled(on) {
        this.inferEnabled = on;
    }
    getInferPauseMs(t) {
        return Math.max(0, this.inferPauseUntilMs - t);
    }
    getLastInferMs() {
        return this.lastInferMs;
    }
    getInferBackend() {
        if (!this.inferEnabled)
            return "off";
        if (this.useWorker && this.workerReady)
            return "worker";
        return "main";
    }
    getWorkerError() {
        return this.workerError;
    }
    async start(video) {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 360 },
                frameRate: { ideal: 30, max: 30 }
            },
            audio: false
        });
        this.stream = stream;
        this.videoTrack = stream.getVideoTracks?.()?.[0] ?? null;
        this.video = video;
        video.srcObject = stream;
        await new Promise((resolve) => {
            video.onloadedmetadata = () => resolve();
        });
        this.vision = await FilesetResolver.forVisionTasks(this.wasmUrl);
        this.handLandmarker = await HandLandmarker.createFromOptions(this.vision, {
            baseOptions: {
                modelAssetPath: this.modelUrl
            },
            runningMode: "VIDEO",
            numHands: this.cfg.maxHands
        });
        this.currentNumHands = this.cfg.maxHands;
        this.setSafeMode(this.safeMode);
        this.workerError = null;
        await this.ensureWorker();
        this.vfcActive = false;
        this.vfcInFlight = false;
        this.vfcLastSentMediaTime = -1;
        this.startVideoFrameLoop();
    }
    stop() {
        this.vfcActive = false;
        this.vfcInFlight = false;
        this.workerResult = null;
        this.workerReady = false;
        this.workerInitInFlight = false;
        this.workerError = null;
        try {
            this.worker?.postMessage({ type: "stop" });
        }
        catch {
        }
        try {
            this.worker?.terminate();
        }
        catch {
        }
        this.worker = null;
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.videoTrack = null;
        this.video = null;
        this.handLandmarker?.close();
        this.handLandmarker = null;
        this.vision = null;
        this.restartInFlight = null;
    }
    async ensureWorker() {
        if (!this.useWorker)
            return;
        if (this.worker && this.workerReady)
            return;
        if (this.workerInitInFlight)
            return;
        this.workerInitInFlight = true;
        try {
            if (!this.worker) {
                // Use a true classic worker from /public. MediaPipe Tasks Vision relies on importScripts()
                // internally, which is not allowed in module workers.
                this.worker = new Worker("/handTrackerWorker.js");
            }
            if (!this.worker) {
                throw new Error("worker ctor unavailable");
            }
            this.worker.onmessage = (ev) => {
                const msg = ev.data;
                if (!msg || typeof msg !== "object")
                    return;
                if (msg.type === "ready") {
                    this.workerReady = true;
                    this.workerError = null;
                    return;
                }
                if (msg.type === "result") {
                    this.workerResult = msg.result ?? null;
                    if (typeof msg.inferMs === "number") {
                        this.lastInferMs = msg.inferMs;
                        this.updateInferBudget(this.lastInferMs);
                    }
                    return;
                }
                if (msg.type === "error") {
                    // Disable worker path after a hard failure and fall back to main-thread inference.
                    this.workerError = typeof msg.message === "string" ? msg.message : "worker error";
                    this.workerReady = false;
                    this.useWorker = false;
                    try {
                        this.worker?.terminate();
                    }
                    catch {
                    }
                    this.worker = null;
                    return;
                }
            };
            this.workerReady = false;
            this.workerResult = null;
            this.workerError = null;
            // Worker initializes its own FilesetResolver + HandLandmarker.
            this.worker.postMessage({
                type: "init",
                wasmUrl: this.wasmUrl,
                modelUrl: this.modelUrl,
                maxHands: this.cfg.maxHands
            });
            // Give it a moment; it will flip workerReady asynchronously.
            await new Promise((r) => setTimeout(r, 0));
        }
        catch {
            this.useWorker = false;
            this.workerReady = false;
            this.workerError = "worker init failed";
            try {
                this.worker?.terminate();
            }
            catch {
            }
            this.worker = null;
        }
        finally {
            this.workerInitInFlight = false;
        }
    }
    startVideoFrameLoop() {
        if (!this.useVideoFrameCallback)
            return;
        const videoEl = this.video;
        if (!videoEl || typeof videoEl.requestVideoFrameCallback !== "function")
            return;
        if (this.vfcActive)
            return;
        this.vfcActive = true;
        const loop = async (_now, meta) => {
            if (!this.vfcActive)
                return;
            // Schedule next callback first to keep the loop alive even if inference throws.
            try {
                videoEl.requestVideoFrameCallback(loop);
            }
            catch {
                this.vfcActive = false;
                return;
            }
            // Avoid overlapping work if callbacks come in faster than we can process.
            if (this.vfcInFlight)
                return;
            this.vfcInFlight = true;
            try {
                const v = this.video;
                if (!v)
                    return;
                const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
                if (nowMs < this.inferPauseUntilMs)
                    return;
                if (!this.inferEnabled) {
                    this.result = null;
                    this.workerResult = null;
                    this.prevCenters.clear();
                    return;
                }
                const mediaTime = typeof meta?.mediaTime === "number" ? meta.mediaTime : v.currentTime;
                // Fixed FPS gate.
                if (nowMs - this.lastInferT < this.dynamicMinIntervalMs)
                    return;
                // Only infer when the video frame advanced.
                if (mediaTime === this.lastVideoTime)
                    return;
                this.lastVideoTime = mediaTime;
                this.lastInferT = nowMs;
                // Worker path: transfer an ImageBitmap instead of running inference on main thread.
                if (this.useWorker && this.worker && this.workerReady && typeof globalThis.createImageBitmap === "function") {
                    // Avoid sending duplicate frames.
                    if (mediaTime !== this.vfcLastSentMediaTime) {
                        this.vfcLastSentMediaTime = mediaTime;
                        let bmp = null;
                        try {
                            bmp = await globalThis.createImageBitmap(v);
                        }
                        catch {
                            bmp = null;
                        }
                        if (bmp) {
                            try {
                                this.worker.postMessage({ type: "infer", frame: bmp, timestampMs: nowMs }, [bmp]);
                            }
                            catch {
                                try {
                                    bmp.close();
                                }
                                catch {
                                }
                            }
                        }
                    }
                    return;
                }
                // Fallback: in-thread inference.
                const lm = this.handLandmarker;
                if (!lm)
                    return;
                const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
                this.result = lm.detectForVideo(v, nowMs);
                const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
                this.lastInferMs = Math.max(0, t1 - t0);
                this.updateInferBudget(this.lastInferMs);
            }
            catch {
                this.result = null;
                this.workerResult = null;
            }
            finally {
                this.vfcInFlight = false;
            }
        };
        try {
            videoEl.requestVideoFrameCallback(loop);
        }
        catch {
            this.vfcActive = false;
        }
    }
    async restartLandmarker() {
        if (this.restartInFlight)
            return this.restartInFlight;
        if (!this.video)
            return;
        const run = async () => {
            const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
            this.inferPauseUntilMs = Math.max(this.inferPauseUntilMs, nowMs + 4000);
            try {
                this.handLandmarker?.close();
            }
            catch {
            }
            this.handLandmarker = null;
            this.result = null;
            try {
                if (!this.vision) {
                    this.vision = await FilesetResolver.forVisionTasks(this.wasmUrl);
                }
                this.handLandmarker = await HandLandmarker.createFromOptions(this.vision, {
                    baseOptions: {
                        modelAssetPath: this.modelUrl
                    },
                    runningMode: "VIDEO",
                    numHands: this.cfg.maxHands
                });
                this.currentNumHands = this.cfg.maxHands;
                this.setSafeMode(this.safeMode);
            }
            catch {
            }
        };
        this.restartInFlight = run().finally(() => {
            this.restartInFlight = null;
        });
        return this.restartInFlight;
    }
    setSafeMode(on) {
        this.safeMode = on;
        // In safe mode we need a much lower tracker budget; the HUD showed ~35ms for tracking.
        this.targetFps = on ? 12 : 15;
        this.minIntervalMs = 1000 / this.targetFps;
        this.dynamicMinIntervalMs = this.minIntervalMs;
        this.inferMsEma = 0;
        this.overBudgetMs = 0;
        this.underBudgetMs = 0;
        // Reduce camera resolution in safe mode to reduce MediaPipe workload.
        const track = this.videoTrack;
        if (track && typeof track.applyConstraints === "function") {
            const constraints = on
                ? { width: { ideal: 384 }, height: { ideal: 216 }, frameRate: { ideal: 15, max: 15 } }
                : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } };
            try {
                void track.applyConstraints(constraints);
            }
            catch {
                // ignore
            }
        }
        const lm = this.handLandmarker;
        if (lm && typeof lm.setOptions === "function") {
            try {
                const desired = Math.max(1, this.cfg.maxHands);
                void lm.setOptions({ numHands: desired });
                this.currentNumHands = desired;
            }
            catch {
                // ignore
            }
        }
    }
    update(t, dt) {
        const lm = this.handLandmarker;
        const videoEl = this.video;
        if (!lm || !videoEl) {
            return { count: 0, hands: [] };
        }
        // If inference is being driven by video frame callbacks, just consume cached results.
        if (this.useVideoFrameCallback && this.vfcActive) {
            // Prefer worker output when available.
            if (this.useWorker && this.workerReady && this.workerResult) {
                return this.workerResultToFrame(this.workerResult, dt);
            }
            return this.resultToFrame(this.result, dt);
        }
        // If we haven't produced a fresh inference for a while, clear stale output so hands
        // don't appear to stick when MediaPipe stalls/throttles.
        if (this.result) {
            const staleMs = this.safeMode ? 750 : 500;
            const videoAdvanced = videoEl.currentTime !== this.lastVideoTime;
            if (videoAdvanced && t - this.lastInferT > staleMs) {
                this.result = null;
                this.prevCenters.clear();
            }
        }
        if (!this.inferEnabled) {
            this.result = null;
            this.prevCenters.clear();
            return { count: 0, hands: [] };
        }
        // Vanilla cadence: fixed FPS gate.
        if (t - this.lastInferT < this.minIntervalMs) {
            return this.resultToFrame(this.result, dt);
        }
        // Only infer when the video frame advanced.
        if (videoEl.currentTime === this.lastVideoTime) {
            return this.resultToFrame(this.result, dt);
        }
        this.lastVideoTime = videoEl.currentTime;
        this.lastInferT = t;
        try {
            const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
            this.result = lm.detectForVideo(videoEl, t);
            const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
            this.lastInferMs = Math.max(0, t1 - t0);
        }
        catch {
            this.result = null;
            return { count: 0, hands: [] };
        }
        return this.resultToFrame(this.result, dt);
    }
    resultToFrame(result, dt) {
        if (!result?.landmarks || result.landmarks.length === 0)
            return { count: 0, hands: [] };
        const hands = [];
        for (let i = 0; i < result.landmarks.length; i++) {
            const lm = result.landmarks[i];
            if (!lm || lm.length < 21)
                continue;
            const { label, score } = handedLabelOf(result, i);
            const key = `${label}:${i}`;
            const mx = (idx) => (this.cfg.mirrorX ? 1 - lm[idx].x : lm[idx].x);
            const my = (idx) => lm[idx].y;
            const wrist = { x: mx(0), y: my(0) };
            const center = avg([
                { x: mx(0), y: my(0) },
                { x: mx(5), y: my(5) },
                { x: mx(9), y: my(9) },
                { x: mx(13), y: my(13) },
                { x: mx(17), y: my(17) }
            ]);
            const palmSize = dist(wrist, { x: mx(9), y: my(9) });
            const pinchDist = dist({ x: mx(4), y: my(4) }, { x: mx(8), y: my(8) });
            const pinch = clamp01((0.20 - pinchDist) / 0.13);
            const tipAvg = (dist({ x: mx(8), y: my(8) }, wrist) +
                dist({ x: mx(12), y: my(12) }, wrist) +
                dist({ x: mx(16), y: my(16) }, wrist) +
                dist({ x: mx(20), y: my(20) }, wrist)) /
                4;
            const open = tipAvg > palmSize * 1.75 && pinch < 0.75;
            const fist = tipAvg < palmSize * 1.18 && pinch < 0.45;
            let landmarks;
            if (!this.safeMode && this.wantLandmarks) {
                // Allocate per-hand landmark buffer and update it in-place to reduce churn.
                let buf = this.landmarkBuf.get(key);
                if (!buf || buf.length !== 21) {
                    buf = new Array(21);
                    for (let j = 0; j < 21; j++)
                        buf[j] = { x: 0, y: 0 };
                    this.landmarkBuf.set(key, buf);
                }
                for (let j = 0; j < 21; j++) {
                    const p = lm[j];
                    const o = buf[j];
                    o.x = this.cfg.mirrorX ? 1 - p.x : p.x;
                    o.y = p.y;
                }
                landmarks = buf;
            }
            else {
                landmarks = undefined;
            }
            const prev = this.prevCenters.get(key);
            const speed = prev ? clamp01(dist(prev, center) / Math.max(1e-6, dt) / 1.3) : 0;
            this.prevCenters.set(key, center);
            hands.push({
                label,
                score,
                landmarks,
                center,
                wrist,
                pinch,
                open,
                fist,
                speed
            });
        }
        return this.smoothFrame({ count: hands.length, hands }, dt);
    }
    workerResultToFrame(result, dt) {
        const landmarksAll = result?.landmarks;
        if (!Array.isArray(landmarksAll) || landmarksAll.length === 0)
            return { count: 0, hands: [] };
        const hands = [];
        for (let i = 0; i < landmarksAll.length; i++) {
            const lm = landmarksAll[i];
            if (!Array.isArray(lm) || lm.length < 21)
                continue;
            const { label, score } = handedLabelOf(result, i);
            const key = `${label}:${i}`;
            const mx = (idx) => {
                const p = lm[idx];
                const x = typeof p?.x === "number" ? p.x : 0;
                return this.cfg.mirrorX ? 1 - x : x;
            };
            const my = (idx) => {
                const p = lm[idx];
                return typeof p?.y === "number" ? p.y : 0;
            };
            const wrist = { x: mx(0), y: my(0) };
            const center = avg([
                { x: mx(0), y: my(0) },
                { x: mx(5), y: my(5) },
                { x: mx(9), y: my(9) },
                { x: mx(13), y: my(13) },
                { x: mx(17), y: my(17) }
            ]);
            const palmSize = dist(wrist, { x: mx(9), y: my(9) });
            const pinchDist = dist({ x: mx(4), y: my(4) }, { x: mx(8), y: my(8) });
            const pinch = clamp01((0.20 - pinchDist) / 0.13);
            const tipAvg = (dist({ x: mx(8), y: my(8) }, wrist) +
                dist({ x: mx(12), y: my(12) }, wrist) +
                dist({ x: mx(16), y: my(16) }, wrist) +
                dist({ x: mx(20), y: my(20) }, wrist)) /
                4;
            const open = tipAvg > palmSize * 1.75 && pinch < 0.75;
            const fist = tipAvg < palmSize * 1.18 && pinch < 0.45;
            let landmarks;
            if (!this.safeMode && this.wantLandmarks) {
                let buf = this.landmarkBuf.get(key);
                if (!buf || buf.length !== 21) {
                    buf = new Array(21);
                    for (let j = 0; j < 21; j++)
                        buf[j] = { x: 0, y: 0 };
                    this.landmarkBuf.set(key, buf);
                }
                for (let j = 0; j < 21; j++) {
                    const p = lm[j];
                    const o = buf[j];
                    const x = typeof p?.x === "number" ? p.x : 0;
                    const y = typeof p?.y === "number" ? p.y : 0;
                    o.x = this.cfg.mirrorX ? 1 - x : x;
                    o.y = y;
                }
                landmarks = buf;
            }
            else {
                landmarks = undefined;
            }
            const prev = this.prevCenters.get(key);
            const speed = prev ? clamp01(dist(prev, center) / Math.max(1e-6, dt) / 1.3) : 0;
            this.prevCenters.set(key, center);
            hands.push({
                label,
                score,
                landmarks,
                center,
                wrist,
                pinch,
                open,
                fist,
                speed
            });
        }
        return this.smoothFrame({ count: hands.length, hands }, dt);
    }
    smoothFrame(frame, dt) {
        if (!frame.count) {
            this.filtered.clear();
            this.filteredLandmarkBuf.clear();
            this.prevCenters.clear();
            return frame;
        }
        const seen = new Set();
        const outHands = [];
        for (let i = 0; i < frame.hands.length; i++) {
            const h = frame.hands[i];
            const key = `${h.label}:${i}`;
            seen.add(key);
            const baseTau = Math.max(0.02, this.smoothTauSec);
            const speed01 = clamp01(h.speed);
            const tau = Math.max(0.02, Math.min(baseTau, baseTau / (1 + speed01 * 6.0)));
            let a = 1 - Math.exp(-Math.max(0, dt) / tau);
            const prevF = this.filtered.get(key);
            // If tracking jumps or the hand is moving fast, reduce lag by snapping more aggressively.
            if (prevF) {
                const jump = dist(prevF.center, h.center);
                if (jump > 0.09 || speed01 > 0.85) {
                    a = 1;
                }
            }
            const nextCenter = prevF
                ? {
                    x: prevF.center.x + (h.center.x - prevF.center.x) * a,
                    y: prevF.center.y + (h.center.y - prevF.center.y) * a
                }
                : h.center;
            const nextWrist = prevF
                ? {
                    x: prevF.wrist.x + (h.wrist.x - prevF.wrist.x) * a,
                    y: prevF.wrist.y + (h.wrist.y - prevF.wrist.y) * a
                }
                : h.wrist;
            const nextPinch = prevF ? prevF.pinch + (h.pinch - prevF.pinch) * a : h.pinch;
            let nextLandmarks;
            if (h.landmarks && h.landmarks.length >= 21) {
                let buf = this.filteredLandmarkBuf.get(key);
                if (!buf || buf.length !== 21) {
                    buf = new Array(21);
                    for (let j = 0; j < 21; j++)
                        buf[j] = { x: 0, y: 0 };
                    this.filteredLandmarkBuf.set(key, buf);
                }
                const prevLm = prevF?.landmarks;
                if (prevLm && prevLm.length === 21) {
                    for (let j = 0; j < 21; j++) {
                        const p = h.landmarks[j];
                        const o = buf[j];
                        const pp = prevLm[j];
                        o.x = pp.x + (p.x - pp.x) * a;
                        o.y = pp.y + (p.y - pp.y) * a;
                    }
                }
                else {
                    for (let j = 0; j < 21; j++) {
                        const p = h.landmarks[j];
                        const o = buf[j];
                        o.x = p.x;
                        o.y = p.y;
                    }
                }
                nextLandmarks = buf;
            }
            this.filtered.set(key, {
                center: nextCenter,
                wrist: nextWrist,
                pinch: nextPinch,
                open: h.open,
                fist: h.fist,
                score: h.score,
                landmarks: nextLandmarks
            });
            const prev = this.prevCenters.get(key);
            const speed = prev ? clamp01(dist(prev, nextCenter) / Math.max(1e-6, dt) / 1.3) : 0;
            this.prevCenters.set(key, nextCenter);
            outHands.push({
                label: h.label,
                score: h.score,
                landmarks: nextLandmarks,
                center: nextCenter,
                wrist: nextWrist,
                pinch: nextPinch,
                open: h.open,
                fist: h.fist,
                speed
            });
        }
        for (const key of Array.from(this.filtered.keys())) {
            if (!seen.has(key)) {
                this.filtered.delete(key);
                this.filteredLandmarkBuf.delete(key);
                this.prevCenters.delete(key);
            }
        }
        return { count: outHands.length, hands: outHands };
    }
    updateTargetsFromResult(result) {
        this.targets.clear();
        if (!result?.landmarks || result.landmarks.length === 0)
            return;
        for (let i = 0; i < result.landmarks.length; i++) {
            const lm = result.landmarks[i];
            if (!lm || lm.length < 21)
                continue;
            const { label, score } = handedLabelOf(result, i);
            const key = `${label}:${i}`;
            const mx = (idx) => (this.cfg.mirrorX ? 1 - lm[idx].x : lm[idx].x);
            const my = (idx) => lm[idx].y;
            const distXY = (ax, ay, bx, by) => {
                const dx = ax - bx;
                const dy = ay - by;
                return Math.sqrt(dx * dx + dy * dy);
            };
            const wx = mx(0);
            const wy = my(0);
            const wrist = { x: wx, y: wy };
            const x5 = mx(5);
            const y5 = my(5);
            const x9 = mx(9);
            const y9 = my(9);
            const x13 = mx(13);
            const y13 = my(13);
            const x17 = mx(17);
            const y17 = my(17);
            const center = { x: (wx + x5 + x9 + x13 + x17) / 5, y: (wy + y5 + y9 + y13 + y17) / 5 };
            const palmSize = distXY(wx, wy, x9, y9);
            const thx = mx(4);
            const thy = my(4);
            const inx = mx(8);
            const iny = my(8);
            const pinchDist = distXY(thx, thy, inx, iny);
            const pinch = clamp01((0.20 - pinchDist) / 0.13);
            const tipAvg = (distXY(inx, iny, wx, wy) +
                distXY(mx(12), my(12), wx, wy) +
                distXY(mx(16), my(16), wx, wy) +
                distXY(mx(20), my(20), wx, wy)) /
                4;
            const open = tipAvg > palmSize * 1.75 && pinch < 0.75;
            const fist = tipAvg < palmSize * 1.18 && pinch < 0.45;
            let landmarks;
            if (!this.safeMode && this.wantLandmarks) {
                let buf = this.landmarkBuf.get(key);
                if (!buf || buf.length !== 21) {
                    buf = new Array(21);
                    for (let j = 0; j < 21; j++) {
                        buf[j] = { x: 0, y: 0 };
                    }
                    this.landmarkBuf.set(key, buf);
                }
                for (let j = 0; j < 21; j++) {
                    const p = lm[j];
                    const x = this.cfg.mirrorX ? 1 - p.x : p.x;
                    const y = p.y;
                    const o = buf[j];
                    o.x = x;
                    o.y = y;
                }
                landmarks = buf;
            }
            else {
                landmarks = undefined;
            }
            this.targets.set(key, { label, score, center, wrist, pinch, open, fist, landmarks });
        }
    }
    smoothToTargets(dt) {
        if (!this.targets.size)
            return { count: 0, hands: [] };
        const out = [];
        const tau = Math.max(0.02, this.smoothTauSec);
        const a = 1 - Math.exp(-Math.max(0, dt) / tau);
        for (const [key, tgt] of this.targets) {
            const prevF = this.filtered.get(key);
            const nextCenter = prevF
                ? {
                    x: prevF.center.x + (tgt.center.x - prevF.center.x) * a,
                    y: prevF.center.y + (tgt.center.y - prevF.center.y) * a
                }
                : tgt.center;
            const nextWrist = prevF
                ? {
                    x: prevF.wrist.x + (tgt.wrist.x - prevF.wrist.x) * a,
                    y: prevF.wrist.y + (tgt.wrist.y - prevF.wrist.y) * a
                }
                : tgt.wrist;
            const nextPinch = prevF ? prevF.pinch + (tgt.pinch - prevF.pinch) * a : tgt.pinch;
            this.filtered.set(key, {
                center: nextCenter,
                wrist: nextWrist,
                pinch: nextPinch,
                open: tgt.open,
                fist: tgt.fist,
                score: tgt.score
            });
            const prev = this.prevCenters.get(key);
            const speed = prev ? clamp01(dist(prev, nextCenter) / Math.max(1e-6, dt) / 1.3) : 0;
            this.prevCenters.set(key, nextCenter);
            out.push({
                label: tgt.label,
                score: tgt.score,
                landmarks: tgt.landmarks,
                center: nextCenter,
                wrist: nextWrist,
                pinch: nextPinch,
                open: tgt.open,
                fist: tgt.fist,
                speed
            });
        }
        return { count: out.length, hands: out };
    }
}
