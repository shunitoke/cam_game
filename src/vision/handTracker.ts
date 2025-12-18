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
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.videoTrack = null;
    this.video = null;
    this.handLandmarker?.close();
    this.handLandmarker = null;
    this.vision = null;
    this.restartInFlight = null;
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
    this.targetFps = on ? 8 : 15;
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
        const desired = on ? 1 : Math.max(1, this.currentNumHands || this.cfg.maxHands);
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

    const nowMs = typeof performance !== "undefined" ? performance.now() : t;

    if (!lm || !videoEl) {
      return { count: 0, hands: [] };
    }

    if (!this.inferEnabled) {
      return this.smoothToTargets(dt);
    }

    if (nowMs < this.inferPauseUntilMs) {
      return this.smoothToTargets(dt);
    }

    let didInfer = false;

    if (t - this.lastInferT < this.dynamicMinIntervalMs) {
      return this.smoothToTargets(dt);
    }

    if (videoEl.currentTime === this.lastVideoTime) {
      return this.smoothToTargets(dt);
    }

    this.lastVideoTime = videoEl.currentTime;
    this.lastInferT = t;

    let detections: HandLandmarkerResult | null = null;
    let inferMs = 0;
    try {
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      detections = (lm as any).detectForVideo(videoEl, t) as HandLandmarkerResult;
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      inferMs = Math.max(0, t1 - t0);
    } catch {
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      inferMs = Math.max(0, t1 - nowMs);
      detections = null;
    }

    this.lastInferMs = inferMs;

    // MediaPipe can occasionally spike very high (hundreds of ms to seconds). We keep the
    // raw value for diagnostics, but we must not let rare outliers poison the EMA used for
    // adaptive throttling, otherwise inference cadence can collapse to ~0.1 FPS.
    const inferMsForAdaptive = Math.min(inferMs, this.safeMode ? 140 : 180);

    try {
      const spikeMs = this.safeMode ? 220 : 300;
      const spikeCooldownMs = this.safeMode ? 2500 : 2000;
      const spikeRefMs = this.inferMsEma || inferMsForAdaptive;
      const isSpike = inferMs > spikeMs && inferMs > spikeRefMs * 2.2;
      if (isSpike && nowMs - this.lastSpikeAtMs > spikeCooldownMs) {
        this.lastSpikeAtMs = nowMs;
        this.inferPauseUntilMs = nowMs + (this.safeMode ? 650 : 450);
        const canSet = typeof (lm as any).setOptions === "function";
        if (canSet && this.currentNumHands > 1) {
          try {
            void (lm as any).setOptions({ numHands: 1 });
            this.currentNumHands = 1;
          } catch {
          }
        }
      }

      this.inferMsEma = this.inferMsEma
        ? this.inferMsEma + (inferMsForAdaptive - this.inferMsEma) * 0.12
        : inferMsForAdaptive;

      // Adaptive throttling: if inference is expensive, reduce how often we run it.
      // Keeps visuals responsive even if tracking gets heavy.
      const budgetMs = this.safeMode ? 22 : 32;
      const slow = this.inferMsEma > budgetMs;
      const mul = slow ? 1.2 : 1.0;
      const maxIntervalMs = this.safeMode ? 400 : 250;
      this.dynamicMinIntervalMs = Math.min(maxIntervalMs, Math.max(this.minIntervalMs, this.inferMsEma * mul));

      if (this.cfg.maxHands > 1) {
        const dMs = Math.max(0, dt * 1000);
        if (slow) {
          this.overBudgetMs += dMs;
          this.underBudgetMs = Math.max(0, this.underBudgetMs - dMs);
        } else {
          this.underBudgetMs += dMs;
          this.overBudgetMs = Math.max(0, this.overBudgetMs - dMs);
        }

        const canSet = typeof (lm as any).setOptions === "function";
        if (canSet && this.currentNumHands > 1 && this.overBudgetMs > 900) {
          try {
            void (lm as any).setOptions({ numHands: 1 });
            this.currentNumHands = 1;
            this.overBudgetMs = 0;
            this.underBudgetMs = 0;
          } catch {
          }
        }
        if (canSet && this.currentNumHands === 1 && !this.safeMode && this.underBudgetMs > 3500) {
          try {
            void (lm as any).setOptions({ numHands: this.cfg.maxHands });
            this.currentNumHands = this.cfg.maxHands;
            this.overBudgetMs = 0;
            this.underBudgetMs = 0;
          } catch {
          }
        }
      }

      this.result = detections;
      didInfer = true;
    } catch {
      return { count: 0, hands: [] };
    }

    if (didInfer) {
      this.updateTargetsFromResult(this.result);
    }
    return this.smoothToTargets(dt);
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
