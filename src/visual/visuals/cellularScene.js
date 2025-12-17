import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class CellularScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
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
                uEnergy: { value: 0.5 },
                uWet: { value: 0.0 },
                uBuild: { value: 0.0 },
                uKick: { value: 0.0 },
                uAspect: { value: 1.0 },
                uScale: { value: 3.0 },
                uSharp: { value: 2.4 },
                uJitter: { value: 0.25 }
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
        uniform float uAspect;
        uniform float uScale;
        uniform float uSharp;
        uniform float uJitter;

        float hash21(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        vec2 hash22(vec2 p){
          float n = sin(dot(p, vec2(127.1, 311.7)));
          float m = sin(dot(p, vec2(269.5, 183.3)));
          return fract(vec2(n, m) * 43758.5453123);
        }

        vec3 palette(float t) {
          vec3 a = vec3(0.05, 0.06, 0.09);
          vec3 b = vec3(0.32, 0.22, 0.48);
          vec3 c = vec3(0.85, 0.65, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        vec2 rot(vec2 p, float a){
          float c = cos(a), s = sin(a);
          return mat2(c, -s, s, c) * p;
        }

        vec2 worley(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);

          float d1 = 1e9;
          float d2 = 1e9;

          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 g = vec2(float(x), float(y));
              vec2 o = hash22(i + g);
              o = (o - 0.5) * (0.35 + 0.65 * uJitter) + 0.5;
              vec2 r = g + o - f;
              float d = dot(r, r);
              if (d < d1) {
                d2 = d1;
                d1 = d;
              } else if (d < d2) {
                d2 = d;
              }
            }
          }

          return vec2(sqrt(d1), sqrt(d2));
        }

        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          p.x *= uAspect;

          float t = uTime * (0.12 + 0.55 * uEnergy + 0.35 * uBuild);
          p = rot(p, 0.15 * sin(t * 0.35) + 0.25 * uWet);

          float sc = uScale * (1.0 + 0.8 * uWet + 0.45 * uBuild);
          vec2 q = p * sc;

          vec2 d = worley(q + vec2(t * 0.15, -t * 0.10));

          float cell = d.x;
          float edge = d.y - d.x;

          float sharp = 1.5 + uSharp + 2.25 * uWet;
          float ink = exp(-sharp * cell);

          float lines = smoothstep(0.00, 0.11 + 0.06 * uWet, edge);
          lines = pow(lines, 1.2 + 2.4 * uWet);

          float k = clamp(uKick, 0.0, 1.0);
          float glow = 0.10 + 0.55 * k + 0.35 * uBuild;

          float hueT = fract(0.58 + 0.15 * uWet + 0.12 * uBuild + 0.05 * sin(t * 0.2));
          vec3 col = palette(hueT + ink * 0.45);

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 outCol = mix(bg, col, ink);

          vec3 lineCol = vec3(0.85, 0.75, 0.95);
          outCol += lineCol * (0.10 + 0.55 * glow) * (1.0 - lines);

          float vign = smoothstep(1.35, 0.25, length(p));
          outCol *= vign;

          gl_FragColor = vec4(outCol, 1.0);
        }
      `
        });
        this.mesh = new THREE.Mesh(geom, this.mat);
        this.mesh.position.z = -0.4;
        this.scene.add(this.mesh);
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.mat.uniforms.uScale.value = on ? 2.6 : 3.4;
        this.mat.uniforms.uJitter.value = on ? 0.22 : 0.30;
    }
    onResize(camera) {
        const cam = camera;
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
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 2.6);
        const bp = clamp01(control.beatPulse ?? 0);
        const pack = (control.audioViz ?? {});
        const kick = pack.kick;
        let kickEnv = 0;
        if (kick && kick.length) {
            const n = Math.min(kick.length, 128);
            let peak = 0;
            for (let i = 0; i < n; i += 4)
                peak = Math.max(peak, Math.abs(kick[i] ?? 0));
            kickEnv = clamp01(peak * 2.2);
        }
        const burstKick = clamp01(kickEnv + this.burst + bp * 0.65);
        const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uEnergy.value = energy;
        this.mat.uniforms.uWet.value = clamp01(control.rightPinch);
        this.mat.uniforms.uBuild.value = clamp01(control.build + bp * 0.18);
        this.mat.uniforms.uKick.value = burstKick;
        if (!this.safeMode) {
            this.mat.uniforms.uScale.value = 2.6 + 3.4 * clamp01(control.rightX);
            this.mat.uniforms.uSharp.value = 1.8 + 3.2 * clamp01(control.rightY + 0.35 * burstKick);
            this.mat.uniforms.uJitter.value = 0.12 + 0.65 * clamp01(control.rightSpeed);
        }
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
