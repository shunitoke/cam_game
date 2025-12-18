import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class FractalFlightScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
    burst = 0;
    camYaw = 0;
    camPitch = 0;
    chaos = 0;
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
                uAspect: { value: 1.0 },
                uSteps: { value: 56.0 },
                uIters: { value: 10.0 },
                uColor: { value: 0.6 },
                uCam: { value: new THREE.Vector3(0, 0, 0) },
                uBuild: { value: 0.0 },
                uChaos: { value: 0.0 }
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
        uniform float uSteps;
        uniform float uIters;
        uniform float uColor;
        uniform vec3 uCam;
        uniform float uBuild;
        uniform float uChaos;

        vec2 rot(vec2 p, float a) {
          float c = cos(a), s = sin(a);
          return mat2(c, -s, s, c) * p;
        }

        float mandelbulbDE(vec3 p) {
          vec3 z = p;
          float dr = 1.0;
          float r = 0.0;

          float power = 7.0;
          float iters = clamp(uIters, 3.0, 14.0);

          for (int i = 0; i < 14; i++) {
            if (float(i) >= iters) break;
            r = length(z);
            if (r > 4.0) break;

            float theta = acos(z.z / max(r, 1e-6));
            float phi = atan(z.y, z.x);
            dr = pow(r, power - 1.0) * power * dr + 1.0;

            float zr = pow(r, power);
            theta *= power;
            phi *= power;

            z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
            z += p;
          }

          return 0.5 * log(r) * r / dr;
        }

        vec3 getNormal(vec3 p) {
          float e = 0.0012;
          float dx = mandelbulbDE(p + vec3(e, 0.0, 0.0)) - mandelbulbDE(p - vec3(e, 0.0, 0.0));
          float dy = mandelbulbDE(p + vec3(0.0, e, 0.0)) - mandelbulbDE(p - vec3(0.0, e, 0.0));
          float dz = mandelbulbDE(p + vec3(0.0, 0.0, e)) - mandelbulbDE(p - vec3(0.0, 0.0, e));
          return normalize(vec3(dx, dy, dz));
        }

        vec3 palette(float t) {
          vec3 a = vec3(0.08, 0.10, 0.15);
          vec3 b = vec3(0.35, 0.35, 0.55);
          vec3 c = vec3(0.95, 0.85, 0.55);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          float time = uTime;

          float yaw = uCam.x;
          float pitch = uCam.y;

          vec3 ro = vec3(0.0, 0.0, -3.2);
          ro.z += time * (0.75 + 1.10 * (0.25 + 0.75 * uBuild));

          vec3 rd = normalize(vec3(p, 1.6));
          rd.xz = rot(rd.xz, yaw);
          rd.yz = rot(rd.yz, pitch);

          float t = 0.0;
          float hit = 0.0;
          float glow = 0.0;
          float steps = clamp(uSteps, 20.0, 96.0);

          for (int i = 0; i < 96; i++) {
            if (float(i) >= steps) break;
            vec3 pos = ro + rd * t;

            // keep the fractal centered while we fly
            pos.z = mod(pos.z, 6.0) - 3.0;
            float wob = 0.65 + 0.35 * sin(time * 0.18 + uChaos * 2.0);
            pos.xy *= wob;

            // Small chaotic deformation (feels alive, not "zoom").
            pos += 0.18 * uChaos * vec3(
              sin(pos.y * 1.5 + time * 0.70),
              sin(pos.z * 1.2 + time * 0.55),
              sin(pos.x * 1.3 + time * 0.60)
            );

            pos *= 1.65;

            float d = mandelbulbDE(pos);
            glow += exp(-8.0 * abs(d)) * 0.012;

            if (d < 0.0015) { hit = 1.0; break; }
            t += d * 0.9;
            if (t > 10.0) break;
          }

          vec3 col = vec3(0.0);
          if (hit > 0.5) {
            vec3 pos = ro + rd * t;
            pos.z = mod(pos.z, 6.0) - 3.0;
            float wob = 0.65 + 0.35 * sin(time * 0.18 + uChaos * 2.0);
            pos.xy *= wob;
            pos += 0.18 * uChaos * vec3(
              sin(pos.y * 1.5 + time * 0.70),
              sin(pos.z * 1.2 + time * 0.55),
              sin(pos.x * 1.3 + time * 0.60)
            );
            pos *= 1.65;

            vec3 n = getNormal(pos);
            vec3 ldir = normalize(vec3(0.35, 0.65, -0.4));
            float diff = clamp(dot(n, ldir), 0.0, 1.0);
            float rim = pow(clamp(1.0 - dot(n, -rd), 0.0, 1.0), 2.2);

            float hue = fract(0.55 + 0.12 * sin(uTime * 0.07) + 0.25 * uColor + 0.20 * uChaos);
            vec3 base = palette(hue + 0.25 * diff);

            col = base * (0.08 + 0.92 * diff) + base * rim * (0.25 + 1.25 * glow);
          }

          // fog + glow
          float fog = exp(-0.12 * t);
          vec3 bg = palette(fract(0.05 + 0.08 * uColor + 0.02 * sin(uTime * 0.15))) * 0.12;
          col = mix(bg, col, fog);
          col += glow * palette(fract(0.65 + 0.15 * uColor + 0.25 * uChaos)) * (0.6 + 0.8 * uBuild);

          float vign = smoothstep(1.35, 0.35, length(uv * 2.0 - 1.0));
          col *= vign;

          col = pow(col, vec3(0.95));
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
        this.mat.uniforms.uSteps.value = on ? 36.0 : 62.0;
        this.mat.uniforms.uIters.value = on ? 7.0 : 11.0;
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
        const b = clamp01(this.burst + bp * 0.75);
        // Smooth, alive camera: blend user control with autonomous drift.
        const t = this.t;
        const userYaw = (clamp01(control.rightX) - 0.5) * (0.75 + 0.35 * b);
        const userPitch = (clamp01(control.leftY) - 0.5) * (0.55 + 0.30 * b);
        const driftYaw = 0.18 * Math.sin(t * 0.23) + 0.12 * Math.sin(t * 0.51 + 1.7);
        const driftPitch = 0.14 * Math.sin(t * 0.19 + 2.1) + 0.10 * Math.sin(t * 0.43);
        const targetYaw = userYaw + driftYaw;
        const targetPitch = userPitch + driftPitch;
        const smooth = 1.0 - Math.pow(0.001, control.dt);
        this.camYaw += (targetYaw - this.camYaw) * smooth;
        this.camPitch += (targetPitch - this.camPitch) * smooth;
        // Pinch becomes "chaos" (visual turbulence), not zoom.
        const chaosTarget = clamp01(control.rightPinch * 0.95 + 0.35 * b + 0.25 * clamp01(control.build));
        this.chaos += (chaosTarget - this.chaos) * smooth;
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uCam.value.set(this.camYaw, this.camPitch, 0);
        this.mat.uniforms.uBuild.value = clamp01(control.build);
        this.mat.uniforms.uChaos.value = this.chaos;
        this.mat.uniforms.uColor.value = clamp01(control.rightY * 0.70 + 0.25 * clamp01(control.rightSpeed) + 0.25 * b);
        if (!this.safeMode) {
            const detail = clamp01(0.25 + 0.75 * clamp01(control.rightSpeed) + 0.25 * b);
            this.mat.uniforms.uIters.value = 7.0 + 6.0 * detail;
            this.mat.uniforms.uSteps.value = 40.0 + 46.0 * detail;
        }
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
