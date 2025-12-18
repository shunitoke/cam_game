import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
function bandsFromFftDb(fft) {
    if (!fft || !fft.length) {
        return { low: 0, mid: 0, high: 0, presence: 0 };
    }
    // fft is in dBFS-ish negative values. Map roughly [-110..-25] => [0..1].
    const to01 = (db) => clamp01((db + 110) / 85);
    const n = fft.length;
    const avg = (a, b) => {
        const i0 = Math.max(0, Math.min(n - 1, a));
        const i1 = Math.max(i0 + 1, Math.min(n, b));
        let s = 0;
        let c = 0;
        for (let i = i0; i < i1; i++) {
            s += to01(fft[i] ?? -120);
            c++;
        }
        return c ? s / c : 0;
    };
    // For analyser.fftSize=1024 => 512 bins, so these are fairly low Hz bins.
    // We're not aiming for physical Hz accuracy, just stable low/mid/high separation.
    const low = avg(1, 10);
    const mid = avg(10, 42);
    const high = avg(42, 120);
    const presence = avg(120, 220);
    return { low, mid, high, presence };
}
export class ResonanceForgeScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
    burst = 0;
    baseW = 4.2;
    baseH = 2.4;
    constructor() {
        this.scene.background = new THREE.Color(0x020308);
        const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);
        this.mat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTime: { value: 0 },
                uAspect: { value: 1.0 },
                uSteps: { value: 72.0 },
                uBass: { value: 0.0 },
                uGtr: { value: 0.0 },
                uBuild: { value: 0.0 },
                uBright: { value: 0.5 },
                uPitch: { value: 0.5 },
                uFftLow: { value: 0.0 },
                uFftMid: { value: 0.0 },
                uFftHigh: { value: 0.0 },
                uFftPresence: { value: 0.0 }
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

        uniform float uBass;
        uniform float uGtr;
        uniform float uBuild;
        uniform float uBright;
        uniform float uPitch;

        uniform float uFftLow;
        uniform float uFftMid;
        uniform float uFftHigh;
        uniform float uFftPresence;

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

        float sdCyl(vec3 p, float r) {
          return length(p.xz) - r;
        }

        float map(vec3 p) {
          float t = uTime;

          // Global twist: guitar/presence rotates space; bass squeezes it.
          float twist = (0.15 + 0.65 * uGtr + 0.35 * uFftPresence) * sin(t * (0.12 + 0.08 * uPitch));
          p.xy = rot2(p.xy, twist);

          // Forge chamber: a fat cylinder in Z with breathing radius.
          float breath = 0.06 * sin(t * 0.35 + p.z * 0.55) + 0.09 * (uBass + uFftLow);
          float chamber = length(p.xy) - (0.62 + breath);

          // Repeating ribs / columns.
          float z = p.z + t * (0.22 + 0.35 * uBuild);
          float cell = floor(z);
          float fz = fract(z) - 0.5;

          float id = cell;
          float rnd = hash11(id * 0.17 + 1.3);

          vec3 q = vec3(p.xy, fz);
          q.xy = rot2(q.xy, rnd * 6.28318);

          float ribs = sdBox(q, vec3(0.18 + 0.08 * rnd, 0.03 + 0.06 * (1.0 - rnd), 0.48));

          // Hanging plates that thicken with bass.
          vec3 plateP = q;
          plateP.y += 0.18 + 0.22 * (uBass + uFftLow);
          float plates = sdBox(plateP, vec3(0.26 + 0.16 * uBuild, 0.015 + 0.04 * (uBass + uFftLow), 0.28));

          // Harmonic filaments: thin "wires" carved by upper spectrum.
          float filA = sin((p.z * 2.2) + t * 0.6 + uPitch * 6.283);
          float filB = sin((p.z * 3.4) - t * 0.42 + uBright * 5.0);
          float fil = abs(filA * filB);
          float wires = length(p.xy) - (0.08 + 0.18 * fil * (0.25 + 0.75 * (uGtr + uFftHigh)));

          float d = chamber;
          d = min(d, ribs);
          d = min(d, plates);
          d = min(d, wires);

          // Floor/ceiling crop.
          float crop = abs(p.y) - 0.85;
          d = max(d, crop);

          return d;
        }

        vec3 shade(vec3 ro, vec3 rd) {
          float t = 0.0;
          float hit = 0.0;

          float maxT = 10.0;
          float steps = clamp(uSteps, 28.0, 96.0);

          float glowAcc = 0.0;

          for (int i = 0; i < 96; i++) {
            if (float(i) >= steps) break;
            vec3 p = ro + rd * t;
            float d = map(p);

            // Volumetric-ish sparkle accumulation near surfaces.
            float near = exp(-abs(d) * (18.0 + 22.0 * (uGtr + uFftHigh)));
            float sp = sin(p.z * 8.0 + uTime * 0.9) * sin(p.x * 7.0 - uTime * 0.7);
            glowAcc += near * (0.015 + 0.06 * (uBright + uFftPresence)) * (0.6 + 0.4 * sp);

            if (d < 0.0018) { hit = 1.0; break; }
            t += d * 0.82;
            if (t > maxT) break;
          }

          vec3 bg = vec3(0.01, 0.015, 0.03);
          float fog = exp(-0.16 * t);

          if (hit < 0.5) {
            // Deep space fog with bass lift.
            vec3 c = bg * (0.75 + 0.55 * (uBass + uFftLow));
            c += vec3(0.04, 0.02, 0.06) * glowAcc;
            return c * fog;
          }

          vec3 p = ro + rd * t;

          float e = 0.0025;
          float nx = map(p + vec3(e, 0.0, 0.0)) - map(p - vec3(e, 0.0, 0.0));
          float ny = map(p + vec3(0.0, e, 0.0)) - map(p - vec3(0.0, e, 0.0));
          float nz = map(p + vec3(0.0, 0.0, e)) - map(p - vec3(0.0, 0.0, e));
          vec3 n = normalize(vec3(nx, ny, nz));

          vec3 ldir = normalize(vec3(-0.35, 0.55, -0.65));
          float diff = clamp(dot(n, ldir), 0.0, 1.0);
          float rim = pow(clamp(1.0 - dot(n, -rd), 0.0, 1.0), 2.0);

          // Color: bass = heat/red, guitar = neon/cyan.
          vec3 heat = vec3(0.95, 0.35, 0.14);
          vec3 neon = vec3(0.20, 0.92, 0.95);
          float mixT = clamp(0.18 + 0.55 * (uGtr + uFftHigh) + 0.15 * uBuild, 0.0, 1.0);
          vec3 base = mix(heat, neon, mixT);

          float emiss = (0.08 + 0.85 * (uBuild + uFftMid)) * (0.35 + 0.65 * (uGtr + uFftPresence));
          emiss += 0.55 * (uBass + uFftLow);

          vec3 col = base * (0.10 + 0.95 * diff);
          col += base * rim * (0.35 + 0.95 * emiss);
          col += vec3(0.10, 0.06, 0.14) * glowAcc;

          col = mix(bg, col, fog);

          return col;
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= uAspect;

          float t = uTime;

          // Camera: bass pushes forward and adds heavier sway.
          vec3 ro = vec3(0.0, 0.0, -2.35);
          ro.z += 0.25 * (uBass + uFftLow);

          float camSw = 0.06 + 0.14 * (uGtr + uFftHigh);
          ro.xy += camSw * vec2(sin(t * 0.5 + uPitch * 4.0), cos(t * 0.44 + uBright * 2.7));

          vec3 rd = normalize(vec3(p, 1.55));

          vec3 col = shade(ro, rd);

          float vign = smoothstep(1.35, 0.35, length(uv * 2.0 - 1.0));
          col *= vign;

          // Slight contrast lift with brightness.
          col = pow(max(col, 0.0), vec3(0.95 - 0.15 * uBright));

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
        this.mat.uniforms.uSteps.value = on ? 52.0 : 76.0;
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
        this.burst = Math.max(0, this.burst - control.dt * 2.0);
        const pack = (control.audioViz ?? {});
        const bands = bandsFromFftDb(pack.fft);
        // In DRONE mode (worklet engine), left pinch is bass intensity, right pinch is guitar sustain/drive.
        const bass = clamp01(control.leftPinch);
        const gtr = clamp01(control.rightPinch);
        const build = clamp01(control.build);
        const bright = clamp01(control.rightY);
        const pitch = clamp01(control.rightX);
        const dyn = clamp01(0.25 * this.burst + 0.35 * (bands.mid + bands.high) + 0.35 * build);
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uBass.value = clamp01(lerp(bass, bands.low, 0.45));
        this.mat.uniforms.uGtr.value = clamp01(lerp(gtr, bands.high, 0.55));
        this.mat.uniforms.uBuild.value = clamp01(build + dyn * 0.35);
        this.mat.uniforms.uBright.value = bright;
        this.mat.uniforms.uPitch.value = pitch;
        this.mat.uniforms.uFftLow.value = bands.low;
        this.mat.uniforms.uFftMid.value = bands.mid;
        this.mat.uniforms.uFftHigh.value = bands.high;
        this.mat.uniforms.uFftPresence.value = bands.presence;
        if (!this.safeMode) {
            const steps = 62.0 + 22.0 * clamp01(0.35 + dyn);
            this.mat.uniforms.uSteps.value = steps;
        }
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
    }
}
