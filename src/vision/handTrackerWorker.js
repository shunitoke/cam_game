import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
let vision = null;
let lm = null;
let busy = false;
function errMsg(e) {
    if (e instanceof Error)
        return e.message;
    try {
        return String(e);
    }
    catch {
        return "unknown error";
    }
}
function toWorkerResult(r) {
    const out = { landmarks: [] };
    const lms = r?.landmarks;
    if (Array.isArray(lms)) {
        for (const hand of lms) {
            if (!Array.isArray(hand))
                continue;
            const pts = [];
            for (const p of hand) {
                if (!p)
                    continue;
                pts.push({ x: Number(p.x) || 0, y: Number(p.y) || 0 });
            }
            out.landmarks.push(pts);
        }
    }
    const handednesses = r?.handednesses ?? r?.handedness;
    if (Array.isArray(handednesses)) {
        out.handednesses = handednesses;
    }
    return out;
}
self.onmessage = async (ev) => {
    const data = ev.data;
    if (data.type === "stop") {
        try {
            lm?.close();
        }
        catch {
        }
        lm = null;
        vision = null;
        busy = false;
        return;
    }
    if (data.type === "init") {
        try {
            vision = await FilesetResolver.forVisionTasks(data.wasmUrl);
            lm = await HandLandmarker.createFromOptions(vision, {
                baseOptions: { modelAssetPath: data.modelUrl },
                runningMode: "VIDEO",
                numHands: data.maxHands
            });
            self.postMessage({ type: "ready" });
        }
        catch (e) {
            self.postMessage({ type: "error", message: errMsg(e) });
        }
        return;
    }
    if (data.type === "infer") {
        if (busy) {
            try {
                data.frame.close();
            }
            catch {
            }
            return;
        }
        busy = true;
        const t0 = self.performance?.now?.() ?? Date.now();
        try {
            const landmarker = lm;
            if (!landmarker) {
                self.postMessage({ type: "result", timestampMs: data.timestampMs, inferMs: 0, result: null });
                return;
            }
            const r = landmarker.detectForVideo(data.frame, data.timestampMs);
            const t1 = self.performance?.now?.() ?? Date.now();
            self.postMessage({
                type: "result",
                timestampMs: data.timestampMs,
                inferMs: Math.max(0, t1 - t0),
                result: r ? toWorkerResult(r) : null
            });
        }
        catch (e) {
            self.postMessage({ type: "error", message: errMsg(e) });
        }
        finally {
            try {
                data.frame.close();
            }
            catch {
            }
            busy = false;
        }
    }
};
