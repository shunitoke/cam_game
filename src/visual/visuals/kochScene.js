import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
export class KochScene {
    scene = new THREE.Scene();
    line;
    geom;
    mat;
    pos;
    posAttr;
    posCount = 0;
    t = 0;
    burst = 0;
    safeMode = false;
    baseW = 4.2;
    baseH = 2.4;
    lastDepth = -1;
    lastWarp = -1;
    lastTileKey = "";
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        this.mat = new THREE.LineBasicMaterial({ color: 0xa0ffe8, transparent: true, opacity: 0.9 });
        this.geom = new THREE.BufferGeometry();
        this.pos = new Float32Array(0);
        this.posAttr = new THREE.BufferAttribute(this.pos, 3);
        this.geom.setAttribute("position", this.posAttr);
        this.geom.setDrawRange(0, 0);
        this.line = new THREE.LineSegments(this.geom, this.mat);
        this.line.position.z = -0.35;
        this.scene.add(this.line);
        this.reset();
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.lastDepth = -1;
    }
    onResize(camera) {
        const cam = camera;
        const dist = Math.abs((cam.position?.z ?? 2.2) - (this.line?.position?.z ?? -0.35));
        const vFov = ((cam.fov ?? 55) * Math.PI) / 180;
        const height = 2 * dist * Math.tan(vFov * 0.5);
        const width = height * (cam.aspect ?? window.innerWidth / window.innerHeight);
        this.line.scale.set(width / this.baseW, height / this.baseH, 1);
    }
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    getScene() {
        return this.scene;
    }
    reset() {
        this.t = 0;
        this.burst = 0;
        this.lastDepth = -1;
        this.lastWarp = -1;
        this.lastTileKey = "";
    }
    build(depth, warp, tilesX, tilesY) {
        // Start with an equilateral triangle (snowflake base)
        const s = 1.25;
        const h = (Math.sqrt(3) / 2) * s;
        const p0 = { x: -s * 0.5, y: -h * 0.35 };
        const p1 = { x: s * 0.5, y: -h * 0.35 };
        const p2 = { x: 0, y: h * 0.65 };
        let segs = [
            { a: p0, b: p1 },
            { a: p1, b: p2 },
            { a: p2, b: p0 }
        ];
        const theta = Math.PI / 3;
        for (let d = 0; d < depth; d++) {
            const next = [];
            for (const s0 of segs) {
                const ax = s0.a.x;
                const ay = s0.a.y;
                const bx = s0.b.x;
                const by = s0.b.y;
                const vx = bx - ax;
                const vy = by - ay;
                const pA = { x: ax, y: ay };
                const pB = { x: ax + vx / 3, y: ay + vy / 3 };
                const pD = { x: ax + (vx * 2) / 3, y: ay + (vy * 2) / 3 };
                const pE = { x: bx, y: by };
                // peak point
                const px = pB.x + (vx / 3) * Math.cos(theta) - (vy / 3) * Math.sin(theta);
                const py = pB.y + (vx / 3) * Math.sin(theta) + (vy / 3) * Math.cos(theta);
                const pC = { x: px, y: py };
                next.push({ a: pA, b: pB }, { a: pB, b: pC }, { a: pC, b: pD }, { a: pD, b: pE });
            }
            segs = next;
            if (this.safeMode && segs.length > 12000)
                break;
        }
        // Tile across the screen: make a wallpaper of snowflakes.
        // We first warp one snowflake, then duplicate it with translations.
        const w = clamp01(warp);
        const warpP = (p) => {
            const r = Math.hypot(p.x, p.y) + 1e-6;
            const a = Math.atan2(p.y, p.x);
            const aa = a + w * (0.35 + r * 0.75);
            const rr = r * (1.0 + w * 0.08 * Math.sin(a * 7.0 + r * 9.0));
            return { x: Math.cos(aa) * rr, y: Math.sin(aa) * rr };
        };
        const warped = new Array(segs.length);
        for (let i = 0; i < segs.length; i++) {
            const s0 = segs[i];
            const a = warpP(s0.a);
            const b = warpP(s0.b);
            warped[i] = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
        }
        const tx = Math.max(1, Math.floor(tilesX));
        const ty = Math.max(1, Math.floor(tilesY));
        const pitchX = 1.55;
        const pitchY = 1.05;
        const scale = 0.86;
        const totalSegs = warped.length * tx * ty;
        const needed = totalSegs * 2 * 3;
        if (this.pos.length < needed) {
            // Grow buffer (avoid constant reallocations). Rebind attribute to new array.
            this.pos = new Float32Array(needed);
            this.posAttr = new THREE.BufferAttribute(this.pos, 3);
            this.geom.setAttribute("position", this.posAttr);
        }
        let wri = 0;
        for (let iy = 0; iy < ty; iy++) {
            for (let ix = 0; ix < tx; ix++) {
                const ox = (ix - (tx - 1) * 0.5) * pitchX;
                const oy = (iy - (ty - 1) * 0.5) * pitchY;
                for (let i = 0; i < warped.length; i++) {
                    const s0 = warped[i];
                    this.pos[wri++] = (s0.ax * scale + ox);
                    this.pos[wri++] = (s0.ay * scale + oy);
                    this.pos[wri++] = 0;
                    this.pos[wri++] = (s0.bx * scale + ox);
                    this.pos[wri++] = (s0.by * scale + oy);
                    this.pos[wri++] = 0;
                }
            }
        }
        this.posCount = wri / 3;
        this.geom.setDrawRange(0, this.posCount);
        this.posAttr.needsUpdate = true;
        this.geom.computeBoundingSphere();
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 3.0);
        const pack = (control.audioViz ?? {});
        const fft = pack.fft;
        const kick = pack.kick;
        let spec = 0;
        if (fft && fft.length) {
            const n = Math.min(fft.length, 96);
            let sum = 0;
            for (let i = 0; i < n; i++)
                sum += clamp01(((fft[i] ?? -120) + 120) / 120);
            spec = Math.pow(sum / n, 1.7);
        }
        let kickEnv = 0;
        if (kick && kick.length) {
            const n = Math.min(kick.length, 128);
            let peak = 0;
            for (let i = 0; i < n; i += 4)
                peak = Math.max(peak, Math.abs(kick[i] ?? 0));
            kickEnv = clamp01(peak * 2.2);
        }
        const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
        const wet = clamp01(control.rightPinch);
        const build = clamp01(control.build);
        const maxDepth = this.safeMode ? 5 : 6;
        const depth = Math.floor(lerp(2, maxDepth, clamp01(0.15 + control.leftY * 0.7 + build * 0.55 + this.burst * 0.65)));
        const warp = clamp01(0.05 + wet * 0.85 + spec * 0.35);
        // Tile count: fill the screen with a wallpaper.
        // RightY increases tiling density; build adds a little; safe mode reduces.
        const tilesX = this.safeMode ? 2 : Math.floor(lerp(2, 4, clamp01(0.15 + control.rightY * 0.75 + build * 0.25)));
        const tilesY = this.safeMode ? 2 : Math.floor(lerp(2, 3, clamp01(0.10 + control.rightY * 0.65 + spec * 0.2)));
        const tileKey = `${tilesX}x${tilesY}`;
        // rebuild geometry only when parameters change enough
        if (depth !== this.lastDepth || Math.abs(warp - this.lastWarp) > 0.08 || tileKey !== this.lastTileKey) {
            this.lastDepth = depth;
            this.lastWarp = warp;
            this.lastTileKey = tileKey;
            this.build(depth, warp, tilesX, tilesY);
        }
        const hue = lerp(0.55, 0.92, clamp01(control.rightX));
        const lum = lerp(0.52, 0.70, clamp01(0.25 + spec * 0.45 + kickEnv * 0.35 + this.burst * 0.75));
        this.mat.color.setHSL(hue, 0.92, lum);
        this.mat.opacity = lerp(0.20, 0.95, clamp01(0.25 + energy * 0.55 + kickEnv * 0.35));
        const spin = (0.08 + 0.55 * energy + 0.35 * build) * (1.0 + this.burst * 0.75);
        this.line.rotation.z += control.dt * spin;
    }
    dispose() {
        this.geom.dispose();
        this.mat.dispose();
    }
}
