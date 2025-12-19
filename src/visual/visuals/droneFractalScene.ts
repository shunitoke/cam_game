import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

export class DroneFractalScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;
  private t = 0;
  private safeMode = false;

  private gestureLatched = false;
  private gestureAnchor = new THREE.Vector2(0.5, 0.5);
  private gestureOffset = new THREE.Vector2(0.0, 0.0);

  private baseW = 4.2;
  private baseH = 2.4;

  constructor() {
    this.scene.background = new THREE.Color(0x000000);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: 1.0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uMouse: { value: new THREE.Vector3(0, 0, 0) },
        uIters: { value: 20.0 },
        uBuild: { value: 0.0 }
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
        uniform vec2 uRes;
        uniform vec3 uMouse;
        uniform float uIters;
        uniform float uBuild;

        float clamp01(float v){ return clamp(v, 0.0, 1.0); }

        void main(){
          vec2 fragCoord = vUv * uRes;
          vec2 iResolution = uRes;
          vec3 iMouse = uMouse;

          // Pinch should NOT zoom the camera; use it to push the shader harder.
          float pinch = clamp01(iMouse.z);
          float scale = 1.0;
          vec2 look = (iMouse.xy / iResolution.xy - 0.5) * (0.65 + 0.55 * pinch);

          float time = (uTime * (2.0 + 1.5 * uBuild)) + 15.0;
          vec2 res = iResolution.xy;
          vec2 uv = fragCoord.xy / res - vec2(0.5) + look;
          uv *= vec2(res.x / res.y, 1.0) * 4.0 * scale;

          float len = dot(uv, uv) * (0.22 + 0.38 * pinch) - 0.4;

          vec3 z = sin(time * vec3(0.23, 0.19, 0.17));

          float iters = clamp(uIters + 6.0 * pinch, 4.0, 20.0);
          for (int i = 0; i < 20; i++) {
            if (float(i) >= iters) break;
            z += cos(z.zxy + uv.yxy * float(i) * len * (0.85 + 0.35 * pinch));
          }

          float val = z.r * 0.06 + 0.3;
          val -= smoothstep(0.1, -0.3, len) * 1.5 + len * 0.3 - 0.4;
          val += pinch * 0.10;

          float v = max(val, 0.1);

          // Slight doom-contrast driven by build.
          v = pow(v, 1.0 + 0.8 * uBuild);

          gl_FragColor = vec4(vec3(v), 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.mat.uniforms.uIters.value = on ? 12.0 : 20.0;
  }

  onResize(camera: any) {
    const cam: any = camera as any;
    const dist = Math.abs((cam.position?.z ?? 2.2) - (this.mesh?.position?.z ?? -0.4));
    const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
    const height = 2 * dist * Math.tan(vFov * 0.5);
    const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
    this.mesh.scale.set(width / this.baseW, height / this.baseH, 1);

    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.mat.uniforms.uRes.value.set(w, h);
    this.mat.uniforms.uAspect.value = cam.aspect ?? window.innerWidth / window.innerHeight;
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.gestureLatched = false;
    this.gestureAnchor.set(0.5, 0.5);
    this.gestureOffset.set(0, 0);
  }

  update(control: ControlState) {
    this.t += control.dt;

    const mx = clamp01(control.rightX);
    const my = clamp01(control.rightY);
    const md = clamp01(control.rightPinch);

    // While pinching, treat hand motion as relative to a captured center,
    // so the fractal stays centered and doesn't drift due to absolute mapping.
    const pinchOn = md > 0.25;
    if (pinchOn && !this.gestureLatched) {
      this.gestureLatched = true;
      this.gestureAnchor.set(mx, my);
    } else if (!pinchOn) {
      this.gestureLatched = false;
    }

    const dt = control.dt;
    const follow = pinchOn ? 10.0 : 3.0;
    const k = 1.0 - Math.exp(-follow * dt);

    // Desired offset: during pinch, pan relative to the anchor; otherwise recenter.
    const dx = pinchOn ? (mx - this.gestureAnchor.x) : 0.0;
    const dy = pinchOn ? (my - this.gestureAnchor.y) : 0.0;
    this.gestureOffset.x += (dx - this.gestureOffset.x) * k;
    this.gestureOffset.y += (dy - this.gestureOffset.y) * k;

    // Recenter around mid screen + offset.
    const cx = 0.5 + this.gestureOffset.x;
    const cy = 0.5 + this.gestureOffset.y;

    const w = this.mat.uniforms.uRes.value.x as number;
    const h = this.mat.uniforms.uRes.value.y as number;

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uMouse.value.set(clamp01(cx) * w, clamp01(cy) * h, md);
    this.mat.uniforms.uBuild.value = clamp01(control.build);

    if (!this.safeMode) {
      // Right speed can bias iterations a bit (more detail/alias).
      const it = 12.0 + 8.0 * clamp01(control.rightSpeed);
      this.mat.uniforms.uIters.value = it;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
