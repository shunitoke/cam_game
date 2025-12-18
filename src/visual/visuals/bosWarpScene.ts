import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export class BosWarpScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;

  private t = 0;
  private safeMode = false;

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
        uTime: { value: 0.0 },
        uBeat: { value: 0.0 },
        uBuild: { value: 0.0 },
        uWet: { value: 0.0 },
        uEnergy: { value: 0.0 },
        uX: { value: 0.5 },
        uY: { value: 0.5 },
        uAspect: { value: 1.0 },
        uQuality: { value: 1.0 }
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
        uniform float uBeat;
        uniform float uBuild;
        uniform float uWet;
        uniform float uEnergy;
        uniform float uX;
        uniform float uY;
        uniform float uAspect;
        uniform float uQuality;

        float hash12(vec2 p){
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float noise(vec2 p){
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash12(i);
          float b = hash12(i + vec2(1.0, 0.0));
          float c = hash12(i + vec2(0.0, 1.0));
          float d = hash12(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        float fbm(vec2 p){
          float v = 0.0;
          float a = 0.55;
          mat2 m = mat2(1.6, -1.2, 1.2, 1.6);
          for(int i=0;i<7;i++){
            if(float(i) > 6.0 * uQuality) break;
            v += a * noise(p);
            p = m * p;
            a *= 0.55;
          }
          return v;
        }

        vec3 palette(float t){
          vec3 a = vec3(0.06, 0.08, 0.12);
          vec3 b = vec3(0.42, 0.25, 0.55);
          vec3 c = vec3(0.85, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          float beat = clamp(uBeat, 0.0, 1.0);
          float build = clamp(uBuild, 0.0, 1.0);
          float wet = clamp(uWet, 0.0, 1.0);

          float speed = (0.08 + 0.55 * uY + 0.35 * build);
          float t = uTime * (0.55 + 1.35 * speed);

          float sc = mix(1.6, 6.5, clamp(uX, 0.0, 1.0));

          vec2 q = p * sc;

          float w = (0.25 + 1.15 * wet) * (0.55 + 0.45 * beat);
          vec2 warp = vec2(
            fbm(q + vec2(0.0, t * 0.15)),
            fbm(q + vec2(5.2, -t * 0.13))
          );
          q += w * (warp - 0.5) * 1.55;

          float f = fbm(q + vec2(t * 0.08, -t * 0.06));
          float g = fbm(q * 1.35 + vec2(-t * 0.05, t * 0.04));

          float ridge = 1.0 - abs(2.0 * f - 1.0);
          ridge = pow(max(0.0, ridge), 2.0);

          float ink = smoothstep(0.35, 0.85, ridge + 0.25 * g);
          ink = mix(ink, 1.0 - ink, 0.15 * wet);

          float hue = fract(0.55 + 0.18 * wet + 0.12 * build + 0.08 * sin(t * 0.12) + 0.06 * beat);
          vec3 col = palette(hue + 0.25 * f);

          float glow = (0.12 + 0.38 * wet) * (0.35 + 0.65 * beat);
          vec3 bg = vec3(0.02, 0.025, 0.04);

          col = mix(bg, col, ink);
          col += col * glow * ridge;

          float vign = smoothstep(1.35, 0.35, length(uv * 2.0 - 1.0));
          col *= vign;

          float scan = 0.90 + 0.10 * sin((uv.y * 900.0) + uTime * 40.0);
          col *= mix(1.0, scan, 0.55 + 0.25 * wet);

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.mat.uniforms.uQuality.value = on ? 0.65 : 1.0;
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
  }

  update(control: ControlState) {
    this.t += control.dt;

    const bp = clamp01((control as any).beatPulse ?? 0);
    const build = clamp01(control.build);
    const wet = clamp01(control.rightPinch);
    const energy = clamp01((control.leftX + control.leftY) * 0.5 + build * 0.6);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uBeat.value = bp;
    this.mat.uniforms.uBuild.value = build;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uX.value = clamp01(control.rightX);
    this.mat.uniforms.uY.value = clamp01(control.rightY);

    const q = this.safeMode ? 0.65 : 1.0;
    this.mat.uniforms.uQuality.value = lerp(q, 1.0, clamp01(build * 0.5 + bp * 0.5));
  }

  dispose() {
    this.mat.dispose();
    (this.mesh?.geometry as any)?.dispose?.();
  }
}
