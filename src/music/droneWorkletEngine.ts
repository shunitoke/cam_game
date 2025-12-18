import type { ControlState } from "../control/types";
import type { MidiEvent } from "../midi/midiInput";

export const AUDIO_ENGINE_VERSION = "worklet-dual-0.2";

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

function expRange01(x: number, a: number, b: number) {
  const t = clamp(x, 0, 1);
  return a * Math.pow(b / Math.max(1e-6, a), t);
}

function midiToHz(n: number) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

export class DroneWorkletEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;

  // RAVE samples
  private samplesLoaded = false;
  private loadingSamples: Promise<void> | null = null;
  private sampleKick: AudioBuffer | null = null;
  private sampleHat: AudioBuffer | null = null;
  private sampleClap: AudioBuffer | null = null;
  private sampleOpenHat: AudioBuffer | null = null;
  private sampleSnare: AudioBuffer | null = null;
  private sampleRim: AudioBuffer | null = null;

  private lastError: string | null = null;

  private drumGain: GainNode | null = null;
  private drumLP: BiquadFilterNode | null = null;
  private drumHP: BiquadFilterNode | null = null;

  private rumbleSend: GainNode | null = null;
  private rumbleDelay: DelayNode | null = null;
  private rumbleFb: GainNode | null = null;
  private rumbleLP: BiquadFilterNode | null = null;
  private rumbleHP: BiquadFilterNode | null = null;
  private rumbleOut: GainNode | null = null;

  private raveTimer: number | null = null;
  private raveNextStepT = 0;
  private raveStep = 0;
  private raveBpm = 138;
  private raveBar = 0;

  private pulse = 0;

  private started = false;

  private mode: "performance" | "drone" = "performance";

  private gate = 0;
  private currentMidi: number | null = null;

  private lastRightPinch = 0;

  private lastParamsSentAt = 0;

  private async loadSample(ctx: AudioContext, url: string) {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return await ctx.decodeAudioData(buf);
  }

  private async tryLoadSample(ctx: AudioContext, urls: string[]) {
    for (const url of urls) {
      try {
        return await this.loadSample(ctx, url);
      } catch {
        // try next
      }
    }
    return null;
  }

  private sampleUrls(file: string) {
    const baseLocal = "/samples/909";
    const baseA = "https://tonejs.github.io/audio/drum-samples/909";
    const baseB = "https://cdn.jsdelivr.net/gh/Tonejs/audio@master/drum-samples/909";
    const baseC = "https://raw.githubusercontent.com/Tonejs/audio/master/drum-samples/909";
    return [`${baseLocal}/${file}`, `${baseA}/${file}`, `${baseB}/${file}`, `${baseC}/${file}`];
  }

  private ensureRaveScheduler() {
    if (!this.ctx) return;
    if (!this.drumGain || !this.drumLP || !this.drumHP) return;
    if (this.raveTimer != null) return;

    const ctx = this.ctx;
    this.raveNextStepT = ctx.currentTime + 0.05;
    this.raveStep = 0;
    this.raveBar = 0;

    const tick = () => {
      if (!this.ctx) return;
      if (this.mode !== "performance") return;
      if (!this.samplesLoaded) return;
      if (!this.sampleKick || !this.sampleHat) return;

      const now = this.ctx.currentTime;
      const lookahead = 0.35;
      const secPerStep = (60 / Math.max(1e-6, this.raveBpm)) / 4; // 16ths

      // Catch up if we stalled.
      if (this.raveNextStepT < now - 0.05) {
        const missed = Math.floor((now - this.raveNextStepT) / secPerStep);
        this.raveStep = (this.raveStep + missed) & 15;
        this.raveNextStepT += missed * secPerStep;
      }

      while (this.raveNextStepT < now + lookahead) {
        this.scheduleRaveStep(this.raveNextStepT, this.raveStep);
        this.raveStep = (this.raveStep + 1) & 15;
        if (this.raveStep === 0) this.raveBar++;
        this.raveNextStepT += secPerStep;
      }
    };

    this.raveTimer = window.setInterval(() => {
      try {
        tick();
      } catch {
        // ignore
      }
    }, 25);
  }

  private stopRaveScheduler() {
    if (this.raveTimer == null) return;
    try {
      window.clearInterval(this.raveTimer);
    } catch {
    }
    this.raveTimer = null;
  }

  private fireSample(time: number, buffer: AudioBuffer, gain: number, rate = 1) {
    if (!this.ctx) return;
    if (!this.drumGain) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, gain);

    src.connect(g);
    g.connect(this.drumGain);
    src.start(time);
    src.stop(time + Math.min(2.0, buffer.duration + 0.1));
  }

  private fireKick(time: number, gain = 1.0) {
    if (!this.sampleKick) return;
    if (!this.ctx) return;
    if (!this.rumbleSend || !this.rumbleOut) {
      this.fireSample(time, this.sampleKick, gain, 1.0);
      return;
    }

    // Kick to main + rumble send
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.sampleKick;
    src.playbackRate.value = 1.0;

    const gMain = ctx.createGain();
    gMain.gain.value = Math.max(0, gain);
    const gSend = ctx.createGain();
    gSend.gain.value = 0.65;

    src.connect(gMain);
    src.connect(gSend);
    gMain.connect(this.drumGain!);
    gSend.connect(this.rumbleSend);

    // Duck rumble on kick
    try {
      const p = this.rumbleOut.gain;
      p.cancelScheduledValues(time);
      p.setValueAtTime(p.value, time);
      p.linearRampToValueAtTime(0.12, time + 0.01);
      p.linearRampToValueAtTime(0.95, time + 0.18);
    } catch {
    }

    src.start(time);
    src.stop(time + Math.min(2.0, this.sampleKick.duration + 0.1));

    // Visual pulse (kick-driven)
    this.pulse = 1;
  }

  private scheduleRaveStep(time: number, step: number) {
    // Heavy minimal techno: kick foundation, tight off-hats, sparse rim/snare.
    // Arrangement/enrichment is bar-driven (no RNG) and also reacts to density (right pinch).
    const dens = Math.min(1, Math.max(0, this.lastRightPinch));

    const bar = this.raveBar;
    const section = bar < 4 ? 0 : bar < 8 ? 1 : bar < 16 ? 2 : 3;
    const peak = section >= 3;

    const kick = step === 0 || step === 4 || step === 8 || step === 12;
    const offHat = step === 2 || step === 6 || step === 10 || step === 14;
    const hat16 = (step & 1) === 1;
    const openHat = step === 14;

    // Sparse minimal punctuation
    const rim = step === 10;
    const snare = step === 12;

    // Fills: last bar of 8-bar phrase
    const inFillBar = (bar % 8) === 7;
    const fillHat = inFillBar && (step === 11 || step === 13 || step === 15);
    const fillRim = inFillBar && (step === 15 || step === 12);

    if (kick) {
      this.fireKick(time, 1.0);
    }

    // Occasional pre-push only at phrase end
    if (inFillBar && step === 15) {
      this.fireKick(time, 0.35);
    }

    // Hats
    if (offHat && this.sampleHat) {
      const v = section === 0 ? 0.16 : section === 1 ? 0.18 : 0.20;
      this.fireSample(time, this.sampleHat, v, 1.02);
    }

    // 16th hats come in gradually and with pinch
    if (hat16 && this.sampleHat) {
      const on = (section >= 2 && dens > 0.2) || (peak && dens > 0.05);
      if (on) {
        const v = 0.06 + 0.10 * dens;
        this.fireSample(time, this.sampleHat, v, 1.08);
      }
    }

    // Open hat on the offbeat when density rises
    if (openHat && this.sampleOpenHat) {
      const m = Math.min(1, Math.max(0, (dens - 0.35) / 0.65));
      if ((section >= 2 || peak) && m > 0.02) {
        this.fireSample(time, this.sampleOpenHat, 0.08 + 0.16 * m, 1.0);
      }
    }

    // Rim/snare: keep it minimal, no clap
    if (rim && this.sampleRim) {
      if (section >= 1 && dens > 0.15) {
        this.fireSample(time, this.sampleRim, 0.08 + 0.10 * dens, 1.0);
      }
    }
    if (snare && this.sampleSnare) {
      // snare comes in later (avoid pop/party clap vibe)
      if (section >= 2) {
        this.fireSample(time + 0.004, this.sampleSnare, 0.18 + 0.18 * dens, 1.0);
      }
    }

    // Fills
    if (fillHat && this.sampleHat) {
      this.fireSample(time, this.sampleHat, 0.18, 1.14);
    }
    if (fillRim && this.sampleRim) {
      this.fireSample(time, this.sampleRim, 0.18, 1.0);
    }
  }

  async start() {
    if (this.started) return;

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

    // RAVE drum chain
    this.drumGain = ctx.createGain();
    this.drumGain.gain.value = 0.95;
    this.drumHP = ctx.createBiquadFilter();
    this.drumHP.type = "highpass";
    this.drumHP.frequency.value = 22;
    this.drumLP = ctx.createBiquadFilter();
    this.drumLP.type = "lowpass";
    this.drumLP.frequency.value = 12000;
    this.drumLP.Q.value = 0.2;
    this.drumGain.connect(this.drumHP);
    this.drumHP.connect(this.drumLP);
    this.drumLP.connect(master);

    // Rumble/space bus: filtered feedback delay
    this.rumbleSend = ctx.createGain();
    this.rumbleSend.gain.value = 0.0;

    this.rumbleDelay = ctx.createDelay(1.5);
    this.rumbleDelay.delayTime.value = 0.24;
    this.rumbleFb = ctx.createGain();
    this.rumbleFb.gain.value = 0.55;
    this.rumbleLP = ctx.createBiquadFilter();
    this.rumbleLP.type = "lowpass";
    this.rumbleLP.frequency.value = 180;
    this.rumbleLP.Q.value = 0.4;
    this.rumbleHP = ctx.createBiquadFilter();
    this.rumbleHP.type = "highpass";
    this.rumbleHP.frequency.value = 32;
    this.rumbleHP.Q.value = 0.7;
    this.rumbleOut = ctx.createGain();
    this.rumbleOut.gain.value = 0.95;

    this.rumbleSend.connect(this.rumbleDelay);
    this.rumbleDelay.connect(this.rumbleLP);
    this.rumbleLP.connect(this.rumbleHP);
    this.rumbleHP.connect(this.rumbleOut);
    this.rumbleOut.connect(master);

    // feedback
    this.rumbleOut.connect(this.rumbleFb);
    this.rumbleFb.connect(this.rumbleDelay);

    // Ensure audio starts immediately after user gesture.
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    this.started = true;

    // Kick off sample loading (async) and scheduler.
    void this.ensureSamplesLoaded();
    this.ensureRaveScheduler();
  }

  private async ensureSamplesLoaded() {
    if (this.samplesLoaded) return;
    if (this.loadingSamples) return await this.loadingSamples;
    if (!this.ctx) return;

    const ctx = this.ctx;

    this.loadingSamples = (async () => {
      try {
        this.sampleKick = await this.tryLoadSample(ctx, this.sampleUrls("kick.mp3"));
        this.sampleHat =
          (await this.tryLoadSample(ctx, this.sampleUrls("hihat.mp3"))) ??
          (await this.tryLoadSample(ctx, this.sampleUrls("hat.mp3"))) ??
          (await this.tryLoadSample(ctx, this.sampleUrls("chh.mp3")));
        this.sampleClap = await this.tryLoadSample(ctx, this.sampleUrls("clap.mp3"));
        this.sampleOpenHat =
          (await this.tryLoadSample(ctx, this.sampleUrls("openhat.mp3"))) ??
          (await this.tryLoadSample(ctx, this.sampleUrls("ohh.mp3"))) ??
          (await this.tryLoadSample(ctx, this.sampleUrls("openhihat.mp3")));
        this.sampleSnare = await this.tryLoadSample(ctx, this.sampleUrls("snare.mp3"));
        this.sampleRim =
          (await this.tryLoadSample(ctx, this.sampleUrls("rimshot.mp3"))) ??
          (await this.tryLoadSample(ctx, this.sampleUrls("rim.mp3")));

        if (!this.sampleKick || !this.sampleHat) {
          this.lastError = "RAVE samples missing: need kick+hat";
          this.samplesLoaded = false;
          return;
        }

        this.samplesLoaded = true;
        this.lastError = null;
      } catch (e) {
        this.samplesLoaded = false;
        this.lastError = e instanceof Error ? e.message : "sample load failed";
      }
    })();

    await this.loadingSamples;
  }

  async stop() {
    if (!this.started) return;

    this.stopRaveScheduler();

    try {
      this.node?.disconnect();
    } catch {
    }

    try {
      this.master?.disconnect();
    } catch {
    }

    try {
      await this.ctx?.close();
    } catch {
    }

    this.ctx = null;
    this.node = null;
    this.master = null;
    this.drumGain = null;
    this.drumLP = null;
    this.drumHP = null;
    this.rumbleSend = null;
    this.rumbleDelay = null;
    this.rumbleFb = null;
    this.rumbleLP = null;
    this.rumbleHP = null;
    this.rumbleOut = null;
    this.started = false;
  }

  update(control: ControlState) {
    if (!this.started) return;
    if (!this.node) return;

    // Decay visual pulse regardless of param throttling.
    {
      const dt = Math.max(0, Math.min(0.05, control.dt ?? 0.016));
      this.pulse = Math.max(0, this.pulse - dt * 2.6);
    }

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    // Keep main-thread messages low-frequency; the DSP is in the worklet.
    if (now - this.lastParamsSentAt < 33) return;
    this.lastParamsSentAt = now;

    // Base pitch: either held MIDI note, or left hand X.
    // In RAVE (performance) we don't want keyboard notes to detune the whole track,
    // so only apply MIDI pitch when in drone mode.
    const baseHz =
      this.mode === "drone" && this.currentMidi != null
        ? midiToHz(this.currentMidi)
        : expRange01(control.leftX, 55, 220);

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

    // Guitar (right hand): pinch = pluck trigger, X = pitch, Y = brightness
    const guitarFreq = expRange01(control.rightX, 82, 330);
    const guitarBright = clamp(control.rightY, 0, 1);
    const rPinch = clamp(control.rightPinch, 0, 1);
    const pluck = rPinch > 0.65 && this.lastRightPinch <= 0.65 ? 1 : 0;
    this.lastRightPinch = rPinch;

    // RAVE: map tempo + drum tone to hands
    if (this.mode === "performance") {
      this.raveBpm = expRange01(control.leftX, 126, 152);
      if (this.drumLP) {
        this.drumLP.frequency.value = expRange01(control.rightY, 1400, 14000);
      }
      if (this.drumGain) {
        this.drumGain.gain.value = 0.78 + 0.22 * clamp(1 - control.build, 0, 1);
      }

      if (this.rumbleSend && this.rumbleFb && this.rumbleDelay) {
        const b = clamp(control.build, 0, 1);
        const dens = clamp(control.rightPinch, 0, 1);
        this.rumbleSend.gain.value = 0.02 + 0.22 * b;
        this.rumbleFb.gain.value = 0.50 + 0.35 * b;
        this.rumbleDelay.delayTime.value = expRange01(control.rightX, 0.18, 0.34);
        if (this.rumbleLP) this.rumbleLP.frequency.value = expRange01(control.rightY, 120, 260);
        if (this.rumbleHP) this.rumbleHP.frequency.value = 28 + 18 * (1 - dens);
      }

      this.ensureRaveScheduler();
    }

    // Level: DRONE is gated by left pinch, RAVE plays by itself.
    const kill = !!control.kill;
    const gate =
      this.mode === "performance"
        ? (kill ? 0 : 1)
        : kill
          ? 0
          : clamp(Math.max(this.gate, control.leftPinch * 1.1), 0, 1);

    this.node.port.postMessage({
      type: "params",
      mode: this.mode,
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
      tickTone,
      guitarFreq,
      guitarPluck: pluck,
      guitarBright
    });

    this.node.port.postMessage({ type: "gate", gate });
  }

  handleMidi(events: MidiEvent[]) {
    if (!events.length) return;

    // In RAVE mode, use keys/MIDI to trigger the 909 kit (one-shots).
    if (this.mode === "performance" && this.ctx) {
      void this.ensureSamplesLoaded();

      const t = this.ctx.currentTime + 0.02;
      for (const e of events) {
        if (e.type !== "noteon") continue;

        const v = clamp(e.velocity, 0, 1);
        const vel = 0.12 + 0.88 * v;

        // Standard-ish mapping
        // 36 kick, 38 hat, 39 clap, 40 perc/rim, 37 snare
        if (e.note === 36 && this.sampleKick) this.fireKick(t, 0.95 * vel);
        if (e.note === 38 && this.sampleHat) this.fireSample(t, this.sampleHat, 0.20 * vel, 1.03);
        if (e.note === 39 && this.sampleClap) this.fireSample(t, this.sampleClap, 0.45 * vel, 1.0);
        if (e.note === 37 && this.sampleSnare) this.fireSample(t, this.sampleSnare, 0.32 * vel, 1.0);
        if (e.note === 40 && this.sampleRim) this.fireSample(t, this.sampleRim, 0.18 * vel, 1.0);

        // Optional: open hat / crash-ish on FX key
        if (e.note === 47 && this.sampleOpenHat) this.fireSample(t, this.sampleOpenHat, 0.22 * vel, 1.0);
      }

      return;
    }

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
    return this.pulse;
  }

  setMode(_mode: "performance" | "drone") {
    this.mode = _mode;
    if (this.mode === "performance") {
      void this.ensureSamplesLoaded();
      this.ensureRaveScheduler();
    }
  }

  setTrack(_track: any) {
    // Drone-only engine.
  }

  setSafeMode(_on: boolean) {
    // Not used.
  }

  setScene(_id: string) {
    // Not used.
  }

  reset() {
    this.gate = 0;
    this.currentMidi = null;
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
