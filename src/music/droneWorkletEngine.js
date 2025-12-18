export const AUDIO_ENGINE_VERSION = "worklet-drone-0.1";
function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
}
function expRange01(x, a, b) {
    const t = clamp(x, 0, 1);
    return a * Math.pow(b / Math.max(1e-6, a), t);
}
function midiToHz(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
}
export class DroneWorkletEngine {
    ctx = null;
    node = null;
    master = null;
    started = false;
    gate = 0;
    currentMidi = null;
    lastParamsSentAt = 0;
    async start() {
        if (this.started)
            return;
        const ctx = new AudioContext({ latencyHint: "playback" });
        this.ctx = ctx;
        // Worklet module: Vite will serve/compile this URL.
        await ctx.audioWorklet.addModule(new URL("./worklets/droneProcessor.ts", import.meta.url));
        const node = new AudioWorkletNode(ctx, "drone-processor", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });
        this.node = node;
        const master = ctx.createGain();
        master.gain.value = 0.9;
        this.master = master;
        node.connect(master);
        master.connect(ctx.destination);
        // Ensure audio starts immediately after user gesture.
        if (ctx.state === "suspended") {
            await ctx.resume();
        }
        this.started = true;
    }
    async stop() {
        if (!this.started)
            return;
        try {
            this.node?.disconnect();
        }
        catch {
        }
        try {
            this.master?.disconnect();
        }
        catch {
        }
        try {
            await this.ctx?.close();
        }
        catch {
        }
        this.ctx = null;
        this.node = null;
        this.master = null;
        this.started = false;
    }
    update(control) {
        if (!this.started)
            return;
        if (!this.node)
            return;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        // Keep main-thread messages low-frequency; the DSP is in the worklet.
        if (now - this.lastParamsSentAt < 33)
            return;
        this.lastParamsSentAt = now;
        // Base pitch: either held MIDI note, or left hand X.
        const baseHz = this.currentMidi != null ? midiToHz(this.currentMidi) : expRange01(control.leftX, 55, 220);
        // Brightness: right hand Y (in ControlBus Y is already flipped)
        const cutoff = expRange01(control.rightY, 120, 6200);
        // Drive/texture: build + right pinch
        const drive = clamp(0.1 + control.build * 1.25 + control.rightPinch * 0.6, 0, 2.2);
        // LFO
        const lfoHz = expRange01(control.rightX, 0.05, 3.2);
        const lfoAmt = clamp(0.015 + control.leftPinch * 0.28, 0, 0.65);
        // Envelope / texture
        const attack = expRange01(1 - control.leftY, 0.006, 0.18);
        const release = expRange01(1 - control.leftY, 0.06, 0.9);
        const detune = clamp(0.0015 + control.build * 0.008 + control.rightSpeed * 0.004, 0, 0.02);
        const sub = clamp(0.12 + control.build * 0.55, 0, 0.85);
        const noise = clamp(0.01 + control.rightPinch * 0.08, 0, 0.2);
        // Delay as space: right pinch opens mix, build increases feedback.
        const delayTime = expRange01(control.rightX, 0.09, 0.42);
        const delayFb = clamp(0.18 + control.build * 0.55, 0, 0.86);
        const delayMix = clamp(0.03 + control.rightPinch * 0.22, 0, 0.35);
        // Rhythm (worklet stepper): slow pulse you can "wake up" with build.
        const bpm = expRange01(control.leftX, 44, 92);
        const pulseAmt = clamp(0.04 + control.build * 0.55, 0, 0.85);
        const pulseDecay = expRange01(1 - control.leftY, 0.04, 0.26);
        const tickAmt = clamp(0.00 + control.rightPinch * 0.55, 0, 0.9);
        const tickDecay = expRange01(1 - control.rightY, 0.01, 0.11);
        const tickTone = expRange01(control.rightY, 400, 5200);
        // Level: left pinch opens the drone, fist/kill shuts it.
        const kill = !!control.kill;
        const gate = kill ? 0 : clamp(Math.max(this.gate, control.leftPinch * 1.1), 0, 1);
        this.node.port.postMessage({
            type: "params",
            freq: baseHz,
            gain: 1.0,
            cutoff,
            drive,
            lfoHz,
            lfoAmt,
            attack,
            release,
            detune,
            sub,
            noise,
            delayTime,
            delayFb,
            delayMix,
            bpm,
            pulseAmt,
            pulseDecay,
            tickAmt,
            tickDecay,
            tickTone
        });
        this.node.port.postMessage({ type: "gate", gate });
    }
    handleMidi(events) {
        if (!events.length)
            return;
        for (const e of events) {
            if (e.type === "noteon") {
                this.currentMidi = e.note;
                this.gate = Math.max(this.gate, clamp(e.velocity, 0, 1));
            }
            if (e.type === "noteoff") {
                if (this.currentMidi === e.note) {
                    this.currentMidi = null;
                    this.gate = 0;
                }
            }
        }
    }
    // Compatibility helpers for existing HUD code.
    getWaveforms() {
        return null;
    }
    getPulse() {
        return 0;
    }
    setMode(_mode) {
        // Drone-only engine.
    }
    setTrack(_track) {
        // Drone-only engine.
    }
    setSafeMode(_on) {
        // Not used.
    }
    setScene(_id) {
        // Not used.
    }
    reset() {
        this.gate = 0;
        this.currentMidi = null;
    }
    getLastError() {
        return null;
    }
}
