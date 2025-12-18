"use strict";
function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
}
function midiToHz(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
}
class DroneProcessor extends AudioWorkletProcessor {
    phase = 0;
    lfoPhase = 0;
    detunePhase = 0;
    subPhase = 0;
    seed = 22222;
    freq = 110;
    gain = 0.0;
    targetGain = 0.0;
    gate = 0.0;
    cutoff = 900;
    drive = 0.2;
    attackSec = 0.02;
    releaseSec = 0.15;
    detune = 0.003;
    sub = 0.25;
    noise = 0.02;
    env = 0;
    lfoHz = 0.18;
    lfoAmt = 0.12;
    // simple one-pole LP state
    lp = 0;
    // simple delay
    delayL = null;
    delayR = null;
    delayIdx = 0;
    delayTimeSec = 0.18;
    delayFb = 0.25;
    delayMix = 0.08;
    // rhythm
    bpm = 72;
    pulseAmt = 0.15;
    pulseDecaySec = 0.12;
    tickAmt = 0.10;
    tickDecaySec = 0.04;
    tickTone = 2400;
    step = 0;
    stepPhase = 0;
    pulseEnv = 0;
    tickEnv = 0;
    constructor() {
        super();
        this.port.onmessage = (ev) => {
            const m = ev.data;
            if (!m)
                return;
            if (m.type === "params") {
                this.freq = clamp(m.freq, 20, 2000);
                this.targetGain = clamp(m.gain, 0, 1.5);
                this.cutoff = clamp(m.cutoff, 40, 18000);
                this.drive = clamp(m.drive, 0, 2.5);
                this.lfoHz = clamp(m.lfoHz, 0, 12);
                this.lfoAmt = clamp(m.lfoAmt, 0, 1);
                this.attackSec = clamp(m.attack, 0.001, 2.0);
                this.releaseSec = clamp(m.release, 0.001, 4.0);
                this.detune = clamp(m.detune, 0, 0.02);
                this.sub = clamp(m.sub, 0, 1);
                this.noise = clamp(m.noise, 0, 0.5);
                this.delayTimeSec = clamp(m.delayTime, 0, 1.5);
                this.delayFb = clamp(m.delayFb, 0, 0.95);
                this.delayMix = clamp(m.delayMix, 0, 1);
                this.bpm = clamp(m.bpm, 20, 220);
                this.pulseAmt = clamp(m.pulseAmt, 0, 1);
                this.pulseDecaySec = clamp(m.pulseDecay, 0.005, 2.0);
                this.tickAmt = clamp(m.tickAmt, 0, 1);
                this.tickDecaySec = clamp(m.tickDecay, 0.002, 1.0);
                this.tickTone = clamp(m.tickTone, 120, 12000);
            }
            if (m.type === "gate") {
                this.gate = clamp(m.gate, 0, 1);
            }
        };
    }
    process(_inputs, outputs) {
        const out = outputs[0];
        if (!out || out.length < 1)
            return true;
        const ch0 = out[0];
        const ch1 = out[1] ?? out[0];
        const sr = sampleRate;
        const invSr = 1 / sr;
        if (!this.delayL || !this.delayR || this.delayL.length !== Math.floor(sr * 2.0)) {
            const n = Math.max(1, Math.floor(sr * 2.0));
            this.delayL = new Float32Array(n);
            this.delayR = new Float32Array(n);
            this.delayIdx = 0;
        }
        const dL = this.delayL;
        const dR = this.delayR;
        const dN = dL.length;
        // smooth gain (avoid zipper noise)
        const atk = 1 - Math.exp(-1 / (sr * Math.max(0.001, this.attackSec)));
        const rel = 1 - Math.exp(-1 / (sr * Math.max(0.001, this.releaseSec)));
        const pulseRel = 1 - Math.exp(-1 / (sr * Math.max(0.001, this.pulseDecaySec)));
        const tickRel = 1 - Math.exp(-1 / (sr * Math.max(0.001, this.tickDecaySec)));
        // 16th note stepper (4 steps per beat)
        const secPerBeat = 60 / Math.max(1e-6, this.bpm);
        const secPerStep = secPerBeat / 4;
        const stepInc = invSr / Math.max(1e-6, secPerStep);
        for (let i = 0; i < ch0.length; i++) {
            const gateTarget = this.gate > 0.5 ? this.targetGain : 0;
            const a = gateTarget > this.gain ? atk : rel;
            this.gain = this.gain + (gateTarget - this.gain) * a;
            // additional envelope for smoother perception
            const ea = gateTarget > this.env ? atk : rel;
            this.env = this.env + (gateTarget - this.env) * ea;
            // step clock
            this.stepPhase += stepInc;
            if (this.stepPhase >= 1) {
                this.stepPhase -= 1;
                this.step = (this.step + 1) & 15;
                // simple pattern: slow, drone-centric (anchors on 1 + occasional offbeats)
                const on = this.step === 0 || this.step === 8 || this.step === 12 || (this.step === 4 && (this.step & 1) === 0);
                if (on) {
                    this.pulseEnv = 1;
                    if (this.tickAmt > 0.001)
                        this.tickEnv = 1;
                }
            }
            // decay envelopes
            this.pulseEnv = this.pulseEnv + (0 - this.pulseEnv) * pulseRel;
            this.tickEnv = this.tickEnv + (0 - this.tickEnv) * tickRel;
            // LFO
            const lfo = Math.sin(this.lfoPhase * 2 * Math.PI);
            this.lfoPhase += this.lfoHz * invSr;
            if (this.lfoPhase >= 1)
                this.lfoPhase -= 1;
            const f = this.freq * (1 + lfo * this.lfoAmt);
            this.phase += f * invSr;
            if (this.phase >= 1)
                this.phase -= 1;
            const det = this.detune;
            this.detunePhase += f * (1 + det) * invSr;
            if (this.detunePhase >= 1)
                this.detunePhase -= 1;
            this.subPhase += (f * 0.5) * invSr;
            if (this.subPhase >= 1)
                this.subPhase -= 1;
            // waveform: tri + detuned tri + sub sine + tiny noise
            const tri = 1 - 4 * Math.abs(this.phase - 0.5);
            const tri2 = 1 - 4 * Math.abs(this.detunePhase - 0.5);
            const sub = Math.sin(this.subPhase * 2 * Math.PI);
            // xorshift-ish noise
            this.seed ^= this.seed << 13;
            this.seed ^= this.seed >> 17;
            this.seed ^= this.seed << 5;
            const n01 = (this.seed >>> 0) / 4294967295;
            const nz = (n01 * 2 - 1) * this.noise;
            let x = 0.62 * tri + 0.20 * tri2 + this.sub * 0.30 * sub + nz;
            // tick (short noise burst) - simple 1-pole BP-ish tone emphasis
            let tick = 0;
            if (this.tickEnv > 1e-5) {
                const tn = (n01 * 2 - 1);
                const tf = this.tickTone;
                // crude resonant feel: multiply by a fast sine at tf
                tick = tn * Math.sin((this.phase + this.detunePhase) * Math.PI * 2 * (tf / Math.max(1e-6, f)));
                tick *= this.tickEnv * this.tickAmt;
            }
            // 1-pole LP
            const c = clamp(this.cutoff, 40, 18000);
            const alpha = clamp((2 * Math.PI * c) / sr, 0.0005, 0.95);
            this.lp = this.lp + (x - this.lp) * alpha;
            x = this.lp;
            // drive
            const d = this.drive;
            x = Math.tanh(x * (1 + d * 3.2));
            // pulse/tremolo: make the drone breathe rhythmically
            const pulse = 1 + this.pulseAmt * this.pulseEnv;
            x *= pulse;
            // add tick after saturation to cut through
            x += tick;
            // output gain
            const g = this.gain;
            const dry = x * g * (0.30 + 0.08 * this.env);
            const delayTime = this.delayTimeSec;
            const delaySamp = Math.min(dN - 1, Math.max(0, Math.floor(delayTime * sr)));
            const readIdx = (this.delayIdx - delaySamp + dN) % dN;
            const dl = dL[readIdx] ?? 0;
            const dr = dR[readIdx] ?? 0;
            // small stereo spread in the feedback
            const fb = this.delayFb;
            dL[this.delayIdx] = dry + dl * fb;
            dR[this.delayIdx] = dry + dr * fb;
            this.delayIdx = (this.delayIdx + 1) % dN;
            const mix = this.delayMix;
            const outL = dry * (1 - mix) + dl * mix;
            const outR = dry * (1 - mix) + dr * mix;
            ch0[i] = outL;
            ch1[i] = outR;
        }
        return true;
    }
}
registerProcessor("drone-processor", DroneProcessor);
// Silence TS/ESLint about unused helpers in worklet scope
void midiToHz;
