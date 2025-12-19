import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export class LogPolarLatticeScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;
  private t = 0;

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
        uRes: { value: new THREE.Vector2(1, 1) },
        uSpeed: { value: 1.0 },
        uDrive: { value: 0.0 }
      },
      vertexShader: `
        void main(){
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;

        uniform float uTime;
        uniform vec2 uRes;
        uniform float uSpeed;
        uniform float uDrive;

        float seg(in vec2 p, in vec2 a, in vec2 b) {
          vec2 pa = p-a, ba = b-a;
          float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
          return length(pa - ba*h);
        }

        void main(){
          vec2 fragCoord = gl_FragCoord.xy;
          vec2 uv = (fragCoord - 0.5 * uRes.xy) / uRes.y;

          float iTime = uTime * (0.55 + 1.35 * uSpeed);

          float a = atan(uv.y, uv.x);
          vec2 p = cos(a + iTime) * vec2(cos(0.5 * iTime), sin(0.3 * iTime));
          vec2 q = (cos(iTime)) * vec2(cos(iTime), sin(iTime));

          float d1 = length(uv - p);
          float d2 = length(uv);

          vec2 uv2 = 2.0 * cos(log(max(1e-4, length(uv))) * 0.25 - 0.5 * iTime + log(vec2(d1,d2) / max(1e-4, (d1 + d2))));

          vec2 fpos = fract(4.0 * uv2) - 0.5;
          float d = max(abs(fpos.x), abs(fpos.y));
          float k = 5.0 / uRes.y;
          float s = smoothstep(-k, k, 0.25 - d);

          vec3 col = vec3(s, 0.5 * s, 0.1 - 0.1 * s);
          col += 1.0 / cosh(-2.5 * (length(uv - p) + length(uv))) * vec3(1.0, 0.5, 0.1);

          float c = cos(10.0 * length(uv2) + 4.0 * iTime);
          col += (0.5 + 0.5 * c) * vec3(0.5, 1.0, 1.0) *
            exp(-9.0 * abs(cos(9.0 * a + iTime) * uv.x + sin(9.0 * a + iTime) * uv.y + 0.1 * c));

          // Mild drive-based gain so it can react to controls.
          col *= 0.85 + 0.55 * uDrive;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);
  }

  onResize(camera: any) {
    const cam: any = camera as any;

    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.mat.uniforms.uRes.value.set(w, h);

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
  }

  update(control: ControlState) {
    this.t += control.dt;

    const bp = clamp01(control.beatPulse ?? 0);
    const speed = lerp(0.55, 2.1, clamp01(control.rightY + 0.25 * bp));
    const drive = clamp01(control.build + 0.65 * bp);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uSpeed.value = speed;
    this.mat.uniforms.uDrive.value = drive;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
