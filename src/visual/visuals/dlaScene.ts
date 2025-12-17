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

type Walker = { x: number; y: number };

export class DlaScene {
  private scene = new THREE.Scene();

  private mesh: any;
  private mat: any;

  private safeMode = false;
  private t = 0;
  private burst = 0;

  private gridW = 240;
  private gridH = 140;
  private grid: Uint8Array = new Uint8Array(1);
  private tex: any;

  private walkers: Walker[] = [];

  private frontY = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.tex = new THREE.DataTexture(this.grid, 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTex: { value: this.tex },
        uTime: { value: 0 },
        uEnergy: { value: 0.5 },
        uBuild: { value: 0.0 },
        uKick: { value: 0.0 }
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
        uniform float uEnergy;
        uniform float uBuild;
        uniform float uKick;

        vec3 pal(float t){
          vec3 a = vec3(0.10, 0.08, 0.14);
          vec3 b = vec3(0.80, 0.60, 0.95);
          vec3 c = vec3(1.0, 1.0, 1.0);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 tuv = vec2(vUv.x, 1.0 - vUv.y);
          float v = texture2D(uTex, tuv).r;

          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float vign = smoothstep(1.4, 0.25, r);

          float a = pow(v, 0.50);
          float glow = smoothstep(0.015, 0.65, a) * (0.40 + 0.75 * (uEnergy + uKick));

          float hue = fract(0.55 + 0.08 * sin(uTime * 0.13) + 0.15 * uBuild);
          vec3 col = pal(fract(hue + a * 0.45));
          col = mix(vec3(0.02, 0.025, 0.04), col, glow);

          float scan = 0.93 + 0.07 * sin((vUv.y * 900.0) + uTime * 36.0);
          col *= scan;
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

  private setGridTexture(grid: Uint8Array, w: number, h: number) {
    if (this.tex) {
      this.tex.dispose();
    }

    const tex = new THREE.DataTexture(grid, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.tex = tex;

    this.mat.uniforms.uTex.value = this.tex;
  }

  onResize(camera: any) {
    const cam: any = camera as any;
    const dist = Math.abs((cam.position?.z ?? 2.2) - (this.mesh?.position?.z ?? -0.4));
    const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
    const height = 2 * dist * Math.tan(vFov * 0.5);
    const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
    this.mesh.scale.set(width / this.baseW, height / this.baseH, 1);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.reset();
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

    this.gridW = this.safeMode ? 170 : 240;
    this.gridH = this.safeMode ? 100 : 140;
    this.grid = new Uint8Array(this.gridW * this.gridH);

    // Seed: bottom row.
    for (let x = 0; x < this.gridW; x++) {
      this.grid[(this.gridH - 1) * this.gridW + x] = 255;
    }

    this.frontY = this.gridH - 1;

    // Extra seeds so the scene is immediately visible.
    for (let i = 0; i < (this.safeMode ? 10 : 18); i++) {
      const x = (Math.random() * this.gridW) | 0;
      const y = this.gridH - 2 - ((Math.random() * 10) | 0);
      this.grid[y * this.gridW + x] = 220 + ((Math.random() * 35) | 0);
    }

    this.setGridTexture(this.grid, this.gridW, this.gridH);

    this.walkers = [];
    const n = this.safeMode ? 70 : 140;
    for (let i = 0; i < n; i++) this.walkers.push(this.spawnWalker());
  }

  private spawnWalker(): Walker {
    const x = (Math.random() * this.gridW) | 0;
    const margin = this.safeMode ? 12 : 18;
    const y0 = Math.max(0, this.frontY - margin);
    const y = y0 + ((Math.random() * Math.min(this.gridH, margin)) | 0);
    return { x, y };
  }

  private idx(x: number, y: number) {
    return y * this.gridW + x;
  }

  private hasNeighbor(x: number, y: number, r: 1 | 2) {
    const w = this.gridW;
    const h = this.gridH;
    const gx = this.grid;

    const x0 = Math.max(0, x - r);
    const x1 = Math.min(w - 1, x + r);
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);

    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (xx === x && yy === y) continue;
        if (gx[yy * w + xx] > 0) return true;
      }
    }
    return false;
  }

  update(control: ControlState) {
    this.t += control.dt;
    this.burst = Math.max(0, this.burst - control.dt * 2.6);

    const pack = (control.audioViz ?? {}) as VizPack;
    const kick = pack.kick;

    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) peak = Math.max(peak, Math.abs(kick[i] ?? 0));
      kickEnv = clamp01(peak * 2.2);
    }

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const build = clamp01(control.build);
    const burstKick = clamp01(kickEnv + this.burst);

    // Growth speed: keep it stable on weak GPUs, but let it ramp up hard.
    const speed = clamp01(0.15 + energy * 0.55 + build * 0.55 + burstKick * 0.75);

    const biasDown = lerp(0.22, 0.44, clamp01(0.15 + build * 0.85 + burstKick * 0.55));
    const biasUp = lerp(0.16, 0.10, clamp01(build * 0.7 + burstKick * 0.5));
    const biasSide = (1.0 - (biasDown + biasUp)) * 0.5;

    const subSteps = Math.floor((this.safeMode ? 7 : 10) + lerp(0, this.safeMode ? 8 : 14, speed));
    const walkersToStep = Math.min(this.walkers.length, Math.floor((this.safeMode ? 45 : 90) + lerp(0, this.safeMode ? 35 : 85, speed)));

    const stickR: 1 | 2 = burstKick > 0.50 ? 2 : 1;

    const w = this.gridW;
    const h = this.gridH;

    // Extra passes are faster than increasing subSteps too much.
    const passes = 1 + Math.floor(lerp(0, this.safeMode ? 1 : 2, speed));

    let any = false;

    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < walkersToStep; i++) {
        const p = this.walkers[i]!;
        for (let k = 0; k < subSteps; k++) {
          const rr = Math.random();
          if (rr < biasUp) p.y -= 1;
          else if (rr < biasUp + biasDown) p.y += 1;
          else if (rr < biasUp + biasDown + biasSide) p.x -= 1;
          else p.x += 1;

          if (p.x < 0) p.x = w - 1;
          if (p.x >= w) p.x = 0;

          if (p.y < 0 || p.y >= h) {
            this.walkers[i] = this.spawnWalker();
            break;
          }

          if (this.hasNeighbor(p.x, p.y, stickR)) {
            const id = this.idx(p.x, p.y);
            if (this.grid[id] === 0) {
              const vv = 190 + ((Math.random() * 65) | 0);
              this.grid[id] = vv;
              if (p.y < this.frontY) this.frontY = p.y;
              any = true;
            }
            this.walkers[i] = this.spawnWalker();
            break;
          }
        }
      }
    }

    if (any) {
      this.tex.needsUpdate = true;
    }

    // very light fade (keeps it alive)
    if (!this.safeMode && (energy > 0.75 || burstKick > 0.8) && Math.random() < 0.05) {
      const n = 200 + ((energy + burstKick) * 300) | 0;
      for (let i = 0; i < n; i++) {
        const x = (Math.random() * w) | 0;
        const y = ((Math.random() * h) | 0) * 0.92;
        const yi = Math.min(h - 2, y | 0);
        const id = yi * w + x;
        const v = this.grid[id];
        if (v > 0) this.grid[id] = (v * 0.995) | 0;
      }
      this.tex.needsUpdate = true;
    }

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uBuild.value = build;
    this.mat.uniforms.uKick.value = burstKick;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
