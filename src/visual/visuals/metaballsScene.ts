import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export class MetaballsScene {
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
        uX: { value: 0.5 },
        uY: { value: 0.5 },
        uAspect: { value: 1.0 },
        uCount: { value: 6.0 },
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
        uniform float uX;
        uniform float uY;
        uniform float uAspect;
        uniform float uCount;
        uniform float uQuality;

        float hash11(float p){
          p = fract(p * 0.1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

        vec3 palette(float t){
          vec3 a = vec3(0.06, 0.08, 0.12);
          vec3 b = vec3(0.28, 0.30, 0.55);
          vec3 c = vec3(0.80, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        float field(vec2 p){
          float t = uTime;
          float beat = clamp(uBeat, 0.0, 1.0);
          float nCount = floor(uCount + 0.5);
          float f = 0.0;

          for(int i=0;i<10;i++){
            if(float(i) >= nCount) break;
            float fi = float(i);
            float a = t * (0.25 + 0.10 * fi) + hash11(fi) * 6.28318;
            float r = mix(0.15, 0.52, hash11(fi + 10.0));
            vec2 c = vec2(cos(a), sin(a)) * r;
            c.x *= 1.05;

            float rad = mix(0.10, 0.18, hash11(fi + 20.0));
            rad *= 1.0 + 0.55 * beat;

            vec2 d = p - c;
            float d2 = dot(d, d) + 1e-4;
            f += (rad * rad) / d2;
          }
          return f;
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          float beat = clamp(uBeat, 0.0, 1.0);
          float build = clamp(uBuild, 0.0, 1.0);
          float wet = clamp(uWet, 0.0, 1.0);

          float zoom = mix(0.85, 2.10, clamp(uX, 0.0, 1.0));
          p *= zoom;

          float f = field(p);

          float thresh = mix(1.05, 1.55, clamp(0.25 + wet * 0.65 + build * 0.25, 0.0, 1.0));
          thresh += 0.25 * beat;

          float edge = 0.07 + 0.10 * wet;
          float ink = smoothstep(thresh - edge, thresh + edge, f);

          float rim = smoothstep(thresh - edge * 2.2, thresh, f) - smoothstep(thresh, thresh + edge * 2.2, f);
          rim = clamp(rim * (1.5 + 1.5 * wet), 0.0, 1.0);

          float hue = fract(0.56 + 0.18 * wet + 0.10 * build + 0.08 * sin(uTime * 0.12) + 0.12 * beat);
          vec3 c = palette(hue + 0.10 * f);

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 col = mix(bg, c, ink);

          float glow = (0.08 + 0.35 * wet) * (0.35 + 0.65 * beat);
          col += c * glow * rim;

          float vign = smoothstep(1.35, 0.30, length(uv * 2.0 - 1.0));
          col *= vign;

          float scan = 0.90 + 0.10 * sin((uv.y * 950.0) + uTime * 40.0);
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
    this.mat.uniforms.uCount.value = on ? 5.0 : 7.0;
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

    const count = lerp(this.safeMode ? 4.0 : 5.0, this.safeMode ? 6.0 : 8.0, clamp01(0.15 + build * 0.85));

    this.mat.uniforms.uTime.value = this.t * (0.45 + 1.55 * (0.15 + clamp01(control.rightY)));
    this.mat.uniforms.uBeat.value = bp;
    this.mat.uniforms.uBuild.value = build;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uX.value = clamp01(control.rightX);
    this.mat.uniforms.uY.value = clamp01(control.rightY);
    this.mat.uniforms.uCount.value = count + bp * 0.35;

    const q = this.safeMode ? 0.65 : 1.0;
    this.mat.uniforms.uQuality.value = lerp(q, 1.0, clamp01(build * 0.5 + bp * 0.5));
  }

  dispose() {
    this.mat.dispose();
    (this.mesh?.geometry as any)?.dispose?.();
  }
}
