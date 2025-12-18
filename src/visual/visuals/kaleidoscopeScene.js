import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
export class KaleidoscopeScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
    baseW = 4.2;
    baseH = 2.4;
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
                uSeg: { value: 7.0 },
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
        uniform float uSeg;
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
          for(int i=0;i<6;i++){
            if(float(i) > 5.0 * uQuality) break;
            v += a * noise(p);
            p = m * p;
            a *= 0.55;
          }
          return v;
        }

        vec3 palette(float t){
          vec3 a = vec3(0.08, 0.08, 0.12);
          vec3 b = vec3(0.35, 0.30, 0.55);
          vec3 c = vec3(0.80, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        vec2 kalei(vec2 p, float n){
          float a = atan(p.y, p.x);
          float r = length(p);
          float tau = 6.28318530718;
          float seg = tau / max(1.0, n);
          a = mod(a, seg);
          a = abs(a - seg * 0.5);
          return vec2(cos(a), sin(a)) * r;
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          float beat = clamp(uBeat, 0.0, 1.0);
          float build = clamp(uBuild, 0.0, 1.0);
          float wet = clamp(uWet, 0.0, 1.0);

          float seg = max(3.0, floor(uSeg + 0.5));

          float t = uTime * (0.25 + 1.35 * (0.15 + uY));

          float zoom = mix(0.85, 2.35, clamp(uX, 0.0, 1.0));
          vec2 q = kalei(p * zoom, seg);

          float twist = (wet * 0.85 + build * 0.35) * (0.35 + 0.65 * beat);
          float ang = twist * (0.4 + 0.6 * length(q)) + 0.15 * sin(t * 0.25);
          mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
          q = rot * q;

          vec2 w = vec2(
            fbm(q * 1.35 + vec2(t * 0.07, -t * 0.05)),
            fbm(q * 1.35 + vec2(-t * 0.06, t * 0.08))
          );
          q += (w - 0.5) * (0.25 + 1.35 * wet) * (0.55 + 0.45 * beat);

          float f = fbm(q * 2.0 + vec2(0.0, t * 0.12));
          float g = fbm(q * 3.5 + vec2(4.2, -t * 0.08));

          float rings = sin((f * 6.0 + g * 2.5) * 6.28318);
          rings = smoothstep(0.15, 0.95, 0.5 + 0.5 * rings);

          float lines = abs(fract((atan(q.y, q.x) / 6.28318) * seg * 2.0) - 0.5);
          lines = smoothstep(0.48, 0.25, lines);

          float ink = clamp(rings * (0.55 + 0.45 * lines), 0.0, 1.0);
          float hue = fract(0.62 + 0.20 * wet + 0.10 * build + 0.10 * beat + 0.05 * sin(t * 0.12));
          vec3 col = palette(hue + 0.30 * f);

          vec3 bg = vec3(0.02, 0.025, 0.04);
          col = mix(bg, col, ink);

          float glow = (0.08 + 0.35 * wet) * (0.25 + 0.75 * beat);
          col += col * glow * (0.25 + 0.75 * lines);

          float vign = smoothstep(1.35, 0.30, length(uv * 2.0 - 1.0));
          col *= vign;

          float scan = 0.90 + 0.10 * sin((uv.y * 1000.0) + uTime * 40.0);
          col *= mix(1.0, scan, 0.50 + 0.25 * wet);

          gl_FragColor = vec4(col, 1.0);
        }
      `
        });
        this.mesh = new THREE.Mesh(g, this.mat);
        this.mesh.position.z = -0.4;
        this.scene.add(this.mesh);
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.mat.uniforms.uQuality.value = on ? 0.65 : 1.0;
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
    }
    update(control) {
        this.t += control.dt;
        const bp = clamp01(control.beatPulse ?? 0);
        const build = clamp01(control.build);
        const wet = clamp01(control.rightPinch);
        const seg = lerp(4, this.safeMode ? 9 : 13, clamp01(0.15 + build * 0.85));
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uBeat.value = bp;
        this.mat.uniforms.uBuild.value = build;
        this.mat.uniforms.uWet.value = wet;
        this.mat.uniforms.uX.value = clamp01(control.rightX);
        this.mat.uniforms.uY.value = clamp01(control.rightY);
        this.mat.uniforms.uSeg.value = seg + bp * 0.5;
        const q = this.safeMode ? 0.65 : 1.0;
        this.mat.uniforms.uQuality.value = lerp(q, 1.0, clamp01(build * 0.5 + bp * 0.5));
    }
    dispose() {
        this.mat.dispose();
        this.mesh?.geometry?.dispose?.();
    }
}
