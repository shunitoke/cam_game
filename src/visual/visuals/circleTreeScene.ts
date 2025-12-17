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

type Node = {
  x: number;
  y: number;
  r: number;
  depth: number;
  parent: number;
};

export class CircleTreeScene {
  private scene = new THREE.Scene();

  private mesh: any;
  private geom: any;
  private mat: any;

  private t = 0;
  private burst = 0;
  private safeMode = false;

  private maxNodes = 1600;
  private nodes: Node[] = [];

  private poolSize = 140;
  private bubCount = 0;
  private bx: Float32Array;
  private by: Float32Array;
  private bvx: Float32Array;
  private bvy: Float32Array;
  private br0: Float32Array;
  private br: Float32Array;
  private bPhase: Float32Array;
  private prevBp = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    const g = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.mat = new THREE.ShaderMaterial({
      transparent: false,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uKick: { value: 0 },
        uEnergy: { value: 0.5 },
        uWet: { value: 0.0 },
        uBuild: { value: 0.0 },
        uAspect: { value: 1.0 },
        uSeed: { value: 0.0 },
        uCount: { value: 0.0 },
        uNodes: { value: new Array(256).fill(new THREE.Vector4()) }
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

        uniform float uTime;
        uniform float uKick;
        uniform float uEnergy;
        uniform float uWet;
        uniform float uBuild;
        uniform float uAspect;
        uniform float uSeed;
        uniform float uCount;
        uniform vec4 uNodes[256];

        float hash11(float p) {
          p = fract(p * 0.1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

        vec3 palette(float t) {
          vec3 a = vec3(0.07, 0.08, 0.12);
          vec3 b = vec3(0.32, 0.25, 0.44);
          vec3 c = vec3(0.75, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          p.x *= uAspect;

          float k = clamp(uKick, 0.0, 1.0);
          float t = uTime * (0.12 + 0.55 * uEnergy + 0.25 * uBuild);

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 col = bg;

          float glow = 0.0;
          float lines = 0.0;

          float nCount = floor(uCount + 0.5);
          for (int i = 0; i < 256; i++) {
            if (float(i) >= nCount) break;
            vec4 n = uNodes[i];
            vec2 c = n.xy;
            float r = n.z;
            float d = length(p - c);

            float ring = smoothstep(r * (1.0 + 0.06 * k), r * (1.0 + 0.06 * k) - 0.01, d);
            float fill = smoothstep(r, r - 0.03, d);

            float w = 0.25 + 0.75 * smoothstep(0.0, 1.0, 1.0 - float(i) / max(1.0, nCount));
            glow += fill * w;
            lines += ring * w;
          }

          float hue = fract(0.55 + 0.18 * uWet + 0.08 * uBuild + 0.05 * sin(t * 0.15) + uSeed * 0.1);
          vec3 pc = palette(hue + 0.15 * lines);

          col = mix(col, pc, clamp(lines * (0.25 + 0.85 * k), 0.0, 1.0));
          col += pc * glow * (0.06 + 0.10 * uWet) * (0.35 + 0.65 * k);

          float scan = 0.92 + 0.08 * sin((vUv.y * 900.0) + uTime * 35.0);
          col *= scan;

          float vign = smoothstep(1.30, 0.20, length(vUv * 2.0 - 1.0));
          col *= vign;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);

    this.bx = new Float32Array(256);
    this.by = new Float32Array(256);
    this.bvx = new Float32Array(256);
    this.bvy = new Float32Array(256);
    this.br0 = new Float32Array(256);
    this.br = new Float32Array(256);
    this.bPhase = new Float32Array(256);

    this.reset();
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.maxNodes = on ? 900 : 1600;
    this.poolSize = on ? 96 : 140;
    this.reset();
  }

  onResize(camera: any) {
    const cam: any = camera as any;
    const dist = Math.abs((cam.position?.z ?? 2.2) - (this.mesh?.position?.z ?? -0.4));
    const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
    const height = 2 * dist * Math.tan(vFov * 0.5);
    const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
    this.mesh.scale.set(width / this.baseW, height / this.baseH, 1);
    this.mat.uniforms.uAspect.value = cam.aspect ?? window.innerWidth / window.innerHeight;
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
    this.prevBp = 0;

    // Start with a root circle.
    this.nodes = [{ x: 0, y: 0, r: 0.55, depth: 0, parent: -1 }];

    // Fill node list upfront with a packing-ish growth.
    const maxDepth = 10;
    while (this.nodes.length < this.maxNodes) {
      const parent = this.nodes[(Math.random() * this.nodes.length) | 0]!;
      if (parent.depth >= maxDepth) continue;

      const r = parent.r * lerp(0.36, 0.58, Math.random());
      const a = Math.random() * Math.PI * 2;

      const x = parent.x + Math.cos(a) * (parent.r + r) * lerp(0.92, 1.05, Math.random());
      const y = parent.y + Math.sin(a) * (parent.r + r) * lerp(0.92, 1.05, Math.random());

      // keep within bounds
      if (Math.abs(x) > 1.45 || Math.abs(y) > 0.95) continue;

      // avoid overlap too much
      let ok = true;
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i]!;
        const dx = x - n.x;
        const dy = y - n.y;
        const d = Math.hypot(dx, dy);
        if (d < (r + n.r) * 0.92) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      this.nodes.push({ x, y, r, depth: parent.depth + 1, parent: this.nodes.indexOf(parent) });
    }

    // Upload subset (shader uniform array limited)
    const limit = 256;
    const nCount = Math.min(limit, this.nodes.length);

    const u: any[] = new Array(limit);
    for (let i = 0; i < limit; i++) u[i] = new (THREE as any).Vector4(0, 0, 0, 0);

    for (let i = 0; i < nCount; i++) {
      const n = this.nodes[i]!;
      u[i] = new (THREE as any).Vector4(n.x, n.y, n.r, n.depth);
    }

    this.mat.uniforms.uNodes.value = u;
    this.bubCount = Math.min(this.poolSize, nCount);
    this.mat.uniforms.uCount.value = this.bubCount;
    this.mat.uniforms.uSeed.value = Math.random();

    for (let i = 0; i < this.bubCount; i++) {
      const n = this.nodes[i]!;
      this.bx[i] = n.x;
      this.by[i] = n.y;
      this.bvx[i] = 0;
      this.bvy[i] = 0;
      this.br0[i] = n.r;
      this.br[i] = n.r;
      this.bPhase[i] = n.depth + i * 0.17;
    }

    for (let i = this.bubCount; i < 256; i++) {
      this.bx[i] = 0;
      this.by[i] = 0;
      this.bvx[i] = 0;
      this.bvy[i] = 0;
      this.br0[i] = 0;
      this.br[i] = 0;
      this.bPhase[i] = 0;
    }
  }

  update(control: ControlState) {
    this.t += control.dt;
    this.burst = Math.max(0, this.burst - control.dt * 2.8);

    const pack = (control.audioViz ?? {}) as VizPack;
    const kick = pack.kick;
    const fft = pack.fft;

    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) peak = Math.max(peak, Math.abs(kick[i] ?? 0));
      kickEnv = clamp01(peak * 2.2);
    }

    let spec = 0;
    if (fft && fft.length) {
      const n = Math.min(fft.length, 96);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += clamp01(((fft[i] ?? -120) + 120) / 120);
      spec = Math.pow(sum / n, 1.7);
    }

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const wet = clamp01(control.rightPinch);
    const build = clamp01(control.build);

    // Gesture mapping:
    // - rightX : palette shift
    // - rightPinch : glow
    // - rightY : tempo wobble
    // - leftPinch : regenerate
    const k = clamp01(kickEnv + this.burst);

    const bp = clamp01(control.beatPulse ?? 0);
    const beatEdge = bp > 0.55 && this.prevBp <= 0.55;
    this.prevBp = bp;

    if (control.leftPinch > 0.92 && Math.random() < 0.06) {
      this.reset();
    }

    // Update uniforms
    this.mat.uniforms.uTime.value = this.t + spec * 0.5;
    this.mat.uniforms.uKick.value = k;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uBuild.value = build;

    const arr: any[] = this.mat.uniforms.uNodes.value as any;
    const dt = Math.min(0.033, control.dt);
    const damp = this.safeMode ? 0.94 : 0.92;
    const drive = (0.0012 + 0.0035 * wet) * (0.35 + 0.65 * k);

    if (beatEdge) {
      if (Math.random() < 0.65 + 0.25 * build) {
        const i = (Math.random() * Math.max(1, this.bubCount)) | 0;
        this.bvx[i] += (Math.random() * 2 - 1) * (0.10 + 0.35 * energy);
        this.bvy[i] += (Math.random() * 2 - 1) * (0.10 + 0.35 * energy);
      }

      if (build > 0.25 && this.bubCount < this.poolSize) {
        const j = this.bubCount++;
        const src = (Math.random() * Math.max(1, j)) | 0;
        const sx = this.bx[src];
        const sy = this.by[src];
        const a = Math.random() * Math.PI * 2;
        const rr = Math.max(0.05, Math.min(0.32, this.br0[src] * lerp(0.35, 0.60, Math.random())));
        this.bx[j] = sx + Math.cos(a) * (this.br[src] + rr) * 0.75;
        this.by[j] = sy + Math.sin(a) * (this.br[src] + rr) * 0.75;
        this.bvx[j] = (Math.random() * 2 - 1) * 0.18;
        this.bvy[j] = (Math.random() * 2 - 1) * 0.18;
        this.br0[j] = rr;
        this.br[j] = rr;
        this.bPhase[j] = this.t * 0.17 + j * 0.11;
        this.mat.uniforms.uCount.value = this.bubCount;
      }

      if (build > 0.55 && this.bubCount >= 3 && Math.random() < 0.45) {
        let bi = 0;
        let br = -1;
        for (let i = 0; i < this.bubCount; i++) {
          const r = this.br0[i];
          if (r > br) {
            br = r;
            bi = i;
          }
        }
        if (br > 0.12) {
          const j = this.bubCount < this.poolSize ? this.bubCount++ : ((Math.random() * this.bubCount) | 0);
          const a = Math.random() * Math.PI * 2;
          const rr = br * 0.62;
          this.br0[bi] = rr;
          this.br0[j] = rr;
          this.bx[j] = this.bx[bi] + Math.cos(a) * rr * 1.05;
          this.by[j] = this.by[bi] + Math.sin(a) * rr * 1.05;
          this.bvx[bi] += -Math.cos(a) * 0.22;
          this.bvy[bi] += -Math.sin(a) * 0.22;
          this.bvx[j] = Math.cos(a) * 0.22;
          this.bvy[j] = Math.sin(a) * 0.22;
          this.br[j] = rr;
          this.bPhase[j] = this.t * 0.21 + j * 0.07;
          this.mat.uniforms.uCount.value = this.bubCount;
        }
      }
    }

    const w = (0.004 + 0.020 * wet) * (0.35 + 0.65 * Math.max(bp, k));
    const wobT = this.t * (0.75 + control.rightY * 1.8);

    for (let i = 0; i < this.bubCount; i++) {
      const px = this.bx[i];
      const py = this.by[i];

      const ph = this.bPhase[i] + i * 0.08;
      const fx = Math.sin(wobT * 0.85 + ph) * drive;
      const fy = Math.cos(wobT * 0.92 + ph * 1.13) * drive;

      let vx = this.bvx[i] * damp + fx;
      let vy = this.bvy[i] * damp + fy;

      vx += (-px) * (0.0015 + 0.0045 * build) * dt;
      vy += (-py) * (0.0015 + 0.0045 * build) * dt;

      this.bx[i] = px + vx;
      this.by[i] = py + vy;
      this.bvx[i] = vx;
      this.bvy[i] = vy;

      const rr = this.br0[i];
      this.br[i] = rr * (1.0 + w * Math.sin(wobT + ph));
    }

    const repel = (0.002 + 0.010 * wet) * (0.15 + 0.85 * (k + bp) * 0.5);
    for (let i = 0; i < this.bubCount; i++) {
      const xi = this.bx[i];
      const yi = this.by[i];
      const ri = this.br[i];
      for (let j = i + 1; j < this.bubCount; j++) {
        const dx = this.bx[j] - xi;
        const dy = this.by[j] - yi;
        const d2 = dx * dx + dy * dy + 1e-6;
        const minD = (ri + this.br[j]) * (0.62 + 0.25 * build);
        const minD2 = minD * minD;
        if (d2 < minD2) {
          const d = Math.sqrt(d2);
          const push = ((minD - d) / minD) * repel;
          const nx = dx / d;
          const ny = dy / d;
          this.bx[i] -= nx * push;
          this.by[i] -= ny * push;
          this.bx[j] += nx * push;
          this.by[j] += ny * push;

          if (!this.safeMode && build > 0.60 && beatEdge && d < (ri + this.br[j]) * 0.42 && Math.random() < 0.18) {
            const keep = ri >= this.br[j] ? i : j;
            const kill = keep === i ? j : i;
            const a = Math.min(0.38, Math.max(this.br0[keep], this.br0[kill]) * 1.08);
            this.br0[keep] = a;
            this.br0[kill] = 0;
            this.br[kill] = 0;
            this.bx[kill] = (Math.random() * 2 - 1) * 1.4;
            this.by[kill] = (Math.random() * 2 - 1) * 0.95;
            this.bvx[kill] = (Math.random() * 2 - 1) * 0.12;
            this.bvy[kill] = (Math.random() * 2 - 1) * 0.12;
          }
        }
      }
    }

    for (let i = 0; i < this.bubCount; i++) {
      const rr = Math.max(0.0, this.br[i]);
      const limX = 1.45;
      const limY = 0.95;
      let x = this.bx[i];
      let y = this.by[i];
      if (x < -limX) {
        x = -limX;
        this.bvx[i] *= -0.55;
      }
      if (x > limX) {
        x = limX;
        this.bvx[i] *= -0.55;
      }
      if (y < -limY) {
        y = -limY;
        this.bvy[i] *= -0.55;
      }
      if (y > limY) {
        y = limY;
        this.bvy[i] *= -0.55;
      }
      this.bx[i] = x;
      this.by[i] = y;

      const v = arr[i] as any;
      v.x = x;
      v.y = y;
      v.z = rr;
      v.w = this.bPhase[i];
    }

    for (let i = this.bubCount; i < 256; i++) {
      const v = arr[i] as any;
      v.z = 0;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
