import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
export class PhysicsScene {
    scene = new THREE.Scene();
    line;
    geom;
    mat;
    nodes = [];
    links = [];
    tmpColor = new THREE.Color();
    safeMode = false;
    burst = 0;
    grabL = -1;
    grabR = -1;
    constructor() {
        this.scene.background = new THREE.Color(0x05060a);
        this.mat = new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.85 });
        const g = new THREE.BufferGeometry();
        const pts = new Float32Array(1800 * 3);
        g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
        this.geom = g;
        this.line = new THREE.LineSegments(g, this.mat);
        this.line.position.z = -0.35;
        this.scene.add(this.line);
        this.buildGrid();
    }
    buildGrid() {
        this.nodes = [];
        this.links = [];
        const cols = this.safeMode ? 14 : 18;
        const rows = this.safeMode ? 8 : 10;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const nx = (x / (cols - 1)) * 2.6 - 1.3;
                // Build from top (0.65) down to bottom (-0.65) so the cloth hangs from the top wall.
                const ny = 0.65 - (y / (rows - 1)) * 1.3;
                const pin = y === 0;
                this.nodes.push({ x: nx, y: ny, px: nx, py: ny, pin, pinLife: pin ? 1 : 0 });
            }
        }
        const idx = (x, y) => y * cols + x;
        const restX = 2.6 / (cols - 1);
        const restY = 1.3 / (rows - 1);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (x + 1 < cols)
                    this.links.push({ a: idx(x, y), b: idx(x + 1, y), len: restX });
                if (y + 1 < rows)
                    this.links.push({ a: idx(x, y), b: idx(x, y + 1), len: restY });
                if (x + 1 < cols && y + 1 < rows)
                    this.links.push({ a: idx(x, y), b: idx(x + 1, y + 1), len: Math.hypot(restX, restY) });
            }
        }
    }
    setSafeMode(on) {
        this.safeMode = on;
        this.buildGrid();
    }
    getScene() {
        return this.scene;
    }
    reset() {
        this.buildGrid();
        this.burst = 0;
    }
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    findNearestNode(x, y, maxD) {
        let best = -1;
        let bestD = maxD * maxD;
        for (let i = 0; i < this.nodes.length; i++) {
            const n = this.nodes[i];
            if (n.pin)
                continue;
            const dx = x - n.x;
            const dy = y - n.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD) {
                bestD = d2;
                best = i;
            }
        }
        return best;
    }
    applyGrab(hand, pinch, which) {
        if (!hand) {
            if (which === "L")
                this.grabL = -1;
            else
                this.grabR = -1;
            return;
        }
        const gx = (hand.x - 0.5) * 2.6;
        const gy = (0.5 - hand.y) * 1.3;
        const maxD = 0.32;
        const grabOn = pinch > 0.62;
        const grabOff = pinch < 0.42;
        let idx = which === "L" ? this.grabL : this.grabR;
        if (idx < 0 && grabOn) {
            idx = this.findNearestNode(gx, gy, maxD);
            if (idx >= 0) {
                if (which === "L")
                    this.grabL = idx;
                else
                    this.grabR = idx;
            }
        }
        if (idx >= 0) {
            const n = this.nodes[idx];
            // When grabbed, directly drag node with hand and inject velocity via prev position.
            const drag = clamp01((pinch - 0.55) / 0.45);
            const px = n.x;
            const py = n.y;
            n.x = n.x + (gx - n.x) * (0.55 + 0.35 * drag);
            n.y = n.y + (gy - n.y) * (0.55 + 0.35 * drag);
            n.px = px;
            n.py = py;
            if (grabOff) {
                if (which === "L")
                    this.grabL = -1;
                else
                    this.grabR = -1;
            }
        }
    }
    applyAttractor(hand, strength) {
        if (!hand)
            return;
        const ax = (hand.x - 0.5) * 2.6;
        const ay = (0.5 - hand.y) * 1.3;
        for (const n of this.nodes) {
            if (n.pin)
                continue;
            const dx = ax - n.x;
            const dy = ay - n.y;
            const d2 = dx * dx + dy * dy + 0.0008;
            const f = strength / d2;
            n.x += dx * f;
            n.y += dy * f;
        }
    }
    step(dt, build, tear) {
        const g = -0.38 * (1.0 - build * 0.7);
        const damp = this.safeMode ? 0.985 : 0.982;
        for (const n of this.nodes) {
            if (n.pin)
                continue;
            const vx = (n.x - n.px) * damp;
            const vy = (n.y - n.py) * damp;
            n.px = n.x;
            n.py = n.y;
            n.x += vx;
            n.y += vy + g * dt;
        }
        const iters = this.safeMode ? 2 : 3;
        const toTear = [];
        // Tearing threshold: lower threshold means easier tearing.
        // We bias tearing with pinch/speed (tear) so you can rip it deliberately.
        const baseStretch = this.safeMode ? 2.2 : 1.85;
        const stretch = Math.max(1.35, baseStretch - tear * 0.55);
        for (let k = 0; k < iters; k++) {
            for (let li = 0; li < this.links.length; li++) {
                const l = this.links[li];
                const a = this.nodes[l.a];
                const b = this.nodes[l.b];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.hypot(dx, dy) + 1e-6;
                if (!this.safeMode && tear > 0.15 && d > l.len * stretch) {
                    toTear.push(li);
                    continue;
                }
                const diff = (d - l.len) / d;
                const s = 0.5;
                if (!a.pin) {
                    a.x += dx * diff * s;
                    a.y += dy * diff * s;
                }
                if (!b.pin) {
                    b.x -= dx * diff * s;
                    b.y -= dy * diff * s;
                }
            }
        }
        if (toTear.length) {
            const kill = new Set(toTear);
            this.links = this.links.filter((_, i) => !kill.has(i));
        }
        // Detach only after heavy shredding: pinned points break only when they have almost no remaining links.
        if (!this.safeMode && tear > 0.85) {
            const incident = new Array(this.nodes.length).fill(0);
            for (const l of this.links) {
                incident[l.a]++;
                incident[l.b]++;
            }
            for (let i = 0; i < this.nodes.length; i++) {
                const n = this.nodes[i];
                if (!n.pin || !n.pinLife)
                    continue;
                const weak = incident[i] <= 1;
                if (weak && Math.random() < 0.01 + tear * 0.02) {
                    n.pin = false;
                    n.pinLife = 0;
                }
            }
        }
    }
    update(control) {
        const dt = Math.min(0.033, control.dt);
        const build = clamp01(control.build);
        this.burst = Math.max(0, this.burst - dt * 2.6);
        const left = control.hands?.hands?.find((h) => h.label === "Left")?.center ?? null;
        const right = control.hands?.hands?.find((h) => h.label === "Right")?.center ?? null;
        const burstMul = 1.0 + this.burst * 0.9;
        const attract = (0.0015 + control.rightPinch * 0.004) * burstMul;
        const repel = (0.0008 + control.rightSpeed * 0.003) * burstMul;
        // Physical grabs: pinch to grab and drag cloth nodes.
        this.applyGrab(left, control.leftPinch, "L");
        this.applyGrab(right, control.rightPinch, "R");
        this.applyAttractor(left, attract);
        if (right)
            this.applyAttractor({ x: 1 - right.x, y: right.y }, -repel);
        const tear = clamp01(Math.max(control.rightPinch, control.leftPinch) * 0.9 + control.rightSpeed * 0.35 + this.burst * 0.65);
        this.step(dt, build, tear);
        const pts = this.geom.getAttribute("position").array;
        let w = 0;
        for (const l of this.links) {
            const a = this.nodes[l.a];
            const b = this.nodes[l.b];
            pts[w++] = a.x;
            pts[w++] = a.y;
            pts[w++] = 0;
            pts[w++] = b.x;
            pts[w++] = b.y;
            pts[w++] = 0;
        }
        this.geom.setDrawRange(0, w / 3);
        this.geom.getAttribute("position").needsUpdate = true;
        const hue = 0.46 + control.leftX * 0.25;
        this.tmpColor.setHSL(hue, 0.9, 0.6);
        this.mat.color.copy(this.tmpColor);
        this.mat.opacity = this.safeMode ? 0.7 : 0.9;
    }
    dispose() {
        this.geom.dispose();
        this.mat.dispose();
    }
}
