import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class DomainWarpScene {
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
                uOctaves: { value: 6.0 },
                uWarp: { value: 1.0 },
                uSpeed: { value: 1.0 }
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
        uniform float uOctaves;
        uniform float uWarp;
        uniform float uSpeed;

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

        float fbm(vec2 p, float oct){
          float v = 0.0;
          float a = 0.55;
          float f = 1.0;
          for (int i = 0; i < 9; i++) {
            if (float(i) >= oct) break;
            v += a * noise21(p * f);
            f *= 2.0;
            a *= 0.5;
          }
          return v;
        }

        vec3 palette(float t) {
          vec3 a = vec3(0.10, 0.12, 0.18);
          vec3 b = vec3(0.35, 0.30, 0.55);
          vec3 c = vec3(0.80, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          p.x *= uAspect;

          float k = clamp(uKick, 0.0, 1.0);
          float e = clamp(uEnergy, 0.0, 1.0);

          float sp = (0.10 + 0.85 * e + 0.45 * uBuild) * (0.7 + 0.6 * uSpeed);
          float t = uTime * sp;

          float oct = floor(clamp(uOctaves, 1.0, 9.0));

          float zoom = 1.25 + 1.9 * uWet + 0.7 * uBuild;
          vec2 q = p * zoom;

          float w = (0.45 + 1.65 * uWet + 0.55 * uBuild) * (0.7 + 0.6 * k) * uWarp;

          vec2 d1 = vec2(
            fbm(q + vec2(0.0, t * 0.35), oct),
            fbm(q + vec2(t * -0.28, 0.0), oct)
          );
          q += w * (d1 - 0.5);

          vec2 d2 = vec2(
            fbm(q * 1.6 + vec2(t * 0.18, t * -0.21), oct),
            fbm(q * 1.6 + vec2(t * -0.14, t * 0.16), oct)
          );
          q += (0.65 * w) * (d2 - 0.5);

          float v = fbm(q * (1.05 + 0.75 * uWet), oct);
          float ridges = abs(2.0 * v - 1.0);
          ridges = pow(ridges, 1.2 + 2.8 * uWet);

          float ink = smoothstep(0.18 - 0.06 * uBuild, 0.82 + 0.10 * uBuild, v);
          ink = mix(ink, 1.0 - ridges, 0.55 + 0.25 * uWet);

          float hueT = fract(0.55 + 0.20 * uWet + 0.16 * uBuild + 0.08 * k + 0.03 * sin(t * 0.15));
          vec3 col = palette(hueT + v * (0.55 + 0.35 * uWet));

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 outCol = mix(bg, col, ink);

          float gain = 0.75 + 0.55 * e + 0.20 * uBuild + 0.25 * k;
          outCol *= gain;

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
        this.mat.uniforms.uOctaves.value = on ? 5.0 : 7.0;
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
        this.burst = Math.max(0, this.burst - control.dt * 3.0);
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
        const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7 + 0.55 * burstKick);
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uEnergy.value = energy;
        this.mat.uniforms.uWet.value = clamp01(control.rightPinch);
        this.mat.uniforms.uBuild.value = clamp01(control.build);
        this.mat.uniforms.uKick.value = burstKick;
        const warp = clamp01(0.35 + 0.65 * clamp01(control.rightSpeed + 0.35 * burstKick + 0.20 * bp));
        this.mat.uniforms.uWarp.value = 0.65 + 1.35 * warp;
        const sp = clamp01(0.25 + 0.75 * clamp01(control.rightY));
        this.mat.uniforms.uSpeed.value = 0.65 + 1.35 * sp;
        if (!this.safeMode) {
            this.mat.uniforms.uOctaves.value = 6.0 + 2.0 * clamp01(control.rightX);
        }
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
