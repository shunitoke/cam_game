import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}
function distPointSeg2(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0)
        return dist2(p, a);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1)
        return dist2(p, b);
    const t = c1 / c2;
    const px = a.x + t * vx;
    const py = a.y + t * vy;
    const dx = p.x - px;
    const dy = p.y - py;
    return dx * dx + dy * dy;
}
function rdp(points, eps2) {
    if (points.length <= 2)
        return points;
    let maxD = 0;
    let idx = -1;
    const a = points[0];
    const b = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
        const d = distPointSeg2(points[i], a, b);
        if (d > maxD) {
            maxD = d;
            idx = i;
        }
    }
    if (idx >= 0 && maxD > eps2) {
        const left = rdp(points.slice(0, idx + 1), eps2);
        const right = rdp(points.slice(idx), eps2);
        return left.slice(0, left.length - 1).concat(right);
    }
    return [a, b];
}
export class SimplifyScene {
    scene = new THREE.Scene();
    line;
    geom;
    mat;
    t = 0;
    burst = 0;
    safeMode = false;
    baseW = 4.2;
    baseH = 2.4;
    raw = [];
    simplified = [];
    lastEps = -1;
    lastSeed = 0;
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        this.mat = new THREE.LineBasicMaterial({ color: 0xc8fff4, transparent: true, opacity: 0.9 });
        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
        this.line = new THREE.Line(this.geom, this.mat);
        this.line.position.z = -0.35;
        this.scene.add(this.line);
        this.reset();
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.lastEps = -1;
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
        this.lastEps = -1;
        // Generate a "scribble" polyline (rave-friendly instead of a static SVG path)
        const n = this.safeMode ? 900 : 1600;
        this.raw = new Array(n);
        const seed = Math.floor((typeof performance !== "undefined" ? performance.now() : Date.now()) % 100000);
        this.lastSeed = seed;
        let x = 0;
        let y = 0;
        let a = Math.random() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            a += (Math.random() - 0.5) * 0.55;
            const r = 0.015 + 0.06 * (0.3 + 0.7 * Math.sin(t * Math.PI));
            x += Math.cos(a) * r;
            y += Math.sin(a) * r;
            x = Math.max(-1.55, Math.min(1.55, x));
            y = Math.max(-0.95, Math.min(0.95, y));
            this.raw[i] = { x, y };
        }
        this.simplified = this.raw;
    }
    rebuild(eps) {
        const eps2 = eps * eps;
        this.simplified = rdp(this.raw, eps2);
        const out = new Float32Array(this.simplified.length * 3);
        for (let i = 0; i < this.simplified.length; i++) {
            const p = this.simplified[i];
            const o = i * 3;
            out[o + 0] = p.x;
            out[o + 1] = p.y;
            out[o + 2] = 0;
        }
        this.geom.setAttribute("position", new THREE.BufferAttribute(out, 3));
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 2.8);
        const pack = (control.audioViz ?? {});
        const fft = pack.fft;
        const kick = pack.kick;
        let spec = 0;
        if (fft && fft.length) {
            const n = Math.min(fft.length, 96);
            let sum = 0;
            for (let i = 0; i < n; i++)
                sum += clamp01(((fft[i] ?? -120) + 120) / 120);
            spec = Math.pow(sum / n, 1.6);
        }
        let kickEnv = 0;
        if (kick && kick.length) {
            const n = Math.min(kick.length, 128);
            let peak = 0;
            for (let i = 0; i < n; i += 4)
                peak = Math.max(peak, Math.abs(kick[i] ?? 0));
            kickEnv = clamp01(peak * 2.2);
        }
        const wet = clamp01(control.rightPinch);
        const build = clamp01(control.build);
        // Main control: epsilon
        // - rightX: simplify amount
        // - build/kick/burst: temporarily increase epsilon (more brutal simplification)
        const eps = lerp(0.001, this.safeMode ? 0.045 : 0.070, clamp01(control.rightX * 0.9 + wet * 0.25 + build * 0.15 + kickEnv * 0.18 + this.burst * 0.35));
        if (this.lastEps < 0 || Math.abs(eps - this.lastEps) > 0.0015) {
            this.lastEps = eps;
            this.rebuild(eps);
        }
        // "Regenerate" on left pinch, but without binding to events (so it feels alive)
        if (control.leftPinch > 0.85 && Math.random() < 0.06) {
            this.reset();
            this.rebuild(this.lastEps < 0 ? eps : this.lastEps);
        }
        const hue = lerp(0.52, 0.92, clamp01(0.2 + wet * 0.5 + spec * 0.35));
        const lum = lerp(0.48, 0.70, clamp01(0.25 + kickEnv * 0.4 + this.burst * 0.65));
        this.mat.color.setHSL(hue, 0.92, lum);
        this.mat.opacity = lerp(0.18, 0.95, clamp01(0.25 + wet * 0.55 + spec * 0.35 + kickEnv * 0.25));
        const spin = (0.10 + 0.35 * wet + 0.18 * spec) * (1.0 + this.burst * 0.85);
        this.line.rotation.z = Math.sin(this.t * spin) * 0.12;
        this.line.rotation.x = lerp(-0.10, 0.10, control.rightY);
    }
    dispose() {
        this.geom.dispose();
        this.mat.dispose();
    }
}
