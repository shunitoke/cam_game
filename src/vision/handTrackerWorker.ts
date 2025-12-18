import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";

type InitMsg = {
  type: "init";
  wasmUrl: string;
  modelUrl: string;
  maxHands: number;
};

type InferMsg = {
  type: "infer";
  frame: ImageBitmap;
  timestampMs: number;
};

type StopMsg = { type: "stop" };

type Msg = InitMsg | InferMsg | StopMsg;

type HandednessCat = {
  categoryName?: string;
  displayName?: string;
  label?: string;
  name?: string;
  score?: number;
};

type WorkerResult = {
  landmarks: Array<Array<{ x: number; y: number }>>;
  handednesses?: Array<HandednessCat[]>;
};

type ResultMsg = {
  type: "result";
  timestampMs: number;
  inferMs: number;
  result: WorkerResult | null;
};

type ReadyMsg = { type: "ready" };

type ErrorMsg = { type: "error"; message: string };

type OutMsg = ResultMsg | ReadyMsg | ErrorMsg;

let vision: any | null = null;
let lm: HandLandmarker | null = null;
let busy = false;

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  try {
    return String(e);
  } catch {
    return "unknown error";
  }
}

function toWorkerResult(r: HandLandmarkerResult): WorkerResult {
  const out: WorkerResult = { landmarks: [] };
  const lms = (r as any)?.landmarks as any[];
  if (Array.isArray(lms)) {
    for (const hand of lms) {
      if (!Array.isArray(hand)) continue;
      const pts: Array<{ x: number; y: number }> = [];
      for (const p of hand) {
        if (!p) continue;
        pts.push({ x: Number(p.x) || 0, y: Number(p.y) || 0 });
      }
      out.landmarks.push(pts);
    }
  }
  const handednesses = (r as any)?.handednesses ?? (r as any)?.handedness;
  if (Array.isArray(handednesses)) {
    out.handednesses = handednesses;
  }
  return out;
}

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const data = ev.data;

  if (data.type === "stop") {
    try {
      lm?.close();
    } catch {
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
      (self as any).postMessage({ type: "ready" } satisfies OutMsg);
    } catch (e) {
      (self as any).postMessage({ type: "error", message: errMsg(e) } satisfies OutMsg);
    }
    return;
  }

  if (data.type === "infer") {
    if (busy) {
      try {
        data.frame.close();
      } catch {
      }
      return;
    }
    busy = true;

    const t0 = (self as any).performance?.now?.() ?? Date.now();
    try {
      const landmarker = lm;
      if (!landmarker) {
        (self as any).postMessage({ type: "result", timestampMs: data.timestampMs, inferMs: 0, result: null } satisfies OutMsg);
        return;
      }

      const r = (landmarker as any).detectForVideo(data.frame, data.timestampMs) as HandLandmarkerResult;
      const t1 = (self as any).performance?.now?.() ?? Date.now();
      (self as any).postMessage({
        type: "result",
        timestampMs: data.timestampMs,
        inferMs: Math.max(0, t1 - t0),
        result: r ? toWorkerResult(r) : null
      } satisfies OutMsg);
    } catch (e) {
      (self as any).postMessage({ type: "error", message: errMsg(e) } satisfies OutMsg);
    } finally {
      try {
        data.frame.close();
      } catch {
      }
      busy = false;
    }
  }
};
