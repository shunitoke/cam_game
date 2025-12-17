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
  const labelRaw = (first?.categoryName ?? first?.displayName ?? "Unknown") as string;
  const score = typeof first?.score === "number" ? first.score : 0;
  if (labelRaw === "Left" || labelRaw === "Right") return { label: labelRaw, score };
  return { label: "Unknown", score };
}

export class HandTracker {
  private handLandmarker: HandLandmarker | null = null;
  private result: HandLandmarkerResult | null = null;

  private prevCenters = new Map<string, Vec2>();

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private lastVideoTime = -1;

  private targetFps = 15;
  private minIntervalMs = 1000 / 15;
  private lastInferT = -Infinity;
  private safeMode = false;

  constructor(
    private readonly cfg: {
      maxHands: number;
      mirrorX: boolean;
    }
  ) {}

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
    this.video = video;
    video.srcObject = stream;

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    const wasmUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
    const modelUrl =
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

    const vision = await FilesetResolver.forVisionTasks(wasmUrl);

    this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelUrl
      },
      runningMode: "VIDEO",
      numHands: this.cfg.maxHands
    });

    this.setSafeMode(this.safeMode);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.handLandmarker?.close();
    this.handLandmarker = null;
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.targetFps = on ? 12 : 15;
    this.minIntervalMs = 1000 / this.targetFps;

    const lm: any = this.handLandmarker as any;
    if (lm && typeof lm.setOptions === "function") {
      try {
        void lm.setOptions({ numHands: on ? 1 : this.cfg.maxHands });
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

    if (t - this.lastInferT < this.minIntervalMs) {
      return this.resultToFrame(this.result, dt);
    }

    if (videoEl.currentTime === this.lastVideoTime) {
      return this.resultToFrame(this.result, dt);
    }

    this.lastVideoTime = videoEl.currentTime;
    this.lastInferT = t;

    try {
      const detections = (lm as any).detectForVideo(videoEl, t) as HandLandmarkerResult;
      this.result = detections;
    } catch {
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

      const landmarks: Vec2[] = lm.map((p) => ({
        x: this.cfg.mirrorX ? 1 - p.x : p.x,
        y: p.y
      }));

      const wrist: Vec2 = {
        x: this.cfg.mirrorX ? 1 - lm[0].x : lm[0].x,
        y: lm[0].y
      };

      const keyPoints = [0, 5, 9, 13, 17].map((idx) => ({
        x: this.cfg.mirrorX ? 1 - lm[idx].x : lm[idx].x,
        y: lm[idx].y
      }));

      const center = avg(keyPoints);

      const palmSize = dist(wrist, {
        x: this.cfg.mirrorX ? 1 - lm[9].x : lm[9].x,
        y: lm[9].y
      });

      const thumbTip = { x: this.cfg.mirrorX ? 1 - lm[4].x : lm[4].x, y: lm[4].y };
      const indexTip = { x: this.cfg.mirrorX ? 1 - lm[8].x : lm[8].x, y: lm[8].y };
      const pinchDist = dist(thumbTip, indexTip);
      const pinch = clamp01((0.20 - pinchDist) / 0.13);

      const tips = [8, 12, 16, 20].map((idx) => ({
        x: this.cfg.mirrorX ? 1 - lm[idx].x : lm[idx].x,
        y: lm[idx].y
      }));

      const avgTipDist = tips.reduce((acc, p) => acc + dist(p, wrist), 0) / tips.length;
      const open = avgTipDist > palmSize * 1.75 && pinch < 0.75;
      const fist = avgTipDist < palmSize * 1.18 && pinch < 0.45;

      const key = `${label}:${i}`;
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
}
