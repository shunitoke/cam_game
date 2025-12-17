import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class RaymarchTunnelScene {
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
                uSteps: { value: 64.0 },
                uTwist: { value: 0.35 },
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
        uniform float uSteps;
        uniform float uTwist;
        uniform float uSpeed;

        float hash11(float p) {
          p = fract(p * 0.1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

        vec2 rot2(vec2 p, float a) {
          float c = cos(a), s = sin(a);
          return mat2(c, -s, s, c) * p;
        }

        float sdBox(vec3 p, vec3 b) {
          vec3 q = abs(p) - b;
          return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
        }

        float map(vec3 p) {
          float t = uTime * (0.55 + 0.75 * uSpeed + 0.45 * uEnergy + 0.35 * uBuild);

          float z = p.z + t * 2.0;
          float cell = floor(z);
          float f = fract(z) - 0.5;

          float id = cell;
          float rnd = hash11(id * 0.13 + 1.7);

          p.xy = rot2(p.xy, uTwist * (cell * 0.35 + t * 0.15) + rnd * 2.2);

          float tunnel = length(p.xy) - (0.55 + 0.15 * sin(cell * 0.9 + t * 0.7));

          vec3 q = vec3(p.xy, f);
          q.xy = rot2(q.xy, rnd * 6.28318);
          float box = sdBox(q, vec3(0.18 + 0.12 * rnd, 0.10 + 0.08 * (1.0 - rnd), 0.12));

          float beams = sdBox(q, vec3(0.45, 0.02 + 0.03 * rnd, 0.45));

          float d = min(tunnel, box);
          d = min(d, beams);

          return d;
        }

        vec3 shade(vec3 ro, vec3 rd) {
          float t = 0.0;
          float hit = 0.0;

          float maxT = 8.5;
          float steps = clamp(uSteps, 24.0, 90.0);

          for (int i = 0; i < 90; i++) {
            if (float(i) >= steps) break;
            vec3 p = ro + rd * t;
            float d = map(p);
            if (d < 0.0015) { hit = 1.0; break; }
            t += d * 0.85;
            if (t > maxT) break;
          }

          vec3 bg = vec3(0.02, 0.025, 0.04);
          if (hit < 0.5) {
            float fog = exp(-0.18 * t);
            return bg * fog;
          }

          vec3 p = ro + rd * t;

          float e = 0.0025;
          float nx = map(p + vec3(e, 0.0, 0.0)) - map(p - vec3(e, 0.0, 0.0));
          float ny = map(p + vec3(0.0, e, 0.0)) - map(p - vec3(0.0, e, 0.0));
          float nz = map(p + vec3(0.0, 0.0, e)) - map(p - vec3(0.0, 0.0, e));
          vec3 n = normalize(vec3(nx, ny, nz));

          vec3 ldir = normalize(vec3(-0.35, 0.45, -0.6));
          float diff = clamp(dot(n, ldir), 0.0, 1.0);

          float rim = pow(clamp(1.0 - dot(n, -rd), 0.0, 1.0), 2.2);

          float glow = 0.10 + 0.55 * uWet + 0.55 * uKick;

          float hue = fract(0.70 + 0.12 * sin(uTime * 0.08) + 0.18 * uBuild);
          vec3 neon = vec3(0.18, 0.55, 0.95);
          neon = mix(neon, vec3(0.95, 0.35, 0.85), hue);

          vec3 col = neon * (0.08 + 0.85 * diff) + neon * rim * (0.45 + 0.85 * glow);

          float fog = exp(-0.22 * t);
          col = mix(bg, col, fog);

          return col;
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          vec3 ro = vec3(0.0, 0.0, -2.25);
          float t = uTime * (0.25 + 0.75 * uSpeed);

          ro.xy += 0.08 * vec2(sin(t * 0.7), cos(t * 0.6));
          ro.xy += (uWet * 0.15) * vec2(cos(t * 0.9), sin(t * 1.1));

          vec3 rd = normalize(vec3(p, 1.55));
          rd.xy = rot2(rd.xy, (uTwist * 0.35) * sin(uTime * 0.08));

          vec3 col = shade(ro, rd);

          float vign = smoothstep(1.35, 0.35, length(uv * 2.0 - 1.0));
          col *= vign;

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
        this.burst = Math.max(0, this.burst - control.dt * 2.8);
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
        this.mat.uniforms.uBuild.value = clamp01(control.build);
        this.mat.uniforms.uKick.value = burstKick;
        if (!this.safeMode) {
            this.mat.uniforms.uTwist.value = 0.15 + 0.85 * clamp01(control.rightX);
            this.mat.uniforms.uSpeed.value = 0.65 + 1.35 * clamp01(control.rightY + 0.25 * burstKick + 0.20 * bp);
            this.mat.uniforms.uSteps.value = 58.0 + 26.0 * clamp01(control.rightSpeed);
        }
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
