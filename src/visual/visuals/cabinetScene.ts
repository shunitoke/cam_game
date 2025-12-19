import * as THREE from "three";
import { TeapotGeometry } from "three/examples/jsm/geometries/TeapotGeometry.js";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

type VizPack = {
  kick?: Float32Array;
  fft?: Float32Array;
};

export class CabinetScene {
  private scene = new THREE.Scene();

  private t = 0;
  private safeMode = false;
  private burst = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  private plasmaMesh: any;
  private plasmaMat: any;

  private tunnelMesh: any;
  private tunnelMat: any;

  private sineMesh: any;
  private sineMat: any;

  private floorMesh: any;
  private floorMat: any;

  private portalFrame: any;
  private portalRim: any;

  private objA: any;
  private objB: any;
  private objMatA: any;
  private objMatB: any;

  private teapotGeom: any;
  private teapotMat: any;
  private teapotA: any;
  private teapotB: any;

  private teapotHomeA = new THREE.Vector3();
  private teapotHomeB = new THREE.Vector3();
  private teapotVelA = new THREE.Vector3();
  private teapotVelB = new THREE.Vector3();
  private tmpV0 = new THREE.Vector3();
  private tmpV1 = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();

  private keyLight: any;
  private fillLight: any;
  private rimLight: any;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.Fog(0x05060a, 1.8, 6.5);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    // Plasma
    this.plasmaMat = new THREE.ShaderMaterial({
      depthWrite: true,
      depthTest: true,
      transparent: false,
      uniforms: {
        uTime: { value: 0 },
        uWet: { value: 0 },
        uDrive: { value: 0 },
        uEnergy: { value: 0.5 },
        uBuild: { value: 0 }
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
        uniform float uWet;
        uniform float uDrive;
        uniform float uEnergy;
        uniform float uBuild;

        float hash11(float p) {
          p = fract(p * 0.1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

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

        vec3 palette(float t) {
          vec3 a = vec3(0.18, 0.20, 0.26);
          vec3 b = vec3(0.32, 0.26, 0.38);
          vec3 c = vec3(0.65, 0.55, 0.45);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec2 uv = vUv;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= 1.35;

          float speed = 0.25 + 0.9 * uEnergy + 0.45 * uDrive;
          float t = uTime * speed;

          float sw = 0.8 + 2.2 * uWet + 1.2 * uBuild;

          float n1 = noise21(p * (1.75 * sw) + vec2(0.0, t * 0.25));
          float n2 = noise21(p * (3.50 * sw) + vec2(t * -0.22, 0.0));
          float n = 0.65 * n1 + 0.35 * n2;

          float bands = sin((p.y + n * 0.35) * (5.0 + 9.0 * uDrive) + t * 0.7);
          bands = 0.5 + 0.5 * bands;

          float grad = 0.55 + 0.45 * (p.y * 0.5 + 0.5);
          float v = mix(grad, bands, 0.35 + 0.45 * uWet);
          v = clamp(v + (n - 0.5) * (0.25 + 0.55 * uWet), 0.0, 1.0);

          float hueT = fract(0.55 + 0.18 * uWet + 0.08 * uDrive + 0.20 * uBuild + 0.05 * sin(t * 0.25));
          vec3 col = palette(hueT + v * (0.45 + 0.35 * uWet));

          float spark = step(0.985, fract(n2 + t * 0.15 + hash11(floor((p.x + 2.0) * 13.0))));
          col += spark * vec3(0.35, 0.55, 0.85) * (0.15 + 0.45 * uDrive);

          float vign = smoothstep(1.15, 0.25, length(p));
          // Softer vignette so the surface never collapses to full black.
          col *= mix(0.65, 1.0, vign);

          float gain = 0.75 + 0.65 * uEnergy + 0.25 * uBuild;
          col *= gain;
          col *= 1.25;

          // Base lift so low-energy moments still read.
          col += vec3(0.035, 0.030, 0.045);

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    // Tunnel
    this.tunnelMat = new THREE.ShaderMaterial({
      depthWrite: true,
      depthTest: true,
      transparent: true,
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

          // Circular portal alpha mask.
          float r = length(p);
          float aPortal = smoothstep(0.98, 0.90, r);
          if (aPortal <= 0.001) discard;

          vec3 ro = vec3(0.0, 0.0, -2.25);
          float t = uTime * (0.25 + 0.75 * uSpeed);

          ro.xy += 0.08 * vec2(sin(t * 0.7), cos(t * 0.6));
          ro.xy += (uWet * 0.15) * vec2(cos(t * 0.9), sin(t * 1.1));

          vec3 rd = normalize(vec3(p, 1.55));
          rd.xy = rot2(rd.xy, (uTwist * 0.35) * sin(uTime * 0.08));

          vec3 col = shade(ro, rd);

          float vign = smoothstep(1.35, 0.35, length(uv * 2.0 - 1.0));
          col *= vign;

          gl_FragColor = vec4(col, aPortal);
        }
      `
    });

    // Sine warp bump
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

    this.sineMat = new THREE.ShaderMaterial({
      depthWrite: true,
      depthTest: true,
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 1.0 },
        uTex: { value: tex },
        uDrive: { value: 0.0 },
        uSpeed: { value: 1.0 },
        uBump: { value: 0.05 },
        uAlpha: { value: 0.55 }
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
        uniform float uAlpha;

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
          // Local UV (plane space). Do not use screen-sized uRes here because
          // this material is used as a world-space floor surface.
          vec2 uv = vUv * 2.0 - 1.0;
          uv.x *= uAspect;

          vec3 sp = vec3(uv, 0.0);
          vec3 rd = normalize(vec3(uv, 1.0));
          float t = uTime * (0.45 + 0.85 * uSpeed);
          vec3 lp = vec3(cos(uTime) * 0.5, sin(uTime) * 0.2, -1.0);
          vec3 sn = vec3(0.0, 0.0, -1.0);

          vec2 eps = vec2(0.008, 0.0);
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
          float grain = (hash21(vUv * 512.0 + uTime) - 0.5) * (0.02 + 0.06 * uDrive);
          col += grain;

          vec3 outCol = sqrt(clamp(col, 0.0, 1.0));
          gl_FragColor = vec4(outCol, clamp(uAlpha, 0.0, 1.0));
        }
      `
    });

    // Plasma lives on an actual 3D object (not as a background wall).
    const plasmaBox = new THREE.BoxGeometry(0.78, 0.78, 0.78, 1, 1, 1);
    this.plasmaMesh = new THREE.Mesh(plasmaBox, this.plasmaMat);
    this.plasmaMesh.position.set(-0.92, -0.02, -0.10);
    this.scene.add(this.plasmaMesh);

    this.tunnelMesh = new THREE.Mesh(geom, this.tunnelMat);
    this.tunnelMesh.position.set(0, 0.08, -0.65);
    this.tunnelMesh.scale.set(0.92, 0.92, 1);
    this.scene.add(this.tunnelMesh);

    // Use sine warp as a floor decal/surface (not a fullscreen overlay).
    const sineGeom = new THREE.PlaneGeometry(6.2, 6.2, 1, 1);
    this.sineMesh = new THREE.Mesh(sineGeom, this.sineMat);
    this.sineMesh.position.set(0, -1.30, -0.90);
    this.sineMesh.rotation.set(-Math.PI * 0.5, 0.0, 0.0);
    this.scene.add(this.sineMesh);

    this.floorMat = new THREE.MeshStandardMaterial({ color: 0x07080b, metalness: 0.1, roughness: 0.95 });
    const floorGeom = new THREE.PlaneGeometry(7.5, 7.5, 1, 1);
    this.floorMesh = new THREE.Mesh(floorGeom, this.floorMat);
    this.floorMesh.position.set(0, -1.35, -0.85);
    this.floorMesh.rotation.set(-Math.PI * 0.5, 0, 0);
    this.scene.add(this.floorMesh);

    // No bulky square frame; keep a glowing rim.
    this.portalFrame = null;

    const rimGeom = new THREE.TorusGeometry(0.98, 0.055, 14, 64);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x1b2240, emissive: 0x142060, emissiveIntensity: 0.75, metalness: 0.4, roughness: 0.35 });
    this.portalRim = new THREE.Mesh(rimGeom, rimMat);
    this.portalRim.position.copy(this.tunnelMesh.position);
    this.portalRim.position.z += 0.08;
    this.scene.add(this.portalRim);

    this.objMatA = new THREE.MeshStandardMaterial({ color: 0xbfd7ff, emissive: 0x0b1230, emissiveIntensity: 0.35, metalness: 0.85, roughness: 0.22 });
    this.objMatB = new THREE.MeshStandardMaterial({ color: 0xffc7a0, emissive: 0x2a0f10, emissiveIntensity: 0.25, metalness: 0.6, roughness: 0.35 });

    const aGeom = new THREE.TorusKnotGeometry(0.30, 0.10, 160, 18);
    this.objA = new THREE.Mesh(aGeom, this.objMatA);
    this.objA.position.set(-0.35, -0.10, -0.45);
    this.scene.add(this.objA);

    const bGeom = new THREE.IcosahedronGeometry(0.30, 2);
    this.objB = new THREE.Mesh(bGeom, this.objMatB);
    this.objB.position.set(0.80, 0.18, -0.35);
    this.scene.add(this.objB);

    this.teapotGeom = new TeapotGeometry(0.22, 10, true, true, true, false, true);
    this.teapotMat = new THREE.MeshStandardMaterial({ color: 0xe9ecff, emissive: 0x050815, emissiveIntensity: 0.35, metalness: 0.65, roughness: 0.25 });

    this.teapotA = new THREE.Mesh(this.teapotGeom, this.teapotMat);
    this.teapotA.position.set(0.55, -0.18, -0.20);
    this.teapotA.rotation.x = -0.25;
    this.scene.add(this.teapotA);

    this.teapotB = new THREE.Mesh(this.teapotGeom, this.teapotMat);
    this.teapotB.position.set(-0.15, 0.32, -0.55);
    this.teapotB.rotation.x = 0.15;
    this.scene.add(this.teapotB);

    this.teapotHomeA.copy(this.teapotA.position);
    this.teapotHomeB.copy(this.teapotB.position);
    this.teapotVelA.set(0, 0, 0);
    this.teapotVelB.set(0, 0, 0);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
    this.keyLight.position.set(1.2, 1.4, 1.6);
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0x7aa6ff, 0.65);
    this.fillLight.position.set(-1.6, 0.6, 0.8);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.PointLight(0xff2aa6, 1.0, 8.0);
    this.rimLight.position.set(0.0, 0.55, -1.10);
    this.scene.add(this.rimLight);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.tunnelMat.uniforms.uSteps.value = on ? 46.0 : 72.0;
    this.sineMat.uniforms.uAlpha.value = on ? 0.42 : 0.55;

    if (this.objA?.geometry && typeof this.objA.geometry.dispose === "function") {
      this.objA.geometry.dispose();
      this.objA.geometry = new THREE.TorusKnotGeometry(0.28, 0.10, on ? 80 : 160, on ? 12 : 18);
    }
    if (this.objB?.geometry && typeof this.objB.geometry.dispose === "function") {
      this.objB.geometry.dispose();
      this.objB.geometry = new THREE.IcosahedronGeometry(0.30, on ? 1 : 2);
    }

    this.objB.visible = !on;
    if (this.teapotB) this.teapotB.visible = !on;
  }

  onResize(camera: any) {
    const cam: any = camera as any;

    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.sineMat.uniforms.uRes.value.set(w, h);
    this.sineMat.uniforms.uAspect.value = cam.aspect ?? window.innerWidth / window.innerHeight;
    this.tunnelMat.uniforms.uAspect.value = cam.aspect ?? window.innerWidth / window.innerHeight;

    const scaleToFill = (mesh: any, z: number) => {
      const dist = Math.abs((cam.position?.z ?? 2.2) - z);
      const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
      const height = 2 * dist * Math.tan(vFov * 0.5);
      const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
      mesh.scale.set(width / this.baseW, height / this.baseH, 1);
    };

    scaleToFill(this.tunnelMesh, this.tunnelMesh.position.z);

    // Sine is a world-space floor plane; no camera scaling.
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.burst = 0;

    if (this.teapotA) this.teapotA.position.copy(this.teapotHomeA);
    if (this.teapotB) this.teapotB.position.copy(this.teapotHomeB);
    this.teapotVelA.set(0, 0, 0);
    this.teapotVelB.set(0, 0, 0);
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  update(control: ControlState) {
    const dt = control.dt;
    this.t += dt;

    this.burst = Math.max(0, this.burst - dt * 2.6);

    const bp = clamp01(control.beatPulse ?? 0);
    const pack = (control.audioViz ?? {}) as VizPack;
    const kick = pack.kick;

    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) peak = Math.max(peak, Math.abs(kick[i] ?? 0));
      kickEnv = clamp01(peak * 2.2);
    }

    const burstKick = clamp01(kickEnv + this.burst + bp * 0.65);

    // Plasma mapping
    const plasmaEnergy = clamp01(0.45 + 0.55 * ((control.leftX + control.leftY) * 0.5) + 0.35 * control.build + this.burst * 0.55 + bp * 0.35);
    const plasmaWet = clamp01(0.10 + 0.90 * control.rightPinch);
    const plasmaDrive = clamp01(0.15 + 0.85 * control.rightSpeed + this.burst * 0.60 + bp * 0.35);

    this.plasmaMat.uniforms.uTime.value = this.t;
    this.plasmaMat.uniforms.uWet.value = plasmaWet;
    this.plasmaMat.uniforms.uDrive.value = plasmaDrive;
    this.plasmaMat.uniforms.uEnergy.value = plasmaEnergy;
    this.plasmaMat.uniforms.uBuild.value = clamp01(0.08 + control.build + bp * 0.18);

    // Tunnel mapping
    const tunnelEnergy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    this.tunnelMat.uniforms.uTime.value = this.t;
    this.tunnelMat.uniforms.uEnergy.value = tunnelEnergy;
    this.tunnelMat.uniforms.uWet.value = clamp01(control.rightPinch);
    this.tunnelMat.uniforms.uBuild.value = clamp01(control.build);
    this.tunnelMat.uniforms.uKick.value = burstKick;

    if (!this.safeMode) {
      this.tunnelMat.uniforms.uTwist.value = 0.15 + 0.85 * clamp01(control.rightX);
      this.tunnelMat.uniforms.uSpeed.value = 0.65 + 1.35 * clamp01(control.rightY + 0.25 * burstKick + 0.20 * bp);
      this.tunnelMat.uniforms.uSteps.value = 58.0 + 26.0 * clamp01(control.rightSpeed);
    }

    // Sine mapping
    const drive = clamp01(control.build * 0.85 + control.rightPinch * 0.35 + bp * 0.25);

    this.sineMat.uniforms.uTime.value = this.t;
    this.sineMat.uniforms.uDrive.value = drive;
    this.sineMat.uniforms.uSpeed.value = 0.65 + 1.25 * clamp01(control.rightY + 0.25 * bp);

    const bump = 0.032 + 0.055 * clamp01(control.rightPinch) + (this.safeMode ? 0.0 : 0.015 * bp);
    this.sineMat.uniforms.uBump.value = bump;

    // Cabinet motion
    const wob = 0.15 * clamp01(control.rightPinch) + 0.10 * bp;
    const tt = this.t;
    const rx = (control.rightX - 0.5);

    this.tunnelMesh.rotation.z = 0.02 * Math.sin(tt * 0.55) + 0.045 * rx;
    this.sineMesh.rotation.y = 0.06 * Math.sin(tt * 0.25) * wob;

    const framePulse = 0.06 * burstKick + 0.03 * bp;
    this.portalRim.rotation.z = -0.12 * tt + 0.10 * rx;
    this.portalRim.scale.setScalar(1.0 + framePulse);
    if (this.portalFrame) {
      this.portalFrame.rotation.z = 0.012 * Math.sin(tt * 0.45) + 0.02 * rx;
    }

    const build = clamp01(control.build);
    const energy = clamp01((control.leftX + control.leftY) * 0.5);
    const floatAmt = 0.12 + 0.28 * clamp01(control.rightPinch) + 0.20 * build;
    const spin = 0.5 + 2.6 * clamp01(control.rightSpeed) + 0.9 * bp;

    if (this.plasmaMesh) {
      // Make the plasma cube feel like a powered module in the cabinet.
      this.plasmaMesh.rotation.x = tt * (0.22 * spin);
      this.plasmaMesh.rotation.y = -tt * (0.28 * spin);
      this.plasmaMesh.rotation.z = 0.20 * Math.sin(tt * 0.6) - 0.10 * rx;
      this.plasmaMesh.position.y = -0.05 + 0.10 * Math.sin(tt * 0.85) * (0.5 + floatAmt);
    }

    if (this.objA) {
      this.objA.position.y = -0.15 + floatAmt * Math.sin(tt * 0.9);
      this.objA.rotation.x = tt * (0.55 * spin);
      this.objA.rotation.y = tt * (0.32 * spin);
      this.objA.rotation.z = tt * (0.18 * spin);
    }
    if (this.objB) {
      this.objB.position.y = 0.15 + floatAmt * Math.cos(tt * 0.8);
      this.objB.rotation.x = tt * (0.35 * spin);
      this.objB.rotation.y = -tt * (0.50 * spin);
      this.objB.rotation.z = tt * (0.22 * spin);
    }

    if (this.teapotA) {
      this.teapotA.rotation.y = tt * (0.85 + 0.85 * spin);
      this.teapotA.rotation.z = 0.25 * Math.sin(tt * 0.75) - 0.10 * rx;
    }
    if (this.teapotB) {
      this.teapotB.rotation.y = -tt * (0.75 + 0.65 * spin);
      this.teapotB.rotation.x = 0.15 + 0.20 * Math.sin(tt * 0.6);
    }

    // Zero-g teapot drift with soft repulsion (no hard collisions).
    if (this.teapotA && this.teapotB) {
      const tdrift = 0.22 + 0.85 * clamp01(control.rightPinch) + 0.55 * bp;
      const damp = Math.pow(0.18, dt);
      const spring = 0.95;

      // Gentle drift around their home positions.
      this.tmpV0.set(
        Math.sin(tt * 0.63) * 0.7 + Math.cos(tt * 0.21) * 0.3,
        Math.cos(tt * 0.51) * 0.6,
        Math.sin(tt * 0.37) * 0.4
      );
      this.tmpV1.set(
        Math.cos(tt * 0.58) * 0.6,
        Math.sin(tt * 0.44) * 0.7 + Math.cos(tt * 0.17) * 0.25,
        Math.cos(tt * 0.33) * 0.4
      );

      this.tmpV0.multiplyScalar(0.22 * tdrift);
      this.tmpV1.multiplyScalar(0.22 * tdrift);

      // Soft spring back to home.
      this.tmpV0.add(this.tmpV1);

      this.tmpV1.copy(this.teapotHomeA).sub(this.teapotA.position).multiplyScalar(0.55 * spring);
      this.teapotVelA.addScaledVector(this.tmpV1, dt);
      this.tmpV1.copy(this.teapotHomeB).sub(this.teapotB.position).multiplyScalar(0.55 * spring);
      this.teapotVelB.addScaledVector(this.tmpV1, dt);

      // Add drift forces.
      this.teapotVelA.addScaledVector(this.tmpV0, dt);
      this.teapotVelB.addScaledVector(this.tmpV0, -dt);

      // Soft repulsion to prevent intersection.
      const minDist = 0.56;
      this.tmpV1.copy(this.teapotB.position).sub(this.teapotA.position);
      const d = this.tmpV1.length();
      if (d > 1e-4) {
        const n = this.tmpV1.multiplyScalar(1.0 / d);
        const overlap = minDist - d;
        if (overlap > 0) {
          const push = overlap * (3.5 + 2.5 * tdrift);
          this.teapotVelA.addScaledVector(n, -push * dt);
          this.teapotVelB.addScaledVector(n, push * dt);
        }
      }

      // Damping and integrate.
      this.teapotVelA.multiplyScalar(damp);
      this.teapotVelB.multiplyScalar(damp);

      this.teapotA.position.addScaledVector(this.teapotVelA, dt);
      this.teapotB.position.addScaledVector(this.teapotVelB, dt);

      // Keep them in a loose "cabinet volume".
      const clampBox = (p: any) => {
        p.x = Math.min(0.95, Math.max(-0.95, p.x));
        p.y = Math.min(0.65, Math.max(-0.45, p.y));
        p.z = Math.min(-0.10, Math.max(-0.85, p.z));
      };
      clampBox(this.teapotA.position);
      clampBox(this.teapotB.position);
    }

    // Soft non-collision for cabinet objects (avoid visible intersections).
    {
      const items: Array<{ m: any; r: number }> = [];
      if (this.plasmaMesh) items.push({ m: this.plasmaMesh, r: 0.52 });
      if (this.objA) items.push({ m: this.objA, r: 0.42 });
      if (this.objB && this.objB.visible) items.push({ m: this.objB, r: 0.38 });
      if (this.teapotA) items.push({ m: this.teapotA, r: 0.30 });
      if (this.teapotB && this.teapotB.visible) items.push({ m: this.teapotB, r: 0.30 });

      const clampCabinet = (p: any) => {
        p.x = Math.min(0.98, Math.max(-0.98, p.x));
        p.y = Math.min(0.75, Math.max(-0.55, p.y));
        p.z = Math.min(-0.08, Math.max(-0.95, p.z));
      };

      const strength = 0.9 + 0.9 * clamp01(control.rightPinch) + 0.45 * bp;
      const iters = this.safeMode ? 1 : 2;

      for (let iter = 0; iter < iters; iter++) {
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const A = items[i]!.m;
            const B = items[j]!.m;
            const minD = (items[i]!.r + items[j]!.r) * 0.98;

            this.tmpV2.copy(B.position).sub(A.position);
            const d = this.tmpV2.length();
            if (d < 1e-4) {
              // Deterministic tiny nudge to break symmetry.
              this.tmpV2.set(1, 0, 0);
            } else {
              this.tmpV2.multiplyScalar(1.0 / d);
            }

            const overlap = minD - d;
            if (overlap > 0) {
              const push = overlap * 0.5 * strength;
              A.position.addScaledVector(this.tmpV2, -push);
              B.position.addScaledVector(this.tmpV2, push);
              clampCabinet(A.position);
              clampCabinet(B.position);
            }
          }
        }
      }
    }

    const k = 0.25 + 0.75 * burstKick;
    this.keyLight.intensity = 0.95 + 0.55 * k;
    this.fillLight.intensity = 0.45 + 0.45 * (0.35 * energy + 0.65 * build);
    this.rimLight.intensity = 0.55 + 1.05 * (0.5 * k + 0.5 * clamp01(control.rightPinch));
    this.rimLight.position.x = 0.65 * Math.sin(tt * 0.35);
    this.rimLight.position.y = 0.55 + 0.25 * Math.cos(tt * 0.28);

    // Fade overlay slightly based on energy for readability.
    const a = clamp01(0.65 + 0.25 * drive + 0.15 * bp);
    const baseA = this.safeMode ? 0.42 : 0.55;
    this.sineMat.uniforms.uAlpha.value = clamp01(baseA + 0.20 * a);
  }

  dispose() {
    this.plasmaMesh.geometry.dispose();
    this.plasmaMat.dispose();

    this.tunnelMesh.geometry.dispose();
    this.tunnelMat.dispose();

    this.sineMesh.geometry.dispose();
    this.sineMat.dispose();

    if (this.floorMesh?.geometry) this.floorMesh.geometry.dispose();
    if (this.floorMat?.dispose) this.floorMat.dispose();

    if (this.portalFrame) {
      this.portalFrame.traverse((o: any) => {
        if (o?.geometry?.dispose) o.geometry.dispose();
        if (o?.material?.dispose) o.material.dispose();
      });
    }

    if (this.portalRim?.geometry) this.portalRim.geometry.dispose();
    if (this.portalRim?.material?.dispose) this.portalRim.material.dispose();

    if (this.objA?.geometry) this.objA.geometry.dispose();
    if (this.objMatA?.dispose) this.objMatA.dispose();

    if (this.objB?.geometry) this.objB.geometry.dispose();
    if (this.objMatB?.dispose) this.objMatB.dispose();

    if (this.teapotGeom?.dispose) this.teapotGeom.dispose();
    if (this.teapotMat?.dispose) this.teapotMat.dispose();

    const tex: any = this.sineMat.uniforms.uTex.value as any;
    if (tex && typeof tex.dispose === "function") tex.dispose();
  }
}
