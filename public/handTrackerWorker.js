/* eslint-disable */

let lm = null;
let vision = null;
let busy = false;

function errMsg(e) {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  try {
    return String(e);
  } catch {
    return "unknown error";
  }
}

function toWorkerResult(r) {
  const out = { landmarks: [] };
  const lms = r && r.landmarks;
  if (Array.isArray(lms)) {
    for (const hand of lms) {
      if (!Array.isArray(hand)) continue;
      const pts = [];
      for (const p of hand) {
        if (!p) continue;
        pts.push({ x: Number(p.x) || 0, y: Number(p.y) || 0 });
      }
      out.landmarks.push(pts);
    }
  }
  const handednesses = (r && (r.handednesses || r.handedness)) || null;
  if (Array.isArray(handednesses)) out.handednesses = handednesses;
  return out;
}

async function loadMediapipe() {
  // Dynamic import works in modern browsers even from classic workers.
  // MediaPipe will use importScripts() internally, which is allowed here.
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/vision_bundle.mjs");
  return mod;
}

self.onmessage = async (ev) => {
  const data = ev.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "stop") {
    try {
      lm && lm.close && lm.close();
    } catch {
    }
    lm = null;
    vision = null;
    busy = false;
    return;
  }

  if (data.type === "init") {
    try {
      const mp = await loadMediapipe();
      vision = await mp.FilesetResolver.forVisionTasks(data.wasmUrl);
      lm = await mp.HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: data.modelUrl },
        runningMode: "VIDEO",
        numHands: data.maxHands
      });
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", message: errMsg(e) });
    }
    return;
  }

  if (data.type === "infer") {
    const frame = data.frame;
    if (busy) {
      try {
        frame && frame.close && frame.close();
      } catch {
      }
      return;
    }
    busy = true;

    const t0 = (self.performance && self.performance.now && self.performance.now()) || Date.now();
    try {
      const landmarker = lm;
      if (!landmarker) {
        self.postMessage({ type: "result", timestampMs: data.timestampMs, inferMs: 0, result: null });
        return;
      }
      const r = landmarker.detectForVideo(frame, data.timestampMs);
      const t1 = (self.performance && self.performance.now && self.performance.now()) || Date.now();
      self.postMessage({
        type: "result",
        timestampMs: data.timestampMs,
        inferMs: Math.max(0, t1 - t0),
        result: r ? toWorkerResult(r) : null
      });
    } catch (e) {
      self.postMessage({ type: "error", message: errMsg(e) });
    } finally {
      try {
        frame && frame.close && frame.close();
      } catch {
      }
      busy = false;
    }
  }
};
