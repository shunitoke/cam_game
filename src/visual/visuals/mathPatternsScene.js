import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class MathPatternsScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    burst = 0;
    baseW = 4.2;
    baseH = 2.4;
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);
        this.mat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTime: { value: 0 },
                uA: { value: 2.0 },
                uB: { value: 3.0 },
                uC: { value: 5.0 },
                uWarp: { value: 0.25 },
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
        uniform float uA;
        uniform float uB;
        uniform float uC;
        uniform float uWarp;
        uniform float uBuild;

        float sat(float x){ return clamp(x, 0.0, 1.0); }

        void main(){
          vec2 uv = vUv * 2.0 - 1.0;
          uv.x *= 1.15;

          float t = uTime;

          // domain warp
          float w = uWarp;
          float r = length(uv);
          float a = atan(uv.y, uv.x);

          uv += w * vec2(
            sin(t * 0.9 + a * uA + r * uC),
            cos(t * 0.8 - a * uB + r * uC)
          );

          // Moire / lissajous interference
          float f1 = sin((uv.x * uA + uv.y * uB) * 6.283 + t * 1.2);
          float f2 = cos((uv.x * uB - uv.y * uC) * 6.283 - t * 1.1);
          float f3 = sin((r * (uC * 3.0 + 1.0) + a * (uA * 0.7 + 0.7)) * 3.0 + t * 0.7);

          float v = (f1 + f2 + 0.6 * f3) / 2.2;
          v = 0.5 + 0.5 * v;

          float lines = abs(fract(v * 22.0) - 0.5);
          lines = pow(lines, 0.25 + uBuild * 0.7);

          float hue = fract(0.58 + v * 0.25 + uBuild * 0.12);
          float satv = 0.65 + 0.3 * uBuild;
          float lum = 0.10 + 0.85 * sat(1.0 - lines);

          vec3 p = vec3(fract(hue + 0.0), fract(hue + 0.33), fract(hue + 0.66));
          vec3 col = clamp(abs(fract(p * 6.0 + 0.0) - 3.0) - 1.0, 0.0, 1.0);
          col = (col - 0.5) * satv + 0.5;
          col *= lum;

          float vign = smoothstep(1.35, 0.25, length(vUv * 2.0 - 1.0));
          col *= vign;

          gl_FragColor = vec4(col, 1.0);
        }
      `
        });
        this.mesh = new THREE.Mesh(geom, this.mat);
        this.mesh.position.z = -0.4;
        this.scene.add(this.mesh);
    }
    onResize(camera) {
        const cam = camera;
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
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 3.2);
        const build = clamp01(control.build + this.burst * 0.65);
        const a = 1.5 + control.leftX * 5.0;
        const b = 1.5 + control.leftY * 5.0;
        const c = 1.5 + control.rightX * 6.0;
        const warp = 0.05 + control.rightPinch * 0.55 + this.burst * 0.35;
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uA.value = a;
        this.mat.uniforms.uB.value = b;
        this.mat.uniforms.uC.value = c;
        this.mat.uniforms.uWarp.value = warp;
        this.mat.uniforms.uBuild.value = build;
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
