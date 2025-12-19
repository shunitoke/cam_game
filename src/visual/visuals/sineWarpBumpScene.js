import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class SineWarpBumpScene {
    scene = new THREE.Scene();
    mesh;
    mat;
    t = 0;
    safeMode = false;
    baseW = 4.2;
    baseH = 2.4;
    constructor() {
        this.scene.background = new THREE.Color(0x07080b);
        const texSize = 128;
        const data = new Uint8Array(texSize * texSize * 4);
        for (let y = 0; y < texSize; y++) {
            for (let x = 0; x < texSize; x++) {
                const i = (y * texSize + x) * 4;
                const u = x / (texSize - 1);
                const v = y / (texSize - 1);
                const g1 = Math.sin((u * 6.28318) * 4.0) * 0.5 + 0.5;
                const g2 = Math.sin((v * 6.28318) * 3.0) * 0.5 + 0.5;
                const n = Math.sin((u * 11.7 + v * 9.3) * 6.28318) * 0.5 + 0.5;
                const c = Math.floor(255 * (0.25 + 0.55 * g1 * g2 + 0.20 * n));
                data[i + 0] = c;
                data[i + 1] = Math.floor(c * 0.92);
                data[i + 2] = Math.floor(c * 0.78);
                data[i + 3] = 255;
            }
        }
        const tex = new THREE.DataTexture(data, texSize, texSize, THREE.RGBAFormat);
        tex.needsUpdate = true;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipMapLinearFilter;
        tex.generateMipmaps = true;
        const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);
        this.mat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTime: { value: 0 },
                uRes: { value: new THREE.Vector2(1, 1) },
                uAspect: { value: 1.0 },
                uTex: { value: tex },
                uDrive: { value: 0.0 },
                uSpeed: { value: 1.0 },
                uBump: { value: 0.05 }
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
        uniform sampler2D uTex;
        uniform float uDrive;
        uniform float uSpeed;
        uniform float uBump;

        float hash21(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        vec2 W(vec2 p, float t){
          p = (p + 3.0) * 4.0;
          for (int i = 0; i < 3; i++) {
            p += cos(p.yx * 3.0 + vec2(t, 1.57)) / 3.0;
            p += sin(p.yx + t + vec2(1.57, 0.0)) / 2.0;
            p *= 1.3;
          }
          p += fract(sin(p + vec2(13.0, 7.0)) * 5e5) * 0.03 - 0.015;
          return mod(p, 2.0) - 1.0;
        }

        float bumpFunc(vec2 p, float t){
          return length(W(p, t)) * 0.7071;
        }

        void main(){
          vec2 fragCoord = vUv * uRes;
          vec2 uv = (fragCoord - uRes * 0.5) / uRes.y;
          uv.x *= uAspect;

          vec3 sp = vec3(uv, 0.0);
          vec3 rd = normalize(vec3(uv, 1.0));
          float t = uTime * (0.45 + 0.85 * uSpeed);
          vec3 lp = vec3(cos(uTime) * 0.5, sin(uTime) * 0.2, -1.0);
          vec3 sn = vec3(0.0, 0.0, -1.0);

          vec2 eps = vec2(4.0 / uRes.y, 0.0);
          float f = bumpFunc(sp.xy, t);
          float fx = bumpFunc(sp.xy - eps.xy, t);
          float fy = bumpFunc(sp.xy - eps.yx, t);

          fx = (fx - f) / eps.x;
          fy = (fy - f) / eps.x;

          float bumpFactor = uBump;
          sn = normalize(sn + vec3(fx, fy, 0.0) * bumpFactor);

          vec3 ld = lp - sp;
          float lDist = max(length(ld), 0.0001);
          ld /= lDist;

          float atten = 1.0 / (1.0 + lDist * lDist * 0.15);
          atten *= f * 0.9 + 0.1;

          float diff = max(dot(sn, ld), 0.0);
          diff = pow(diff, 4.0) * 0.66 + pow(diff, 8.0) * 0.34;
          float spec = pow(max(dot(reflect(-ld, sn), -rd), 0.0), 12.0);

          vec2 warp = W(sp.xy, t) / 8.0;
          vec3 texCol = texture2D(uTex, sp.xy + warp).xyz;
          texCol *= texCol;
          texCol = smoothstep(0.05, 0.75, pow(texCol, vec3(0.75, 0.8, 0.85)));

          vec3 col = (texCol * (diff * vec3(1.0, 0.97, 0.92) * 2.0 + 0.5) + vec3(1.0, 0.6, 0.2) * spec * 2.0) * atten;

          float refv = max(dot(reflect(rd, sn), vec3(1.0)), 0.0);
          col += col * pow(refv, 4.0) * vec3(0.25, 0.5, 1.0) * 3.0;

          col *= 0.8 + 0.35 * uDrive;
          float grain = (hash21(fragCoord + uTime) - 0.5) * (0.02 + 0.06 * uDrive);
          col += grain;

          gl_FragColor = vec4(sqrt(clamp(col, 0.0, 1.0)), 1.0);
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
    }
    update(control) {
        this.t += control.dt;
        const bp = clamp01(control.beatPulse ?? 0);
        const drive = clamp01(control.build * 0.85 + control.rightPinch * 0.35 + bp * 0.25);
        this.mat.uniforms.uTime.value = this.t;
        this.mat.uniforms.uDrive.value = drive;
        this.mat.uniforms.uSpeed.value = 0.65 + 1.25 * clamp01(control.rightY + 0.25 * bp);
        const bump = 0.032 + 0.055 * clamp01(control.rightPinch) + (this.safeMode ? 0.0 : 0.015 * bp);
        this.mat.uniforms.uBump.value = bump;
    }
    dispose() {
        this.mesh.geometry.dispose();
        this.mat.dispose();
        const tex = this.mat.uniforms.uTex.value;
        if (tex && typeof tex.dispose === "function")
            tex.dispose();
    }
}
