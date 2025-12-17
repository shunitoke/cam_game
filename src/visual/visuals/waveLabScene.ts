import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function createLabelSprite(text: string, colorHex: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context not available");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = "bold 28px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "middle";

  const c = new THREE.Color(colorHex);
  ctx.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.98)`;
  ctx.fillText(text, 14, canvas.height * 0.5);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(0.8, 0.18, 1);

  return { sprite: spr, texture: tex, material: mat };
}

type WavePack = {
  kick?: Float32Array;
  hat?: Float32Array;
  bass?: Float32Array;
  stab?: Float32Array;
  lead?: Float32Array;
  simpleLead?: Float32Array;
  pad?: Float32Array;
  fft?: Float32Array;
  partialsBass?: number[];
  partialsStab?: number[];
  partialsLead?: number[];
  partialsSimpleLead?: number[];
  waveEdit?: {
    enabled: boolean;
    target: "bass" | "stab" | "lead" | "simpleLead";
    harmonicIndex: number;
    value: number;
  };
  selectedVoice?: number;
};

export class WaveLabScene {
  private scene = new THREE.Scene();

  private lines: any[] = [];
  private geoms: any[] = [];
  private mats: any[] = [];
  private labels: Array<{ sprite: any; texture: any; material: any }> = [];
  private baseY: number[] = [];

  private laneEnv: number[] = Array.from({ length: 7 }, () => 0);

  private t = 0;

  private burst = 0;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    const names: Array<{ id: string; hue: number; y: number }> = [
      { id: "kick", hue: 0.03, y: 0.78 },
      { id: "hat", hue: 0.55, y: 0.40 },
      { id: "bass", hue: 0.12, y: 0.02 },
      { id: "stab", hue: 0.78, y: -0.36 },
      { id: "lead", hue: 0.90, y: -0.70 },
      { id: "simpleLead", hue: 0.15, y: -0.98 },
      { id: "pad", hue: 0.62, y: -1.24 }
    ];

    for (const n of names) {
      const pts = new Float32Array(256 * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pts, 3));

      const c = new THREE.Color().setHSL(n.hue, 0.9, 0.6);
      const m = new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(g, m);

      line.position.set(0, n.y, -0.3);
      this.scene.add(line);

      const label = createLabelSprite(n.id.toUpperCase(), c.getHex());
      label.sprite.position.set(-1.65, n.y, -0.25);
      this.scene.add(label.sprite);
      this.labels.push(label);
      this.baseY.push(n.y);

      this.lines.push(line);
      this.geoms.push(g);
      this.mats.push(m);
    }

    {
      const pts = new Float32Array(256 * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color: 0xc8fff4, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(g, m);
      line.position.set(0, -1.10, -0.3);
      this.scene.add(line);

      const label = createLabelSprite("FFT", 0xc8fff4);
      label.sprite.position.set(-1.65, -1.10, -0.25);
      this.scene.add(label.sprite);
      this.labels.push(label);
      this.baseY.push(-1.10);

      this.lines.push(line);
      this.geoms.push(g);
      this.mats.push(m);
    }

    // partials editor bars (16 bars as line segments)
    {
      const pts = new Float32Array(16 * 2 * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color: 0xffc8ff, transparent: true, opacity: 0.85 });
      const line = new THREE.LineSegments(g, m);
      line.position.set(0, -1.33, -0.3);
      this.scene.add(line);

      const label = createLabelSprite("PARTIALS", 0xffc8ff);
      label.sprite.position.set(-1.65, -1.33, -0.25);
      this.scene.add(label.sprite);
      this.labels.push(label);
      this.baseY.push(-1.33);

      this.lines.push(line);
      this.geoms.push(g);
      this.mats.push(m);
    }

    const grid = new THREE.GridHelper(8, 24, 0x1b2a55, 0x0c1020);
    grid.position.y = -0.05;
    grid.position.z = -0.45;
    this.scene.add(grid);
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    for (let i = 0; i < this.laneEnv.length; i++) this.laneEnv[i] = 0;
    this.burst = 0;
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  update(control: ControlState) {
    this.t += control.dt;

    this.burst = Math.max(0, this.burst - control.dt * 3.2);

    const pack = (control.audioViz ?? {}) as WavePack;

    const waves: Array<Float32Array | undefined> = [
      pack.kick,
      pack.hat,
      pack.bass,
      pack.stab,
      pack.lead,
      pack.simpleLead,
      pack.pad
    ];
    const selected = typeof pack.selectedVoice === "number" ? pack.selectedVoice : -1;

    // Fit content vertically on smaller screens by compressing Y positions.
    const h = typeof window !== "undefined" ? window.innerHeight : 900;
    const yScale = clamp01((h - 420) / 520) * 0.45 + 0.50;
    const yOffset = (1 - yScale) * 0.55;

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const baseGain = 0.10 + energy * 0.22 + this.burst * 0.10;
    const dt = Math.min(0.033, control.dt);
    const envAlpha = 1 - Math.exp(-dt * 18);

    for (let i = 0; i < 7; i++) {
      const w = waves[i];
      const g = this.geoms[i];
      const m = this.mats[i];

      // Estimate amplitude (cheap): sample every 4th point
      let peak = 0;
      let sumSq = 0;
      let count = 0;
      if (w && w.length) {
        const stride = 4;
        const max = Math.min(256, w.length);
        for (let s = 0; s < max; s += stride) {
          const v = w[s]!;
          const av = Math.abs(v);
          if (av > peak) peak = av;
          sumSq += v * v;
          count++;
        }
      }
      const rms = count ? Math.sqrt(sumSq / count) : 0;
      const targetEnv = clamp01(Math.max(peak, rms * 1.8));
      this.laneEnv[i] = this.laneEnv[i] + (targetEnv - this.laneEnv[i]) * envAlpha;
      const env = this.laneEnv[i];

      const by = this.baseY[i] ?? 0;
      const yy = by * yScale + yOffset + env * 0.10;
      if (this.lines[i]) this.lines[i].position.y = yy;
      const lbl = this.labels[i];
      if (lbl) lbl.sprite.position.y = yy;

      const pts = (g.getAttribute("position").array as Float32Array);
      const len = Math.min(256, w?.length ?? 0);
      const laneGain = baseGain * (1.0 + env * 6.5);

      for (let s = 0; s < 256; s++) {
        const x = (s / 255) * 2.8 - 1.4;
        const v = s < len && w ? w[s] : 0;
        const y = v * laneGain;
        const i3 = s * 3;
        pts[i3 + 0] = x;
        pts[i3 + 1] = y;
        pts[i3 + 2] = 0;
      }

      g.getAttribute("position").needsUpdate = true;

      const isSel = i === selected;
      m.opacity = isSel ? 1.0 : 0.55;

      if (lbl) {
        lbl.material.opacity = isSel ? 1.0 : 0.55;
        lbl.sprite.scale.set(isSel ? 0.92 : 0.8, isSel ? 0.205 : 0.18, 1);
      }
    }

    // spectrum (FFT) with cosine-warped axis for more low-end detail
    const fft = pack.fft;
    const sg = this.geoms[7];
    const sm = this.mats[7];
    const spts = sg.getAttribute("position").array as Float32Array;
    const n = Math.min(256, fft?.length ?? 0);

    const fftLine = this.lines[7];
    if (fftLine) fftLine.position.y = (this.baseY[7] ?? -1.1) * yScale + yOffset;
    const fftLbl = this.labels[7];
    if (fftLbl) fftLbl.sprite.position.y = (this.baseY[7] ?? -1.1) * yScale + yOffset;

    for (let i = 0; i < 256; i++) {
      const u = i / 255;
      const uw = 1 - Math.cos(u * Math.PI * 0.5);
      const x = uw * 2.8 - 1.4;
      const db = fft && i < n ? fft[i] : -120;
      const m = clamp01((db + 120) / 120);
      const y = Math.pow(m, 3.2) * (0.22 + energy * 0.34);
      const i3 = i * 3;
      spts[i3 + 0] = x;
      spts[i3 + 1] = y;
      spts[i3 + 2] = 0;
    }
    sg.getAttribute("position").needsUpdate = true;
    sm.opacity = 0.75 + energy * 0.25;

    if (fftLbl) fftLbl.material.opacity = 0.55 + energy * 0.45;

    // partials editor
    const edit = pack.waveEdit;
    const pb = pack.partialsBass;
    const ps = pack.partialsStab;
    const pl = pack.partialsLead;
    const psl = pack.partialsSimpleLead;
    const bars = this.geoms[8];
    const barsMat = this.mats[8];
    const bpts = bars.getAttribute("position").array as Float32Array;
    const partials =
      edit?.target === "stab"
        ? ps
        : edit?.target === "lead"
          ? pl
          : edit?.target === "simpleLead"
            ? psl
            : pb;
    const on = Boolean(edit?.enabled && partials && partials.length);

    const barsLine = this.lines[8];
    if (barsLine) barsLine.position.y = (this.baseY[8] ?? -1.33) * yScale + yOffset;
    const partialsLbl = this.labels[8];
    if (partialsLbl) partialsLbl.sprite.position.y = (this.baseY[8] ?? -1.33) * yScale + yOffset;

    barsMat.opacity = on ? 0.9 : 0.18;
    const tint =
      on && edit?.target === "stab"
        ? 0xffc8ff
        : on && edit?.target === "lead"
          ? 0xfff2a8
          : on && edit?.target === "simpleLead"
            ? 0xb6d0ff
            : 0xa0ffe8;
    barsMat.color.set(tint);

    for (let i = 0; i < 16; i++) {
      const x = (i / 15) * 2.8 - 1.4;
      const amp = on && partials ? clamp01(partials[i] ?? 0) : 0;
      const h = amp * 0.28;

      const i6 = i * 6;
      bpts[i6 + 0] = x;
      bpts[i6 + 1] = 0;
      bpts[i6 + 2] = 0;
      bpts[i6 + 3] = x;
      bpts[i6 + 4] = h;
      bpts[i6 + 5] = 0;
    }

    bars.getAttribute("position").needsUpdate = true;

    // Highlight current harmonic via material opacity pulse
    if (on && typeof edit?.harmonicIndex === "number") {
      const pulse = 0.55 + 0.45 * Math.sin(this.t * 10.0);
      barsMat.opacity = 0.65 + 0.35 * pulse;
    }

    if (partialsLbl) partialsLbl.material.opacity = on ? 0.95 : 0.25;
  }

  dispose() {
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const l of this.labels) {
      l.texture.dispose();
      l.material.dispose();
    }
  }
}
