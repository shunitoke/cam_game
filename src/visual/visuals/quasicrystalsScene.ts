import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

type VizPack = {
  fft?: Float32Array;
  kick?: Float32Array;
};

export class QuasicrystalsScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;
  private t = 0;
  private safeMode = false;

  private burst = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0.5 },
        uWet: { value: 0.0 },
        uBuild: { value: 0.0 },
        uKick: { value: 0.0 },
        uSpectrum: { value: 0.0 },
        uAspect: { value: 1.0 },
        uComplexity: { value: 8.0 }
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
        uniform float uEnergy;
        uniform float uWet;
        uniform float uBuild;
        uniform float uKick;
        uniform float uSpectrum;
        uniform float uAspect;
        uniform float uComplexity;

        vec3 palette(float t) {
          vec3 a = vec3(0.12, 0.14, 0.20);
          vec3 b = vec3(0.35, 0.30, 0.48);
          vec3 c = vec3(0.75, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          p.x *= uAspect;

          float k = clamp(uKick, 0.0, 1.0);
          float t = uTime * (0.18 + 0.65 * uEnergy + 0.35 * uBuild);

          float zoom = 1.35 + 1.85 * uWet + 0.95 * uBuild;
          p *= zoom;

          float warp = (0.10 + 0.55 * uWet + 0.35 * uBuild) * (0.45 + 0.55 * k);
          p += warp * vec2(
            sin(t * 1.1 + p.y * 1.6),
            cos(t * 0.9 - p.x * 1.4)
          );

          float n = floor(uComplexity + 0.5);
          float sum = 0.0;
          float wsum = 0.0;

          float phase = t * (0.85 + 1.75 * uWet + 0.65 * uSpectrum);
          for (int i = 0; i < 12; i++) {
            float fi = float(i);
            float on = step(fi, n - 1.0);
            float a = fi * (3.14159265 / n) * 2.0 + 0.35 * sin(phase * 0.25);
            vec2 d = vec2(cos(a), sin(a));
            float f = 2.2 + fi * (0.55 + 0.25 * uBuild);
            float w = 1.0 / (1.0 + fi * 0.35);
            float v = cos(dot(p, d) * f + phase + fi * 0.65);
            sum += on * v * w;
            wsum += on * w;
          }

          float v = sum / max(1e-5, wsum);
          v = 0.5 + 0.5 * v;

          float sharp = 1.1 + 3.5 * uWet + 1.4 * k;
          float ink = smoothstep(0.42 - 0.18 * uBuild, 0.42 + 0.18 * uBuild, v);
          ink = pow(ink, sharp);

          float hueT = fract(0.55 + 0.08 * uSpectrum + 0.20 * uWet + 0.22 * uBuild + 0.05 * sin(t * 0.15));
          vec3 col = palette(hueT + v * (0.55 + 0.35 * uWet));

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 outCol = mix(bg, col, ink);

          float pulse = 0.15 + 0.85 * k;
          outCol *= 0.85 + 0.35 * pulse;

          float vign = smoothstep(1.30, 0.20, length(vUv * 2.0 - 1.0));
          outCol *= vign;

          gl_FragColor = vec4(outCol, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.mat.uniforms.uComplexity.value = on ? 7.0 : 10.0;
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

    this.burst = Math.max(0, this.burst - control.dt * 2.8);

    const bp = clamp01(control.beatPulse ?? 0);

    const pack = (control.audioViz ?? {}) as VizPack;
    const fft = pack.fft;
    const kick = pack.kick;

    let spec = 0;
    if (fft && fft.length) {
      const n = Math.min(fft.length, 96);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const db = fft[i];
        sum += clamp01((db + 120) / 120);
      }
      spec = Math.pow(sum / n, 1.8);
    }

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

    const burstKick = clamp01(kickEnv + this.burst + bp * 0.65);

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const wet = clamp01(control.rightPinch);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uBuild.value = clamp01(control.build);
    this.mat.uniforms.uKick.value = burstKick;
    this.mat.uniforms.uSpectrum.value = spec;

    if (!this.safeMode) {
      this.mat.uniforms.uComplexity.value = 7.0 + 5.0 * clamp01(control.rightY);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
