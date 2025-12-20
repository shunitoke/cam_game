import type { HandPose, Vec2 } from "../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

const CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],

  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],

  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12],

  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16],

  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],

  [5, 9],
  [9, 13],
  [13, 17],
  [5, 17]
];

export class HandOverlay2D {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private lowPower = false;
  private enabled = true;
  private maxDpr = 1.25;

  private targetFps = 15;
  private minIntervalMs = 1000 / 15;
  private lastDrawAt = -Infinity;
  private landmarkCache = new Map<string, Vec2[]>();
  private smoothing = 0.35;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context not available");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.canvas.style.display = on ? "block" : "none";
    if (on) this.resize();
  }

  setMaxDpr(max: number) {
    this.maxDpr = Math.max(1, max);
    this.resize();
  }

  setLowPower(on: boolean) {
    this.lowPower = on;
  }

  setTargetFps(fps: number) {
    this.targetFps = Math.max(1, fps);
    this.minIntervalMs = 1000 / this.targetFps;
  }

  setSmoothing(amount: number) {
    this.smoothing = clamp01(amount);
    this.landmarkCache.clear();
  }

  resize() {
    this.dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    const w = Math.floor(window.innerWidth * this.dpr);
    const h = Math.floor(window.innerHeight * this.dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
  }

  clear() {
    if (!this.enabled) return;
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  draw(hands: HandPose[]) {
    if (!this.enabled) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.lastDrawAt < this.minIntervalMs) return;
    this.lastDrawAt = now;

    this.clear();

    const relabeled = this.normalizeLabels(hands);

    for (const { hand, label } of relabeled) {
      const alpha = clamp01(0.35 + hand.score * 0.65);
      const hue = label === "Left" ? 195 : label === "Right" ? 275 : 220;

      const smoothed = this.smoothLandmarks(hand, label);
      const landmarks = smoothed ?? hand.landmarks;

      if (!landmarks || landmarks.length < 21) {
        this.drawSimple(hand, hue, alpha);
        continue;
      }

      const lineWidth = 2 + hand.pinch * 2.2;
      const glow = this.lowPower ? 3 + hand.pinch * 3 : 10 + hand.pinch * 14;

      this.ctx.save();
      this.ctx.globalCompositeOperation = this.lowPower ? "source-over" : "lighter";
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";
      this.ctx.shadowBlur = glow;
      this.ctx.shadowColor = `hsla(${hue}, 95%, 60%, ${alpha})`;

      this.ctx.strokeStyle = `hsla(${hue}, 95%, 65%, ${alpha})`;
      this.ctx.lineWidth = lineWidth;

      // Batch connections into a single stroke.
      this.ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        const pa = landmarks[a];
        const pb = landmarks[b];
        if (!pa || !pb) continue;
        const ppa = this.toPx(pa);
        const ppb = this.toPx(pb);
        this.ctx.moveTo(ppa.x, ppa.y);
        this.ctx.lineTo(ppb.x, ppb.y);
      }
      this.ctx.stroke();

      const baseR = 2.2 + hand.speed * 2.6;
      const activeR = 4.0 + hand.pinch * 6.0;

      // Batch points into a single fill.
      this.ctx.fillStyle = `hsla(${hue}, 95%, 70%, ${alpha})`;
      this.ctx.beginPath();
      for (let i = 0; i < 21; i++) {
        const p = landmarks[i];
        if (!p) continue;

        let r = baseR;
        if (i === 4 || i === 8) {
          r = activeR;
        }
        if (hand.fist) {
          r *= 1.15;
        }

        const pp = this.toPx(p);
        this.ctx.moveTo(pp.x + r, pp.y);
        this.ctx.arc(pp.x, pp.y, r, 0, Math.PI * 2);
      }
      this.ctx.fill();

      this.ctx.restore();
    }
  }

  private drawSimple(hand: HandPose, hue: number, alpha: number) {
    const c = this.toPx(hand.center);
    const w = this.toPx(hand.wrist);
    const r = 10 + hand.pinch * 18;
    const glow = this.lowPower ? 3 + hand.pinch * 3 : 10 + hand.pinch * 14;

    this.ctx.save();
    this.ctx.globalCompositeOperation = this.lowPower ? "source-over" : "lighter";
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.shadowBlur = glow;
    this.ctx.shadowColor = `hsla(${hue}, 95%, 60%, ${alpha})`;

    this.ctx.strokeStyle = `hsla(${hue}, 95%, 65%, ${alpha})`;
    this.ctx.fillStyle = `hsla(${hue}, 95%, 70%, ${alpha})`;
    this.ctx.lineWidth = 2.5;

    this.ctx.beginPath();
    this.ctx.moveTo(w.x, w.y);
    this.ctx.lineTo(c.x, c.y);
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    this.ctx.fill();

    const pr = 3.5 + hand.pinch * 7;
    this.ctx.beginPath();
    this.ctx.arc(c.x, c.y, pr, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.restore();
  }

  private normalizeLabels(hands: HandPose[]): Array<{ hand: HandPose; label: "Left" | "Right" | "Unknown" }> {
    if (!hands.length) return [];
    const indexed = hands.map((hand, idx) => ({ hand, idx, label: (hand.label as "Left" | "Right" | "Unknown") ?? "Unknown" }));
    const sorted = [...indexed].sort((a, b) => (a.hand.center.x ?? 0.5) - (b.hand.center.x ?? 0.5));

    if (sorted.length === 1) {
      sorted[0].label = sorted[0].hand.center.x < 0.5 ? "Left" : "Right";
    } else if (sorted.length >= 2) {
      sorted[0].label = "Left";
      sorted[sorted.length - 1].label = "Right";
    }

    const restored = sorted
      .sort((a, b) => a.idx - b.idx)
      .map((item) => ({ hand: item.hand, label: item.label ?? "Unknown" }));
    return restored;
  }

  private smoothLandmarks(hand: HandPose, visualLabel: "Left" | "Right" | "Unknown"): Vec2[] | null {
    if (!hand?.landmarks || hand.landmarks.length < 21) return null;
    const key = visualLabel ?? hand.label ?? "unknown";
    const prev = this.landmarkCache.get(key);
    const alpha = this.lowPower ? Math.min(0.6, this.smoothing + 0.1) : this.smoothing;
    const result: Vec2[] = new Array(hand.landmarks.length);

    for (let i = 0; i < hand.landmarks.length; i++) {
      const curr = hand.landmarks[i];
      if (!curr) continue;
      if (!prev || prev.length !== hand.landmarks.length || !prev[i]) {
        result[i] = { x: curr.x, y: curr.y };
        continue;
      }
      const p = prev[i]!;
      result[i] = {
        x: p.x + (curr.x - p.x) * alpha,
        y: p.y + (curr.y - p.y) * alpha
      };
    }

    this.landmarkCache.set(key, result);
    return result;
  }

  private toPx(p: Vec2) {
    return {
      x: p.x * window.innerWidth,
      y: p.y * window.innerHeight
    };
  }

  private line(a: Vec2, b: Vec2) {
    const pa = this.toPx(a);
    const pb = this.toPx(b);
    this.ctx.beginPath();
    this.ctx.moveTo(pa.x, pa.y);
    this.ctx.lineTo(pb.x, pb.y);
    this.ctx.stroke();
  }

  private point(p: Vec2, r: number, hue: number, alpha: number) {
    const pp = this.toPx(p);
    this.ctx.fillStyle = `hsla(${hue}, 95%, 70%, ${alpha})`;
    this.ctx.beginPath();
    this.ctx.arc(pp.x, pp.y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }
}
