import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

type VizPack = {
  kick?: Float32Array;
};

type Cell = 0 | 1 | 2; // 0 empty, 1 red (right), 2 blue (down)

export class BmlTrafficScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;

  private tex: any;
  private texData: Uint8Array;

  private w = 256;
  private h = 256;

  private grid: Uint8Array;
  private next: Uint8Array;

  private phase: 0 | 1 = 0;
  private t = 0;
  private safeMode = false;

  private burst = 0;

  private lastDimKey = "";
  private lastTargetDensity = -1;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    this.grid = new Uint8Array(this.w * this.h);
    this.next = new Uint8Array(this.w * this.h);

    this.texData = new Uint8Array(this.w * this.h * 4);
    this.tex = new THREE.DataTexture(this.texData, this.w, this.h, THREE.RGBAFormat);
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTex: { value: this.tex },
        uTime: { value: 0 },
        uKick: { value: 0 },
        uEnergy: { value: 0.5 },
        uWet: { value: 0 },
        uBuild: { value: 0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D uTex;
        uniform float uTime;
        uniform float uKick;
        uniform float uEnergy;
        uniform float uWet;
        uniform float uBuild;

        vec3 palette(float t) {
          vec3 a = vec3(0.07, 0.08, 0.12);
          vec3 b = vec3(0.32, 0.25, 0.44);
          vec3 c = vec3(0.75, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec4 s = texture2D(uTex, vUv);
          float kind = floor(s.r * 255.0 + 0.5);

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 red = palette(0.05 + 0.10 * uWet + 0.08 * sin(uTime * 0.15));
          vec3 blu = palette(0.62 + 0.10 * uBuild + 0.08 * cos(uTime * 0.17));

          // Encode: 0 empty, 1 red, 2 blue
          vec3 col = bg;
          col = mix(col, red, step(0.5, kind) * step(kind, 1.5));
          col = mix(col, blu, step(1.5, kind));

          float k = clamp(uKick, 0.0, 1.0);
          col *= 0.78 + 0.55 * k;

          float scan = 0.92 + 0.08 * sin((vUv.y * 900.0) + uTime * 35.0);
          col *= scan;

          float vign = smoothstep(1.30, 0.20, length(vUv * 2.0 - 1.0));
          col *= vign;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);

    this.reset();
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    const target = on ? 160 : 256;
    if (target !== this.w) {
      this.resizeGrid(target, target);
    }
  }

  onResize(camera: any) {
    const cam: any = camera as any;
    const dist = Math.abs((cam.position?.z ?? 2.2) - (this.mesh?.position?.z ?? -0.4));
    const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
    const height = 2 * dist * Math.tan(vFov * 0.5);
    const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
    this.mesh.scale.set(width / this.baseW, height / this.baseH, 1);
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.phase = 0;
    this.burst = 0;
    this.lastDimKey = "";
    this.lastTargetDensity = -1;
    // Base density: leave open for performance visuals; build increases it.
    this.randomize(0.22);
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  private resizeGrid(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.grid = new Uint8Array(this.w * this.h);
    this.next = new Uint8Array(this.w * this.h);

    this.texData = new Uint8Array(this.w * this.h * 4);
    this.tex.dispose();
    this.tex = new THREE.DataTexture(this.texData, this.w, this.h, THREE.RGBAFormat);
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    this.mat.uniforms.uTex.value = this.tex;

    this.lastTargetDensity = -1;
    this.randomize(0.22);
  }

  private randomize(density: number) {
    const d = clamp01(density);
    for (let i = 0; i < this.grid.length; i++) {
      const r = Math.random();
      if (r < d * 0.5) this.grid[i] = 1;
      else if (r < d) this.grid[i] = 2;
      else this.grid[i] = 0;
    }
    this.blitToTexture();
  }

  private sprinkleSamples(count: number) {
    const n = this.grid.length;
    const c = Math.max(0, Math.floor(count));
    for (let i = 0; i < c; i++) {
      const idx = (Math.random() * n) | 0;
      const r = Math.random();
      this.grid[idx] = r < 0.5 ? 1 : 2;
    }
  }

  private sprinkleSamplesBias(count: number, redBias01: number) {
    const n = this.grid.length;
    const c = Math.max(0, Math.floor(count));
    const b = clamp01(redBias01);
    for (let i = 0; i < c; i++) {
      const idx = (Math.random() * n) | 0;
      const r = Math.random();
      this.grid[idx] = r < b ? 1 : 2;
    }
  }

  private removeSamples(count: number) {
    const n = this.grid.length;
    const c = Math.max(0, Math.floor(count));
    for (let i = 0; i < c; i++) {
      const idx = (Math.random() * n) | 0;
      this.grid[idx] = 0;
    }
  }

  private estimateDensity(samples = 4096) {
    const n = this.grid.length;
    const s = Math.min(samples, n);
    let count = 0;
    for (let i = 0; i < s; i++) {
      const idx = (Math.random() * n) | 0;
      if (this.grid[idx] !== 0) count++;
    }
    return count / s;
  }

  private stepOnce() {
    const w = this.w;
    const h = this.h;
    const src = this.grid;
    const dst = this.next;
    dst.fill(0);

    if (this.phase === 0) {
      // Red cars move right
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const v = src[i] as Cell;
          if (v !== 1) {
            if (v === 2) dst[i] = 2;
            continue;
          }
          const nx = (x + 1) % w;
          const ni = row + nx;
          if (src[ni] === 0) dst[ni] = 1;
          else dst[i] = 1;
        }
      }
    } else {
      // Blue cars move down
      for (let y = 0; y < h; y++) {
        const row = y * w;
        const nrow = ((y + 1) % h) * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const v = src[i] as Cell;
          if (v !== 2) {
            if (v === 1) dst[i] = 1;
            continue;
          }
          const ni = nrow + x;
          if (src[ni] === 0) dst[ni] = 2;
          else dst[i] = 2;
        }
      }
    }

    this.grid = dst;
    this.next = src;
    this.phase = this.phase === 0 ? 1 : 0;
  }

  private blitToTexture() {
    const n = this.w * this.h;
    const out = this.texData;
    const src = this.grid;
    for (let i = 0; i < n; i++) {
      const v = src[i] ?? 0;
      const o = i * 4;
      out[o + 0] = v;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
    this.tex.needsUpdate = true;
  }

  update(control: ControlState) {
    this.t += control.dt;

    this.burst = Math.max(0, this.burst - control.dt * 3.2);

    const pack = (control.audioViz ?? {}) as VizPack;
    const kick = pack.kick;

    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) {
        const a = Math.abs(kick[i] ?? 0);
        if (a > peak) peak = a;
      }
      kickEnv = clamp01(peak * 2.2);
    }

    const burstKick = clamp01(kickEnv + this.burst);

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const wet = clamp01(control.rightPinch);
    const build = clamp01(control.build);

    const leftX = clamp01(control.leftX);
    const leftY = clamp01(control.leftY);
    const rightX = clamp01(control.rightX);
    const rightY = clamp01(control.rightY);
    const leftPinch = clamp01(control.leftPinch);

    // Lattice dimensions (grid resolution): hold left pinch to enter "lattice mode".
    // In lattice mode, rightX controls width and rightY controls height.
    if (leftPinch > 0.72) {
      const minS = this.safeMode ? 112 : 144;
      const maxS = this.safeMode ? 208 : 360;
      const tw = Math.max(64, Math.round(lerp(minS, maxS, rightX) / 16) * 16);
      const th = Math.max(64, Math.round(lerp(minS, maxS, rightY) / 16) * 16);
      const key = `${tw}x${th}`;
      if (key !== this.lastDimKey && (Math.abs(tw - this.w) >= 16 || Math.abs(th - this.h) >= 16)) {
        this.lastDimKey = key;
        this.resizeGrid(tw, th);
      }
    }

    const densityFromLeft = 0.06 + 0.62 * leftY;
    const densityFromBuild = 0.16 + 0.26 * build;
    const targetDensity = clamp01(0.55 * densityFromBuild + 0.45 * densityFromLeft);
    const redBias = clamp01(0.05 + 0.9 * leftX);

    // If target density changes a lot, re-seed so changes are immediately visible.
    if (this.lastTargetDensity < 0) this.lastTargetDensity = targetDensity;
    if (Math.abs(targetDensity - this.lastTargetDensity) > 0.085) {
      this.lastTargetDensity = targetDensity;
      this.randomize(targetDensity);
    }

    // Steps per frame: base + kick burst + build density
    const baseSteps = this.safeMode ? 1 : 2;
    const burst = Math.floor(burstKick * (this.safeMode ? 1 : 3));
    const maxSteps = this.safeMode ? 4 : 8;
    const speedSteps = Math.floor((leftPinch > 0.72 ? 0.0 : rightY) * (this.safeMode ? 1 : 4));
    const steps = Math.min(maxSteps, baseSteps + burst + Math.floor(build * 2) + speedSteps);

    for (let i = 0; i < steps; i++) this.stepOnce();

    // Turbulence/injection: make right hand feel like it "stirs" jams.
    const turb = 0.03 + 0.18 * rightX + 0.10 * wet + 0.10 * burstKick;
    if (Math.random() < turb * (0.25 + 0.75 * burstKick)) {
      const p = 0.002 + 0.010 * rightX + 0.006 * wet;
      this.sprinkleSamplesBias(this.grid.length * p, redBias);
    }

    if (wet > 0.15) {
      const p = (wet - 0.15) * 0.020;
      this.sprinkleSamplesBias(this.grid.length * p, redBias);
    }

    if (leftPinch > 0.15) {
      const p = (leftPinch - 0.15) * 0.028;
      this.removeSamples(this.grid.length * p);
    }

    // Rebalance density more aggressively so density changes are obvious.
    // (still bounded; avoids total re-randomization spam)
    const current = this.estimateDensity(4096);
    const delta = targetDensity - current;
    if (Math.abs(delta) > 0.006) {
      const amt = this.grid.length * clamp01(Math.abs(delta) * 0.22);
      if (delta > 0) this.sprinkleSamplesBias(amt, redBias);
      else this.removeSamples(amt);
    }

    this.blitToTexture();

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uKick.value = burstKick;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uBuild.value = build;
  }

  private randomSprinkle(p: number) {
    this.sprinkleSamples(this.grid.length * clamp01(p));
  }

  private rebalanceDensity(targetDensity: number) {
    const target = clamp01(targetDensity);
    const current = this.estimateDensity(4096);
    const delta = target - current;
    if (Math.abs(delta) < 0.01) return;
    if (delta > 0) this.sprinkleSamples(this.grid.length * clamp01(delta * 0.12));
    else this.removeSamples(this.grid.length * clamp01(-delta * 0.12));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
