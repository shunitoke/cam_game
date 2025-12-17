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
    this.clear();

    for (const hand of hands) {
      if (!hand.landmarks || hand.landmarks.length < 21) continue;

      const alpha = clamp01(0.35 + hand.score * 0.65);
      const hue = hand.label === "Left" ? 195 : hand.label === "Right" ? 275 : 220;

      const lineWidth = 2 + hand.pinch * 2.2;
      const glow = this.lowPower ? 0 : 10 + hand.speed * 18;

      this.ctx.save();
      this.ctx.globalCompositeOperation = this.lowPower ? "source-over" : "lighter";
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";
      this.ctx.shadowBlur = glow;
      this.ctx.shadowColor = `hsla(${hue}, 95%, 60%, ${alpha})`;

      this.ctx.strokeStyle = `hsla(${hue}, 95%, 65%, ${alpha})`;
      this.ctx.lineWidth = lineWidth;

      for (const [a, b] of CONNECTIONS) {
        const pa = hand.landmarks[a];
        const pb = hand.landmarks[b];
        if (!pa || !pb) continue;
        this.line(pa, pb);
      }

      const baseR = 2.2 + hand.speed * 2.6;
      const activeR = 4.0 + hand.pinch * 6.0;

      for (let i = 0; i < 21; i++) {
        const p = hand.landmarks[i];
        if (!p) continue;

        let r = baseR;
        let a = alpha;

        if (i === 4 || i === 8) {
          r = activeR;
          a = clamp01(alpha + hand.pinch * 0.35);
        }

        if (hand.fist) {
          r *= 1.15;
        }

        this.point(p, r, hue, a);
      }

      this.ctx.restore();
    }
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
