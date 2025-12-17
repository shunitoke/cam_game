import * as THREE from "three";

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

export class ReactionDiffusionScene {
  private scene = new THREE.Scene();
  private mesh: any;
  private mat: any;

  private simScene: any;
  private simCamera: any;
  private simQuad: any;
  private simMat: any;

  private renderer: any = null;

  private t = 0;
  private safeMode = false;
  private burst = 0;

  private rtA: any;
  private rtB: any;
  private ping = 0;

  private baseW = 4.2;
  private baseH = 2.4;

  private simW = 256;
  private simH = 256;

  constructor() {
    this.scene.background = new THREE.Color(0x05060a);

    const geom = new THREE.PlaneGeometry(this.baseW, this.baseH, 1, 1);

    this.mat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTex: { value: null },
        uTime: { value: 0 },
        uEnergy: { value: 0.5 },
        uWet: { value: 0.0 },
        uBuild: { value: 0.0 },
        uKick: { value: 0.0 },
        uAspect: { value: 1.0 }
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

        uniform sampler2D uTex;
        uniform float uTime;
        uniform float uEnergy;
        uniform float uWet;
        uniform float uBuild;
        uniform float uKick;
        uniform float uAspect;

        vec3 palette(float t) {
          vec3 a = vec3(0.05, 0.06, 0.09);
          vec3 b = vec3(0.26, 0.22, 0.42);
          vec3 c = vec3(0.85, 0.55, 0.35);
          vec3 d = vec3(0.00, 0.33, 0.67);
          return a + b * cos(6.28318 * (c * t + d));
        }

        void main(){
          vec4 s = texture2D(uTex, vUv);
          float a = s.r;
          float b = s.g;

          float edge = clamp(b - a, -1.0, 1.0);
          float ink = smoothstep(0.10, 0.85, b);

          float hueT = fract(0.62 + 0.18 * uWet + 0.20 * uBuild + 0.12 * uKick + 0.05 * sin(uTime * 0.12));
          vec3 col = palette(hueT + b * 0.85);

          vec3 bg = vec3(0.02, 0.025, 0.04);

          float gain = 0.70 + 0.55 * uEnergy + 0.25 * uBuild + 0.25 * uKick;
          vec3 outCol = mix(bg, col, ink);
          outCol *= gain;

          float rim = smoothstep(-0.06, 0.12, edge);
          outCol += vec3(0.55, 0.65, 0.95) * rim * (0.08 + 0.35 * uKick);

          vec2 p = vUv * 2.0 - 1.0;
          p.x *= uAspect;
          float vign = smoothstep(1.35, 0.30, length(p));
          outCol *= vign;

          gl_FragColor = vec4(outCol, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geom, this.mat);
    this.mesh.position.z = -0.4;
    this.scene.add(this.mesh);

    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const simGeom = new THREE.PlaneGeometry(2, 2, 1, 1);
    this.simMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: false,
      uniforms: {
        uTex: { value: null },
        uPx: { value: new THREE.Vector2(1 / this.simW, 1 / this.simH) },
        uFeed: { value: 0.035 },
        uKill: { value: 0.062 },
        uDa: { value: 1.0 },
        uDb: { value: 0.5 },
        uDt: { value: 1.0 },
        uBrush: { value: new THREE.Vector3(0.5, 0.5, 0.0) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec2 vUv;

        uniform sampler2D uTex;
        uniform vec2 uPx;
        uniform float uFeed;
        uniform float uKill;
        uniform float uDa;
        uniform float uDb;
        uniform float uDt;
        uniform vec3 uBrush;

        vec4 S(vec2 o){
          return texture2D(uTex, vUv + o * uPx);
        }

        void main(){
          vec4 c = texture2D(uTex, vUv);
          float a = c.r;
          float b = c.g;

          vec4 n = S(vec2(0.0, 1.0));
          vec4 s = S(vec2(0.0, -1.0));
          vec4 e = S(vec2(1.0, 0.0));
          vec4 w = S(vec2(-1.0, 0.0));
          vec4 ne = S(vec2(1.0, 1.0));
          vec4 nw = S(vec2(-1.0, 1.0));
          vec4 se = S(vec2(1.0, -1.0));
          vec4 sw = S(vec2(-1.0, -1.0));

          float lapA = (n.r + s.r + e.r + w.r - 4.0 * a) * 0.20 + (ne.r + nw.r + se.r + sw.r - 4.0 * a) * 0.05;
          float lapB = (n.g + s.g + e.g + w.g - 4.0 * b) * 0.20 + (ne.g + nw.g + se.g + sw.g - 4.0 * b) * 0.05;

          float reaction = a * b * b;

          float aN = a + (uDa * lapA - reaction + uFeed * (1.0 - a)) * uDt;
          float bN = b + (uDb * lapB + reaction - (uKill + uFeed) * b) * uDt;

          aN = clamp(aN, 0.0, 1.0);
          bN = clamp(bN, 0.0, 1.0);

          vec2 d = vUv - uBrush.xy;
          float r = length(d);
          float add = smoothstep(uBrush.z, 0.0, r);
          bN = clamp(bN + 0.75 * add, 0.0, 1.0);
          aN = clamp(aN - 0.35 * add, 0.0, 1.0);

          gl_FragColor = vec4(aN, bN, 0.0, 1.0);
        }
      `
    });

    this.simQuad = new THREE.Mesh(simGeom, this.simMat);
    this.simScene.add(this.simQuad);
  }

  setRenderer(r: any) {
    this.renderer = r;
    this.allocate();
    this.reset();
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.simW = on ? 200 : 300;
    this.simH = on ? 200 : 300;
    this.allocate();
    this.reset();
  }

  onResize(camera: any) {
    const cam: any = camera as any;
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
    this.ping = 0;

    if (!this.renderer || !this.rtA || !this.rtB) return;

    const a0 = new Uint8Array(this.simW * this.simH * 4);
    for (let i = 0; i < this.simW * this.simH; i++) {
      a0[i * 4 + 0] = 255;
      a0[i * 4 + 1] = 0;
      a0[i * 4 + 2] = 0;
      a0[i * 4 + 3] = 255;
    }

    for (let k = 0; k < 22; k++) {
      const cx = (Math.random() * this.simW) | 0;
      const cy = (Math.random() * this.simH) | 0;
      const rad = 3 + ((Math.random() * 10) | 0);
      for (let y = -rad; y <= rad; y++) {
        for (let x = -rad; x <= rad; x++) {
          const xx = cx + x;
          const yy = cy + y;
          if (xx < 0 || yy < 0 || xx >= this.simW || yy >= this.simH) continue;
          if (x * x + y * y > rad * rad) continue;
          const idx = (yy * this.simW + xx) * 4;
          a0[idx + 1] = 235;
          a0[idx + 0] = 40;
        }
      }
    }

    const tex = new THREE.DataTexture(a0, this.simW, this.simH, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.clear();
    this.renderer.copyTextureToTexture(new THREE.Vector2(0, 0), tex, this.rtA.texture);
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.clear();
    this.renderer.copyTextureToTexture(new THREE.Vector2(0, 0), tex, this.rtB.texture);
    this.renderer.setRenderTarget(prev);

    tex.dispose();

    this.mat.uniforms.uTex.value = this.rtA.texture;
  }

  triggerBurst(amount: number) {
    this.burst = Math.max(this.burst, clamp01(amount));
  }

  update(control: ControlState) {
    this.t += control.dt;
    this.burst = Math.max(0, this.burst - control.dt * 2.8);

    const pack = (control.audioViz ?? {}) as VizPack;
    const kick = pack.kick;

    let kickEnv = 0;
    if (kick && kick.length) {
      const n = Math.min(kick.length, 128);
      let peak = 0;
      for (let i = 0; i < n; i += 4) peak = Math.max(peak, Math.abs(kick[i] ?? 0));
      kickEnv = clamp01(peak * 2.2);
    }

    const burstKick = clamp01(kickEnv + this.burst);
    const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7 + 0.45 * burstKick);

    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uEnergy.value = energy;
    this.mat.uniforms.uWet.value = clamp01(control.rightPinch);
    this.mat.uniforms.uBuild.value = clamp01(control.build);
    this.mat.uniforms.uKick.value = burstKick;

    if (!this.renderer || !this.rtA || !this.rtB) return;

    const feed = lerp(0.024, 0.046, clamp01(0.2 + control.rightX * 0.9));
    const kill = lerp(0.048, 0.072, clamp01(0.15 + control.rightY * 0.9));
    const dt = lerp(0.75, 1.25, clamp01(0.35 + control.build + burstKick * 0.6));

    this.simMat.uniforms.uFeed.value = feed;
    this.simMat.uniforms.uKill.value = kill;
    this.simMat.uniforms.uDt.value = dt;

    const brush = clamp01(control.rightPinch * 0.85 + burstKick * 0.55);
    const bx = clamp01(control.rightX);
    const by = clamp01(1.0 - control.rightY);
    this.simMat.uniforms.uBrush.value.set(bx, by, brush > 0.01 ? (this.safeMode ? 0.06 : 0.045) : 0.0);

    const its = Math.floor(lerp(this.safeMode ? 6 : 9, this.safeMode ? 16 : 24, clamp01(control.build + burstKick)));

    for (let i = 0; i < its; i++) {
      const src = this.ping === 0 ? this.rtA : this.rtB;
      const dst = this.ping === 0 ? this.rtB : this.rtA;

      this.simMat.uniforms.uTex.value = src.texture;

      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(dst);
      this.renderer.render(this.simScene, this.simCamera);
      this.renderer.setRenderTarget(prev);

      this.ping = 1 - this.ping;
    }

    const outTex = this.ping === 0 ? this.rtA.texture : this.rtB.texture;
    this.mat.uniforms.uTex.value = outTex;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.simQuad.geometry.dispose();
    this.simMat.dispose();
    this.rtA?.dispose?.();
    this.rtB?.dispose?.();
  }

  private allocate() {
    if (!this.renderer) return;

    this.rtA?.dispose?.();
    this.rtB?.dispose?.();

    const opts: any = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat
    };

    this.rtA = new THREE.WebGLRenderTarget(this.simW, this.simH, opts);
    this.rtB = new THREE.WebGLRenderTarget(this.simW, this.simH, opts);

    this.simMat.uniforms.uPx.value.set(1 / this.simW, 1 / this.simH);

    this.mat.uniforms.uTex.value = this.rtA.texture;
  }
}
