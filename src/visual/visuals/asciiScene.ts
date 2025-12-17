import * as THREE from "three";

import type { ControlState } from "../../control/types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

type VizPack = {
  fft?: Float32Array;
  kick?: Float32Array;
};

function makeGlyphAtlas() {
  // 16x16 = 256 glyphs
  const cols = 16;
  const rows = 16;
  const cell = 32;
  const w = cols * cell;
  const h = rows * cell;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { tex: null as any, cols, rows };

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, w, h);

  // Dense -> sparse ramp (we'll index into this)
  const ramp = "@%#*+=-:. ";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";
  ctx.font = "26px monospace";

  for (let i = 0; i < cols * rows; i++) {
    const gx = i % cols;
    const gy = (i / cols) | 0;
    const x = gx * cell + cell * 0.5;
    const y = gy * cell + cell * 0.55;
    const ch = ramp[Math.floor((i / (cols * rows - 1)) * (ramp.length - 1))] ?? " ";
    ctx.fillText(ch, x, y);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, cols, rows };
}

export class AsciiScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;
  private t = 0;
  private safeMode = false;

  private burst = 0;

  private videoTexture: any = null;

  private atlasTexture: any = null;
  private atlasCols = 16;
  private atlasRows = 16;

  private baseW = 4.2;
  private baseH = 2.4;

  constructor(video?: HTMLVideoElement) {
    this.scene.background = new THREE.Color(0x05060a);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    if (video) {
      const vt = new THREE.VideoTexture(video);
      vt.minFilter = THREE.LinearFilter;
      vt.magFilter = THREE.LinearFilter;
      vt.generateMipmaps = false;
      vt.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture = vt;
    }

    const atlas = makeGlyphAtlas();
    this.atlasTexture = atlas.tex;
    this.atlasCols = atlas.cols;
    this.atlasRows = atlas.rows;

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0.5 },
        uWet: { value: 0.0 },
        uBuild: { value: 0.0 },
        uSpectrum: { value: 0.0 },
        uKick: { value: 0.0 },
        uGrid: { value: 120.0 },
        uColorize: { value: 0.5 },
        uVideo: { value: this.videoTexture },
        uHasVideo: { value: this.videoTexture ? 1.0 : 0.0 },
        uVideoAspect: { value: 4 / 3 },
        uAtlas: { value: this.atlasTexture },
        uAtlasCols: { value: this.atlasCols },
        uAtlasRows: { value: this.atlasRows }
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
        uniform float uSpectrum;
        uniform float uKick;
        uniform float uGrid;
        uniform float uColorize;

        uniform sampler2D uVideo;
        uniform float uHasVideo;
        uniform float uVideoAspect;

        uniform sampler2D uAtlas;
        uniform float uAtlasCols;
        uniform float uAtlasRows;

        float hash(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float glyph(vec2 cellUv, float idx){
          float cols = max(1.0, uAtlasCols);
          float rows = max(1.0, uAtlasRows);
          float i = clamp(floor(idx + 0.5), 0.0, cols * rows - 1.0);
          float gx = mod(i, cols);
          float gy = floor(i / cols);
          vec2 uv = (vec2(gx, gy) + cellUv) / vec2(cols, rows);
          float a = texture2D(uAtlas, uv).r;
          return a;
        }

        vec2 coverUv(vec2 uv, float srcAspect, float dstAspect) {
          vec2 p = uv * 2.0 - 1.0;
          if (dstAspect > srcAspect) {
            p.y *= dstAspect / srcAspect;
          } else {
            p.x *= srcAspect / dstAspect;
          }
          return p * 0.5 + 0.5;
        }

        void main(){
          vec2 uv = vUv;
          uv.x *= 1.15;
          float t = uTime;

          float v = 0.0;

          if (uHasVideo > 0.5) {
            float dstAspect = 1.0;
            vec2 vuv = coverUv(vUv, uVideoAspect, dstAspect);
            // trail/smear: sample multiple offsets based on kick energy
            float k = clamp(uKick, 0.0, 1.0);
            float smear = (0.002 + 0.018 * k) * (0.35 + 0.65 * uWet);
            vec2 dir = normalize(vec2(0.85, 0.35));
            vec3 src0 = texture2D(uVideo, vuv).rgb;
            vec3 src1 = texture2D(uVideo, vuv - dir * smear).rgb;
            vec3 src2 = texture2D(uVideo, vuv - dir * smear * 2.0).rgb;
            float lum0 = dot(src0, vec3(0.2126, 0.7152, 0.0722));
            float lum1 = dot(src1, vec3(0.2126, 0.7152, 0.0722));
            float lum2 = dot(src2, vec3(0.2126, 0.7152, 0.0722));

            float lum = lum0 * 0.62 + lum1 * 0.26 + lum2 * 0.12;

            // Edges-first ASCII: make camera barely visible; mostly contour ink.
            float dx = 1.0 / (uGrid * 0.90);
            float dy = 1.0 / (uGrid * 0.58);
            float lumR = dot(texture2D(uVideo, vuv + vec2(dx, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
            float lumL = dot(texture2D(uVideo, vuv - vec2(dx, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
            float lumU = dot(texture2D(uVideo, vuv + vec2(0.0, dy)).rgb, vec3(0.2126, 0.7152, 0.0722));
            float lumD = dot(texture2D(uVideo, vuv - vec2(0.0, dy)).rgb, vec3(0.2126, 0.7152, 0.0722));
            float edge = abs(lumR - lumL) + abs(lumU - lumD);
            edge = clamp(edge * (3.0 + uEnergy * 3.0 + uBuild * 2.8 + k * 2.4), 0.0, 1.0);

            float thr = 0.20 + 0.18 * (1.0 - uWet);
            float contour = smoothstep(thr, thr + 0.35, edge);

            // very weak fill (optional): keeps some structure when edge is missing
            float fill = smoothstep(0.62, 0.40, lum);
            float fillAmt = (0.02 + 0.08 * uBuild) * (0.25 + 0.75 * uWet);

            v = clamp(contour + fill * fillAmt, 0.0, 1.0);
            v = pow(v, 1.55 - 0.45 * k);
          } else {
            // fallback: procedural field
            v += 0.55 + 0.45 * sin((uv.x * 3.8 + uv.y * 2.2) + t * (0.6 + uEnergy));
            v += 0.25 * cos((uv.y * 4.7 - uv.x * 2.6) - t * (0.7 + uWet * 1.2));
            v += 0.30 * uSpectrum;
            v = clamp(v * 0.55, 0.0, 1.0);
          }

          // ASCII grid
          float grid = uGrid;
          vec2 gUv = vec2(uv.x * grid, uv.y * grid * 0.62);
          vec2 cell = floor(gUv);
          vec2 cellUv = fract(gUv);

          float rnd = hash(cell);
          // 10 levels to match our ramp feel; kick/burst increases density.
          float levels = 10.0;
          float vv = clamp(v * (0.85 + 0.25 * uKick) + rnd * 0.04, 0.0, 1.0);
          float lvl = floor(vv * (levels - 1.0) + 0.5);
          float idx = lvl / (levels - 1.0) * (uAtlasCols * uAtlasRows - 1.0);

          float g = glyph(cellUv, idx);
          // Ink: keep background open, mostly edges
          float ink = g * smoothstep(0.12, 0.92, vv);
          ink *= 0.45 + 0.55 * vv;

          float hue = fract(0.52 + uColorize * 0.22 + v * 0.18 + uBuild * 0.12);
          vec3 p = vec3(fract(hue + 0.0), fract(hue + 0.33), fract(hue + 0.66));
          vec3 col = clamp(abs(fract(p * 6.0) - 3.0) - 1.0, 0.0, 1.0);
          col = mix(vec3(0.85, 0.98, 0.92), col, uColorize);

          vec3 bg = vec3(0.02, 0.025, 0.04);
          vec3 outCol = mix(bg, col, ink);

          // scanline / vignette
          float scan = 0.92 + 0.08 * sin((vUv.y * 900.0) + t * 40.0);
          outCol *= scan;
          float vign = smoothstep(1.4, 0.25, length(vUv * 2.0 - 1.0));
          outCol *= vign;

          gl_FragColor = vec4(outCol, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);
  }

  onResize(camera: any) {
    const cam: any = camera as any;
    const dist = Math.abs((cam.position?.z ?? 2.2) - (this.mesh?.position?.z ?? -0.4));
    const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
    const height = 2 * dist * Math.tan(vFov * 0.5);
    const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
    this.mesh.scale.set(width / this.baseW, height / this.baseH, 1);
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.mat.uniforms.uGrid.value = on ? 95.0 : 120.0;
  }

  getScene() {
    return this.scene;
  }

  reset() {
    this.t = 0;
    this.burst = 0;
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  update(control: ControlState) {
    this.t += control.dt;

    this.burst = Math.max(0, this.burst - control.dt * 3.0);

    const pack = (control.audioViz ?? {}) as VizPack;
    const fft = pack.fft;
    const kick = pack.kick;

    // crude spectrum energy (0..1)
    let spec = 0;
    if (fft && fft.length) {
      const n = Math.min(fft.length, 128);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const db = fft[i];
        const m = clamp01((db + 120) / 120);
        sum += m;
      }
      spec = sum / n;
      spec = Math.pow(spec, 1.8);
    }

    // kick envelope (0..1): cheap peak estimate
    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) {
        const a = Math.abs(kick[i] ?? 0);
        if (a > peak) peak = a;
      }
      kickEnv = clamp01(peak * 2.2);
    }

    const burstKick = clamp01(kickEnv + this.burst);

    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
    const wet = clamp01(control.rightPinch);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uWet.value = wet;
    this.mat.uniforms.uBuild.value = clamp01(control.build);
    this.mat.uniforms.uSpectrum.value = spec;
    this.mat.uniforms.uKick.value = burstKick;
    this.mat.uniforms.uColorize.value = clamp01(control.rightX);

    const video: any = (this.videoTexture as any)?.image;
    if (video && typeof video.videoWidth === "number" && video.videoWidth > 0 && typeof video.videoHeight === "number" && video.videoHeight > 0) {
      this.mat.uniforms.uVideoAspect.value = video.videoWidth / Math.max(1, video.videoHeight);
      this.mat.uniforms.uHasVideo.value = 1.0;
    }

    if (!this.safeMode) {
      this.mat.uniforms.uGrid.value = 110.0 + 40.0 * clamp01(control.rightY);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.videoTexture?.dispose();
    this.atlasTexture?.dispose();
  }
}
