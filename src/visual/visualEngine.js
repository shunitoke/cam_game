import * as THREE from "three";
import { ParticlesScene } from "./visuals/particlesScene";
import { GeometryScene } from "./visuals/geometryScene";
import { PlasmaScene } from "./visuals/plasmaScene";
import { DomainWarpScene } from "./visuals/domainWarpScene";
import { CellularScene } from "./visuals/cellularScene";
import { RaymarchTunnelScene } from "./visuals/raymarchTunnelScene";
import { ReactionDiffusionScene } from "./visuals/reactionDiffusionScene";
import { WaveLabScene } from "./visuals/waveLabScene";
import { PhysicsScene } from "./visuals/physicsScene";
import { AsciiScene } from "./visuals/asciiScene";
import { QuasicrystalsScene } from "./visuals/quasicrystalsScene";
import { BifurcationScene } from "./visuals/bifurcationScene";
import { LloydScene } from "./visuals/lloydScene";
import { RrtScene } from "./visuals/rrtScene";
import { RandomArboretumScene } from "./visuals/randomArboretumScene";
import { KochScene } from "./visuals/kochScene";
import { DlaScene } from "./visuals/dlaScene";
import { BosWarpScene } from "./visuals/bosWarpScene";
import { KaleidoscopeScene } from "./visuals/kaleidoscopeScene";
import { MetaballsScene } from "./visuals/metaballsScene";
export class VisualEngine {
    canvas;
    renderer;
    camera;
    rt;
    postScene;
    postCamera;
    postQuad;
    postMat;
    catAmount = 0;
    postTime = 0;
    safeMode = false;
    renderEnabled = true;
    renderScale = 1;
    dpr = 1;
    lastInternalW = 1;
    lastInternalH = 1;
    scenes;
    sceneIndex = 0;
    constructor(canvas, opts) {
        this.canvas = canvas;
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: false,
            alpha: false,
            powerPreference: "low-power"
        });
        // Keep renderer pixel ratio at 1 and bake DPR + SAFE scaling into the internal size.
        // This allows SAFE mode to reduce GPU workload while keeping the canvas CSS fullscreen.
        this.renderer.setPixelRatio(1);
        this.dpr = Math.min(1.25, window.devicePixelRatio || 1);
        this.renderer.setSize(Math.floor(window.innerWidth * this.dpr), Math.floor(window.innerHeight * this.dpr), false);
        this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 40);
        this.camera.position.set(0, 0, 2.2);
        this.rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: true,
            stencilBuffer: false
        });
        this.postScene = new THREE.Scene();
        this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.postMat = new THREE.ShaderMaterial({
            depthWrite: false,
            depthTest: false,
            transparent: false,
            uniforms: {
                uTex: { value: this.rt.texture },
                uAmount: { value: 0.0 },
                uIters: { value: 0.0 },
                uTime: { value: 0.0 },
                uInvRes: { value: new THREE.Vector2(1 / Math.max(1, window.innerWidth), 1 / Math.max(1, window.innerHeight)) },
                uCrt: { value: 0.85 },
                uChromAb: { value: 0.55 },
                uFxaa: { value: 1.0 },
                uGain: { value: 1.18 }
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
        uniform float uAmount;
        uniform float uIters;
        uniform float uTime;
        uniform vec2 uInvRes;
        uniform float uCrt;
        uniform float uChromAb;
        uniform float uFxaa;
        uniform float uGain;

        vec2 catMap(vec2 uv){
          // Arnold's Cat Map on [0,1) torus.
          // [x']   [1 1][x]
          // [y'] = [1 2][y]
          vec2 p = uv;
          p = vec2(p.x + p.y, p.x + 2.0 * p.y);
          return fract(p);
        }

        float luma(vec3 c) {
          return dot(c, vec3(0.299, 0.587, 0.114));
        }

        vec3 tex2(vec2 uv) {
          return texture2D(uTex, uv).rgb;
        }

        vec3 fxaa(vec2 uv) {
          vec2 px = uInvRes;

          vec3 rgbNW = tex2(uv + vec2(-1.0, -1.0) * px);
          vec3 rgbNE = tex2(uv + vec2( 1.0, -1.0) * px);
          vec3 rgbSW = tex2(uv + vec2(-1.0,  1.0) * px);
          vec3 rgbSE = tex2(uv + vec2( 1.0,  1.0) * px);
          vec3 rgbM  = tex2(uv);

          float lNW = luma(rgbNW);
          float lNE = luma(rgbNE);
          float lSW = luma(rgbSW);
          float lSE = luma(rgbSE);
          float lM  = luma(rgbM);

          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

          vec2 dir;
          dir.x = -((lNW + lNE) - (lSW + lSE));
          dir.y =  ((lNW + lSW) - (lNE + lSE));

          float dirReduce = max((lNW + lNE + lSW + lSE) * (0.25 * 0.5), 1e-6);
          float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
          dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * px;

          vec3 rgbA = 0.5 * (tex2(uv + dir * (1.0 / 3.0 - 0.5)) + tex2(uv + dir * (2.0 / 3.0 - 0.5)));
          vec3 rgbB = rgbA * 0.5 + 0.25 * (tex2(uv + dir * -0.5) + tex2(uv + dir * 0.5));

          float lB = luma(rgbB);
          if (lB < lMin || lB > lMax) return rgbA;
          return rgbB;
        }

        vec2 barrel(vec2 uv, float k) {
          vec2 p = uv * 2.0 - 1.0;
          float r2 = dot(p, p);
          p *= (1.0 + k * r2);
          return p * 0.5 + 0.5;
        }

        void main(){
          vec2 uv = vUv;
          float a = clamp(uAmount, 0.0, 1.0);
          float it = clamp(uIters, 0.0, 20.0);

          // apply integer iterations; keep shader deterministic.
          vec2 cuv = uv;
          for (int i = 0; i < 20; i++) {
            if (float(i) >= it) break;
            cuv = catMap(cuv);
          }

          // Cat map as UV warp (faster than color-mix).
          vec2 suv = mix(uv, cuv, a);

          // Global AA first.
          vec3 base = (uFxaa > 0.5) ? fxaa(suv) : tex2(suv);

          // CRT barrel distortion (subtle).
          float crt = clamp(uCrt, 0.0, 1.0);
          vec2 duv = barrel(suv, 0.12 * crt);

          // Chromatic aberration (radial, very small).
          float ca = clamp(uChromAb, 0.0, 1.0) * (0.0010 + 0.0020 * crt);
          vec2 p = duv - 0.5;
          float r = length(p);
          vec2 off = p * (ca * (0.35 + 0.65 * r));

          vec3 col;
          col.r = tex2(duv + off).r;
          col.g = tex2(duv).g;
          col.b = tex2(duv - off).b;

          // Slight sharpening/glitch feel while cat transition is active.
          col = mix(col, col * (0.92 + 0.16 * a) + vec3(0.06 * a), a * 0.55);

          // CRT scanlines + vignette.
          float scan = 0.90 + 0.10 * sin((vUv.y * 1000.0) + uTime * 40.0);
          col *= mix(1.0, scan, 0.75 * crt);

          float vign = smoothstep(1.35, 0.35, length(vUv * 2.0 - 1.0));
          col *= mix(1.0, vign, 0.85 * crt);

          // Slight bloom-ish lift.
          col += 0.015 * crt;

          // Overall screen gain (TV brightness).
          col *= max(0.0, uGain);

          // Clamp edges outside barrel.
          float inb = step(0.0, duv.x) * step(0.0, duv.y) * step(duv.x, 1.0) * step(duv.y, 1.0);
          col *= inb;
          gl_FragColor = vec4(col, 1.0);
        }
      `
        });
        const postGeom = new THREE.PlaneGeometry(2, 2, 1, 1);
        this.postQuad = new THREE.Mesh(postGeom, this.postMat);
        this.postScene.add(this.postQuad);
        const particles = new ParticlesScene();
        const geo = new GeometryScene();
        const plasma = new PlasmaScene();
        const warp = new DomainWarpScene();
        const cellular = new CellularScene();
        const tunnel = new RaymarchTunnelScene();
        const rd = new ReactionDiffusionScene();
        const wave = new WaveLabScene();
        const phys = new PhysicsScene({ mode: "cloth" });
        const physRope = new PhysicsScene({ mode: "rope" });
        const physJelly = new PhysicsScene({ mode: "jelly" });
        const physChainmail = new PhysicsScene({ mode: "chainmail" });
        const quasi = new QuasicrystalsScene();
        const ascii = new AsciiScene(opts?.video);
        const bif = new BifurcationScene();
        const lloyd = new LloydScene();
        const rrt = new RrtScene();
        const arbor = new RandomArboretumScene();
        const koch = new KochScene();
        const dla = new DlaScene();
        const bosWarp = new BosWarpScene();
        const kalei = new KaleidoscopeScene();
        const metaballs = new MetaballsScene();
        // Some scenes need access to the WebGLRenderer (ping-pong simulation, etc.).
        for (const sc of [
            particles,
            geo,
            plasma,
            warp,
            cellular,
            tunnel,
            rd,
            wave,
            phys,
            physRope,
            physJelly,
            physChainmail,
            quasi,
            ascii,
            bif,
            lloyd,
            rrt,
            arbor,
            koch,
            dla,
            bosWarp,
            kalei,
            metaballs
        ]) {
            if (typeof sc.setRenderer === "function") {
                sc.setRenderer(this.renderer);
            }
        }
        this.scenes = [
            { def: { id: "particles", name: "Particles" }, scene: particles },
            { def: { id: "geometry", name: "Geometry" }, scene: geo },
            { def: { id: "plasma", name: "Plasma" }, scene: plasma },
            { def: { id: "warp", name: "DomainWarp" }, scene: warp },
            { def: { id: "cellular", name: "Cellular" }, scene: cellular },
            { def: { id: "tunnel", name: "Tunnel" }, scene: tunnel },
            { def: { id: "quasi", name: "Quasicrystals" }, scene: quasi },
            { def: { id: "rd", name: "ReactionDiffusion" }, scene: rd },
            { def: { id: "dla", name: "DLA" }, scene: dla },
            { def: { id: "bif", name: "Bifurcation" }, scene: bif },
            { def: { id: "wavelab", name: "WaveLab" }, scene: wave },
            { def: { id: "physics", name: "Physics" }, scene: phys },
            { def: { id: "physicsRope", name: "Physics Rope" }, scene: physRope },
            { def: { id: "physicsJelly", name: "Physics Jelly" }, scene: physJelly },
            { def: { id: "physicsChainmail", name: "Physics Chainmail" }, scene: physChainmail },
            { def: { id: "lloyd", name: "Lloyd" }, scene: lloyd },
            { def: { id: "rrt", name: "RRT" }, scene: rrt },
            { def: { id: "arboretum", name: "Arboretum" }, scene: arbor },
            { def: { id: "koch", name: "Koch" }, scene: koch },
            { def: { id: "bosWarp", name: "BoS Warp" }, scene: bosWarp },
            { def: { id: "kaleidoscope", name: "Kaleidoscope" }, scene: kalei },
            { def: { id: "metaballs", name: "Metaballs" }, scene: metaballs },
            { def: { id: "ascii", name: "ASCII" }, scene: ascii }
        ];
        window.addEventListener("resize", () => this.onResize());
        this.onResize();
    }
    get current() {
        return this.scenes[this.sceneIndex].def;
    }
    nextScene(delta) {
        const n = this.scenes.length;
        this.sceneIndex = (this.sceneIndex + delta + n) % n;
        const s = this.scenes[this.sceneIndex].scene;
        if (typeof s.setSafeMode === "function") {
            s.setSafeMode(this.safeMode);
        }
        this.catAmount = Math.max(this.catAmount, 0.9);
        return this.current;
    }
    update(control) {
        if (!this.renderEnabled)
            return;
        const s = this.scenes[this.sceneIndex].scene;
        s.update(control);
        this.postTime += control.dt;
        const bp = control.beatPulse ?? 0;
        this.postMat.uniforms.uChromAb.value = 0.55 + 0.25 * clamp01(bp);
        this.postMat.uniforms.uCrt.value = 0.85 + 0.10 * clamp01(bp);
        // Decay cat transition amount.
        this.catAmount = Math.max(0, this.catAmount - control.dt * 1.65);
        // Render scene to target first.
        this.renderer.setRenderTarget(this.rt);
        this.renderer.render(s.getScene(), this.camera);
        this.renderer.setRenderTarget(null);
        // Postprocess (cat map) to screen.
        const a = this.catAmount;
        this.postMat.uniforms.uAmount.value = a;
        this.postMat.uniforms.uIters.value = Math.floor(lerp(0, this.safeMode ? 2 : 3, a));
        this.postMat.uniforms.uTime.value = this.postTime;
        this.renderer.render(this.postScene, this.postCamera);
    }
    setRenderEnabled(on) {
        this.renderEnabled = on;
    }
    getRenderEnabled() {
        return this.renderEnabled;
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.renderScale = on ? 0.65 : 1;
        const s = this.scenes[this.sceneIndex].scene;
        if (typeof s.setSafeMode === "function") {
            s.setSafeMode(on);
        }
        this.onResize();
    }
    reset() {
        this.scenes[this.sceneIndex].scene.reset();
    }
    triggerBurst(amount) {
        const s = this.scenes[this.sceneIndex].scene;
        if (typeof s.triggerBurst === "function") {
            s.triggerBurst(amount);
        }
        // Use bursts as brief glitch transitions.
        this.catAmount = Math.max(this.catAmount, clamp01(amount) * 0.12);
    }
    onResize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.dpr = Math.min(1.25, window.devicePixelRatio || 1);
        const scale = this.renderScale;
        const iw = Math.max(1, Math.floor(w * this.dpr * scale));
        const ih = Math.max(1, Math.floor(h * this.dpr * scale));
        this.lastInternalW = iw;
        this.lastInternalH = ih;
        this.renderer.setSize(iw, ih, false);
        this.rt.setSize(iw, ih);
        this.postMat.uniforms.uInvRes.value.set(1 / Math.max(1, iw), 1 / Math.max(1, ih));
        for (const s of this.scenes) {
            if (typeof s.scene.onResize === "function") {
                s.scene.onResize(this.camera);
            }
        }
    }
}
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
