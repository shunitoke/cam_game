import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

export class PlasmaScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;
  private t = 0;

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
        uWet: { value: 0 },
        uDrive: { value: 0 },
        uEnergy: { value: 0.5 },
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
        uniform float uTime;
        uniform float uWet;
        uniform float uDrive;
        uniform float uEnergy;
        uniform float uBuild;

        float hash11(float p) {
          p = fract(p * 0.1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

        float hash21(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise21(vec2 p){
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        vec3 palette(float t) {
          vec3 a = vec3(0.18, 0.20, 0.26);
          vec3 b = vec3(0.32, 0.26, 0.38);
          vec3 c = vec3(0.65, 0.55, 0.45);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= 1.35;

          float speed = 0.25 + 0.9 * uEnergy + 0.45 * uDrive;
          float t = uTime * speed;

          float sw = 0.8 + 2.2 * uWet + 1.2 * uBuild;

          float n1 = noise21(p * (1.75 * sw) + vec2(0.0, t * 0.25));
          float n2 = noise21(p * (3.50 * sw) + vec2(t * -0.22, 0.0));
          float n = 0.65 * n1 + 0.35 * n2;

          float bands = sin((p.y + n * 0.35) * (5.0 + 9.0 * uDrive) + t * 0.7);
          bands = 0.5 + 0.5 * bands;

          float grad = 0.55 + 0.45 * (p.y * 0.5 + 0.5);
          float v = mix(grad, bands, 0.35 + 0.45 * uWet);
          v = clamp(v + (n - 0.5) * (0.25 + 0.55 * uWet), 0.0, 1.0);

          float hueT = fract(0.55 + 0.18 * uWet + 0.08 * uDrive + 0.20 * uBuild + 0.05 * sin(t * 0.25));
          vec3 col = palette(hueT + v * (0.45 + 0.35 * uWet));

          float spark = step(0.985, fract(n2 + t * 0.15 + hash11(floor((p.x + 2.0) * 13.0))));
          col += spark * vec3(0.35, 0.55, 0.85) * (0.15 + 0.45 * uDrive);

          float vign = smoothstep(1.15, 0.25, length(p));
          col *= vign;

          float gain = 0.75 + 0.65 * uEnergy + 0.25 * uBuild;
          col *= gain;

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
    this.burst = 0;
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  update(control: ControlState) {
    this.t += control.dt;

    this.burst = Math.max(0, this.burst - control.dt * 3.0);

    const bp = clamp01(control.beatPulse ?? 0);

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7 + this.burst * 0.65 + bp * 0.55);
    const wet = clamp01(control.rightPinch);
    const drive = clamp01(control.rightSpeed + this.burst * 0.85 + bp * 0.45);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uDrive.value = drive;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uBuild.value = clamp01(control.build + bp * 0.18);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
