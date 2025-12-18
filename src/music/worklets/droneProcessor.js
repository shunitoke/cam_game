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
    mode = "drone";
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
    // rave voices
    kickPhase = 0;
    kickEnv = 0;
    kickPitchEnv = 0;
    bassPhase = 0;
    bassEnv = 0;
    bassHz = 55;
    hatHp = 0;
    // Sunn O))) underlay (drone mode)
    doomPhase = 0;
    doomLfoPhase = 0;
    // Karplus-Strong guitar (drone mode)
    guitarBuf = null;
    guitarIdx = 0;
    guitarLen = 0;
    guitarLp = 0;
    guitarHp = 0;
    guitarPrev = 0;
    guitarFreq = 196;
    guitarBright = 0.6;
    guitarGate = 0;
    guitarEnv = 0;
    guitarPluckEnv = 0;
    guitarOscPhase = 0;
    guitarCabLP = 0;
    guitarCabNotch = 0;
    guitarLow = 0;
    constructor() {
        super();
        this.port.onmessage = (ev) => {
            const m = ev.data;
            if (!m)
                return;
            if (m.type === "params") {
                this.mode = m.mode === "performance" ? "performance" : "drone";
                this.freq = clamp(m.freq, 20, 2000);
                this.targetGain = clamp(m.gain, 0, 1.0);
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
                this.guitarFreq = clamp(m.guitarFreq, 40, 900);
                this.guitarBright = clamp(m.guitarBright, 0, 1);
                this.guitarGate = clamp(m.guitarGate, 0, 1);
                if (m.guitarPluck > 0.5) {
                    // will be handled in process loop (ensures buffer exists with correct sr)
                    this.guitarIdx = -1;
                    this.guitarPluckEnv = 1;
                }
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
        // Karplus-Strong buffer: up to ~1.2s (low notes)
        if (!this.guitarBuf || this.guitarBuf.length !== Math.floor(sr * 1.2)) {
            this.guitarBuf = new Float32Array(Math.max(1, Math.floor(sr * 1.2)));
            this.guitarIdx = 0;
            this.guitarLp = 0;
            this.guitarHp = 0;
        }
        const gBuf = this.guitarBuf;
        const gN = gBuf.length;
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
        const guitarAtk = 1 - Math.exp(-1 / (sr * 0.020));
        const guitarRel = 1 - Math.exp(-1 / (sr * 0.120));
        const pluckRel = 1 - Math.exp(-1 / (sr * 0.055));
        // 16th note stepper (4 steps per beat)
        const secPerBeat = 60 / Math.max(1e-6, this.bpm);
        const secPerStep = secPerBeat / 4;
        const stepInc = invSr / Math.max(1e-6, secPerStep);
        for (let i = 0; i < ch0.length; i++) {
            const gateTarget = this.mode === "performance" ? 1 : (this.gate > 0.5 ? this.targetGain : 0);
            const a = gateTarget > this.gain ? atk : rel;
            this.gain = this.gain + (gateTarget - this.gain) * a;
            // additional envelope for smoother perception
            const ea = gateTarget > this.env ? atk : rel;
            this.env = this.env + (gateTarget - this.env) * ea;
            // Guitar envelope (sustained while pinched)
            const gTarget = this.guitarGate;
            const ga = gTarget > this.guitarEnv ? guitarAtk : guitarRel;
            this.guitarEnv = this.guitarEnv + (gTarget - this.guitarEnv) * ga;
            // Pluck envelope (short transient layer, should be silent if no pluck triggers)
            this.guitarPluckEnv = this.guitarPluckEnv + (0 - this.guitarPluckEnv) * pluckRel;
            // step clock
            this.stepPhase += stepInc;
            if (this.stepPhase >= 1) {
                this.stepPhase -= 1;
                this.step = (this.step + 1) & 15;
                if (this.mode === "performance") {
                    // RAVE: kick on 1+3, hats on offbeats, bass on a simple 16-step lane.
                    const kickOn = this.step === 0 || this.step === 8;
                    if (kickOn) {
                        this.kickEnv = 1;
                        this.kickPitchEnv = 1;
                        this.pulseEnv = 1;
                    }
                    const hatOn = (this.step & 1) === 1;
                    if (hatOn) {
                        this.tickEnv = 1;
                    }
                    const bassOn = this.step === 2 || this.step === 6 || this.step === 10 || this.step === 14;
                    if (bassOn) {
                        this.bassEnv = 1;
                        // two-note-ish feel
                        this.bassHz = (this.step === 6 || this.step === 14) ? 73.42 : 65.41; // D2 / C2
                    }
                }
                else {
                    // DRONE: slow, drone-centric (anchors on 1 + occasional offbeats)
                    const on = this.step === 0 || this.step === 8 || this.step === 12;
                    if (on) {
                        this.pulseEnv = 1;
                        if (this.tickAmt > 0.001)
                            this.tickEnv = 1;
                    }
                }
            }
            // decay envelopes
            this.pulseEnv = this.pulseEnv + (0 - this.pulseEnv) * pulseRel;
            this.tickEnv = this.tickEnv + (0 - this.tickEnv) * tickRel;
            // rave envelopes
            const kickRel = 1 - Math.exp(-1 / (sr * 0.18));
            const kickPitchRel = 1 - Math.exp(-1 / (sr * 0.05));
            const bassRel = 1 - Math.exp(-1 / (sr * 0.12));
            this.kickEnv = this.kickEnv + (0 - this.kickEnv) * kickRel;
            this.kickPitchEnv = this.kickPitchEnv + (0 - this.kickPitchEnv) * kickPitchRel;
            this.bassEnv = this.bassEnv + (0 - this.bassEnv) * bassRel;
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
            // In RAVE (performance) mode, the worklet should not output a continuous drone bed.
            // RAVE sound comes from the sample-based drum scheduler on the main thread.
            if (this.mode === "performance") {
                x = 0;
            }
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
            // Note: RAVE drums are sample-based (scheduled on main thread).
            // Keep this worklet focused on DRONE textures + guitar.
            // DRONE underlay: heavy sub + slow movement (Sunn O))) vibe)
            if (this.mode === "drone") {
                const doomHz = Math.max(22, Math.min(68, this.freq * 0.25));
                this.doomPhase += doomHz * invSr;
                if (this.doomPhase >= 1)
                    this.doomPhase -= 1;
                this.doomLfoPhase += 0.035 * invSr;
                if (this.doomLfoPhase >= 1)
                    this.doomLfoPhase -= 1;
                const doomLfo = 0.65 + 0.35 * Math.sin(this.doomLfoPhase * 2 * Math.PI);
                const doom = Math.sin(this.doomPhase * 2 * Math.PI);
                const doomDrive = 1.0 + this.drive * 1.25 + this.sub * 1.35;
                const doomSat = Math.tanh(doom * doomDrive);
                x += doomSat * doomLfo * this.env * (0.28 + 0.22 * this.sub);
            }
            // DRONE guitar: Karplus-Strong pluck, triggered by right pinch edge
            if (this.mode === "drone") {
                const freq = this.guitarFreq;
                const desiredLen = Math.max(16, Math.min(gN - 1, Math.floor(sr / Math.max(1e-6, freq))));
                this.guitarLen = desiredLen;
                // pluck requested via special idx=-1
                if (this.guitarIdx < 0) {
                    this.guitarIdx = 0;
                    // fill delay line with noise burst
                    for (let k = 0; k < this.guitarLen; k++) {
                        // reuse RNG state; cheap noise
                        this.seed ^= this.seed << 13;
                        this.seed ^= this.seed >> 17;
                        this.seed ^= this.seed << 5;
                        const r01 = (this.seed >>> 0) / 4294967295;
                        gBuf[k] = (r01 * 2 - 1) * (0.85 + 0.15 * this.guitarBright);
                    }
                    for (let k = this.guitarLen; k < gN; k++) {
                        gBuf[k] = 0;
                    }
                }
                // process one sample of the string
                const idx = this.guitarIdx;
                const next = idx + 1;
                const a0 = gBuf[idx] ?? 0;
                const a1 = gBuf[next >= this.guitarLen ? 0 : next] ?? 0;
                let y = 0.5 * (a0 + a1);
                // lowpass in the loop, brightness controls damping
                const damp = 0.18 + (1 - this.guitarBright) * 0.68;
                this.guitarLp = this.guitarLp + (y - this.guitarLp) * damp;
                y = this.guitarLp;
                // write back (feedback slightly < 1)
                const fb = 0.992 - (1 - this.guitarBright) * 0.018;
                gBuf[idx] = y * fb;
                this.guitarIdx = next >= this.guitarLen ? 0 : next;
                // highpass-ish output to avoid too much sub rumble
                // DC blocker: yHP[n] = a*(yHP[n-1] + x[n] - x[n-1])
                const hpA = 0.995;
                this.guitarHp = hpA * (this.guitarHp + y - this.guitarPrev);
                this.guitarPrev = y;
                const gOut = this.guitarHp;
                // Transient only: should NOT be heard as "pluck" unless explicitly triggered.
                const pe = this.guitarPluckEnv;
                const gGain = (0.45 + 0.35 * this.guitarBright) * pe;
                x += gOut * gGain;
            }
            // DRONE sustained "amp" guitar (Sunn O))) vibe): drones while right pinch held
            if (this.mode === "drone" && this.guitarEnv > 1e-4) {
                const f0 = this.guitarFreq;
                this.guitarOscPhase += f0 * invSr;
                if (this.guitarOscPhase >= 1)
                    this.guitarOscPhase -= 1;
                // Thick saw-ish + sub harmonic
                const saw = 2 * this.guitarOscPhase - 1;
                const sub = Math.sin(this.guitarOscPhase * Math.PI); // 1/2 harmonic
                const raw = 0.72 * saw + 0.28 * sub;
                // Sustain envelope
                const env = this.guitarEnv;
                // Two-stage fuzz amp stack
                // Stage 1: preamp drive (brightness = more bite)
                const pre = 2.8 + 7.5 * (0.35 + 0.65 * this.guitarGate) + 2.2 * this.drive;
                let amp = Math.tanh(raw * pre);
                // Low-end boost around ~100Hz (crude one-pole low shelf feel)
                // Extract a low band, then mix it back in.
                const lowA = 0.014; // ~100Hz @ 48k (rough)
                this.guitarLow = this.guitarLow + (amp - this.guitarLow) * lowA;
                const lowBoost = 0.65 + 0.85 * (0.35 + 0.65 * this.sub);
                amp = amp + this.guitarLow * lowBoost;
                // Stage 2: power amp / fuzz clamp
                const post = 2.2 + 5.0 * (0.25 + 0.75 * this.guitarGate);
                amp = Math.tanh(amp * post);
                amp = Math.tanh(amp * (2.4 + 3.0 * (1 - this.guitarBright)));
                // Cabinet: tighter lowpass ~3-4k (brightness opens a bit)
                const cab = 0.10 + 0.12 * this.guitarBright; // higher = brighter
                this.guitarCabLP = this.guitarCabLP + (amp - this.guitarCabLP) * cab;
                let cabbed = this.guitarCabLP;
                // crude notch around ~900Hz (honky removal)
                const notchA = 0.07;
                this.guitarCabNotch = this.guitarCabNotch + (cabbed - this.guitarCabNotch) * notchA;
                cabbed = cabbed - (cabbed - this.guitarCabNotch) * 0.50;
                // Keep both original and amplification "true": blend raw-ish and cabbed fuzz.
                const rawMix = 0.10 + 0.22 * this.guitarBright;
                const ampMix = 1.0 - rawMix;
                const out = raw * rawMix + cabbed * ampMix;
                x += out * env * (0.18 + 0.36 * this.sub);
            }
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
