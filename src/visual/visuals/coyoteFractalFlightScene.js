import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class CoyoteFractalFlightScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
    baseW = 4.2;
    baseH = 2.4;
    constructor() {
        this.scene.background = new THREE.Color(0x020306);
        const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);
        this.mat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTime: { value: 0 },
                uRes: { value: new THREE.Vector2(1, 1) },
                uAspect: { value: 1.0 },
                uYaw: { value: 0.0 },
                uPitch: { value: 0.0 },
                uChaos: { value: 0.4 },
                uDetail: { value: 0.5 },
                uDrive: { value: 0.0 },
                uBurst: { value: 0.0 }
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
        uniform vec2 uRes;
        uniform float uAspect;
        uniform float uYaw;
        uniform float uPitch;
        uniform float uChaos;
        uniform float uDetail;
        uniform float uDrive;
        uniform float uBurst;

        mat3 getRotYMat(float a){
          return mat3(cos(a),0.,sin(a),0.,1.,0.,-sin(a),0.,cos(a));
        }

        mat3 getRotXMat(float a){
          return mat3(1.,0.,0.,0.,cos(a),-sin(a),0.,sin(a),cos(a));
        }

        float clamp01(float v){ return clamp(v, 0.0, 1.0); }

        void main(){
          vec2 fragCoord = vUv * uRes;
          vec2 s = uRes.xy;

          float t = uTime * (0.20 + 0.55 * uDrive + 0.25 * uBurst);

          vec2 uv = (2.0 * fragCoord.xy - s) / s.x;
          vec3 p = vec3(uv, 1.0);

          float yaw = (uYaw * 2.0 - 1.0) * (0.75 + 0.35 * uChaos);
          float pitch = (uPitch * 2.0 - 1.0) * (0.55 + 0.25 * uChaos);

          p *= getRotYMat(-t + yaw);
          p *= getRotXMat(pitch);

          vec3 r = p - p;
          vec3 q = r;

          q.zx += 10.0 + vec2(sin(t), cos(t)) * (2.0 + 4.0 * uChaos);

          float c = 0.0;
          float d = 0.0;
          float m = 1.0;

          float maxOuter = mix(1.0, 0.65, clamp01(uDetail));

          for (float i = 1.0; i > 0.0; i -= 0.01) {
            if (i < (1.0 - maxOuter)) break;
            c = 0.0;
            d = 0.0;
            m = 1.0;
            r = q;

            for (int j = 0; j < 3; j++) {
              r *= r;
              r *= r;
              r *= r;
              r *= r;
              r = mod(q * m + 1.0, 2.0) - 1.0;
              r = max(r, r.yzx);
              d = max(d, (0.29 - length(r) * 0.6) / m) * 0.8;
              m *= 1.1;
            }

            q += p * d;
            c = i;
            if (d < 1e-5) break;
          }

          float k = dot(r, r + 0.15);
          float cc = max(c, 0.03);

          vec3 col = vec3(1.0, k, k / cc) - 0.8;

          float glow = 0.65 + 0.75 * uBurst;
          col *= glow;

          float vign = smoothstep(1.35, 0.25, length(uv));
          col *= vign;

          col = pow(max(col, 0.0), vec3(0.85 + 0.6 * uDrive));

          gl_FragColor = vec4(col, 1.0);
        }
      `
        });
        this.mesh = new THREE.Mesh(geom, this.mat);
        this.mesh.position.z = -0.4;
        this.scene.add(this.mesh);
    }
    setSafeMode(on) {
        this.safeMode = on;
    }
    onResize(camera) {
        const cam = camera;
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
        this.mat.uniforms.uBurst.value = 0.0;
    }
    triggerBurst(amount) {
        const a = clamp01(amount);
        this.mat.uniforms.uBurst.value = Math.max(this.mat.uniforms.uBurst.value, a);
    }
    update(control) {
        this.t += control.dt;
        const bp = clamp01(control.beatPulse ?? 0);
        const burst = clamp01(this.mat.uniforms.uBurst.value - control.dt * 1.8);
        this.mat.uniforms.uBurst.value = burst;
        const yaw = clamp01(control.rightX);
        const pitch = clamp01(control.leftY);
        const chaos = clamp01(control.rightPinch);
        const detail = clamp01(control.rightSpeed);
        const drive = clamp01(control.build * 0.8 + bp * 0.25);
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uYaw.value = yaw;
        this.mat.uniforms.uPitch.value = pitch;
        this.mat.uniforms.uChaos.value = chaos;
        this.mat.uniforms.uDetail.value = this.safeMode ? Math.min(0.7, detail) : detail;
        this.mat.uniforms.uDrive.value = drive;
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
