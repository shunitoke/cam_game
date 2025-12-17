import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
export class ParticlesScene {
    scene = new THREE.Scene();
    points;
    geom;
    mat;
    time = 0;
    pulse = 0;
    safeMode = false;
    colorA = new THREE.Color();
    colorB = new THREE.Color();
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        const count = 70000;
        const pos = new Float32Array(count * 3);
        const seed = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            const i3 = i * 3;
            const r = 0.25 + Math.random() * 1.65;
            const a = Math.random() * Math.PI * 2;
            const z = (Math.random() - 0.5) * 4.6;
            pos[i3 + 0] = Math.cos(a) * r;
            pos[i3 + 1] = Math.sin(a) * r;
            pos[i3 + 2] = z;
            seed[i3 + 0] = Math.random();
            seed[i3 + 1] = Math.random();
            seed[i3 + 2] = Math.random();
        }
        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        this.geom.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime: { value: 0 },
                uEnergy: { value: 0.5 },
                uWet: { value: 0.0 },
                uDrive: { value: 0.0 },
                uBuild: { value: 0.0 },
                uRightY: { value: 0.5 },
                uDensity: { value: 1.0 },
                uColorA: { value: new THREE.Color(0x88aaff) },
                uColorB: { value: new THREE.Color(0xff5588) }
            },
            vertexShader: `
        uniform float uTime;
        uniform float uEnergy;
        uniform float uWet;
        uniform float uDrive;
        uniform float uBuild;
        uniform float uRightY;
        uniform float uDensity;
        attribute vec3 aSeed;
        varying float vFade;
        varying float vMix;
        float hash(float n){ return fract(sin(n)*43758.5453123); }
        void main(){
          if (aSeed.x > uDensity) {
            vFade = 0.0;
            vMix = 0.0;
            gl_PointSize = 0.0;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          float t = uTime * (0.18 + uEnergy * 0.42);

          vec3 p = position;
          float r = length(p.xy) + 1e-6;

          float baseA = atan(p.y, p.x);
          float swirl = (0.6 + uEnergy * 2.2 + uWet * 3.0) * (0.65 + aSeed.x);
          float a = baseA + t * swirl;

          float wob = sin(t * 1.7 + aSeed.y * 6.283) * (0.06 + uWet * 0.28);
          float rr = r + wob;

          float shove = (uBuild * 0.55 + uWet * 0.18) * (0.35 + uEnergy);
          rr *= 1.0 + shove * sin(t * 2.0 + aSeed.x * 12.0);

          float z = p.z;
          z += (hash(aSeed.z * 123.4 + floor(t * 0.5)) - 0.5) * (0.18 + uWet * 0.35);
          z = mod(z + t * (0.55 + uEnergy * 2.0), 4.6) - 2.3;

          vec3 pos;
          pos.x = cos(a) * rr;
          pos.y = sin(a) * rr;
          pos.z = z;

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;

          float size = (1.1 + uEnergy * 3.8 + uWet * 2.2) * (1.0 + uDrive * 1.25);
          gl_PointSize = min(14.0, size * (280.0 / max(1.0, -mv.z)));

          vFade = clamp(0.15 + uEnergy * 0.75 + uWet * 0.35, 0.0, 1.0);
          vMix = clamp(uWet * 0.7 + uBuild * 0.35, 0.0, 1.0);
        }
      `,
            fragmentShader: `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        varying float vFade;
        varying float vMix;
        void main(){
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float d = dot(uv, uv);
          float a = smoothstep(1.0, 0.0, d);
          a *= a;
          vec3 c = mix(uColorA, uColorB, vMix);
          gl_FragColor = vec4(c, a * vFade);
        }
      `
        });
        this.points = new THREE.Points(this.geom, this.mat);
        this.scene.add(this.points);
        const light = new THREE.PointLight(0xffffff, 0.35);
        light.position.set(0.8, 1.2, 1.4);
        this.scene.add(light);
    }
    getScene() {
        return this.scene;
    }
    reset() {
        this.pulse = 0;
    }
    triggerBurst(amount) {
        this.pulse = Math.max(this.pulse, clamp01(amount));
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.mat.uniforms.uDensity.value = on ? 0.35 : 1.0;
    }
    update(control) {
        const dt = control.dt;
        this.time += dt;
        const bp = clamp01(control.beatPulse ?? 0);
        const energy = clamp01(lerp(control.leftX, control.leftY, 0.5) + control.build * 0.6 + bp * 0.45);
        const wet = clamp01(control.rightPinch);
        const drive = clamp01(control.rightSpeed + bp * 0.35);
        this.pulse = Math.max(0, this.pulse - dt * 1.8);
        if (control.events.reset)
            this.pulse = 0;
        this.colorA.setHSL(lerp(0.58, 0.72, control.rightX), 0.85, lerp(0.45, 0.6, drive));
        this.colorB.setHSL(lerp(0.00, 0.12, wet), 0.9, 0.55);
        this.mat.uniforms.uTime.value = this.time;
        this.mat.uniforms.uEnergy.value = energy;
        this.mat.uniforms.uWet.value = wet;
        this.mat.uniforms.uDrive.value = drive;
        this.mat.uniforms.uBuild.value = clamp01(control.build + this.pulse * 0.5 + bp * 0.18);
        this.mat.uniforms.uRightY.value = clamp01(control.rightY);
        this.mat.uniforms.uDensity.value = this.safeMode ? 0.35 : 1.0;
        this.mat.uniforms.uColorA.value.copy(this.colorA);
        this.mat.uniforms.uColorB.value.copy(this.colorB);
        this.points.rotation.z += dt * lerp(0.1, 0.65, energy);
        this.points.rotation.x = lerp(-0.12, 0.12, control.rightY);
    }
    dispose() {
        this.geom.dispose();
        this.mat.dispose();
    }
}
