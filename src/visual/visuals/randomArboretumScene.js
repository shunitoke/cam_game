import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
export class RandomArboretumScene {
    scene = new THREE.Scene();
    line;
    geom;
    mat;
    segments = [];
    maxSegs = 22000;
    segCount = 0;
    safeMode = false;
    t = 0;
    burst = 0;
    tmpColor = new THREE.Color();
    grabIdx = -1;
    grabOffX = 0;
    grabOffY = 0;
    lastPluckT = 0;
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        this.mat = new THREE.LineBasicMaterial({ color: 0xa0ffe8, transparent: true, opacity: 0.9 });
        this.geom = new THREE.BufferGeometry();
        const pts = new Float32Array(this.maxSegs * 2 * 3);
        this.geom.setAttribute("position", new THREE.BufferAttribute(pts, 3));
        this.line = new THREE.LineSegments(this.geom, this.mat);
        this.line.position.z = -0.35;
        this.scene.add(this.line);
        this.reset();
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.maxSegs = on ? 11000 : 22000;
        const pts = new Float32Array(this.maxSegs * 2 * 3);
        this.geom.setAttribute("position", new THREE.BufferAttribute(pts, 3));
        this.reset();
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
        this.segments = [];
        this.segCount = 0;
        // seed a few trunks
        const trunks = this.safeMode ? 2 : 4;
        for (let i = 0; i < trunks; i++) {
            const x = lerp(-0.9, 0.9, (i + 0.5) / trunks);
            this.segments.push({ x0: x, y0: -1.05, x1: x, y1: -0.35, depth: 0 });
        }
    }
    growOne(params) {
        if (this.segCount >= this.maxSegs)
            return;
        if (!this.segments.length)
            return;
        const i = (Math.random() * this.segments.length) | 0;
        const b = this.segments[i];
        if (b.depth >= params.maxDepth)
            return;
        const dx = b.x1 - b.x0;
        const dy = b.y1 - b.y0;
        const baseA = Math.atan2(dy, dx);
        const baseLen = params.len * lerp(1.0, 0.72, b.depth / Math.max(1, params.maxDepth));
        const angleJ = (Math.random() - 0.5) * params.jitter;
        const a = baseA + angleJ;
        const nx = b.x1 + Math.cos(a) * baseLen;
        const ny = b.y1 + Math.sin(a) * baseLen;
        const n = { x0: b.x1, y0: b.y1, x1: nx, y1: ny, depth: b.depth + 1 };
        this.segments.push(n);
        this.segCount++;
        // occasional split
        if (Math.random() < params.split) {
            const a2 = baseA + (Math.random() < 0.5 ? -1 : 1) * (params.branch + Math.random() * params.jitter);
            const nx2 = b.x1 + Math.cos(a2) * (baseLen * lerp(0.75, 1.05, Math.random()));
            const ny2 = b.y1 + Math.sin(a2) * (baseLen * lerp(0.75, 1.05, Math.random()));
            this.segments.push({ x0: b.x1, y0: b.y1, x1: nx2, y1: ny2, depth: b.depth + 1 });
            this.segCount++;
        }
    }
    update(control) {
        this.t += control.dt;
        this.burst = Math.max(0, this.burst - control.dt * 2.6);
        const bp = clamp01(control.beatPulse ?? 0);
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
        const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
        const wet = clamp01(control.rightPinch);
        const build = clamp01(control.build);
        const leftY = clamp01(control.leftY);
        const rh = control.hands?.hands?.find((h) => h.label === "Right")?.center ?? null;
        const pinch = clamp01(control.rightPinch);
        const rSpeed = clamp01(control.rightSpeed);
        const hx = rh ? (rh.x * 2 - 1) * 1.65 : 0;
        const hy = rh ? (rh.y * 2 - 1) * 1.05 : 0;
        // Grab a branch tip and drag it around.
        const grabOn = pinch > 0.65;
        const grabOff = pinch < 0.45;
        if (!rh) {
            this.grabIdx = -1;
        }
        else if (this.grabIdx < 0 && grabOn) {
            let best = -1;
            let bestD = 0.18 * 0.18;
            const nSeg = Math.min(this.segments.length, this.maxSegs);
            for (let i = 0; i < nSeg; i++) {
                const s = this.segments[i];
                const dx = hx - s.x1;
                const dy = hy - s.y1;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD) {
                    bestD = d2;
                    best = i;
                }
            }
            if (best >= 0) {
                this.grabIdx = best;
                const s = this.segments[best];
                this.grabOffX = s.x1 - hx;
                this.grabOffY = s.y1 - hy;
            }
        }
        if (this.grabIdx >= 0 && rh) {
            const s = this.segments[this.grabIdx];
            const tx = hx + this.grabOffX;
            const ty = hy + this.grabOffY;
            const k = clamp01((pinch - 0.55) / 0.45);
            const nx = s.x1 + (tx - s.x1) * (0.20 + 0.55 * k);
            const ny = s.y1 + (ty - s.y1) * (0.20 + 0.55 * k);
            const dx = nx - s.x1;
            const dy = ny - s.y1;
            // Move tip
            s.x1 = nx;
            s.y1 = ny;
            // Propagate to immediate children (segments whose start is near this tip)
            const nSeg = Math.min(this.segments.length, this.maxSegs);
            for (let i = 0; i < nSeg; i++) {
                if (i === this.grabIdx)
                    continue;
                const b = this.segments[i];
                const ddx = b.x0 - s.x1;
                const ddy = b.y0 - s.y1;
                if (ddx * ddx + ddy * ddy < 0.03 * 0.03) {
                    b.x0 += dx;
                    b.y0 += dy;
                    b.x1 += dx * 0.85;
                    b.y1 += dy * 0.85;
                }
            }
            // Pluck: fast yank + release removes nearby segments and punches burst.
            if (grabOff && rSpeed > 0.55 && this.t - this.lastPluckT > 0.25) {
                this.lastPluckT = this.t;
                this.burst = Math.max(this.burst, 0.85);
                const cx = s.x1;
                const cy = s.y1;
                const rad2 = (0.22 + 0.18 * wet) * (0.22 + 0.18 * wet);
                this.segments = this.segments.filter((q, i) => {
                    if (i < 4)
                        return true;
                    const mx = (q.x0 + q.x1) * 0.5;
                    const my = (q.y0 + q.y1) * 0.5;
                    const ddx = mx - cx;
                    const ddy = my - cy;
                    return ddx * ddx + ddy * ddy > rad2;
                });
                this.segCount = Math.min(this.segCount, this.segments.length);
                this.grabIdx = -1;
            }
            if (grabOff) {
                this.grabIdx = -1;
            }
        }
        // Gestures:
        // - leftY -> depth/size
        // - leftX -> branching angle
        // - rightX -> randomness/jitter
        // - rightY -> growth rate
        const maxDepth = Math.floor(lerp(8, this.safeMode ? 16 : 22, clamp01(0.2 + leftY * 0.75 + build * 0.55)));
        const branch = lerp(0.25, 1.2, clamp01(0.2 + control.leftX * 0.8));
        const jitter = lerp(0.05, 1.25, clamp01(control.rightX * 0.9 + wet * 0.35));
        const split = lerp(0.02, 0.12, clamp01(0.15 + spec * 0.5 + build * 0.35 + bp * 0.25 + this.burst * 0.6));
        const len = lerp(0.05, 0.14, clamp01(0.2 + energy * 0.55));
        // growth ticks per frame
        const ticks = Math.floor(lerp(10, this.safeMode ? 80 : 160, clamp01(control.rightY * 0.75 + kickEnv * 0.25 + bp * 0.18 + this.burst * 0.7)));
        for (let i = 0; i < ticks; i++) {
            this.growOne({ branch, jitter, split, maxDepth, len, curl: 0 });
            if (this.segCount >= this.maxSegs)
                break;
        }
        // Auto-reset when full (or on hard build peaks)
        if (this.segCount >= this.maxSegs - 64 || (build > 0.95 && kickEnv > 0.6 && Math.random() < 0.02)) {
            this.reset();
        }
        // Upload line segments
        const pts = this.geom.getAttribute("position").array;
        const nSeg = Math.min(this.segments.length, this.maxSegs);
        for (let i = 0; i < nSeg; i++) {
            const s = this.segments[i];
            const o = i * 6;
            pts[o + 0] = s.x0;
            pts[o + 1] = s.y0;
            pts[o + 2] = 0;
            pts[o + 3] = s.x1;
            pts[o + 4] = s.y1;
            pts[o + 5] = 0;
        }
        this.geom.setDrawRange(0, nSeg * 2);
        this.geom.getAttribute("position").needsUpdate = true;
        const hue = lerp(0.38, 0.92, clamp01(control.rightX));
        this.tmpColor.setHSL(hue, 0.9, lerp(0.52, 0.68, wet));
        this.mat.color.copy(this.tmpColor);
        this.mat.opacity = lerp(0.18, 0.95, clamp01(0.22 + energy * 0.55 + spec * 0.25 + kickEnv * 0.35 + bp * 0.25));
        this.line.rotation.z = Math.sin(this.t * 0.08) * 0.03;
    }
    dispose() {
        this.geom.dispose();
        this.mat.dispose();
    }
}
