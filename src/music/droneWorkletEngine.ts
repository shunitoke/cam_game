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

function makeDriveCurve(amount: number) {
  const a = clamp(amount, 0, 1);
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + a * 24;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k);
  }
  return curve;
}

export class DroneWorkletEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;

  private limiter: DynamicsCompressorNode | null = null;
  private preClip: GainNode | null = null;
  private clipper: WaveShaperNode | null = null;
  private postClip: GainNode | null = null;

  private output: GainNode | null = null;

  private analyser: AnalyserNode | null = null;
  private waveBuf: Float32Array<ArrayBuffer> | null = null;
  private fftBuf: Float32Array<ArrayBuffer> | null = null;

  // RAVE samples
  private samplesLoaded = false;
  private loadingSamples: Promise<void> | null = null;
  private sampleKick: AudioBuffer | null = null;
  private sampleHat: AudioBuffer | null = null;
  private sampleClap: AudioBuffer | null = null;
  private sampleOpenHat: AudioBuffer | null = null;
  private sampleSnare: AudioBuffer | null = null;
  private sampleRim: AudioBuffer | null = null;

  // DRONE stems (real samples)
  private droneStemsLoaded = false;
  private loadingDroneStems: Promise<void> | null = null;
  private sampleDroneBass: AudioBuffer | null = null;
  private sampleDroneGuitar: AudioBuffer | null = null;

  private droneBassEl: HTMLAudioElement | null = null;
  private droneBassElSrc: MediaElementAudioSourceNode | null = null;

  private droneBassSrc: AudioBufferSourceNode | null = null;
  private droneBassGain: GainNode | null = null;
  private droneBassLP: BiquadFilterNode | null = null;
  private droneBassDrive: WaveShaperNode | null = null;

  // DRONE guitar (single layer)
  private droneGtrASrc: AudioBufferSourceNode | null = null;
  private droneGtrAGain: GainNode | null = null;
  private droneGtrAHP: BiquadFilterNode | null = null;
  private droneGtrAPre: WaveShaperNode | null = null;
  private droneGtrALP: BiquadFilterNode | null = null;
  private droneGtrADrive: WaveShaperNode | null = null;
  private droneGtrAComp: DynamicsCompressorNode | null = null;

  private lastError: string | null = null;

  private drumGain: GainNode | null = null;
  private drumLP: BiquadFilterNode | null = null;
  private drumHP: BiquadFilterNode | null = null;

  // RAVE FX
  private fxIn: GainNode | null = null;
  private fxFilter: BiquadFilterNode | null = null;
  private fxDrive: WaveShaperNode | null = null;
  private fxOut: GainNode | null = null;
  private fxDelay: DelayNode | null = null;
  private fxDelayFb: GainNode | null = null;
  private fxDelayMix: GainNode | null = null;

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

  private raveSection = 0;
  private ravePrevSection = 0;
  private raveNextSectionBar = 0;
  private raveSectionChangeT = 0;
  private raveFillType = 0;
  private raveFillUntilBar = 0;
  private raveGroove = 0;
  private raveNextGrooveBar = 0;
  private raveBarVariant = 0;
  private raveVariantUntilBar = 0;
  private raveNextVariantBar = 0;
  private raveLastVariantBar = 0;
  private raveRand = 0x12345678;

  private pulse = 0;

  private fxHold = 0;

  private rand01() {
    let x = this.raveRand | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.raveRand = x | 0;
    return ((x >>> 0) % 1000000) / 1000000;
  }

  private pickNextSection() {
    const r = this.rand01();
    const a = (this.raveSection + 1) % 3;
    const b = (this.raveSection + 2) % 3;
    return r < 0.55 ? a : b;
  }

  private pickNextGroove() {
    const r = this.rand01();
    if (r < 0.50) return 0;
    if (r < 0.76) return 1;
    if (r < 0.92) return 2;
    return 3;
  }

  private maybeAdvanceGroove(bar: number) {
    if (bar < this.raveNextGrooveBar) return;
    this.raveGroove = this.pickNextGroove();
    const r = this.rand01();
    const len = r < 0.15 ? 8 : r < 0.75 ? 4 : 2;
    this.raveNextGrooveBar = bar + len;
  }

  private pickBarVariant(section: number, dens: number) {
    // 0 normal
    // 1 kick-drop (no kick)
    // 2 kick-sparse (kick only on 1)
    // 3 half-time (kick on 1+3 only)
    // 4 hats-only (no kick + no snare, percussion stays)
    const r = this.rand01();
    // Variants should be able to happen even with no hands.
    if (r < 0.42) return 1;
    if (r < 0.70) return 2;
    if (r < 0.88) return 3;
    return 4;
  }

  private maybeAdvanceBarVariant(bar: number, section: number, dens: number, fillOn: boolean) {
    if (bar < this.raveNextVariantBar) return;
    if (fillOn) return;

    // One-bar holes, with cooldown. Must work even with no hands.
    // When no hands, make the break chance higher so you still get movement.
    const handsCount = (this.lastControlHandsCount ?? 0) | 0;
    const idleBoost = handsCount > 0 ? 0 : 0.08;
    const baseChance = section <= 0 ? 0.10 : section === 1 ? 0.13 : 0.16;
    const chance = Math.min(0.40, baseChance + idleBoost);

    // Anti-stale: if we haven't had a break for a while, force one.
    const barsSince = Math.max(0, (bar - (this.raveLastVariantBar | 0)) | 0);
    const force = barsSince >= 24;

    if (force || this.rand01() < chance) {
      this.raveBarVariant = this.pickBarVariant(section, dens);
      this.raveVariantUntilBar = bar + 1;
      this.raveLastVariantBar = bar;

      const rr = this.rand01();
      const cooldown = rr < 0.20 ? 16 : rr < 0.70 ? 12 : 8;
      this.raveNextVariantBar = bar + cooldown;
    } else {
      this.raveBarVariant = 0;
      this.raveVariantUntilBar = 0;
      this.raveNextVariantBar = bar + 4;
    }
  }

  private maybeAdvanceArrangement(bar: number) {
    if (!this.ctx) return;
    if (bar < this.raveNextSectionBar) return;

    this.ravePrevSection = this.raveSection;
    this.raveSection = this.pickNextSection();
    this.raveSectionChangeT = this.ctx.currentTime;

    const r = this.rand01();
    const nextLen = r < 0.20 ? 32 : r < 0.75 ? 16 : 8;
    this.raveNextSectionBar = bar + nextLen;

    const fillChance = 0.12 + 0.08 * (this.raveSection === 2 ? 1 : 0);
    if (this.raveFillUntilBar <= bar && this.rand01() < fillChance) {
      const rr = this.rand01();
      this.raveFillType = rr < 0.62 ? 1 : rr < 0.92 ? 2 : 3;
      this.raveFillUntilBar = bar + 1;
    } else {
      this.raveFillType = 0;
      this.raveFillUntilBar = 0;
    }
  }

  private started = false;

  private mode: "performance" | "drone" = "performance";

  private gate = 0;
  private currentMidi: number | null = null;

  private lastRightPinch = 0;
  private lastControlHandsCount = 0;

  private lastParamsSentAt = 0;

  private idleAmt = 0;

  private lastDroneRate = 1;
  private lastDroneRateA = 1;

  private lastBassDriveAmt = -1;
  private lastBassCut = -1;
  private lastBassQ = -1;

  private droneGtrAuto = 0;
  private droneGtrAutoTarget = 0;
  private droneGtrNextSwellT = 0;
  private droneGtrSwellUntilT = 0;

  private async loadSample(ctx: AudioContext, url: string) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`fetch failed ${res.status} ${res.statusText}`);
    }
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

  private droneStemUrls(file: string) {
    // /public/samples/* is served at /samples/* (Vite). Filenames may include '#', so encode.
    // Try browser-friendly formats first so users can just drop a converted .mp3/.ogg next to the .wav.
    const dot = file.lastIndexOf(".");
    const base = dot >= 0 ? file.slice(0, dot) : file;
    const candidates = [`${base}.mp3`, `${base}.ogg`, `${base}.wav`];
    return candidates.map((f) => `/samples/${encodeURIComponent(f)}`);
  }

  private ensureBassEl(ctx: AudioContext, url: string) {
    if (this.droneBassEl && this.droneBassElSrc) return;

    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.src = url;
    el.loop = true;
    el.preload = "auto";

    let src: MediaElementAudioSourceNode;
    try {
      src = ctx.createMediaElementSource(el);
    } catch {
      // Some browsers forbid multiple MediaElementSource nodes; fall back to reusing existing.
      return;
    }

    this.droneBassEl = el;
    this.droneBassElSrc = src;
  }

  private pickPlayableMediaUrl(urls: string[]) {
    const test = new Audio();
    for (const url of urls) {
      const ext = url.split("?")[0]!.split("#")[0]!.split(".").pop()?.toLowerCase();
      const mime = ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : ext === "wav" ? "audio/wav" : "";
      if (!mime) continue;
      try {
        const ok = test.canPlayType(mime);
        if (ok === "probably" || ok === "maybe") return url;
      } catch {
      }
    }
    // Fall back to first candidate.
    return urls[0] ?? null;
  }

  private async ensureDroneStemsLoaded() {
    if (!this.ctx) return;
    // Allow retrying missing stems (e.g. guitar loaded but bass failed earlier).
    if (this.sampleDroneBass && this.sampleDroneGuitar) {
      this.droneStemsLoaded = true;
      return;
    }
    if (this.loadingDroneStems) return this.loadingDroneStems;

    const ctx = this.ctx;
    this.loadingDroneStems = (async () => {
      const bassName = "bass.ogg";
      const gtrName = "guitar.ogg";

      const bUrls = this.droneStemUrls(bassName);
      const gUrls = this.droneStemUrls(gtrName);
      const bUrl = bUrls[0]!;
      const gUrl = gUrls[0]!;

      let bass: AudioBuffer | null = null;
      let gtr: AudioBuffer | null = null;
      let bassErr: string | null = null;
      let gtrErr: string | null = null;

      if (!this.sampleDroneBass) {
        try {
          // Use direct load so we capture the actual failing status/decode error.
          bass = await this.tryLoadSample(ctx, bUrls);
        } catch (e) {
          bassErr = String(e);

          // If decodeAudioData fails due to WAV encoding (common with float/24-bit),
          // fall back to HTMLAudioElement which uses the browser's media decoder.
          if (/EncodingError/i.test(bassErr) || /decodeAudioData/i.test(bassErr)) {
            try {
              const u = this.pickPlayableMediaUrl(bUrls);
              if (u) this.ensureBassEl(ctx, u);
              bassErr = bassErr + " (fallback: HTMLAudioElement)";
            } catch {
            }
          }
        }
      }
      try {
        if (!this.sampleDroneGuitar) {
          gtr = await this.tryLoadSample(ctx, gUrls);
        }
      } catch (e) {
        gtrErr = String(e);
      }

      if (!bass || !gtr) {
        this.lastError = `Drone stems load. Bass: ${bass ? "ok" : `fail (${bUrl})`} ${bassErr ?? ""} | Guitar: ${gtr ? "ok" : `fail (${gUrl})`} ${gtrErr ?? ""}`;
      }

      // Allow partial availability (so at least guitar can play even if bass fails).
      if (bass) this.sampleDroneBass = bass;
      if (gtr) this.sampleDroneGuitar = gtr;
      this.droneStemsLoaded = !!(this.sampleDroneBass || this.sampleDroneGuitar || this.droneBassElSrc);

      if (this.sampleDroneBass && this.sampleDroneGuitar) {
        this.lastError = null;
      }
    })();

    try {
      await this.loadingDroneStems;
    } finally {
      this.loadingDroneStems = null;
    }
  }

  private stopDroneStems() {
    const stopSrc = (src: AudioBufferSourceNode | null) => {
      if (!src) return;
      try {
        src.stop();
      } catch {
      }
      try {
        src.disconnect();
      } catch {
      }
    };

    stopSrc(this.droneBassSrc);
    stopSrc(this.droneGtrASrc);
    this.droneBassSrc = null;
    this.droneGtrASrc = null;

    try {
      this.droneBassEl?.pause();
    } catch {
    }

    try {
      this.droneBassElSrc?.disconnect();
    } catch {
    }
  }

  private ensureDroneStemsPlaying() {
    if (!this.ctx) return;
    if (!this.master) return;
    if (!this.sampleDroneBass && !this.sampleDroneGuitar && !this.droneBassElSrc) return;

    const ctx = this.ctx;

    // Bass FX chain must exist for both decoded buffer and HTMLAudioElement fallback.
    if ((this.sampleDroneBass || this.droneBassElSrc) && !this.droneBassGain) {
      this.droneBassGain = ctx.createGain();
      this.droneBassGain.gain.value = 0.0;
      this.droneBassLP = ctx.createBiquadFilter();
      this.droneBassLP.type = "lowpass";
      this.droneBassLP.frequency.value = 220;
      this.droneBassLP.Q.value = 0.45;
      this.droneBassDrive = ctx.createWaveShaper();
      this.droneBassDrive.curve = makeDriveCurve(0.22);
      this.droneBassDrive.oversample = "2x";
      this.droneBassGain.connect(this.droneBassLP);
      this.droneBassLP.connect(this.droneBassDrive);
      this.droneBassDrive.connect(this.master);
    }

    if (this.sampleDroneGuitar && !this.droneGtrAGain) {
      // Guitar (right hand): Sunn-ish amp chain
      this.droneGtrAGain = ctx.createGain();
      this.droneGtrAGain.gain.value = 0.0;
      this.droneGtrAHP = ctx.createBiquadFilter();
      this.droneGtrAHP.type = "highpass";
      this.droneGtrAHP.frequency.value = 55;
      this.droneGtrAHP.Q.value = 0.8;

      // Preamp fuzz stage
      this.droneGtrAPre = ctx.createWaveShaper();
      this.droneGtrAPre.curve = makeDriveCurve(0.85);
      this.droneGtrAPre.oversample = "4x";

      this.droneGtrALP = ctx.createBiquadFilter();
      this.droneGtrALP.type = "lowpass";
      this.droneGtrALP.frequency.value = 2200;
      this.droneGtrALP.Q.value = 0.55;
      this.droneGtrADrive = ctx.createWaveShaper();
      this.droneGtrADrive.curve = makeDriveCurve(0.92);
      this.droneGtrADrive.oversample = "4x";
      this.droneGtrAComp = ctx.createDynamicsCompressor();
      this.droneGtrAComp.threshold.value = -28;
      this.droneGtrAComp.knee.value = 14;
      this.droneGtrAComp.ratio.value = 10;
      this.droneGtrAComp.attack.value = 0.010;
      this.droneGtrAComp.release.value = 0.34;
      this.droneGtrAGain.connect(this.droneGtrAHP);
      this.droneGtrAHP.connect(this.droneGtrAPre);
      this.droneGtrAPre.connect(this.droneGtrALP);
      this.droneGtrALP.connect(this.droneGtrADrive);
      this.droneGtrADrive.connect(this.droneGtrAComp);
      this.droneGtrAComp.connect(this.master);
    }

    if (this.sampleDroneBass && this.droneBassGain && !this.droneBassSrc) {
      const s = ctx.createBufferSource();
      s.buffer = this.sampleDroneBass;
      s.loop = true;
      s.playbackRate.value = 1.0;
      s.connect(this.droneBassGain);
      s.start();
      this.droneBassSrc = s;
    }

    // Bass fallback via HTMLAudioElement if decodeAudioData failed.
    if (!this.sampleDroneBass && this.droneBassElSrc && this.droneBassGain) {
      try {
        this.droneBassElSrc.connect(this.droneBassGain);
      } catch {
      }
      try {
        void this.droneBassEl?.play();
      } catch {
      }
    }

    if (this.sampleDroneGuitar && this.droneGtrAGain && !this.droneGtrASrc) {
      const s = ctx.createBufferSource();
      s.buffer = this.sampleDroneGuitar;
      s.loop = true;
      s.playbackRate.value = 1.0;
      s.connect(this.droneGtrAGain);
      s.start();
      this.droneGtrASrc = s;
      this.lastDroneRateA = 1;
    }

    // (single guitar only)
  }

  private ensureRaveScheduler() {
    if (!this.ctx) return;
    if (!this.drumGain || !this.drumLP || !this.drumHP) return;
    if (this.raveTimer != null) return;

    const ctx = this.ctx;
    this.raveNextStepT = ctx.currentTime + 0.05;
    this.raveStep = 0;
    this.raveBar = 0;
    this.raveSection = 0;
    this.ravePrevSection = 0;
    this.raveNextSectionBar = 8;
    this.raveSectionChangeT = ctx.currentTime;
    this.raveFillType = 0;
    this.raveFillUntilBar = 0;
    this.raveGroove = 0;
    this.raveNextGrooveBar = 2;
    this.raveBarVariant = 0;
    this.raveVariantUntilBar = 0;
    this.raveNextVariantBar = 4;
    this.raveLastVariantBar = 0;
    this.raveRand = ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) | 0) || 0x12345678;

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
        if (this.raveStep === 0) {
          this.maybeAdvanceArrangement(this.raveBar);
          this.maybeAdvanceGroove(this.raveBar);
          const dens = Math.min(1, Math.max(0, this.lastRightPinch));
          const fillOn = this.raveFillUntilBar > this.raveBar;
          this.maybeAdvanceBarVariant(this.raveBar, this.raveSection, dens, fillOn);
        }
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
    const section = this.raveSection;
    const fillOn = this.raveFillUntilBar > bar;
    const groove = this.raveGroove | 0;

    const variantOn = this.raveVariantUntilBar > bar;
    const variant = variantOn ? (this.raveBarVariant | 0) : 0;

    let kick = step === 0 || step === 4 || step === 8 || step === 12;
    const offHat = step === 2 || step === 6 || step === 10 || step === 14;
    const hat16 = (step & 1) === 1;
    const openHat = step === 14;

    // Sparse minimal punctuation
    let rim = step === 10 || (groove === 2 && step === 6);
    let snare = step === 12;

    // Global kick gating: when a break variant is active, we must also suppress ALL ghost kicks.
    let kickAllowed = true;

    if (!fillOn && variantOn) {
      if (variant === 1) {
        // Kick-drop bar.
        kick = false;
        kickAllowed = false;
      } else if (variant === 2) {
        // Kick only on 1.
        kick = step === 0;
      } else if (variant === 3) {
        // Half-time: keep 1+3.
        kick = step === 0 || step === 8;
      } else if (variant === 4) {
        // Hats-only: keep hat grid, drop kick + snare for a bar.
        kick = false;
        kickAllowed = false;
        snare = false;
        // Rim can stay (quiet) as punctuation.
        rim = rim && section >= 2 && dens > 0.25;
      }
    }

    const fillHat = fillOn && (this.raveFillType === 1 || this.raveFillType === 3) && (step >= 10 && hat16);
    const fillRim = fillOn && this.raveFillType === 2 && (step >= 12 && (step & 1) === 1);

    if (kickAllowed && kick) {
      this.fireKick(time, 1.0);
    }

    if (!fillOn) {
      if (groove === 1) {
        if (kickAllowed && step === 7 && section >= 1 && dens > 0.25) this.fireKick(time, 0.16);
        if (kickAllowed && step === 15 && section >= 2 && dens > 0.45) this.fireKick(time, 0.14);
      }
      if (groove === 2) {
        if (kickAllowed && step === 3 && section >= 2 && dens > 0.55) this.fireKick(time, 0.15);
      }
      if (groove === 3) {
        if (kickAllowed && step === 11 && section >= 1 && dens > 0.40) this.fireKick(time, 0.12);
      }
    }

    // Occasional pre-push only at phrase end
    if (kickAllowed && fillOn && step === 15 && this.raveFillType === 3) {
      this.fireKick(time, 0.22);
    }

    // Hats
    if (offHat && this.sampleHat) {
      const v = section === 0 ? 0.16 : section === 1 ? 0.18 : 0.205;
      this.fireSample(time, this.sampleHat, v, 1.02);
    }

    if (!fillOn && this.sampleHat) {
      const ghostOn = (section >= 1 && dens > 0.25) || (section >= 2 && dens > 0.12);
      if (ghostOn) {
        const micro = step === 6 || step === 14 ? 0.006 : 0.0;
        if (groove === 1 && (step === 9 || step === 13)) {
          this.fireSample(time + micro, this.sampleHat, 0.055 + 0.045 * dens, 1.10);
        }
        if (groove === 3 && step === 5) {
          this.fireSample(time + micro, this.sampleHat, 0.050 + 0.040 * dens, 1.08);
        }
      }
    }

    // 16th hats come in gradually and with pinch
    if (hat16 && this.sampleHat) {
      const on = (section >= 1 && dens > 0.35) || (section >= 2 && dens > 0.22);
      if (on) {
        const v = 0.045 + 0.085 * dens;
        const r = 1.05 + 0.03 * section;
        this.fireSample(time, this.sampleHat, v, r);
      }
    }

    // Open hat on the offbeat when density rises
    if (openHat && this.sampleOpenHat) {
      const m = Math.min(1, Math.max(0, (dens - 0.35) / 0.65));
      if (section >= 2 && m > 0.06) {
        this.fireSample(time, this.sampleOpenHat, 0.06 + 0.12 * m, 1.0);
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
      if (section >= 1) {
        const v = (section === 1 ? 0.11 : 0.14) + 0.14 * dens;
        this.fireSample(time + 0.004, this.sampleSnare, v, 1.0);
      }
    }

    if (!fillOn && this.sampleSnare && groove === 2 && section >= 2 && dens > 0.35) {
      if (step === 11) {
        this.fireSample(time + 0.002, this.sampleSnare, 0.06 + 0.05 * dens, 1.0);
      }
    }

    // Fills
    if (fillHat && this.sampleHat) {
      const rr = this.raveFillType === 3 ? 1.18 : 1.14;
      this.fireSample(time, this.sampleHat, 0.12, rr);
    }
    if (fillRim && this.sampleRim) {
      this.fireSample(time, this.sampleRim, 0.12, 1.0);
    }
  }

  async start() {
    if (this.started) return;

    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;

    // Worklet module: Vite will serve/compile this URL.
    await ctx.audioWorklet.addModule(new URL("./worklets/droneProcessor.js", import.meta.url));

    const node = new AudioWorkletNode(ctx, "drone-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    this.node = node;

    const master = ctx.createGain();
    master.gain.value = 0.55;
    this.master = master;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -16;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.18;

    this.preClip = ctx.createGain();
    this.preClip.gain.value = 1.0;

    this.clipper = ctx.createWaveShaper();
    this.clipper.curve = makeDriveCurve(0.18);
    this.clipper.oversample = "4x";

    this.postClip = ctx.createGain();
    this.postClip.gain.value = 1.0;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.82;

    this.output = ctx.createGain();
    this.output.gain.value = 0.12;

    node.connect(master);
    master.connect(this.limiter);
    this.limiter.connect(this.preClip);
    this.preClip.connect(this.clipper);
    this.clipper.connect(this.postClip);
    this.postClip.connect(this.analyser);
    this.analyser.connect(this.output);
    this.output.connect(ctx.destination);

    // Apply mode-dependent gain staging/clip character.
    this.applyModeGainStaging();

    // RAVE drum chain -> FX bus -> master
    this.drumGain = ctx.createGain();
    this.drumGain.gain.value = 0.95;
    this.drumHP = ctx.createBiquadFilter();
    this.drumHP.type = "highpass";
    this.drumHP.frequency.value = 22;
    this.drumLP = ctx.createBiquadFilter();
    this.drumLP.type = "lowpass";
    this.drumLP.frequency.value = 12000;
    this.drumLP.Q.value = 0.2;

    this.fxIn = ctx.createGain();
    this.fxIn.gain.value = 1.0;
    this.fxFilter = ctx.createBiquadFilter();
    this.fxFilter.type = "lowpass";
    this.fxFilter.frequency.value = 14000;
    this.fxFilter.Q.value = 0.6;
    this.fxDrive = ctx.createWaveShaper();
    this.fxDrive.curve = makeDriveCurve(0.0);
    this.fxDrive.oversample = "2x";
    this.fxOut = ctx.createGain();
    this.fxOut.gain.value = 0.95;

    this.fxDelay = ctx.createDelay(1.5);
    this.fxDelay.delayTime.value = 0.25;
    this.fxDelayFb = ctx.createGain();
    this.fxDelayFb.gain.value = 0.35;
    this.fxDelayMix = ctx.createGain();
    this.fxDelayMix.gain.value = 0.0;

    // dry path
    this.drumGain.connect(this.drumHP);
    this.drumHP.connect(this.drumLP);
    this.drumLP.connect(this.fxIn);

    this.fxIn.connect(this.fxFilter);
    this.fxFilter.connect(this.fxDrive);
    this.fxDrive.connect(this.fxOut);
    this.fxOut.connect(master);

    // delay send
    this.fxIn.connect(this.fxDelay);
    this.fxDelay.connect(this.fxDelayMix);
    this.fxDelayMix.connect(master);
    // feedback
    this.fxDelay.connect(this.fxDelayFb);
    this.fxDelayFb.connect(this.fxDelay);

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

    // Seed drone guitar auto-swell scheduler.
    this.droneGtrNextSwellT = ctx.currentTime + 3.0;
    this.droneGtrSwellUntilT = 0;
    this.droneGtrAuto = 0;
    this.droneGtrAutoTarget = 0;

    // Kick off sample loading (async) and scheduler.
    void this.ensureSamplesLoaded();
    void this.ensureDroneStemsLoaded();
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
    this.stopDroneStems();

    try {
      this.node?.disconnect();
    } catch {
    }

    try {
      this.master?.disconnect();
    } catch {
    }

    try {
      this.limiter?.disconnect();
    } catch {
    }

    try {
      this.preClip?.disconnect();
    } catch {
    }

    try {
      this.clipper?.disconnect();
    } catch {
    }

    try {
      this.postClip?.disconnect();
    } catch {
    }

    try {
      this.analyser?.disconnect();
    } catch {
    }

    try {
      this.output?.disconnect();
    } catch {
    }

    try {
      await this.ctx?.close();
    } catch {
    }

    this.ctx = null;
    this.lastParamsSentAt = 0;
    this.idleAmt = 0;
    this.node = null;
    this.master = null;
    this.limiter = null;
    this.preClip = null;
    this.clipper = null;
    this.analyser = null;
    this.postClip = null;
    this.output = null;
    this.waveBuf = null;
    this.fftBuf = null;
    this.drumGain = null;
    this.drumLP = null;
    this.drumHP = null;
    this.rumbleSend = null;
    this.rumbleDelay = null;
    this.rumbleFb = null;
    this.rumbleLP = null;
    this.rumbleHP = null;
    this.rumbleOut = null;

    this.droneStemsLoaded = false;
    this.loadingDroneStems = null;
    this.sampleDroneBass = null;
    this.sampleDroneGuitar = null;
    this.droneBassEl = null;
    this.droneBassElSrc = null;
    this.droneBassGain = null;
    this.droneBassLP = null;
    this.droneBassDrive = null;
    this.droneGtrAGain = null;
    this.droneGtrAHP = null;
    this.droneGtrAPre = null;
    this.droneGtrALP = null;
    this.droneGtrADrive = null;
    this.droneGtrAComp = null;
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

    // Track hands count for RAVE scheduling decisions (breakdowns should happen even with no hands).
    this.lastControlHandsCount = (control.hands?.count ?? 0) | 0;

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
    const noiseRaw = clamp(0.01 + control.rightPinch * 0.08, 0, 0.2);
    const noise = this.mode === "drone" ? 0 : noiseRaw;

    // Delay as space: right pinch opens mix, build increases feedback.
    const delayTime = expRange01(control.rightX, 0.09, 0.42);
    const delayFb = clamp(0.18 + control.build * 0.55, 0, 0.86);
    const delayMixRaw = clamp(0.03 + control.rightPinch * 0.22, 0, 0.35);
    const delayMix = this.mode === "drone" ? 0.08 + 0.12 * clamp(control.build, 0, 1) : delayMixRaw;

    // Rhythm (worklet stepper): slow pulse you can "wake up" with build.
    const bpm = expRange01(control.leftX, 44, 92);
    const pulseAmtRaw = clamp(0.04 + control.build * 0.55, 0, 0.85);
    const pulseAmt = this.mode === "drone" ? 0 : pulseAmtRaw;
    const pulseDecay = expRange01(1 - control.leftY, 0.04, 0.26);

    const tickAmtRaw = clamp(0.00 + control.rightPinch * 0.55, 0, 0.9);
    const tickAmt = this.mode === "drone" ? 0 : tickAmtRaw;
    const tickDecay = expRange01(1 - control.rightY, 0.01, 0.11);
    const tickTone = expRange01(control.rightY, 400, 5200);

    // Guitar (right hand): pinch = pluck trigger, X = pitch, Y = brightness
    const guitarFreq = expRange01(control.rightX, 82, 392);
    const guitarBright = clamp(control.rightY, 0, 1);
    const rPinch = clamp(control.rightPinch, 0, 1);
    const pluckRaw = rPinch > 0.65 && this.lastRightPinch <= 0.65 ? 1 : 0;
    const pluck = this.mode === "drone" ? 0 : pluckRaw;
    this.lastRightPinch = rPinch;
    const guitarGate = this.mode === "drone" ? rPinch : 0;

    // RAVE: map tempo + drum tone to hands
    if (this.mode === "performance") {
      this.raveBpm = expRange01(control.leftX, 126, 152);
      if (this.drumLP) {
        this.drumLP.frequency.value = expRange01(control.rightY, 1400, 14000);
      }
      if (this.drumGain) {
        this.drumGain.gain.value = 0.78 + 0.22 * clamp(1 - control.build, 0, 1);
      }

      const tNow = this.ctx?.currentTime ?? 0;
      const morph = clamp((tNow - this.raveSectionChangeT) / 4.0, 0, 1);
      const prev = this.ravePrevSection | 0;
      const cur = this.raveSection | 0;

      const secDrive = [0.0, 0.10, 0.20];
      const secDelay = [0.0, 0.05, 0.10];
      const secDelayFb = [0.0, 0.04, 0.08];
      const secRumble = [0.0, 0.035, 0.070];
      const secRumbleFb = [0.0, 0.04, 0.08];
      const secQ = [0.0, 0.4, 0.8];

      const baseDrive = (secDrive[prev] ?? 0) * (1 - morph) + (secDrive[cur] ?? 0) * morph;
      const baseDelay = (secDelay[prev] ?? 0) * (1 - morph) + (secDelay[cur] ?? 0) * morph;
      const baseDelayFb = (secDelayFb[prev] ?? 0) * (1 - morph) + (secDelayFb[cur] ?? 0) * morph;
      const baseRumble = (secRumble[prev] ?? 0) * (1 - morph) + (secRumble[cur] ?? 0) * morph;
      const baseRumbleFb = (secRumbleFb[prev] ?? 0) * (1 - morph) + (secRumbleFb[cur] ?? 0) * morph;
      const baseQ = (secQ[prev] ?? 0) * (1 - morph) + (secQ[cur] ?? 0) * morph;
      const pinch = clamp(control.rightPinch, 0, 1);
      this.fxHold = Math.max(0, Math.min(1, this.fxHold + (pinch - this.fxHold) * 0.15));

      const fx = this.fxHold;
      const cut = expRange01(1 - control.rightY, 180, 14000);
      const q = 0.6 + 6.0 * fx * clamp(control.build, 0, 1) + baseQ;
      if (this.fxFilter) {
        this.fxFilter.type = fx > 0.6 ? "bandpass" : "lowpass";
        this.fxFilter.frequency.value = cut;
        this.fxFilter.Q.value = q;
      }

      if (this.fxDrive) {
        (this.fxDrive as any).curve = makeDriveCurve(0.15 + 0.85 * fx + baseDrive);
      }

      if (this.fxDelay && this.fxDelayFb && this.fxDelayMix) {
        this.fxDelay.delayTime.value = expRange01(control.rightX, 0.12, 0.38);
        this.fxDelayFb.gain.value = 0.25 + 0.55 * fx + baseDelayFb;
        this.fxDelayMix.gain.value = 0.00 + 0.55 * fx + baseDelay;
      }

      if (this.rumbleSend && this.rumbleFb && this.rumbleDelay) {
        const b = clamp(control.build, 0, 1);
        const dens = clamp(control.rightPinch, 0, 1);
        this.rumbleSend.gain.value = 0.02 + 0.22 * b + baseRumble;
        this.rumbleFb.gain.value = 0.50 + 0.35 * b + baseRumbleFb;
        this.rumbleDelay.delayTime.value = expRange01(control.rightX, 0.18, 0.34);
        if (this.rumbleLP) this.rumbleLP.frequency.value = expRange01(control.rightY, 120, 260);
        if (this.rumbleHP) this.rumbleHP.frequency.value = 28 + 18 * (1 - dens);
      }

      this.ensureRaveScheduler();
    }

    // Level: DRONE is gated by left pinch, RAVE plays by itself.
    const kill = !!control.kill;

    // No-hands idle fade (smooth): when no hands in frame, play quietly + show prompt in UI.
    const handsCount = control.hands?.count ?? 0;
    const idleTarget = handsCount > 0 ? 0 : 1;
    this.idleAmt = this.idleAmt + (idleTarget - this.idleAmt) * 0.10;
    const gate =
      this.mode === "performance"
        ? (kill ? 0 : 1)
        : kill
          ? 0
          : clamp(Math.max(this.gate, control.leftPinch * 1.1, pluck ? 0.85 : 0), 0, 1);

    // DRONE stems: real bass + real guitar
    if (this.mode === "drone") {
      void this.ensureDroneStemsLoaded();
      if (this.droneStemsLoaded) {
        this.ensureDroneStemsPlaying();
        const ctx = this.ctx;
        if (ctx) {
          const t = ctx.currentTime;

          if (this.droneBassGain) {
            // Bass (left hand): pinch = level. Silent at 0.
            const live = 0.70 * Math.pow(clamp(control.leftPinch, 0, 1), 1.25);
            const idle = 0.10;
            const bassTarget = kill ? 0 : (live * (1 - this.idleAmt) + idle * this.idleAmt);
            try {
              this.droneBassGain.gain.setTargetAtTime(bassTarget, t, 0.08);
            } catch {
              this.droneBassGain.gain.value = bassTarget;
            }
          }
          if (this.droneBassLP) {
            // Bass tone: left Y
            const y = clamp(control.leftY, 0, 1);
            const cut = expRange01(y, 80, 240);
            const q = 0.40 + 0.25 * (1 - y);
            if (Math.abs(cut - this.lastBassCut) > 0.5) {
              this.lastBassCut = cut;
              this.droneBassLP.frequency.value = cut;
            }
            if (Math.abs(q - this.lastBassQ) > 0.02) {
              this.lastBassQ = q;
              this.droneBassLP.Q.value = q;
            }
          }

          // Bass pitch: left X (deeper overall, small expressive drift).
          {
            const x = clamp(control.leftX, 0, 1);
            const rate = expRange01(x, 0.14, 0.36);
            if (Math.abs(rate - this.lastDroneRate) > 0.002) {
              this.lastDroneRate = rate;
              if (this.droneBassSrc) {
                try {
                  this.droneBassSrc.playbackRate.setTargetAtTime(rate, t, 0.18);
                } catch {
                  this.droneBassSrc.playbackRate.value = rate;
                }
              }
              if (this.droneBassEl) {
                try {
                  this.droneBassEl.playbackRate = rate;
                } catch {
                }
              }
            }
          }

          // Bass drive: left pinch (more sustain/weight, less click).
          if (this.droneBassDrive) {
            const p = clamp(control.leftPinch, 0, 1);
            const amt = 0.20 + 0.12 * p;
            if (Math.abs(amt - this.lastBassDriveAmt) > 0.02) {
              this.lastBassDriveAmt = amt;
              this.droneBassDrive.curve = makeDriveCurve(amt);
            }
          }

          // Guitar (right hand): full manual control
          {
            const p = clamp(control.rightPinch, 0, 1);
            const bright = clamp(control.rightY, 0, 1);
            const dtGtr = control.dt;

            // Auto-swell (occasional) when not actively playing by hand.
            // Keeps the drone alive even with hands idle.
            if (!kill) {
              const handActive = p > 0.18;
              if (!handActive) {
                if (t >= this.droneGtrNextSwellT) {
                  const len = 3.5 + 6.5 * this.rand01();
                  this.droneGtrSwellUntilT = t + len;
                  // Subtle amplitude (scaled down by idleAmt below).
                  this.droneGtrAutoTarget = 0.10 + 0.16 * this.rand01();

                  const gap = 6.0 + 18.0 * this.rand01();
                  this.droneGtrNextSwellT = t + len + gap;
                }
                if (t >= this.droneGtrSwellUntilT) {
                  this.droneGtrAutoTarget = 0;
                }
              } else {
                // Manual play cancels the auto swell quickly.
                this.droneGtrAutoTarget = 0;
              }

              const atk = 1.0 - Math.exp(-dtGtr * 0.9);
              const rel = 1.0 - Math.exp(-dtGtr * 0.55);
              const kk = this.droneGtrAutoTarget > this.droneGtrAuto ? atk : rel;
              this.droneGtrAuto += (this.droneGtrAutoTarget - this.droneGtrAuto) * kk;
            } else {
              this.droneGtrAutoTarget = 0;
              this.droneGtrAuto *= Math.pow(0.15, dtGtr);
            }

            // Continuous control: pinch = level. Silent at 0.
            const live = 0.65 * Math.pow(p, 1.25);
            const idle = 0.06;
            const auto = this.droneGtrAuto * (1 - this.idleAmt);
            const g = kill ? 0 : (Math.max(live, auto) * (1 - this.idleAmt) + idle * this.idleAmt);
            if (this.droneGtrAGain) {
              try {
                this.droneGtrAGain.gain.setTargetAtTime(g, t, 0.10);
              } catch {
                this.droneGtrAGain.gain.value = g;
              }
            }
            if (this.droneGtrASrc) {
              // Total drone: force sub-low playbackRate (down-pitched Sunn O))) bed).
              // Right X gives small drift in this low range.
              const rate = expRange01(control.rightX, 0.12, 0.28);
              if (Math.abs(rate - this.lastDroneRateA) > 0.004) {
                this.lastDroneRateA = rate;
                try {
                  this.droneGtrASrc.playbackRate.setTargetAtTime(rate, t, 0.10);
                } catch {
                  this.droneGtrASrc.playbackRate.value = rate;
                }
              }
            }
            if (this.droneGtrALP && this.droneGtrADrive && this.droneGtrAPre) {
              // Cab/brightness
              this.droneGtrALP.frequency.value = expRange01(bright, 900, 2600);

              // Pinch mostly adds gain + more fuzz, not pitch.
              const fuzzMul = 1 - 0.55 * this.idleAmt;
              this.droneGtrAPre.curve = makeDriveCurve((0.65 + 0.30 * p) * fuzzMul);
              this.droneGtrADrive.curve = makeDriveCurve((0.75 + 0.25 * p) * fuzzMul);
            }
          }
        }
      }
    } else {
      // Not in drone mode: silence stems.
      if (this.droneBassGain) this.droneBassGain.gain.value = 0;
      if (this.droneGtrAGain) this.droneGtrAGain.gain.value = 0;
      this.stopDroneStems();
    }

    // Mute worklet's own DRONE synthesis when real stems are active.
    const haveBass = !!this.sampleDroneBass || !!this.droneBassElSrc;
    const haveGtr = !!this.sampleDroneGuitar;
    const muteWorklet = this.mode === "drone" && haveBass && haveGtr;
    const workletGain = muteWorklet ? 0 : 1.0;

    this.node.port.postMessage({
      type: "params",
      mode: this.mode,
      freq: baseHz,
      gain: workletGain,
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
      guitarBright,
      guitarGate
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
    if (!this.analyser) return null;

    const fftSize = this.analyser.frequencyBinCount;
    if (!this.fftBuf || this.fftBuf.length !== fftSize) {
      this.fftBuf = new Float32Array(fftSize) as unknown as Float32Array<ArrayBuffer>;
    }
    if (!this.waveBuf || this.waveBuf.length !== 256) {
      this.waveBuf = new Float32Array(256) as unknown as Float32Array<ArrayBuffer>;
    }

    try {
      this.analyser.getFloatFrequencyData(this.fftBuf);
      this.analyser.getFloatTimeDomainData(this.waveBuf);
    } catch {
      return null;
    }

    // Provide at least kick+fft so HUD meter and WaveLab have something meaningful.
    return {
      kick: this.waveBuf,
      fft: this.fftBuf
    };
  }

  getPulse() {
    return this.pulse;
  }

  setMode(_mode: "performance" | "drone") {
    this.mode = _mode;
    this.applyModeGainStaging();
    if (this.mode === "performance") {
      void this.ensureSamplesLoaded();
      this.ensureRaveScheduler();
    }
  }

  private applyModeGainStaging() {
    // Goal: keep perceived loudness consistent between modes.
    // - performance: cleaner, less clip drive
    // - drone: more overload character, but compensated down post-clip
    if (this.mode === "drone") {
      if (this.preClip) this.preClip.gain.value = 2.2;
      if (this.clipper) this.clipper.curve = makeDriveCurve(0.55);
      if (this.postClip) this.postClip.gain.value = 0.55;
    } else {
      if (this.preClip) this.preClip.gain.value = 1.0;
      if (this.clipper) this.clipper.curve = makeDriveCurve(0.18);
      if (this.postClip) this.postClip.gain.value = 1.0;
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
