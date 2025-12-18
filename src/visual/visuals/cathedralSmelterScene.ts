import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

type VizPack = {
  fft?: Float32Array;
  kick?: Float32Array;
};

function fftBand(fft: Float32Array | undefined, from: number, to: number) {
  if (!fft || !fft.length) return 0;
  const n = fft.length;
  const a = Math.max(0, Math.min(n - 1, from));
  const b = Math.max(a, Math.min(n - 1, to));
  let sum = 0;
  let c = 0;
  for (let i = a; i <= b; i++) {
    // getFloatFrequencyData is in dB. Map [-120..0] -> [0..1]
    const db = fft[i] ?? -120;
    const x = clamp01((db + 120) / 120);
    sum += x;
    c++;
  }
  return c ? sum / c : 0;
}

export class CathedralSmelterScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;
  private t = 0;
  private safeMode = false;
  private burst = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x040305);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: 1.0 },
        uSteps: { value: 72.0 },
        uBass: { value: 0.0 },
        uTreble: { value: 0.0 },
        uBuild: { value: 0.0 },
        uLPinch: { value: 0.0 },
        uRPinch: { value: 0.0 },
        uTwist: { value: 0.2 },
        uDepth: { value: 0.7 },
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

        uniform float uTime;
        uniform float uAspect;
        uniform float uSteps;
        uniform float uBass;
        uniform float uTreble;
        uniform float uBuild;
        uniform float uLPinch;
        uniform float uRPinch;
        uniform float uTwist;
        uniform float uDepth;
        uniform float uKick;

        float hash11(float p) {
          p = fract(p * 0.1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

        vec2 rot2(vec2 p, float a) {
          float c = cos(a), s = sin(a);
          return mat2(c, -s, s, c) * p;
        }

        float sdBox(vec3 p, vec3 b) {
          vec3 q = abs(p) - b;
          return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
        }

        float sdCyl(vec3 p, float r) {
          return length(p.xz) - r;
        }

        float map(vec3 p) {
          float t = uTime;

          // Bass makes the whole cathedral breathe.
          float breathe = 0.10 + 0.35 * uBass + 0.25 * uLPinch;

          // Domain warp (guitar adds twist/heat)
          float twist = (0.10 + 1.25 * uTwist) * (0.25 + 0.75 * (uTreble + uRPinch));
          p.xy = rot2(p.xy, twist * (0.15 * sin(t * 0.25) + 0.05 * sin(t * 0.7)));

          float warp = 0.20 * sin(p.z * 0.55 + t * 0.35) + 0.12 * sin(p.x * 1.7 + t * 0.25);
          p.x += warp * (0.35 + 0.55 * uBuild);

          // Main cavern tube
          float cavern = length(p.xy) - (0.75 + 0.20 * sin(p.z * 0.55 + t * 0.2) - breathe * 0.25);

          // Hanging monoliths (slabs)
          float cell = floor(p.z * 0.5);
          float rnd = hash11(cell * 0.17 + 2.1);
          vec3 q = p;
          q.xy = rot2(q.xy, rnd * 6.28318);
          q.y += 0.25 + 0.25 * sin(cell + t * 0.15);
          float slab = sdBox(q, vec3(0.16 + 0.18 * rnd, 0.55 + 0.25 * (1.0 - rnd), 0.22));

          // Columns
          vec3 c = p;
          c.x = abs(c.x) - 0.62;
          float col = sdCyl(c, 0.10 + 0.05 * rnd);

          float d = min(cavern, slab);
          d = min(d, col);
          return d;
        }

        vec3 normalAt(vec3 p) {
          float e = 0.002;
          float nx = map(p + vec3(e, 0.0, 0.0)) - map(p - vec3(e, 0.0, 0.0));
          float ny = map(p + vec3(0.0, e, 0.0)) - map(p - vec3(0.0, e, 0.0));
          float nz = map(p + vec3(0.0, 0.0, e)) - map(p - vec3(0.0, 0.0, e));
          return normalize(vec3(nx, ny, nz));
        }

        float veins(vec3 p) {
          // Molten veins: driven by treble (guitar) and build.
          float t = uTime;
          float v = 0.0;
          v += sin(p.x * 6.0 + t * 0.35);
          v += sin(p.y * 7.5 - t * 0.28);
          v += sin(p.z * 4.5 + t * 0.22);
          v = abs(v) / 3.0;
          float m = smoothstep(0.70, 0.98, v);
          m *= (0.15 + 1.15 * (uTreble + uRPinch));
          m *= (0.35 + 0.65 * uBuild);
          return clamp(m, 0.0, 1.0);
        }

        vec3 shade(vec3 ro, vec3 rd) {
          float t = 0.0;
          float hit = 0.0;
          float maxT = 10.0;
          float steps = clamp(uSteps, 24.0, 96.0);

          for (int i = 0; i < 96; i++) {
            if (float(i) >= steps) break;
            vec3 p = ro + rd * t;
            float d = map(p);
            if (d < 0.0017) { hit = 1.0; break; }
            t += d * 0.82;
            if (t > maxT) break;
          }

          vec3 bg = vec3(0.015, 0.012, 0.02);
          if (hit < 0.5) {
            float fog = exp(-0.16 * t);
            return bg * fog;
          }

          vec3 p = ro + rd * t;
          vec3 n = normalAt(p);

          vec3 ldir = normalize(vec3(-0.25, 0.55, -0.45));
          float diff = clamp(dot(n, ldir), 0.0, 1.0);
          float rim = pow(clamp(1.0 - dot(n, -rd), 0.0, 1.0), 2.2);

          // Base stone/metal
          vec3 base = vec3(0.07, 0.055, 0.075);
          base = mix(base, vec3(0.09, 0.07, 0.06), 0.35 + 0.45 * uBass);

          // Molten color
          float m = veins(p);
          vec3 molten = mix(vec3(0.6, 0.08, 0.02), vec3(1.0, 0.42, 0.08), 0.35 + 0.65 * m);

          float glow = m * (0.25 + 1.20 * uTreble) + 0.18 * uKick;

          vec3 col = base * (0.08 + 0.85 * diff) + base * rim * (0.15 + 0.85 * uBass);
          col += molten * glow;

          // Fog (bass makes it denser)
          float fog = exp(-(0.14 + 0.22 * uBass + 0.12 * uLPinch) * t);
          col = mix(bg, col, fog);

          // Vignette + doom crush
          float vig = smoothstep(1.35, 0.25, length(vUv * 2.0 - 1.0));
          col *= vig;

          // Slight red shift when guitar is hot
          col.r += 0.04 * (uTreble + uRPinch);

          return col;
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          float t = uTime;

          // Camera: slow push through the smelter.
          float z = -2.8;
          float drift = 0.08 * sin(t * 0.18) + 0.06 * sin(t * 0.43);
          vec3 ro = vec3(0.0 + drift, 0.0, z);
          ro.z += t * (0.22 + 0.55 * uDepth);

          // Bass shake (subtle)
          ro.xy += 0.06 * uBass * vec2(sin(t * 2.0), cos(t * 1.7));

          vec3 rd = normalize(vec3(p, 1.65));
          rd.xy = rot2(rd.xy, (uTwist * 0.55) * sin(t * 0.06));

          vec3 col = shade(ro, rd);

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.mat.uniforms.uSteps.value = on ? 50.0 : 78.0;
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

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.burst = 0;
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  update(control: ControlState) {
    this.t += control.dt;

    this.burst = Math.max(0, this.burst - control.dt * 2.4);

    const pack = (control.audioViz ?? {}) as VizPack;
    const fft = pack.fft;

    const bass = fftBand(fft, 0, 18);
    const treble = fftBand(fft, 64, 160);

    const bp = clamp01(control.beatPulse ?? 0);
    const kickish = clamp01(bp * 0.75 + this.burst * 0.8);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uBass.value = clamp01(bass * 1.35);
    this.mat.uniforms.uTreble.value = clamp01(treble * 1.25);
    this.mat.uniforms.uBuild.value = clamp01(control.build);
    this.mat.uniforms.uLPinch.value = clamp01(control.leftPinch);
    this.mat.uniforms.uRPinch.value = clamp01(control.rightPinch);
    this.mat.uniforms.uKick.value = kickish;

    if (!this.safeMode) {
      this.mat.uniforms.uTwist.value = 0.05 + 0.95 * clamp01(control.rightX);
      this.mat.uniforms.uDepth.value = 0.35 + 0.65 * clamp01(control.leftY);
      this.mat.uniforms.uSteps.value = 62.0 + 24.0 * clamp01(control.rightSpeed);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
