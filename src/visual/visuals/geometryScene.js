import * as THREE from "three";
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
export class GeometryScene {
    scene = new THREE.Scene();
    group = new THREE.Group();
    rings = [];
    lineMat = new THREE.MeshBasicMaterial({ color: 0x9bf2ff, wireframe: true, transparent: true, opacity: 0.65 });
    bg = new THREE.Color(0x05060a);
    tmpColor = new THREE.Color();
    t = 0;
    burst = 0;
    constructor() {
        this.scene.background = this.bg;
        this.scene.add(this.group);
        const ringGeo = new THREE.TorusGeometry(0.9, 0.05, 10, 64);
        for (let i = 0; i < 42; i++) {
            const m = new THREE.Mesh(ringGeo, this.lineMat);
            m.position.z = -i * 0.45;
            this.group.add(m);
            this.rings.push(m);
        }
        const grid = new THREE.GridHelper(8, 28, 0x2340ff, 0x111a33);
        grid.position.y = -1.0;
        this.scene.add(grid);
        const light = new THREE.PointLight(0xffffff, 0.25);
        light.position.set(-0.8, 1.3, 1.5);
        this.scene.add(light);
    }
    getScene() {
        return this.scene;
    }
    reset() {
        this.t = 0;
        this.burst = 0;
    }
    triggerBurst(amount) {
        this.burst = Math.max(this.burst, clamp01(amount));
    }
    update(control) {
        const dt = control.dt;
        this.t += dt;
        this.burst = Math.max(0, this.burst - dt * 3.0);
        const bp = clamp01(control.beatPulse ?? 0);
        const build = clamp01(control.build);
        const wet = clamp01(control.rightPinch);
        const energy = clamp01(lerp(control.leftX, control.leftY, 0.5) + build * 0.7 + bp * 0.45);
        const speed = lerp(0.35, 2.1, energy) * (1.0 + this.burst * 0.75 + bp * 0.25);
        const wobble = lerp(0.02, 0.22, wet);
        this.lineMat.opacity = clamp01(lerp(0.35, 0.9, lerp(energy, wet, 0.35)) + this.burst * 0.35 + bp * 0.12);
        this.tmpColor.setHSL(lerp(0.56, 0.72, control.rightX), 0.9, lerp(0.45, 0.62, wet));
        this.lineMat.color.copy(this.tmpColor);
        for (let i = 0; i < this.rings.length; i++) {
            const r = this.rings[i];
            r.position.z += dt * speed;
            if (r.position.z > 1.2)
                r.position.z = -18.2;
            const phase = this.t * 1.8 + i * 0.35;
            r.rotation.x = Math.sin(phase) * wobble;
            r.rotation.y = Math.cos(phase * 0.8) * wobble;
            const s = lerp(1.0, 1.7, clamp01(build + bp * 0.18));
            r.scale.setScalar(s);
        }
        this.group.rotation.z = Math.sin(this.t * 0.35) * 0.08;
        this.group.position.x = lerp(-0.22, 0.22, control.rightY);
    }
    dispose() {
        this.lineMat.dispose();
        for (const r of this.rings) {
            r.geometry.dispose();
        }
    }
}
