import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

type VizPack = {
  fft?: Float32Array;
  kick?: Float32Array;
};

type Node = { x: number; y: number; parent: number };

export class RrtScene {
  private scene = new THREE.Scene();

  private line: any;
  private geom: any;
  private mat: any;

  private nodes: Node[] = [];
  private segs = 0;

  private maxNodes = 12000;
  private safeMode = false;

  private t = 0;
  private burst = 0;

  private tmpColor = new THREE.Color();

  private lastDeformT = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    this.mat = new THREE.LineBasicMaterial({ color: 0xa0ffe8, transparent: true, opacity: 0.85 });

    const g = new THREE.BufferGeometry();
    const pts = new Float32Array(this.maxNodes * 2 * 3);
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.geom = g;

    this.line = new THREE.LineSegments(g, this.mat);
    this.line.position.z = -0.35;
    this.scene.add(this.line);

    this.reset();
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.maxNodes = on ? 5200 : 12000;
    const pts = new Float32Array(this.maxNodes * 2 * 3);
    this.geom.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.reset();
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  onResize(camera: any) {
    const cam: any = camera as any;
    const dist = Math.abs((cam.position?.z ?? 2.2) - (this.line?.position?.z ?? -0.35));
    const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
    const height = 2 * dist * Math.tan(vFov * 0.5);
    const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
    this.line.scale.set(width / this.baseW, height / this.baseH, 1);
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.burst = 0;
    this.nodes = [{ x: 0, y: 0, parent: -1 }];
    this.segs = 0;
    this.geom.setDrawRange(0, 0);
  }

  private nearest(x: number, y: number) {
    let best = 0;
    let bestD = 1e9;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      const dx = x - n.x;
      const dy = y - n.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  update(control: ControlState) {
    this.t += control.dt;
    this.burst = Math.max(0, this.burst - control.dt * 2.8);

    const bp = clamp01(control.beatPulse ?? 0);

    const pack = (control.audioViz ?? {}) as VizPack;
    const fft = pack.fft;
    const kick = pack.kick;

    let spec = 0;
    if (fft && fft.length) {
      const n = Math.min(fft.length, 96);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += clamp01(((fft[i] ?? -120) + 120) / 120);
      spec = Math.pow(sum / n, 1.7);
    }

    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) peak = Math.max(peak, Math.abs(kick[i] ?? 0));
      kickEnv = clamp01(peak * 2.2);
    }

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const wet = clamp01(control.rightPinch);
    const build = clamp01(control.build);

    const lh = control.hands?.hands?.find((h) => h.label === "Left")?.center ?? null;
    const rh = control.hands?.hands?.find((h) => h.label === "Right")?.center ?? null;
    const lpx = lh ? (lh.x * 2 - 1) * 1.55 : 0;
    const lpy = lh ? (lh.y * 2 - 1) * 0.95 : 0;
    const rpx = rh ? (rh.x * 2 - 1) * 1.55 : 0;
    const rpy = rh ? (rh.y * 2 - 1) * 0.95 : 0;
    const pullHand = clamp01(control.leftPinch);
    const pushHand = clamp01(control.rightPinch);
    const impulse = clamp01(control.rightSpeed * 0.9 + control.leftSpeed * 0.4);

    // Goal / attractor point: right hand in 2D
    const gx = (control.rightX * 2 - 1) * 1.55;
    const gy = (control.rightY * 2 - 1) * 0.95;

    // growth factor: rave speed
    const baseGrow = lerp(0.9, 3.5, clamp01(0.15 + energy * 0.55 + build * 0.35 + spec * 0.25));
    const grow = baseGrow * (1.0 + kickEnv * 0.75 + this.burst * 1.0);

    const samples = this.safeMode ? 18 : 36;
    const extend = lerp(0.030, 0.085, clamp01(0.25 + wet * 0.55 + build * 0.3));

    const nodesBudget = Math.min(this.maxNodes, this.nodes.length + Math.floor(grow * 18));

    // Color shift
    const hue = lerp(0.50, 0.88, clamp01(control.rightX));
    this.tmpColor.setHSL(hue, 0.9, lerp(0.52, 0.68, wet));
    this.mat.color.copy(this.tmpColor);
    this.mat.opacity = lerp(0.35, 0.95, clamp01(0.25 + energy * 0.6 + kickEnv * 0.35 + bp * 0.25));

    const pts = this.geom.getAttribute("position").array as Float32Array;

    // Physical deformation pass: occasionally push/pull the existing tree with hand fields.
    // Keeps it cheap by running at ~30Hz.
    const doDeform = this.t - this.lastDeformT > (this.safeMode ? 0.06 : 0.03);
    if (doDeform && this.nodes.length > 8 && (pullHand > 0.05 || pushHand > 0.05 || impulse > 0.05)) {
      this.lastDeformT = this.t;
      const fieldR = lerp(0.24, 0.85, clamp01(0.15 + wet * 0.65 + build * 0.45));
      const field = (0.0007 + 0.010 * (pullHand + pushHand) + 0.006 * impulse) * (0.45 + 0.55 * clamp01(kickEnv + this.burst));
      const lim = Math.min(this.nodes.length, this.safeMode ? 2400 : 4800);
      for (let i = 1; i < lim; i++) {
        const n = this.nodes[i]!;
        let dx = 0;
        let dy = 0;

        if (lh && pullHand > 0.05) {
          const x = lpx - n.x;
          const y = lpy - n.y;
          const d2 = x * x + y * y + 1e-5;
          const d = Math.sqrt(d2);
          if (d < fieldR) {
            const s = (field / d2) * (0.7 + 0.3 * (1.0 - d / fieldR));
            dx += x * s;
            dy += y * s;
          }
        }

        if (rh && pushHand > 0.05) {
          const x = n.x - rpx;
          const y = n.y - rpy;
          const d2 = x * x + y * y + 1e-5;
          const d = Math.sqrt(d2);
          if (d < fieldR) {
            const s = (field / d2) * (0.9 + 0.1 * (1.0 - d / fieldR));
            dx += x * s;
            dy += y * s;
          }
        }

        const maxStep = this.safeMode ? 0.010 : 0.016;
        const l = Math.hypot(dx, dy);
        if (l > maxStep) {
          dx = (dx / l) * maxStep;
          dy = (dy / l) * maxStep;
        }
        n.x = Math.max(-1.7, Math.min(1.7, n.x + dx));
        n.y = Math.max(-1.1, Math.min(1.1, n.y + dy));
      }

      // Rebuild geometry for existing segs after deformation
      const maxSegs = Math.min(this.segs, (this.maxNodes / 2) | 0);
      for (let s = 0; s < maxSegs; s++) {
        const child = s + 1;
        const c = this.nodes[child];
        if (!c) break;
        const p = this.nodes[c.parent];
        if (!p) continue;
        const o = s * 6;
        pts[o + 0] = p.x;
        pts[o + 1] = p.y;
        pts[o + 2] = 0;
        pts[o + 3] = c.x;
        pts[o + 4] = c.y;
        pts[o + 5] = 0;
      }
    }

    let added = 0;
    while (this.nodes.length < nodesBudget && added < 260) {
      added++;

      // sample: mixture of random and goal-biased
      const goalBias = clamp01(0.08 + wet * 0.55 + this.burst * 0.5);
      let sx: number;
      let sy: number;
      if (Math.random() < goalBias) {
        const j = (Math.random() - 0.5) * 0.25;
        sx = gx + j;
        sy = gy + (Math.random() - 0.5) * 0.18;
      } else {
        sx = (Math.random() * 2 - 1) * 1.65;
        sy = (Math.random() * 2 - 1) * 1.05;
      }

      // simple obstacle: center disc that breathes with build
      const ox = 0;
      const oy = 0;
      const rad = lerp(0.12, 0.55, clamp01(0.10 + build * 0.85));
      if ((sx - ox) * (sx - ox) + (sy - oy) * (sy - oy) < rad * rad && Math.random() < 0.85) {
        continue;
      }

      // find nearest
      const ni = this.nearest(sx, sy);
      const n = this.nodes[ni]!;

      // direction
      let dx = sx - n.x;
      let dy = sy - n.y;
      const d = Math.hypot(dx, dy) + 1e-6;
      dx /= d;
      dy /= d;

      const step = extend * (0.55 + 0.45 * Math.min(1, d));
      let nx = n.x + dx * step;
      let ny = n.y + dy * step;

      // slight curl with spectrum
      const curl = (spec * 0.12 + kickEnv * 0.08) * (Math.random() < 0.5 ? -1 : 1);
      const cx = nx * Math.cos(curl) - ny * Math.sin(curl);
      const cy = nx * Math.sin(curl) + ny * Math.cos(curl);
      nx = cx;
      ny = cy;

      // keep within bounds
      nx = Math.max(-1.7, Math.min(1.7, nx));
      ny = Math.max(-1.1, Math.min(1.1, ny));

      // add node
      const idx = this.nodes.length;
      this.nodes.push({ x: nx, y: ny, parent: ni });

      // write segment
      const s = this.segs;
      const o = s * 6;
      pts[o + 0] = n.x;
      pts[o + 1] = n.y;
      pts[o + 2] = 0;
      pts[o + 3] = nx;
      pts[o + 4] = ny;
      pts[o + 5] = 0;
      this.segs++;

      if (this.segs * 2 >= this.maxNodes) break;

      // extra branch burst
      if (kickEnv + this.burst > 0.65 && Math.random() < 0.08) {
        for (let s2 = 0; s2 < samples; s2++) {
          if (this.nodes.length >= nodesBudget) break;
          const ax = nx + (Math.random() - 0.5) * 0.20;
          const ay = ny + (Math.random() - 0.5) * 0.16;
          const ni2 = this.nearest(ax, ay);
          const nn = this.nodes[ni2]!;
          const ddx = ax - nn.x;
          const ddy = ay - nn.y;
          const dd = Math.hypot(ddx, ddy) + 1e-6;
          const step2 = extend * 0.9;
          const bx = nn.x + (ddx / dd) * step2;
          const by = nn.y + (ddy / dd) * step2;
          const idx2 = this.nodes.length;
          this.nodes.push({ x: bx, y: by, parent: ni2 });
          const o2 = this.segs * 6;
          pts[o2 + 0] = nn.x;
          pts[o2 + 1] = nn.y;
          pts[o2 + 2] = 0;
          pts[o2 + 3] = bx;
          pts[o2 + 4] = by;
          pts[o2 + 5] = 0;
          this.segs++;
          if (this.segs * 2 >= this.maxNodes) break;
        }
      }
    }

    this.geom.setDrawRange(0, this.segs * 2);
    this.geom.getAttribute("position").needsUpdate = true;

    this.line.rotation.z = Math.sin(this.t * 0.18) * 0.03;
  }

  dispose() {
    this.geom.dispose();
    this.mat.dispose();
  }
}
