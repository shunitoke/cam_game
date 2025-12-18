import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult
} from "@mediapipe/tasks-vision";

import type { HandsFrame, HandPose, HandLabel, Vec2 } from "../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function dist(a: Vec2, b: Vec2) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function avg(points: Vec2[]): Vec2 {
  const s = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 }
  );
  return { x: s.x / points.length, y: s.y / points.length };
}

function handedLabelOf(result: any, i: number): { label: HandLabel; score: number } {
  const handedness = result?.handedness ?? result?.handednesses;
  const first = handedness?.[i]?.[0];
  const score = typeof first?.score === "number" ? first.score : 0;
  const labelRaw =
    (typeof first?.categoryName === "string" && first.categoryName) ||
    (typeof first?.displayName === "string" && first.displayName) ||
    (typeof first?.label === "string" && first.label) ||
    (typeof first?.name === "string" && first.name) ||
    "";
  if (labelRaw === "Left" || labelRaw === "Right") return { label: labelRaw, score };
  return { label: "Unknown", score };
}

 export class HandTracker {
  private handLandmarker: HandLandmarker | null = null;
  private result: HandLandmarkerResult | null = null;

  private workerResult: any | null = null;
  private worker: Worker | null = null;
  private useWorker = true;
  private workerReady = false;
  private workerInitInFlight = false;
  private workerError: string | null = null;

  private vision: any | null = null;
  private readonly wasmUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
  private readonly modelUrl =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  private restartInFlight: Promise<void> | null = null;

  private prevCenters = new Map<string, Vec2>();
  private filtered = new Map<
    string,
    {
      center: Vec2;
      wrist: Vec2;
      pinch: number;
      open: boolean;
      fist: boolean;
      score: number;
    }
  >();

  private targets = new Map<
    string,
    {
      label: HandLabel;
      score: number;
      center: Vec2;
      wrist: Vec2;
      pinch: number;
      open: boolean;
      fist: boolean;
      landmarks?: Vec2[];
    }
  >();

  private landmarkBuf = new Map<string, Vec2[]>();

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private lastVideoTime = -1;

  private useVideoFrameCallback = true;
  private vfcActive = false;
  private vfcInFlight = false;

  private vfcLastSentMediaTime = -1;

  private targetFps = 15;
  private minIntervalMs = 1000 / 15;
  private lastInferT = -Infinity;
  private safeMode = false;

  private inferMsEma = 0;
  private lastInferMs = 0;
  private dynamicMinIntervalMs = this.minIntervalMs;

  private smoothTauSec = 0.18;

  private wantLandmarks = true;

  private inferEnabled = true;

  private inferPauseUntilMs = 0;

  private lastSpikeAtMs = -Infinity;

  private currentNumHands = 0;
  private overBudgetMs = 0;
  private underBudgetMs = 0;

  constructor(
    private readonly cfg: {
      maxHands: number;
      mirrorX: boolean;
    }
  ) {}

  setWantLandmarks(on: boolean) {
    this.wantLandmarks = on;
  }

  setInferEnabled(on: boolean) {
    this.inferEnabled = on;
  }

  getInferPauseMs(t: number) {
    return Math.max(0, this.inferPauseUntilMs - t);
  }

  getLastInferMs() {
    return this.lastInferMs;
  }

  getInferBackend(): "worker" | "main" | "off" {
    if (!this.inferEnabled) return "off";
    if (this.useWorker && this.workerReady) return "worker";
    return "main";
  }

  getWorkerError(): string | null {
    return this.workerError;
  }

  async start(video: HTMLVideoElement) {
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

    await new Promise<void>((resolve) => {
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
    } catch {
    }
    try {
      this.worker?.terminate();
    } catch {
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

  private async ensureWorker() {
    if (!this.useWorker) return;
    if (this.worker && this.workerReady) return;
    if (this.workerInitInFlight) return;
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

      this.worker.onmessage = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ready") {
          this.workerReady = true;
          this.workerError = null;
          return;
        }
        if (msg.type === "result") {
          this.workerResult = msg.result ?? null;
          if (typeof msg.inferMs === "number") {
            this.lastInferMs = msg.inferMs;
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
          } catch {
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
      await new Promise<void>((r) => setTimeout(r, 0));
    } catch {
      this.useWorker = false;
      this.workerReady = false;
      this.workerError = "worker init failed";
      try {
        this.worker?.terminate();
      } catch {
      }
      this.worker = null;
    } finally {
      this.workerInitInFlight = false;
    }
  }

  private startVideoFrameLoop() {
    if (!this.useVideoFrameCallback) return;
    const videoEl: any = this.video as any;
    if (!videoEl || typeof videoEl.requestVideoFrameCallback !== "function") return;
    if (this.vfcActive) return;

    this.vfcActive = true;

    const loop = async (_now: number, meta: any) => {
      if (!this.vfcActive) return;
      // Schedule next callback first to keep the loop alive even if inference throws.
      try {
        (videoEl as any).requestVideoFrameCallback(loop);
      } catch {
        this.vfcActive = false;
        return;
      }

      // Avoid overlapping work if callbacks come in faster than we can process.
      if (this.vfcInFlight) return;
      this.vfcInFlight = true;

      try {
        const v = this.video;
        if (!v) return;

        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (nowMs < this.inferPauseUntilMs) return;
        if (!this.inferEnabled) {
          this.result = null;
          this.workerResult = null;
          this.prevCenters.clear();
          return;
        }

        const mediaTime = typeof meta?.mediaTime === "number" ? meta.mediaTime : v.currentTime;

        // Fixed FPS gate.
        if (nowMs - this.lastInferT < this.minIntervalMs) return;

        // Only infer when the video frame advanced.
        if (mediaTime === this.lastVideoTime) return;

        this.lastVideoTime = mediaTime;
        this.lastInferT = nowMs;

        // Worker path: transfer an ImageBitmap instead of running inference on main thread.
        if (this.useWorker && this.worker && this.workerReady && typeof (globalThis as any).createImageBitmap === "function") {
          // Avoid sending duplicate frames.
          if (mediaTime !== this.vfcLastSentMediaTime) {
            this.vfcLastSentMediaTime = mediaTime;
            let bmp: ImageBitmap | null = null;
            try {
              bmp = await (globalThis as any).createImageBitmap(v);
            } catch {
              bmp = null;
            }
            if (bmp) {
              try {
                this.worker.postMessage({ type: "infer", frame: bmp, timestampMs: nowMs }, [bmp as any]);
              } catch {
                try {
                  bmp.close();
                } catch {
                }
              }
            }
          }
          return;
        }

        // Fallback: in-thread inference.
        const lm = this.handLandmarker;
        if (!lm) return;
        const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.result = (lm as any).detectForVideo(v, nowMs) as HandLandmarkerResult;
        const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.lastInferMs = Math.max(0, t1 - t0);
      } catch {
        this.result = null;
        this.workerResult = null;
      } finally {
        this.vfcInFlight = false;
      }
    };

    try {
      (videoEl as any).requestVideoFrameCallback(loop);
    } catch {
      this.vfcActive = false;
    }
  }

  async restartLandmarker() {
    if (this.restartInFlight) return this.restartInFlight;
    if (!this.video) return;

    const run = async () => {
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      this.inferPauseUntilMs = Math.max(this.inferPauseUntilMs, nowMs + 4000);

      try {
        this.handLandmarker?.close();
      } catch {
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
      } catch {
      }
    };

    this.restartInFlight = run().finally(() => {
      this.restartInFlight = null;
    });
    return this.restartInFlight;
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    // In safe mode we need a much lower tracker budget; the HUD showed ~35ms for tracking.
    this.targetFps = on ? 12 : 15;
    this.minIntervalMs = 1000 / this.targetFps;
    this.dynamicMinIntervalMs = this.minIntervalMs;

    // Reduce camera resolution in safe mode to reduce MediaPipe workload.
    const track: any = this.videoTrack as any;
    if (track && typeof track.applyConstraints === "function") {
      const constraints: MediaTrackConstraints = on
        ? { width: { ideal: 384 }, height: { ideal: 216 }, frameRate: { ideal: 15, max: 15 } }
        : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } };
      try {
        void track.applyConstraints(constraints);
      } catch {
        // ignore
      }
    }

    const lm: any = this.handLandmarker as any;
    if (lm && typeof lm.setOptions === "function") {
      try {
        const desired = Math.max(1, this.cfg.maxHands);
        void lm.setOptions({ numHands: desired });
        this.currentNumHands = desired;
      } catch {
        // ignore
      }
    }
  }

  update(t: number, dt: number): HandsFrame {
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
      this.result = (lm as any).detectForVideo(videoEl, t) as HandLandmarkerResult;
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      this.lastInferMs = Math.max(0, t1 - t0);
    } catch {
      this.result = null;
      return { count: 0, hands: [] };
    }

    return this.resultToFrame(this.result, dt);
  }

  private resultToFrame(result: HandLandmarkerResult | null, dt: number): HandsFrame {
    if (!result?.landmarks || result.landmarks.length === 0) return { count: 0, hands: [] };

    const hands: HandPose[] = [];

    for (let i = 0; i < result.landmarks.length; i++) {
      const lm = result.landmarks[i];
      if (!lm || lm.length < 21) continue;

      const { label, score } = handedLabelOf(result as any, i);
      const key = `${label}:${i}`;

      const mx = (idx: number) => (this.cfg.mirrorX ? 1 - lm[idx]!.x : lm[idx]!.x);
      const my = (idx: number) => lm[idx]!.y;

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

      const tipAvg =
        (dist({ x: mx(8), y: my(8) }, wrist) +
          dist({ x: mx(12), y: my(12) }, wrist) +
          dist({ x: mx(16), y: my(16) }, wrist) +
          dist({ x: mx(20), y: my(20) }, wrist)) /
        4;

      const open = tipAvg > palmSize * 1.75 && pinch < 0.75;
      const fist = tipAvg < palmSize * 1.18 && pinch < 0.45;

      let landmarks: Vec2[] | undefined;
      if (!this.safeMode && this.wantLandmarks) {
        // Allocate per-hand landmark buffer and update it in-place to reduce churn.
        let buf = this.landmarkBuf.get(key);
        if (!buf || buf.length !== 21) {
          buf = new Array(21);
          for (let j = 0; j < 21; j++) buf[j] = { x: 0, y: 0 };
          this.landmarkBuf.set(key, buf);
        }
        for (let j = 0; j < 21; j++) {
          const p = lm[j]!;
          const o = buf[j]!;
          o.x = this.cfg.mirrorX ? 1 - p.x : p.x;
          o.y = p.y;
        }
        landmarks = buf;
      } else {
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

    return { count: hands.length, hands };
  }

  private workerResultToFrame(result: any | null, dt: number): HandsFrame {
    const landmarksAll = result?.landmarks as any;
    if (!Array.isArray(landmarksAll) || landmarksAll.length === 0) return { count: 0, hands: [] };

    const hands: HandPose[] = [];

    for (let i = 0; i < landmarksAll.length; i++) {
      const lm = landmarksAll[i] as any;
      if (!Array.isArray(lm) || lm.length < 21) continue;

      const { label, score } = handedLabelOf(result as any, i);
      const key = `${label}:${i}`;

      const mx = (idx: number) => {
        const p = lm[idx];
        const x = typeof p?.x === "number" ? p.x : 0;
        return this.cfg.mirrorX ? 1 - x : x;
      };
      const my = (idx: number) => {
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

      const tipAvg =
        (dist({ x: mx(8), y: my(8) }, wrist) +
          dist({ x: mx(12), y: my(12) }, wrist) +
          dist({ x: mx(16), y: my(16) }, wrist) +
          dist({ x: mx(20), y: my(20) }, wrist)) /
        4;

      const open = tipAvg > palmSize * 1.75 && pinch < 0.75;
      const fist = tipAvg < palmSize * 1.18 && pinch < 0.45;

      let landmarks: Vec2[] | undefined;
      if (!this.safeMode && this.wantLandmarks) {
        let buf = this.landmarkBuf.get(key);
        if (!buf || buf.length !== 21) {
          buf = new Array(21);
          for (let j = 0; j < 21; j++) buf[j] = { x: 0, y: 0 };
          this.landmarkBuf.set(key, buf);
        }
        for (let j = 0; j < 21; j++) {
          const p = lm[j];
          const o = buf[j]!;
          const x = typeof p?.x === "number" ? p.x : 0;
          const y = typeof p?.y === "number" ? p.y : 0;
          o.x = this.cfg.mirrorX ? 1 - x : x;
          o.y = y;
        }
        landmarks = buf;
      } else {
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

    return { count: hands.length, hands };
  }

  private updateTargetsFromResult(result: HandLandmarkerResult | null) {
    this.targets.clear();
    if (!result?.landmarks || result.landmarks.length === 0) return;

    for (let i = 0; i < result.landmarks.length; i++) {
      const lm = result.landmarks[i];
      if (!lm || lm.length < 21) continue;

      const { label, score } = handedLabelOf(result as any, i);
      const key = `${label}:${i}`;

      const mx = (idx: number) => (this.cfg.mirrorX ? 1 - lm[idx]!.x : lm[idx]!.x);
      const my = (idx: number) => lm[idx]!.y;
      const distXY = (ax: number, ay: number, bx: number, by: number) => {
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

      const tipAvg =
        (distXY(inx, iny, wx, wy) +
          distXY(mx(12), my(12), wx, wy) +
          distXY(mx(16), my(16), wx, wy) +
          distXY(mx(20), my(20), wx, wy)) /
        4;
      const open = tipAvg > palmSize * 1.75 && pinch < 0.75;
      const fist = tipAvg < palmSize * 1.18 && pinch < 0.45;

      let landmarks: Vec2[] | undefined;
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
          const p = lm[j]!;
          const x = this.cfg.mirrorX ? 1 - p.x : p.x;
          const y = p.y;
          const o = buf[j]!;
          o.x = x;
          o.y = y;
        }
        landmarks = buf;
      } else {
        landmarks = undefined;
      }

      this.targets.set(key, { label, score, center, wrist, pinch, open, fist, landmarks });
    }
  }

  private smoothToTargets(dt: number): HandsFrame {
    if (!this.targets.size) return { count: 0, hands: [] };

    const out: HandPose[] = [];
    const tau = Math.max(0.02, this.smoothTauSec);
    const a = 1 - Math.exp(-Math.max(0, dt) / tau);

    for (const [key, tgt] of this.targets) {
      const prevF = this.filtered.get(key);

      const nextCenter: Vec2 = prevF
        ? {
            x: prevF.center.x + (tgt.center.x - prevF.center.x) * a,
            y: prevF.center.y + (tgt.center.y - prevF.center.y) * a
          }
        : tgt.center;

      const nextWrist: Vec2 = prevF
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
