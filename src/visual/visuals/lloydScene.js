import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
export class LloydScene {
    scene = new THREE.Scene();
    points;
    pointGeom;
    pointMat;
    lines;
    lineGeom;
    lineMat;
    t = 0;
    burst = 0;
    safeMode = false;
    n = 700;
    pts = [];
    tmpColorA = new THREE.Color();
    tmpColorB = new THREE.Color();
    bestJ = new Int32Array(10);
    bestD = new Float64Array(10);
    posPts;
    posLines;
    lineSegs = 0;
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        this.posPts = new Float32Array(this.n * 3);
        this.pointGeom = new THREE.BufferGeometry();
        this.pointGeom.setAttribute("position", new THREE.BufferAttribute(this.posPts, 3));
        this.pointMat = new THREE.PointsMaterial({
            size: 0.02,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            color: 0xc8fff4
        });
        this.points = new THREE.Points(this.pointGeom, this.pointMat);
        this.points.position.z = -0.35;
        this.scene.add(this.points);
        this.posLines = new Float32Array(this.n * 14 * 2 * 3);
        this.lineGeom = new THREE.BufferGeometry();
        this.lineGeom.setAttribute("position", new THREE.BufferAttribute(this.posLines, 3));
        this.lineMat = new THREE.LineBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.45 });
        this.lines = new THREE.LineSegments(this.lineGeom, this.lineMat);
        this.lines.position.z = -0.36;
        this.scene.add(this.lines);
        this.reset();
    }
    setSafeMode(on) {
        this.safeMode = on;
        const target = on ? 420 : 700;
        if (target !== this.n) {
            this.n = target;
            this.posPts = new Float32Array(this.n * 3);
            this.pointGeom.setAttribute("position", new THREE.BufferAttribute(this.posPts, 3));
            this.posLines = new Float32Array(this.n * 14 * 2 * 3);
            this.lineGeom.setAttribute("position", new THREE.BufferAttribute(this.posLines, 3));
            this.reset();
        }
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
        this.pts = new Array(this.n);
        for (let i = 0; i < this.n; i++) {
            this.pts[i] = {
                x: (Math.random() * 2 - 1) * 1.6,
                y: (Math.random() * 2 - 1) * 1.0,
                vx: 0,
                vy: 0
            };
        }
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
        const energy = clamp01((control.leftX + control.leftY) * 0.5 + control.build * 0.7);
        const wet = clamp01(control.rightPinch);
        const build = clamp01(control.build);
        // This is a "rave-adapted Lloyd": not exact Voronoi centroids (d3), but a stable centroidal effect.
        // Radius and relaxation strength are gesture-controlled.
        const radius = lerp(0.14, 0.55, clamp01(0.10 + wet * 0.65 + build * 0.4));
        const repel = lerp(0.002, 0.018, clamp01(0.25 + energy * 0.55 + spec * 0.35));
        const pull = lerp(0.01, 0.09, clamp01(0.15 + control.rightY * 0.85));
        const iters = 1 + Math.floor(lerp(1, this.safeMode ? 4 : 9, clamp01(build * 0.7 + kickEnv * 0.25 + this.burst * 0.7)));
        // attractor point from right hand
        const ax = (control.rightX * 2 - 1) * 1.55;
        const ay = (control.rightY * 2 - 1) * 1.0;
        // Extra physical field from hands: push/pull + swirl near palms.
        // Left pinch = pull, right pinch = push (plus speed adds impulse).
        const lh = control.hands?.hands?.find((h) => h.label === "Left")?.center ?? null;
        const rh = control.hands?.hands?.find((h) => h.label === "Right")?.center ?? null;
        const lfx = lh ? (lh.x * 2 - 1) * 1.55 : 0;
        const lfy = lh ? (lh.y * 2 - 1) * 1.0 : 0;
        const rfx = rh ? (rh.x * 2 - 1) * 1.55 : 0;
        const rfy = rh ? (rh.y * 2 - 1) * 1.0 : 0;
        const pullHand = clamp01(control.leftPinch);
        const pushHand = clamp01(control.rightPinch);
        const impulse = clamp01(control.rightSpeed * 0.9 + control.leftSpeed * 0.4);
        const fieldR = lerp(0.22, 0.70, clamp01(0.15 + wet * 0.6 + build * 0.35));
        const field = (0.001 + 0.010 * (pullHand + pushHand) + 0.006 * impulse) * (0.45 + 0.55 * clamp01(kickEnv + this.burst));
        const damp = 0.90;
        for (let iter = 0; iter < iters; iter++) {
            for (let i = 0; i < this.n; i++) {
                const p = this.pts[i];
                let cx = 0;
                let cy = 0;
                let cN = 0;
                // local centroid estimate + repulsion
                for (let j = 0; j < this.n; j++) {
                    if (j === i)
                        continue;
                    const q = this.pts[j];
                    const dx = p.x - q.x;
                    const dy = p.y - q.y;
                    const d2 = dx * dx + dy * dy + 1e-6;
                    const d = Math.sqrt(d2);
                    if (d < radius) {
                        cx += q.x;
                        cy += q.y;
                        cN++;
                    }
                    // repulsion falloff
                    if (d < radius * 0.9) {
                        const f = (repel / d2) * 0.035;
                        p.vx += dx * f;
                        p.vy += dy * f;
                    }
                }
                if (cN > 0) {
                    cx /= cN;
                    cy /= cN;
                    p.vx += (cx - p.x) * pull * 0.08;
                    p.vy += (cy - p.y) * pull * 0.08;
                }
                // weak attractor + beat kick
                const k = clamp01(kickEnv + this.burst);
                const att = (0.0002 + 0.002 * wet) * (0.35 + 0.65 * k);
                p.vx += (ax - p.x) * att;
                p.vy += (ay - p.y) * att;
                // Physical hand fields
                if (lh && pullHand > 0.05) {
                    const dx = lfx - p.x;
                    const dy = lfy - p.y;
                    const d2 = dx * dx + dy * dy + 1e-5;
                    const d = Math.sqrt(d2);
                    if (d < fieldR) {
                        const s = (field / d2) * (0.7 + 0.3 * (1.0 - d / fieldR));
                        p.vx += dx * s;
                        p.vy += dy * s;
                        // slight swirl
                        const sw = s * 0.65;
                        p.vx += -dy * sw;
                        p.vy += dx * sw;
                    }
                }
                if (rh && pushHand > 0.05) {
                    const dx = p.x - rfx;
                    const dy = p.y - rfy;
                    const d2 = dx * dx + dy * dy + 1e-5;
                    const d = Math.sqrt(d2);
                    if (d < fieldR) {
                        const s = (field / d2) * (0.8 + 0.2 * (1.0 - d / fieldR));
                        p.vx += dx * s;
                        p.vy += dy * s;
                        // opposite swirl
                        const sw = s * 0.55;
                        p.vx += dy * sw;
                        p.vy += -dx * sw;
                    }
                }
                p.vx *= damp;
                p.vy *= damp;
                p.x += p.vx;
                p.y += p.vy;
                // bounds
                p.x = Math.max(-1.65, Math.min(1.65, p.x));
                p.y = Math.max(-1.05, Math.min(1.05, p.y));
            }
        }
        // Render points
        for (let i = 0; i < this.n; i++) {
            const p = this.pts[i];
            const o = i * 3;
            this.posPts[o + 0] = p.x;
            this.posPts[o + 1] = p.y;
            this.posPts[o + 2] = 0;
        }
        this.pointGeom.getAttribute("position").needsUpdate = true;
        // Render kNN edges (visual Voronoi-ish feel)
        const kNN = this.safeMode ? 6 : 10;
        this.lineSegs = 0;
        const linesMax = (this.posLines.length / 6) | 0;
        for (let i = 0; i < this.n; i++) {
            const p = this.pts[i];
            // find nearest neighbors
            for (let k = 0; k < kNN; k++) {
                this.bestD[k] = Number.POSITIVE_INFINITY;
                this.bestJ[k] = -1;
            }
            for (let j = 0; j < this.n; j++) {
                if (j === i)
                    continue;
                const q = this.pts[j];
                const dx = p.x - q.x;
                const dy = p.y - q.y;
                const d = dx * dx + dy * dy;
                if (d >= this.bestD[kNN - 1])
                    continue;
                for (let k = 0; k < kNN; k++) {
                    if (d < this.bestD[k]) {
                        for (let s = kNN - 1; s > k; s--) {
                            this.bestD[s] = this.bestD[s - 1];
                            this.bestJ[s] = this.bestJ[s - 1];
                        }
                        this.bestD[k] = d;
                        this.bestJ[k] = j;
                        break;
                    }
                }
            }
            for (let k = 0; k < kNN; k++) {
                const jj = this.bestJ[k];
                if (jj < 0)
                    break;
                const q = this.pts[jj];
                if (this.lineSegs >= linesMax)
                    break;
                const o = this.lineSegs * 6;
                this.posLines[o + 0] = p.x;
                this.posLines[o + 1] = p.y;
                this.posLines[o + 2] = 0;
                this.posLines[o + 3] = q.x;
                this.posLines[o + 4] = q.y;
                this.posLines[o + 5] = 0;
                this.lineSegs++;
            }
        }
        this.lineGeom.setDrawRange(0, this.lineSegs * 2);
        this.lineGeom.getAttribute("position").needsUpdate = true;
        const hueA = lerp(0.52, 0.82, control.rightX);
        const hueB = lerp(0.02, 0.18, wet);
        this.tmpColorA.setHSL(hueA, 0.85, 0.60);
        this.tmpColorB.setHSL(hueB, 0.95, 0.62);
        this.pointMat.color.copy(this.tmpColorA);
        this.pointMat.size = this.safeMode ? 0.017 : lerp(0.016, 0.030, clamp01(0.25 + spec * 0.45 + kickEnv * 0.35 + this.burst * 0.8));
        this.lineMat.color.copy(this.tmpColorB);
        this.lineMat.opacity = lerp(0.10, 0.55, clamp01(0.2 + wet * 0.7 + spec * 0.25));
        this.points.rotation.z = Math.sin(this.t * 0.10) * 0.02;
        this.lines.rotation.z = Math.sin(this.t * 0.08) * 0.025;
    }
    dispose() {
        this.pointGeom.dispose();
        this.pointMat.dispose();
        this.lineGeom.dispose();
        this.lineMat.dispose();
    }
}
