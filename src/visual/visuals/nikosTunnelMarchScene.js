import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class NikosTunnelMarchScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
    burst = 0;
    baseW = 4.2;
    baseH = 2.4;
    constructor() {
        this.scene.background = new THREE.Color(0x000000);
        const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);
        this.mat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTime: { value: 0 },
                uRes: { value: new THREE.Vector2(1, 1) },
                uAspect: { value: 1.0 },
                uSpeed: { value: 1.0 },
                uStorm: { value: 0.0 },
                uSteps: { value: 64.0 },
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
        uniform float uSpeed;
        uniform float uStorm;
        uniform float uSteps;
        uniform float uBurst;

        #define EPS 0.001

        float hash1(float n){ return fract(sin(n) * 43758.5453123); }

        float hash2(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f *= f * (3.0 - 2.0 * f);
          vec2 c = vec2(0.0, 1.0);
          return mix(mix(hash2(i + c.xx), hash2(i + c.yx), f.x), mix(hash2(i + c.xy), hash2(i + c.yy), f.x), f.y);
        }

        float fbm(vec2 p){
          float v = 0.0;
          v += 0.5000 * noise(p);
          v += 0.2500 * noise(p * 2.0);
          v += 0.1250 * noise(p * 4.0);
          v += 0.0625 * noise(p * 8.0);
          return v;
        }

        float dst(vec3 p){
          float vel = 25.0 * uTime * (0.35 + 1.25 * uSpeed);
          vec3 pp = p;
          pp.z += vel;
          float n = fbm(pp.zx * 0.55);
          float n2 = noise(pp.xz * 0.10);
          float n3 = noise(pp.xz * 0.40);
          float n4 = noise(pp.xz * 0.001);
          float n5 = noise((pp.xz + 132.453) * 0.0005);
          float y = pp.y + (0.35 + 0.85 * uStorm) * 0.45 * n + (0.55 + 1.55 * uStorm) * 2.55 * n2 + 0.83 * n3 + 3.33 * n4 + 3.59 * n5;
          return y;
        }

        vec3 nrm(vec3 p, float d){
          vec3 e = vec3(EPS, 0.0, 0.0);
          float dx = dst(p + e.xyy);
          float dy = dst(p + e.yxy);
          float dz = dst(p + e.yyx);
          return normalize(vec3(dx, dy, dz) - d);
        }

        bool rmarch(vec3 ro, vec3 rd, out vec3 p, out vec3 n){
          p = ro;
          vec3 pos = p;
          float d = 1.0;
          float steps = clamp(uSteps, 24.0, 96.0);
          for (int i = 0; i < 96; i++) {
            if (float(i) >= steps) break;
            d = dst(pos);
            if (d < EPS) { p = pos; break; }
            pos += d * rd;
          }
          n = nrm(p, d);
          return d < EPS;
        }

        vec4 render(vec2 uv){
          vec2 uvn = uv * vec2(uRes.x / uRes.y, 1.0);

          float vel = 25.0 * uTime * (0.45 + 1.10 * uSpeed);

          vec3 cu = vec3(2.0 * noise(vec2(0.3 * uTime)) - 1.0, 1.0, 1.0 * fbm(vec2(0.8 * uTime)));
          vec3 cp = vec3(0.0, 3.1 + noise(vec2(uTime)) * 3.1, vel);
          vec3 ct = vec3(1.5 * sin(uTime), -2.0 + cos(uTime) + fbm(cp.xz) * 0.4, 13.0 + vel);

          cp.y += (uv.y * 0.25) * (0.5 + 1.0 * uStorm);
          ct.y += (uv.y * 0.45) * (0.5 + 1.0 * uStorm);

          vec3 ro = cp;
          vec3 rd = normalize(vec3(uvn, 1.0 / tan(60.0 * (180.0 / 3.14159265359))));

          vec3 cd = ct - cp;
          vec3 rz = normalize(cd);
          vec3 rx = normalize(cross(rz, cu));
          vec3 ry = normalize(cross(rx, rz));

          rd = normalize(mat3(rx, ry, rz) * rd);

          vec3 sp;
          vec3 sn;
          vec3 col = vec3(0.0);
          float hit = 0.0;
          if (rmarch(ro, rd, sp, sn)) {
            vec3 l = normalize(vec3(cp.x, cp.y + 0.5, cp.z) - sp);
            float d = max(dot(sn, l), 0.0);
            col = vec3(0.6) * d;
            hit = 1.0;
          }

          return vec4(col, hit > 0.5 ? length(ro - sp) : 1e5);
        }

        void main(){
          vec2 fragCoord = vUv * uRes;
          vec2 uv = fragCoord.xy / uRes.xy * 2.0 - 1.0;

          if (abs(EPS + uv.y) >= 0.7) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          vec4 res = render(uv);
          vec3 col = res.xyz;

          float v = smoothstep(length(uv) * 0.35, 0.75, 0.4);
          col *= (1.35 + 0.70 * uStorm + 0.45 * uBurst) * v;

          float n = hash1((hash1(uv.x) + uv.y) * (uTime * 1.2));
          col += (n - 0.5) * (0.10 + 0.15 * uStorm);

          col *= smoothstep(EPS, 3.5, uTime);

          col = sqrt(clamp(col, 0.0, 1.0));
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
        this.mat.uniforms.uSteps.value = on ? 48.0 : 72.0;
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
        this.burst = 0;
    }
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 2.5);
        const bp = clamp01(control.beatPulse ?? 0);
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uSpeed.value = 0.45 + 1.65 * clamp01(control.rightY + 0.25 * bp);
        this.mat.uniforms.uStorm.value = clamp01(control.build);
        const b = clamp01(this.burst + bp * 0.75);
        this.mat.uniforms.uBurst.value = b;
        if (!this.safeMode) {
            this.mat.uniforms.uSteps.value = 56.0 + 30.0 * clamp01(control.rightSpeed);
        }
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
