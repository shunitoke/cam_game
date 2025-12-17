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

export class BifurcationScene {
  private scene = new THREE.Scene();

  private points: any;
  private geom: any;
  private mat: any;

  private t = 0;
  private burst = 0;

  private tmpColorA = new THREE.Color();
  private tmpColorB = new THREE.Color();

  private safeMode = false;

  private count = 52000;
  private r: Float32Array;
  private a: Float32Array;
  private age: Float32Array;

  private pos: Float32Array;
  private col: Float32Array;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    this.r = new Float32Array(this.count);
    this.a = new Float32Array(this.count);
    this.age = new Float32Array(this.count);

    this.pos = new Float32Array(this.count * 3);
    this.col = new Float32Array(this.count * 3);

    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(this.col, 3));

    this.mat = new THREE.PointsMaterial({
      size: 0.011,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      vertexColors: true
    });

    this.points = new THREE.Points(this.geom, this.mat);
    this.points.position.z = -0.35;
    this.scene.add(this.points);

    this.reset();
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    const target = on ? 26000 : 52000;
    if (target !== this.count) {
      this.count = target;
      this.r = new Float32Array(this.count);
      this.a = new Float32Array(this.count);
      this.age = new Float32Array(this.count);
      this.pos = new Float32Array(this.count * 3);
      this.col = new Float32Array(this.count * 3);
      this.geom.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
      this.geom.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
      this.reset();
    }
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.burst = 0;

    for (let i = 0; i < this.count; i++) {
      this.r[i] = 1 + Math.random() * 3;
      this.a[i] = Math.random();
      this.age[i] = 12 + Math.random() * 110;
    }
  }

  update(control: ControlState) {
    this.t += control.dt;
    this.burst = Math.max(0, this.burst - control.dt * 2.4);

    const bp = clamp01(control.beatPulse ?? 0);

    const pack = (control.audioViz ?? {}) as VizPack;
    const fft = pack.fft;
    const kick = pack.kick;

    let spec = 0;
    if (fft && fft.length) {
      const n = Math.min(fft.length, 96);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += clamp01(((fft[i] ?? -120) + 120) / 120);
      spec = Math.pow(sum / n, 1.9);
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

    const rMin = lerp(2.55, 3.25, clamp01(control.leftX * 0.9 + build * 0.25));
    const rMax = lerp(3.35, 4.00, clamp01(control.leftY * 0.9 + build * 0.25));

    const baseAge = lerp(16, 220, clamp01(0.25 + control.rightY * 0.75));
    const ageJitter = lerp(25, 110, wet);

    const iters = 1 + Math.floor(lerp(1, 10, clamp01(build * 0.65 + kickEnv * 0.35 + bp * 0.35 + this.burst * 0.7)));

    const hueA = lerp(0.56, 0.92, clamp01(control.rightX));
    const hueB = lerp(0.02, 0.22, clamp01(wet));

    const alpha = 0.22 + 0.72 * clamp01(0.35 + spec * 0.45 + kickEnv * 0.35 + bp * 0.25);
    this.mat.opacity = alpha;
    this.mat.size = this.safeMode ? 0.012 : lerp(0.009, 0.016, clamp01(0.3 + this.burst * 0.9 + kickEnv * 0.6 + bp * 0.35));

    for (let k = 0; k < iters; k++) {
      for (let i = 0; i < this.count; i++) {
        let a = this.a[i] ?? 0;
        const r = this.r[i] ?? 3;
        a = r * a * (1 - a);
        this.age[i] = (this.age[i] ?? 0) - 1;
        if (this.age[i] <= 0 || a <= 0 || a >= 1) {
          this.r[i] = rMin + Math.random() * (rMax - rMin);
          this.a[i] = Math.random();
          this.age[i] = baseAge + Math.random() * ageJitter;
        } else {
          this.a[i] = a;
        }
      }
    }

    this.tmpColorA.setHSL(hueA, 0.9, 0.62);
    this.tmpColorB.setHSL(hueB, 0.95, 0.55);

    const ar = this.tmpColorA.r;
    const ag = this.tmpColorA.g;
    const ab = this.tmpColorA.b;
    const br = this.tmpColorB.r;
    const bg = this.tmpColorB.g;
    const bb = this.tmpColorB.b;

    for (let i = 0; i < this.count; i++) {
      const rr = this.r[i] ?? 3;
      const aa = this.a[i] ?? 0;

      const x = ((rr - rMin) / Math.max(1e-4, rMax - rMin)) * 2 - 1;
      const y = aa * 2 - 1;

      const i3 = i * 3;
      this.pos[i3 + 0] = x * 1.65;
      this.pos[i3 + 1] = y * 0.98;
      this.pos[i3 + 2] = 0;

      const mix = clamp01(0.15 + 0.85 * aa);
      this.col[i3 + 0] = ar + (br - ar) * mix;
      this.col[i3 + 1] = ag + (bg - ag) * mix;
      this.col[i3 + 2] = ab + (bb - ab) * mix;
    }

    this.geom.getAttribute("position").needsUpdate = true;
    this.geom.getAttribute("color").needsUpdate = true;

    this.points.rotation.z = Math.sin(this.t * 0.12) * 0.02;
  }

  dispose() {
    this.geom.dispose();
    this.mat.dispose();
  }
}
