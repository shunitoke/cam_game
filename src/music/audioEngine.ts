import * as Tone from "tone";

import type { ControlState } from "../control/types";
import type { MidiEvent } from "../midi/midiInput";

export const AUDIO_ENGINE_VERSION = "techno-demo-2025-12-18-v3";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ ok: boolean; value?: T }> {
  let t: any = null;
  try {
    const v = await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error("timeout")), Math.max(0, ms));
      })
    ]);
    if (t) clearTimeout(t);
    return { ok: true, value: v };
  } catch {
    if (t) clearTimeout(t);
    return { ok: false };
  }
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function expRange01(v: number, min: number, max: number, k = 4) {
  const x = (Math.exp(k * v) - 1) / (Math.exp(k) - 1);
  return min + (max - min) * x;
}

function wrapInt(v: number, m: number) {
  const mm = Math.max(1, Math.floor(m));
  return ((Math.floor(v) % mm) + mm) % mm;
}

function euclid(steps: number, pulses: number, rotation = 0) {
  const s = Math.max(1, Math.floor(steps));
  const p = Math.max(0, Math.min(s, Math.floor(pulses)));
  const r = wrapInt(rotation, s);
  const out: boolean[] = new Array(s).fill(false);
  if (p <= 0) return out;
  if (p >= s) return out.fill(true);
  for (let i = 0; i < s; i++) {
    const a = Math.floor(((i + 1) * p) / s);
    const b = Math.floor((i * p) / s);
    out[(i + r) % s] = a !== b;
  }
  return out;
}

function ramp01(t: number, t0: number, t1: number) {
  if (t1 <= t0) return t >= t1 ? 1 : 0;
  return clamp01((t - t0) / (t1 - t0));
}

export class AudioEngine {
  private static readonly INTRO_BARS = 4;
  private static readonly LOOP_BARS = 8;
  private started = false;

  private safeMode = false;

  private mode: "performance" | "drone" = "performance";
  private track: "rave" | "modern" | "melodic" = "rave";
  private gestureOn = false;
  private gestureNote: string | null = null;
  private gestureVoice: "bass" | "stab" | "lead" | "simpleLead" | "pad" | null = null;

  private gestureMidi: number | null = null;
  private gestureLastPolyT = 0;

  private raveLeadEnabled = true;

  private droneCMinorNotes: number[] | null = null;

  private midiSamplesLoadStarted = false;
  private midiSamplesLoaded = false;

  private midiScheduleT = 0;

  private lastParamUpdateT = 0;
  private paramUpdateIntervalMs = 50;

  private master = new Tone.Gain(1.25);
  private limiter = new Tone.Limiter(-0.5);

  private drive = new Tone.Distortion(0.1);
  private filter = new Tone.Filter(900, "lowpass");

  private droneOsc = new Tone.Oscillator({ type: "sine", frequency: 220 });
  private droneFilter = new Tone.Filter({ type: "lowpass", frequency: 520, Q: 0.25 });
  private droneGain = new Tone.Gain(0);

  private droneBassOsc = new Tone.Oscillator({ type: "sine", frequency: 55 });
  private droneBassFilter = new Tone.Filter({ type: "lowpass", frequency: 220, Q: 0.7 });
  private droneBassGain = new Tone.Gain(0);
  private droneBassDryGain = new Tone.Gain(0);
  private droneDrive = new Tone.Distortion(0.75);
  private droneCheby = new Tone.Chebyshev({ order: 24, oversample: "2x" } as any);
  private droneCrush = new Tone.BitCrusher(6);
  private droneComp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.15 } as any);
  private droneCabHP = new Tone.Filter({ type: "highpass", frequency: 70, Q: 0.7 });
  private droneCabNotch = new Tone.Filter({ type: "peaking", frequency: 850, Q: 1.1, gain: -6 } as any);
  private droneCabLP = new Tone.Filter({ type: "lowpass", frequency: 3600, Q: 0.7 });
  private dronePostFilter = new Tone.Filter({ type: "lowpass", frequency: 520, Q: 0.7 });

  private dronePickNoise = new Tone.Noise({ type: "pink" } as any);
  private dronePickFilter = new Tone.Filter({ type: "bandpass", frequency: 1800, Q: 1.3 });
  private dronePickEnv = new Tone.AmplitudeEnvelope({ attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 } as any);
  private droneGateOn = false;

  private droneCMinorNotesLow: number[] | null = null;
  private droneCMinorNotesBass: number[] | null = null;

  private delay = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0.25, wet: 0.0 });
  private reverb = new Tone.Reverb({ decay: 3.2, preDelay: 0.01, wet: 0.0 });

  private kickPre = new Tone.Filter({ type: "lowpass", frequency: 180, Q: 0.7 });
  private hatPre = new Tone.Filter({ type: "highpass", frequency: 650, Q: 0.7 });
  private bassPre = new Tone.Filter({ type: "lowpass", frequency: 320, Q: 0.8 });
  private stabPre = new Tone.Filter({ type: "lowpass", frequency: 1200, Q: 0.8 });
  private leadPre = new Tone.Filter({ type: "lowpass", frequency: 1650, Q: 0.8 });
  private simpleLeadPre = new Tone.Filter({ type: "lowpass", frequency: 1600, Q: 0.7 });
  private padPre = new Tone.Filter({ type: "lowpass", frequency: 900, Q: 0.7 });

  private waveKick = new Tone.Waveform(256);
  private waveHat = new Tone.Waveform(256);
  private waveBass = new Tone.Waveform(256);
  private waveStab = new Tone.Waveform(256);
  private waveLead = new Tone.Waveform(256);
  private waveSimpleLead = new Tone.Waveform(256);
  private wavePad = new Tone.Waveform(256);

  private fft = new Tone.FFT({ size: 512, smoothing: 0.82, normalRange: false });

  private selectedVoice = 0;

  private partialsBass: number[] = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0));
  private partialsStab: number[] = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.35 : 0));
  private partialsLead: number[] = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.55 : i === 2 ? 0.22 : 0));
  private partialsSimpleLead: number[] = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.25 : 0));

  private waveEditEnabled = false;
  private waveEditHoldMs = 0;
  private waveEditIndex = 0;
  private waveEditValue = 0;
  private waveEditTarget: "bass" | "stab" | "lead" | "simpleLead" = "bass";
  private waveEditDirty = false;
  private waveEditLastApplyT = 0;

  private waveEditPack = {
    enabled: false,
    target: "bass" as "bass" | "stab" | "lead" | "simpleLead",
    harmonicIndex: 0,
    value: 0
  };

  private wavePack: {
    kick?: Float32Array;
    hat?: Float32Array;
    bass?: Float32Array;
    stab?: Float32Array;
    lead?: Float32Array;
    simpleLead?: Float32Array;
    pad?: Float32Array;
    fft?: Float32Array;
    partialsBass?: number[];
    partialsStab?: number[];
    partialsLead?: number[];
    partialsSimpleLead?: number[];
    waveEdit?: {
      enabled: boolean;
      target: "bass" | "stab" | "lead" | "simpleLead";
      harmonicIndex: number;
      value: number;
    };
    selectedVoice?: number;
  } = {
    waveEdit: this.waveEditPack
  };

  private kick = new Tone.MembraneSynth({
    pitchDecay: 0.03,
    octaves: 8,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0.0, release: 0.01 }
  });

  private hat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.12, release: 0.01 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 3400,
    octaves: 1.2
  });

  private bass = new Tone.MonoSynth({
    oscillator: { type: "custom", partials: [1] },
    filter: { Q: 1.8, type: "lowpass", rolloff: -24 },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0.06, release: 0.08 },
    filterEnvelope: { attack: 0.001, decay: 0.13, sustain: 0.02, release: 0.10, baseFrequency: 45, octaves: 4.0 }
  });

  private stab = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "custom", partials: [1] },
    envelope: { attack: 0.003, decay: 0.16, sustain: 0.0, release: 0.10 }
  });

  private lead = new Tone.MonoSynth({
    oscillator: { type: "fatsawtooth", count: 3, spread: 24 } as any,
    filter: { Q: 3.2, type: "lowpass", rolloff: -24 },
    envelope: { attack: 0.003, decay: 0.10, sustain: 0.12, release: 0.10 },
    filterEnvelope: { attack: 0.002, decay: 0.10, sustain: 0.08, release: 0.09, baseFrequency: 180, octaves: 3.6 }
  });

  private simpleLead = new Tone.MonoSynth({
    oscillator: { type: "triangle" },
    filter: { Q: 1.2, type: "lowpass", rolloff: -24 },
    envelope: { attack: 0.01, decay: 0.18, sustain: 0.0, release: 0.12 },
    filterEnvelope: { attack: 0.01, decay: 0.12, sustain: 0.0, release: 0.10, baseFrequency: 180, octaves: 2.2 }
  });

  private pad = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.45, decay: 0.8, sustain: 0.25, release: 1.4 }
  });

  private clap = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.08, sustain: 0.0, release: 0.01 }
  });
  private clapPre = new Tone.Filter({ type: "bandpass", frequency: 1800, Q: 0.9 });

  private snare = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.14, sustain: 0.0, release: 0.01 }
  });
  private snarePre = new Tone.Filter({ type: "bandpass", frequency: 900, Q: 0.8 });

  private beatPulse = 0;

  private leadStep = 0;
  private leadDensity = 0.55;
  private leadAccent = 0.35;

  private simpleLeadStep = 0;
  private padHold = false;

  private hatProb = 0.55;
  private bassProb = 0.55;

  private bassStep = 0;

  private genEnabled = false;
  private genSteps = 16;
  private genRot = 0;
  private genHatP = 9;
  private genClapP = 2;
  private genPercP = 5;
  private genStep = 0;
  private genFillUntilBar = -1;

  private genLatchOn = true;
  private genRootMidi = 48;

  private introT = 0;
  private introOn = true;
  private introStartSec = 0;

  private introKick = 1.0;
  private introHat = 0.0;
  private introClap = 0.0;
  private introBass = 0.0;
  private introLead = 0.0;
  private introPad = 0.0;

  private updateIntroFromTransport() {
    if (this.mode !== "performance") return;
    if (!this.introOn) return;

    if (this.introStartSec <= 0) this.introStartSec = Tone.Transport.seconds;

    const bpm = this.cfg.bpm || 120;
    const secPerBar = (60 / Math.max(1, bpm)) * 4;
    const barsSinceStart = (Tone.Transport.seconds - this.introStartSec) / Math.max(1e-3, secPerBar);

    this.introKick = 1.0;
    this.introHat = ramp01(barsSinceStart, 0, 1);
    this.introBass = ramp01(barsSinceStart, 0.5, 2.0);
    this.introClap = ramp01(barsSinceStart, 1.0, 2.5);
    this.introLead = ramp01(barsSinceStart, 1.5, 3.5);
    this.introPad = ramp01(barsSinceStart, 2.0, AudioEngine.INTRO_BARS);

    if (barsSinceStart > AudioEngine.INTRO_BARS) {
      this.introOn = false;
      this.introHat = 1;
      this.introBass = 1;
      this.introClap = 1;
      this.introLead = 1;
      this.introPad = 1;
    }
  }

  private sceneId = "particles";

  private midiMod = 0;
  private midiRev = 0;

  private midiSampleGain = new Tone.Gain(1.15);
  private midiSampleFilter = new Tone.Filter({ type: "lowpass", frequency: 9000, Q: 0.65 });
  private midiCrush = new Tone.BitCrusher(8);
  private midiCrushAmount = 0;
  private midiSampleCutoff = 0.85;
  private midiSamples: Record<string, any> = {};
  private midiSampleLastT: Record<string, number> = {};
  private midiSynthLastT: Record<number, number> = {};
  private midiSynthThrottle = 0.025;

  private midiSamplesFallbackTried = false;

  private initMidiSamples(useFallback: boolean) {
    const base = useFallback ? "https://tonejs.github.io/audio/drum-samples/909" : "/samples/user/909";
    const ext = useFallback ? "mp3" : "wav";

    this.midiSamples = {
      kick: new Tone.Player({ url: `${base}/kick.${ext}` }),
      snare: new Tone.Player({ url: `${base}/snare.${ext}` }),
      hat: new Tone.Player({ url: `${base}/hihat.${ext}` }),
      clap: new Tone.Player({ url: `${base}/clap.${ext}` }),
      cowbell: new Tone.Player({ url: `${base}/cowbell.${ext}` }),
      perc: new Tone.Player({ url: `${base}/tom.${ext}` })
    };

    for (const p of Object.values(this.midiSamples)) {
      p.retrigger = true;
      p.connect(this.midiSampleGain);
    }
  }

  private async loadMidiSamples() {
    if (this.midiSamplesLoaded) return;
    if (this.midiSamplesLoadStarted) return;
    this.midiSamplesLoadStarted = true;

    const players = Object.values(this.midiSamples);
    try {
      await Promise.all(
        players.map(async (p: any) => {
          if (!p) return;
          if (typeof p.load === "function") {
            await p.load();
          }
        })
      );
      this.midiSamplesLoaded = true;
    } catch {
      if (!this.midiSamplesFallbackTried) {
        this.midiSamplesFallbackTried = true;
        this.midiSamplesLoadStarted = false;
        this.initMidiSamples(true);
        await this.loadMidiSamples();
        return;
      }
      this.midiSamplesLoaded = false;
    }
  }

  private midiHeldNotes = new Set<number>();
  private midiMaxHeld = 10;

  private midiNoteName: string[] = [];
  private midiTriad: Array<[string, string, string] | null> = [];

  private transportPpq = 192;
  private transportBeatsPerBar = 4;
  private transportTicksPerBar = 192 * 4;
  private transportTicksPerBeat = 192;
  private transportTicksPer16 = 48;

  private genPatSteps = -1;
  private genPatHatP = -1;
  private genPatClapP = -1;
  private genPatPercP = -1;
  private genPatRot = -999999;
  private genPatHat: boolean[] = [];
  private genPatClap: boolean[] = [];
  private genPatPerc: boolean[] = [];

  constructor(private readonly cfg: { bpm: number }) {
    this.master.chain(this.limiter, Tone.getDestination());

    this.kick.connect(this.kickPre);
    this.hat.connect(this.hatPre);
    this.bass.connect(this.bassPre);
    this.stab.connect(this.stabPre);
    this.lead.connect(this.leadPre);
    this.simpleLead.connect(this.simpleLeadPre);
    this.pad.connect(this.padPre);

    this.kickPre.connect(this.drive);
    this.hatPre.connect(this.filter);
    this.bassPre.connect(this.drive);
    this.stabPre.connect(this.filter);
    this.leadPre.connect(this.filter);
    this.simpleLeadPre.connect(this.filter);
    this.padPre.connect(this.reverb);

    this.kickPre.connect(this.waveKick);
    this.hatPre.connect(this.waveHat);
    this.bassPre.connect(this.waveBass);
    this.stabPre.connect(this.waveStab);
    this.leadPre.connect(this.waveLead);
    this.simpleLeadPre.connect(this.waveSimpleLead);
    this.padPre.connect(this.wavePad);

    this.reverb.connect(this.fft);

    this.clap.connect(this.clapPre);
    this.clapPre.connect(this.filter);

    this.snare.connect(this.snarePre);
    this.snarePre.connect(this.filter);

    // MIDI one-shot samples (routed into existing FX chain)
    this.midiSampleGain.connect(this.midiSampleFilter);
    this.midiSampleFilter.connect(this.midiCrush);
    this.midiCrush.connect(this.filter);
    this.initMidiSamples(false);

    this.drive.connect(this.filter);
    this.filter.connect(this.delay);
    this.delay.connect(this.reverb);
    this.reverb.connect(this.master);

    this.droneOsc.connect(this.droneFilter);
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.droneDrive);
    this.droneDrive.connect(this.droneCheby);
    this.droneCheby.connect(this.droneCrush);
    this.droneCrush.connect(this.droneComp);
    this.droneComp.connect(this.droneCabHP);
    this.droneCabHP.connect(this.droneCabNotch);
    this.droneCabNotch.connect(this.droneCabLP);
    this.droneCabLP.connect(this.dronePostFilter);
    this.dronePostFilter.connect(this.reverb);

    this.dronePickNoise.connect(this.dronePickFilter);
    this.dronePickFilter.connect(this.dronePickEnv);
    this.dronePickEnv.connect(this.droneDrive);

    this.droneBassOsc.connect(this.droneBassFilter);
    this.droneBassFilter.connect(this.droneBassGain);
    this.droneBassGain.connect(this.reverb);
    this.droneBassGain.connect(this.droneBassDryGain);
    this.droneBassDryGain.connect(this.master);
    this.droneBassDryGain.connect(this.waveBass);

    this.applyCustomWaveforms();

    Tone.Transport.bpm.value = cfg.bpm;
    Tone.Transport.timeSignature = [4, 4];
    (Tone.Transport as any).swing = 0;
    (Tone.Transport as any).swingSubdivision = "8n";

    {
      const tr: any = Tone.Transport as any;
      const ppq = typeof tr?.PPQ === "number" ? tr.PPQ : 192;
      const ts: any = Tone.Transport.timeSignature as any;
      const beatsPerBar = Array.isArray(ts) ? (ts[0] ?? 4) : typeof ts === "number" ? ts : 4;

      this.transportPpq = ppq;
      this.transportBeatsPerBar = beatsPerBar;
      this.transportTicksPerBeat = ppq;
      this.transportTicksPerBar = ppq * beatsPerBar;
      this.transportTicksPer16 = Math.max(1, Math.floor(ppq / 4));
    }

    this.hat.frequency.value = 270;

    // Acid-ish behavior
    this.lead.portamento = 0.03;
    // Slight detune thickness (set via signal to avoid TS option mismatch)
    (this.lead.detune as any).value = 6;
    // Slight detune for stabs (PolySynth forwards set() to voices)
    (this.stab as any).set({ detune: 7 });

    // Simple mono legato lead
    this.simpleLead.portamento = 0.08;

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      if (!Number.isFinite(barNum) || !Number.isFinite(beat)) return;

      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const inBreak = loopBar === 4;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;

      const kickOn = inDrop ? beat === 0 || beat === 2 : beat === 0;
      if (kickOn) {
        const v = inBreak ? 0.60 : inBuild ? 0.86 : inDrop ? (beat === 2 ? 0.92 : 0.98) : 0.94;
        this.kick.triggerAttackRelease("C1", "8n", time, v);
        this.beatPulse = 1;
      }
    }, "4n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const g = this.introHat;
      if (g <= 0.001) return;

      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      if (!Number.isFinite(barNum) || !Number.isFinite(beat)) return;

      if (this.safeMode) {
        const ticksPer8 = Math.max(1, Math.floor(this.transportTicksPerBeat / 2));
        const sub8 = Math.floor(inBar / ticksPer8);
        if ((sub8 & 1) === 1) return;
      }
      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const inBreak = loopBar === 4;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;

      const secMul = inBreak ? 0.30 : inBuild ? 0.85 : inDrop ? 1.25 : 1.0;
      const dens = Math.max(0.05, this.hatProb) * secMul;
      const a = inBreak && beat === 0 ? 0.55 : 1.0;
      this.hat.triggerAttackRelease("16n", time, 0.22 * g * dens * a);
      if (dens > 0.35 && (!inBreak || beat !== 0)) {
        this.hat.triggerAttackRelease("16n", time + Tone.Time("16n").toSeconds(), 0.16 * g * dens);
      }
    }, "8n");

    const bassNotes = ["C1", "C1", "C1", "G0", "D#1", "C1", "G0", "A#0"];
    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const g = this.introBass;
      if (g <= 0.001) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      if (!Number.isFinite(barNum)) return;

      if (this.safeMode) {
        const inBar = ticks - barNum * this.transportTicksPerBar;
        const ticksPer8 = Math.max(1, Math.floor(this.transportTicksPerBeat / 2));
        const sub8 = Math.floor(inBar / ticksPer8);
        if ((sub8 & 1) === 1) return;
      }

      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const inBreak = loopBar === 4;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;

      const step = this.bassStep++ % bassNotes.length;
      const secMul = inBreak ? 0.18 : inBuild ? 0.85 : inDrop ? 1.25 : 1.0;
      const dens = this.bassProb * secMul;
      const play = dens >= 0.55 ? true : step % 2 === 0;
      if (!play) return;
      this.bass.triggerAttackRelease(bassNotes[step]!, "16n", time, 0.55 * g * (inBreak ? 0.65 : 1));
    }, "8n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      if (!Number.isFinite(barNum)) return;
      const g = this.introLead;
      if (g <= 0.001) return;
      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;
      if (inDrop && barNum % 2 === 1) {
        this.stab.triggerAttackRelease(["C4", "G4", "A#4"], "8n", time, 0.22 * g);
      } else if (inBuild && barNum % 2 === 0) {
        this.stab.triggerAttackRelease(["C4", "G4"], "8n", time, 0.16 * g);
      }
    }, "2n");

    const root = Tone.Frequency("C3");
    const pattA = [0, -1, 0, 7, 0, -1, 10, 7, 0, -1, 0, 12, 7, -1, 10, -1];
    const pattB = [0, -1, 0, 3, 7, -1, 0, -1, 10, -1, 12, 10, 7, -1, 3, -1];
    const accentA = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    const accentB = [1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
    const slideA = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
    const slideB = [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0];

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const isA = loopBar < 4;
      const patt = isA ? pattA : pattB;
      const acc = isA ? accentA : accentB;
      const sld = isA ? slideA : slideB;

      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      const inBeat = inBar - beat * this.transportTicksPerBeat;
      const sixteenth = Math.floor(inBeat / this.transportTicksPer16);
      const step = ((beat * 4 + sixteenth) | 0) % 16;
      const barStart = step === 0;

      if (this.safeMode && (step & 1) === 1) return;

      const inBreak = loopBar === 4;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;
      const densMul = inBreak ? 0.10 : inBuild ? 0.75 : inDrop ? 1.25 : 0.95;
      if (Math.random() > this.leadDensity * densMul) return;

      const g = this.introLead;
      if (g <= 0.001) return;

      const semi = patt[step];
      if (semi < 0) return;


      const isAccent = acc[step] === 1 && Math.random() < this.leadAccent;
      const isSlide = sld[step] === 1;
      const vel = (isAccent ? 0.32 : 0.16) * g * (inBreak ? 0.65 : 1);

      const note = root.transpose(semi).toNote();
      if (this.raveLeadEnabled) {
        this.lead.triggerAttackRelease(note, isSlide ? "8n" : "16n", time, vel);
      }
    }, "16n");

    const leadMel = ["E4", "G4", "A4", "G4", "D4", "E4", "B3", "D4"];
    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const g = this.introLead;
      if (g <= 0.001) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      if (!Number.isFinite(barNum)) return;
      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      if (loopBar < 6) return;
      const step = this.simpleLeadStep++ % leadMel.length;
      const note = leadMel[step]!;
      this.simpleLead.triggerAttackRelease(note, "4n", time, 0.16 * g);
    }, "2n", "0");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      if (!Number.isFinite(barNum)) return;
      const g = this.introPad;
      if (g <= 0.001) return;
      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      if (loopBar !== 0 && loopBar !== 4) return;
      const chord = loopBar === 0 ? ["C4", "G4", "A#4", "D5"] : ["A#3", "F4", "G4", "C5"];
      this.pad.triggerAttackRelease(chord, "1m", time, 0.075 * g);
    }, "2m", "0");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const g = this.introClap;
      if (g <= 0.001) return;
      this.clap.triggerAttackRelease("16n", time, 0.52 * g);
    }, "2n", "4n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (this.genEnabled) return;
      const g = Math.max(this.introClap, this.introHat);
      if (g <= 0.001) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      const inBeat = inBar - beat * this.transportTicksPerBeat;
      const sixteenth = Math.floor(inBeat / this.transportTicksPer16);
      if (!Number.isFinite(beat) || !Number.isFinite(sixteenth)) return;
      const step = ((beat * 4 + sixteenth) | 0) % 16;

      if (this.safeMode && (step & 1) === 1) return;
      // Light techno perc: offbeats + occasional extra tick.
      if (step % 8 === 4) {
        this.snare.triggerAttackRelease("16n", time, 0.16 * g);
      } else if (step % 8 === 6 && Math.random() < 0.35) {
        this.snare.triggerAttackRelease("32n", time, 0.10 * g);
      }
    }, "16n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "modern") return;
      if (this.genEnabled) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      const inBeat = inBar - beat * this.transportTicksPerBeat;
      const sixteenth = Math.floor(inBeat / this.transportTicksPer16);
      if (!Number.isFinite(barNum) || !Number.isFinite(beat) || !Number.isFinite(sixteenth)) return;

      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const inBreak = loopBar === 4;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;

      const gK = this.introKick;
      const gH = this.introHat;
      const gC = this.introClap;
      const gB = this.introBass;
      const gL = this.introLead;

      const step16 = ((beat * 4 + sixteenth) | 0) % 16;

      const kick = (step16 === 0 || step16 === 6 || (inDrop && step16 === 10)) && !inBreak;
      if (kick && gK > 0.001) {
        const v = inBuild ? 0.72 : inDrop ? 0.92 : 0.82;
        this.kick.triggerAttackRelease("C1", "16n", time, v * gK);
        this.beatPulse = 1;
      }

      const backbeat = step16 === 4 || step16 === 12;
      if (backbeat && gC > 0.001) {
        const v = (inBreak ? 0.35 : 0.55) * gC;
        this.clap.triggerAttackRelease("16n", time, v);
        this.snare.triggerAttackRelease("16n", time + Tone.Time("64n").toSeconds(), v * 0.35);
      }

      if (gH > 0.001) {
        const hatOn = step16 === 2 || step16 === 7 || step16 === 10 || step16 === 15;
        if (hatOn && !inBreak) {
          const v = (inBuild ? 0.13 : 0.16) * gH * (inDrop ? 1.15 : 1.0);
          const t = step16 === 7 || step16 === 15 ? time + Tone.Time("64n").toSeconds() : time;
          this.hat.triggerAttackRelease("32n", t, v);
        }
      }

      if (gB > 0.001 && !inBreak) {
        const bassOn = step16 === 2 || step16 === 9 || (inDrop && step16 === 14);
        if (bassOn) {
          const note = step16 === 9 ? "A#0" : "C1";
          const v = (inBuild ? 0.22 : 0.30) * gB;
          this.bass.triggerAttackRelease(note, "16n", time, v);
        }
      }

      if (gL > 0.001 && (inBuild || inDrop) && step16 === 8 && !inBreak) {
        const chord = inDrop ? (["C4", "G4", "A#4"] as any) : (["C4", "G4"] as any);
        this.stab.triggerAttackRelease(chord, "8n" as any, time, (inDrop ? 0.18 : 0.13) * gL);
      }
    }, "16n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "melodic") return;
      if (this.genEnabled) return;

      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      const inBeat = inBar - beat * this.transportTicksPerBeat;
      const sixteenth = Math.floor(inBeat / this.transportTicksPer16);
      if (!Number.isFinite(barNum) || !Number.isFinite(beat) || !Number.isFinite(sixteenth)) return;

      const loopBar = ((barNum % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;
      const inBreak = loopBar === 4;
      const inBuild = loopBar === 5;
      const inDrop = loopBar >= 6;

      const gK = this.introKick;
      const gH = this.introHat;
      const gB = this.introBass;
      const gL = this.introLead;
      const gP = this.introPad;

      const step16 = ((beat * 4 + sixteenth) | 0) % 16;

      // Keep a simple pulse: kick on 1 (and on 3 in drop), lighter hats.
      const kickOn = inDrop ? step16 === 0 || step16 === 8 : step16 === 0;
      if (kickOn && gK > 0.001 && !inBreak) {
        this.kick.triggerAttackRelease("C1", "8n", time, (inDrop ? 0.82 : 0.72) * gK);
        this.beatPulse = 1;
      }

      if (gH > 0.001) {
        const hatOn = step16 === 4 || step16 === 12 || (inDrop && (step16 === 2 || step16 === 10));
        if (hatOn && !inBreak) {
          const v = (inBuild ? 0.12 : 0.16) * gH;
          this.hat.triggerAttackRelease("16n", time, v);
        }
      }

      if (gB > 0.001 && !inBreak) {
        const bassOn = step16 === 2 || step16 === 6 || (inDrop && step16 === 14);
        if (bassOn) {
          const note = step16 === 6 ? "G0" : "C1";
          this.bass.triggerAttackRelease(note, "16n", time, (inBuild ? 0.22 : 0.28) * gB);
        }
      }

      // Melody: simpleLead plays a repeating 8-step motif, gated by section.
      if (sixteenth === 0 && !inBreak && gL > 0.001) {
        const motif = ["E4", "G4", "A4", "G4", "D4", "E4", "C4", "D4"];
        const idx = ((barNum * 4 + beat) | 0) % motif.length;
        const note = motif[idx]!;
        const vel = (inBuild ? 0.10 : inDrop ? 0.16 : 0.12) * gL;
        this.simpleLead.triggerAttackRelease(note, "8n" as any, time, vel);
      }

      // Chords: pad on bar start, stab in build/drop.
      if (sixteenth === 0 && beat === 0 && gP > 0.001) {
        const chord = loopBar < 4 ? (["C4", "G4", "A#4"] as any) : (["A#3", "F4", "G4"] as any);
        const v = (inBreak ? 0.02 : inDrop ? 0.06 : 0.045) * gP;
        this.pad.triggerAttackRelease(chord, "1m" as any, time, v);
      }

      if (inBuild && step16 === 12 && gL > 0.001) {
        this.stab.triggerAttackRelease(["C4", "G4"] as any, "8n" as any, time, 0.10 * gL);
      }
      if (inDrop && step16 === 8 && gL > 0.001) {
        this.stab.triggerAttackRelease(["C4", "G4", "A#4"] as any, "8n" as any, time, 0.14 * gL);
      }
    }, "16n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (!this.genEnabled) return;

      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      const step = wrapInt(this.genStep++, this.genSteps);
      const rot = this.genRot + (Number.isFinite(barNum) && barNum % 4 === 3 ? 1 : 0);

      const hatP = Math.max(0, Math.min(this.genSteps, this.genHatP));
      const clapP = Math.max(0, Math.min(this.genSteps, this.genClapP));
      const percP = Math.max(0, Math.min(this.genSteps, this.genPercP));

      const inBar = ticks - barNum * this.transportTicksPerBar;
      const beat = Math.floor(inBar / this.transportTicksPerBeat);
      const inBeat = inBar - beat * this.transportTicksPerBeat;
      const sixteenth = Math.floor(inBeat / this.transportTicksPer16);

      if (
        this.genPatSteps !== this.genSteps ||
        this.genPatHatP !== hatP ||
        this.genPatClapP !== clapP ||
        this.genPatPercP !== percP ||
        this.genPatRot !== rot
      ) {
        this.genPatSteps = this.genSteps;
        this.genPatHatP = hatP;
        this.genPatClapP = clapP;
        this.genPatPercP = percP;
        this.genPatRot = rot;
        this.genPatHat = euclid(this.genSteps, hatP, rot + 3);
        this.genPatClap = euclid(this.genSteps, clapP, rot + 8);
        this.genPatPerc = euclid(this.genSteps, percP, rot + 1);
      }

      const hatPat = this.genPatHat;
      const clapPat = this.genPatClap;
      const percPat = this.genPatPerc;

      const fillOn = Number.isFinite(barNum) && this.genFillUntilBar >= 0 && barNum <= this.genFillUntilBar;
      if (Number.isFinite(barNum) && this.genFillUntilBar >= 0 && barNum > this.genFillUntilBar) this.genFillUntilBar = -1;

      const gHat = this.introHat;
      const gClap = this.introClap;
      const gBass = this.introBass;
      const gLead = this.introLead;

      if (Number.isFinite(beat) && Number.isFinite(sixteenth) && sixteenth === 0) {
        this.kick.triggerAttackRelease("C1", "8n", time, 0.95);
        this.beatPulse = 1;
      }

      if (hatPat[step] && gHat > 0.001) {
        const v = fillOn ? 0.42 : 0.32;
        this.hat.triggerAttackRelease("16n", time, v * gHat);
        if (fillOn && step % 4 === 1) {
          this.hat.triggerAttackRelease("32n", time + Tone.Time("32n").toSeconds(), v * 0.65 * gHat);
        }
      }

      if (clapPat[step] && step % 8 === 4 && gClap > 0.001) {
        this.clap.triggerAttackRelease("16n", time, (fillOn ? 0.72 : 0.52) * gClap);
      }

      if (percPat[step] && gBass > 0.001) {
        // Perc lane (was previously reusing bass). Keep it simple + reliable.
        const v = fillOn ? 0.22 : 0.16;
        this.snare.triggerAttackRelease("16n", time, v * gBass);
      }

      if (step === 0 && gLead > 0.001 && Number.isFinite(barNum) && barNum % 2 === 1) {
        this.stab.triggerAttackRelease(["C4", "G4"], "8n", time, (fillOn ? 0.22 : 0.16) * gLead);
      }

      if (step % 4 === 2 && gLead > 0.001 && Math.random() < this.leadDensity * (fillOn ? 1.15 : 1.0)) {
        const rootMidi = Math.max(36, Math.min(96, this.genRootMidi + 24));
        const root = Tone.Frequency(rootMidi, "midi");
        const semi = [0, 7, 10, 12, 3, 7][(barNum + step) % 6] ?? 0;
        const note = root.transpose(semi).toNote();
        if (this.raveLeadEnabled) {
          this.lead.triggerAttackRelease(note, "16n", time, (fillOn ? 0.26 : 0.18) * gLead);
        }
      }
    }, "16n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.track !== "rave") return;
      if (!this.genEnabled) return;
      const ticks = this.getTransportTicksAtTime(time);
      const barNum = Math.floor(ticks / this.transportTicksPerBar);
      if (!Number.isFinite(barNum)) return;
      if (barNum % 4 === 0) {
        const chord = ["C4", "G4", "A#4", "D5"];
        this.pad.triggerAttackRelease(chord, "1m", time, 0.07);
      }
    }, "1m", "0");

    Tone.Transport.scheduleRepeat(() => {
      this.beatPulse = Math.max(0, this.beatPulse - 0.18);
    }, "16n");

    // Keep intro ramps progressing even when the tab is throttled (RAF paused).
    Tone.Transport.scheduleRepeat(() => {
      this.updateIntroFromTransport();
    }, "4n");

    this.midiNoteName = Array.from({ length: 128 }, (_, n) => Tone.Frequency(n, "midi").toNote());
    this.midiTriad = Array.from({ length: 128 }, (_, n) => {
      if (n < 0 || n > 127) return null;
      const root = this.midiNoteName[n]!;
      const fifth = this.midiNoteName[Math.min(127, n + 7)]!;
      const octave = this.midiNoteName[Math.min(127, n + 12)]!;
      return [root, fifth, octave];
    });
  }

  setSafeMode(on: boolean) {
    this.safeMode = on;
    this.paramUpdateIntervalMs = on ? 80 : 50;
  }

  setMode(mode: "performance" | "drone") {
    if (this.mode === mode) return;
    this.mode = mode;

    if (this.started) {
      if (mode === "performance") {
        Tone.Transport.start();
        this.introT = 0;
        this.introOn = true;
        this.introStartSec = Tone.Transport.seconds;
      } else {
        Tone.Transport.stop();
        this.introOn = false;
        this.introHat = 0;
        this.introBass = 0;
        this.introClap = 0;
        this.introLead = 0;
        this.introPad = 0;
        this.releaseGesture(Tone.now());
      }
    }
  }

  getMode() {
    return this.mode;
  }

  setTrack(track: "rave" | "modern" | "melodic") {
    this.track = track;
  }

  getTrack() {
    return this.track;
  }

  async start() {
    if (this.started) return;
    await Tone.start();
    void this.loadMidiSamples();
    // Never block entering performance on network / asset stalls.
    await withTimeout(Tone.loaded(), 2200);
    await withTimeout(this.reverb.ready, 1800);

    try {
      this.droneOsc.start();
    } catch {
    }

    try {
      this.droneBassOsc.start();
    } catch {
    }

    try {
      this.dronePickNoise.start();
    } catch {
    }

    if (this.mode === "performance") {
      Tone.Transport.start();
      this.introT = 0;
      this.introOn = true;
      this.introStartSec = Tone.Transport.seconds;
    } else {
      Tone.Transport.stop();
      this.introOn = false;
      this.introHat = 0;
      this.introBass = 0;
      this.introClap = 0;
      this.introLead = 0;
      this.introPad = 0;
    }

    this.started = true;
  }

  async stop() {
    if (!this.started) return;
    Tone.Transport.stop();
    this.releaseGesture(Tone.now());
    try {
      this.droneGain.gain.rampTo(0, 0.03);
    } catch {
    }
    this.started = false;
  }

  private getTransportTicksAtTime(time: number): number {
    const tr: any = Tone.Transport as any;
    try {
      if (tr && typeof tr.getTicksAtTime === "function") {
        const v = tr.getTicksAtTime(time);
        if (Number.isFinite(v)) return v;
      }
    } catch {
    }

    const bpm = (tr?.bpm?.value as number | undefined) ?? this.cfg.bpm;
    const ticks = time * (Math.max(1, bpm) / 60) * this.transportPpq;
    return Math.floor(ticks);
  }

  handleMidi(events: MidiEvent[]) {
    const now = Tone.now();
    if (this.midiScheduleT > now + 0.05) this.midiScheduleT = now;
    const eps = 1e-3;
    let scheduleT = Math.max(now, this.midiScheduleT + eps);
    const takeTime = () => {
      const t = scheduleT;
      scheduleT += eps;
      return t;
    };
    let synthTriggersThisFrame = 0;
    const maxSynthTriggersPerFrame = 8;

    for (const e of events) {
      if (e.type === "noteon") {
        let t = takeTime();
        // One-octave performance mapping (36..47) for NanoKey2:
        // 36 kick, 37 snare, 38 hat, 39 clap, 40 perc, 41 bass, 42 stab, 43 melody, 44 pad,
        // 45 fill, 46 gen toggle, 47 FX (handled by visuals)
        const n = e.note;
        const vel = 0.15 + e.velocity * 0.85;

        if (n === 46) {
          this.genEnabled = !this.genEnabled;
          continue;
        }

        if (n === 45) {
          const ticks = this.getTransportTicksAtTime(t);
          const barNum = Math.floor(ticks / this.transportTicksPerBar);
          if (Number.isFinite(barNum)) this.genFillUntilBar = barNum + 1;
          continue;
        }

        const pick =
          n === 36
            ? "kick"
            : n === 37
              ? "snare"
              : n === 38
                ? "hat"
                : n === 39
                  ? "clap"
                  : n === 40
                    ? "perc"
                    : null;

        if (pick) {
          const p = this.midiSamples[pick];
          if (p) {
            if (!this.midiSamplesLoaded) {
              // Fallback: always make a sound even if sample loading fails.
              if (pick === "kick") this.kick.triggerAttackRelease("C1", "16n", t, vel);
              else if (pick === "snare") this.snare.triggerAttackRelease("16n", t, vel * 0.85);
              else if (pick === "hat") this.hat.triggerAttackRelease("16n", t, vel * 0.65);
              else if (pick === "clap") this.clap.triggerAttackRelease("16n", t, vel * 0.75);
              else this.clap.triggerAttackRelease("16n", t, vel * 0.6);
              continue;
            }
            const last = this.midiSampleLastT[pick] ?? -999;
            if (t - last < 0.035) continue;
            this.midiSampleLastT[pick] = t;
            p.playbackRate = 0.95 + Math.random() * 0.12;
            // Louder, punchier one-shots (limiter handles peaks)
            p.volume.value = lerp(-12, 2, vel);
            try {
              p.start(t);
            } catch {
            }
          }
          continue;
        }

        if (n === 41) {
          const rootMidi = Math.max(24, Math.min(84, this.genRootMidi));
          const root = Tone.Frequency(rootMidi, "midi");
          this.bass.triggerAttackRelease(root.toNote(), "16n", t, 0.30 + e.velocity * 0.70);
          continue;
        }

        if (n === 42) {
          const chord = ["C4", "G4", "A#4"];
          this.stab.triggerAttackRelease(chord as any, "8n" as any, t, 0.10 + e.velocity * 0.32);
          continue;
        }

        if (n === 43) {
          this.simpleLead.triggerAttackRelease("C5", "8n" as any, t, 0.10 + e.velocity * 0.30);
          continue;
        }

        if (n === 44) {
          const note = this.midiNoteName[60] ?? Tone.Frequency(60, "midi").toNote();
          this.pad.triggerAttack(note, t, 0.06 + e.velocity * 0.20);
          continue;
        }
      }
      if (e.type === "noteoff") {
        this.midiHeldNotes.delete(e.note);
        if (e.note === 44) {
          const note = this.midiNoteName[60] ?? Tone.Frequency(60, "midi").toNote();
          this.pad.triggerRelease(note, Tone.now());
        }
      }
      if (e.type === "cc") {
        // CC1 mod wheel -> extra drive amount
        if (e.controller === 1) this.midiMod = clamp01(e.value);
        // CC91 -> reverb wet
        if (e.controller === 91) this.midiRev = clamp01(e.value);
        // CC71 -> MIDI sample LPF cutoff sweep
        if (e.controller === 71) this.midiSampleCutoff = clamp01(e.value);
        // CC74 -> MIDI sample crusher amount
        if (e.controller === 74) this.midiCrushAmount = clamp01(e.value);

        if (e.controller === 64 && e.value > 0.5) {
          this.genEnabled = !this.genEnabled;
        }

        if (e.controller === 1) {
          const v = clamp01(e.value);
          this.genHatP = Math.round(lerp(6, 13, v));
          this.genPercP = Math.round(lerp(3, 9, v));
        }
        if (e.controller === 74) {
          const v = clamp01(e.value);
          this.genRot = Math.round(lerp(0, this.genSteps - 1, v));
        }
      }
    }

    this.midiScheduleT = scheduleT;

    // Apply crusher lightly (quantize bits). 0 -> clean, 1 -> crushed
    const bits = Math.round(lerp(12, 3, this.midiCrushAmount));
    this.midiCrush.set({ bits } as any);

    const cut = expRange01(this.midiSampleCutoff, 220, 9800);
    this.midiSampleFilter.frequency.rampTo(cut, 0.04);
  }

  reset() {
    this.hatProb = 0.55;
    this.bassProb = 0.55;
    this.drive.distortion = 0.12;
    this.filter.frequency.value = 900;
    this.filter.Q.value = 1.0;
    this.delay.wet.value = 0.05;
    this.reverb.wet.value = 0.06;
    this.reverb.decay = 3.2;
    this.reverb.preDelay = 0.01;

    this.kickPre.frequency.value = 180;
    this.hatPre.frequency.value = 650;
    this.bassPre.frequency.value = 320;
    this.stabPre.frequency.value = 1200;

    this.leadPre.frequency.value = 1650;
    this.simpleLeadPre.frequency.value = 1600;
    this.padPre.frequency.value = 900;

    this.clapPre.frequency.value = 1800;

    this.partialsBass = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0));
    this.partialsStab = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.35 : 0));
    this.partialsLead = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.55 : i === 2 ? 0.22 : 0));
    this.partialsSimpleLead = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.25 : 0));
    this.waveEditEnabled = false;
    this.waveEditHoldMs = 0;
    this.waveEditDirty = true;
    this.applyCustomWaveforms();
  }

  private applyCustomWaveforms() {
    // Apply partials to synth oscillators. Tone expects partials[0] to be the fundamental.
    this.bass.set({ oscillator: { type: "custom", partials: this.partialsBass } } as any);
    this.stab.set({ oscillator: { type: "custom", partials: this.partialsStab } } as any);
    this.simpleLead.set({ oscillator: { type: "custom", partials: this.partialsSimpleLead } } as any);
  }

  private updateWaveEdit(control: ControlState) {
    const hands = control.hands?.hands ?? [];
    const right = hands.find((h) => h.label === "Right") ?? null;
    const left = hands.find((h) => h.label === "Left") ?? null;

    if (this.sceneId !== "wavelab") {
      this.waveEditEnabled = false;
      this.waveEditHoldMs = 0;
      if (this.mode === "drone") {
        const bothPinch = Boolean(left && right && left.pinch > 0.75 && right.pinch > 0.75);

        if (bothPinch) {
          this.waveEditHoldMs += control.dt * 1000;
          if (this.waveEditHoldMs > 480) {
            this.waveEditEnabled = !this.waveEditEnabled;
            this.waveEditHoldMs = 0;
          }
        } else {
          this.waveEditHoldMs = 0;
        }
      }
    } else {
      this.waveEditHoldMs = 0;
    }

    if (!this.waveEditEnabled) return;

    // Target is based on selected voice
    if (this.selectedVoice === 3) this.waveEditTarget = "stab";
    else if (this.selectedVoice === 4) this.waveEditTarget = "lead";
    else if (this.selectedVoice === 5) this.waveEditTarget = "simpleLead";
    else this.waveEditTarget = "bass";

    // Choose harmonic index/value using left hand if present, fallback to control values.
    const lx = left ? clamp01(left.center.x) : clamp01(control.leftX);
    const ly = left ? clamp01(1 - left.center.y) : clamp01(control.leftY);
    const idx = Math.min(15, Math.max(0, Math.floor(lx * 16)));
    const val = clamp01(ly);

    this.waveEditIndex = idx;
    this.waveEditValue = val;

    // Commit while right pinch is held.
    const commit = right ? right.pinch > 0.6 : control.rightPinch > 0.6;
    const clear = Boolean(left?.fist);

    if (clear) {
      if (this.waveEditTarget === "bass") this.partialsBass = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0));
      else if (this.waveEditTarget === "stab") {
        this.partialsStab = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.35 : 0));
      } else if (this.waveEditTarget === "lead") {
        this.partialsLead = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.55 : i === 2 ? 0.22 : 0));
      } else {
        this.partialsSimpleLead = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.25 : 0));
      }
      this.waveEditDirty = true;
    } else if (commit) {
      const p =
        this.waveEditTarget === "bass"
          ? this.partialsBass
          : this.waveEditTarget === "stab"
            ? this.partialsStab
            : this.waveEditTarget === "lead"
              ? this.partialsLead
              : this.partialsSimpleLead;
      p[idx] = val;
      // gentle rolloff using rightSpeed as a macro
      const roll = clamp01(control.rightSpeed);
      for (let i = 1; i < p.length; i++) {
        p[i] *= 1 - roll * 0.25;
      }
      this.waveEditDirty = true;
    }

    // Apply at most ~10 Hz to avoid heavy reconfiguration every frame
    if (this.waveEditDirty) {
      this.waveEditLastApplyT += control.dt;
      if (this.waveEditLastApplyT > 0.10) {
        this.waveEditLastApplyT = 0;
        this.waveEditDirty = false;
        this.applyCustomWaveforms();
      }
    }
  }

  setScene(sceneId: string) {
    this.sceneId = sceneId;
  }

  private releaseGesture(t: number) {
    if (!this.gestureOn) return;
    this.gestureOn = false;

    const note = this.gestureNote;
    const voice = this.gestureVoice;

    try {
      if (voice === "bass") this.bass.triggerRelease(t);
      else if (voice === "lead") this.lead.triggerRelease(t);
      else if (voice === "simpleLead") this.simpleLead.triggerRelease(t);
    } catch {
    }

    try {
      if (note) {
        if (voice === "stab") this.stab.triggerRelease(note as any, t);
        else if (voice === "pad") this.pad.triggerRelease(note as any, t);
      }
    } catch {
    }

    this.gestureNote = null;
    this.gestureVoice = null;
    this.gestureMidi = null;

    // Also kill the dedicated DRONE oscillator gate.
    try {
      this.droneGain.gain.rampTo(0, 0.03);
    } catch {
    }

    try {
      this.droneBassGain.gain.rampTo(0, 0.03);
    } catch {
    }

    try {
      this.droneBassDryGain.gain.rampTo(0, 0.03);
    } catch {
    }

    this.droneGateOn = false;
  }

  private getDroneCMinorNotes() {
    if (this.droneCMinorNotes) return this.droneCMinorNotes;
    const notes: number[] = [];
    const base = 12;
    const max = 60;
    const scale = [0, 2, 3, 5, 7, 8, 10];
    for (let o = 0; o <= 6; o++) {
      const root = base + o * 12;
      for (const st of scale) {
        const n = root + st;
        if (n >= base && n <= max) notes.push(n);
      }
    }
    if (!notes.length) notes.push(base);
    this.droneCMinorNotes = notes;
    return notes;
  }

  private getDroneCMinorNotesInRange(minMidi: number, maxMidi: number, cache: "low" | "bass") {
    if (cache === "low" && this.droneCMinorNotesLow) return this.droneCMinorNotesLow;
    if (cache === "bass" && this.droneCMinorNotesBass) return this.droneCMinorNotesBass;

    const all = this.getDroneCMinorNotes();
    const notes = all.filter((n) => n >= minMidi && n <= maxMidi);
    if (!notes.length) notes.push(Math.max(minMidi, Math.min(maxMidi, all[0] ?? minMidi)));
    if (cache === "low") this.droneCMinorNotesLow = notes;
    else this.droneCMinorNotesBass = notes;
    return notes;
  }

  private quantizeCMinorInRange(x01: number, minMidi: number, maxMidi: number, cache: "low" | "bass") {
    const x = clamp01(x01);
    const notes = this.getDroneCMinorNotesInRange(minMidi, maxMidi, cache);
    const idx = Math.min(notes.length - 1, Math.max(0, Math.round(x * (notes.length - 1))));
    return notes[idx]!;
  }

  private quantizeCMinor(x01: number) {
    const x = clamp01(x01);
    const notes = this.getDroneCMinorNotes();
    const idx = Math.min(notes.length - 1, Math.max(0, Math.round(x * (notes.length - 1))));
    return notes[idx]!;
  }

  update(control: ControlState) {
    this.updateIntroFromTransport();

    const now = performance.now();
    if (now - this.lastParamUpdateT < this.paramUpdateIntervalMs) {
      return;
    }
    this.lastParamUpdateT = now;

    this.selectedVoice = Math.min(6, Math.max(0, Math.floor(control.leftX * 7)));

    this.updateWaveEdit(control);

    if (this.mode === "drone") {
      const hands = control.hands?.hands ?? [];
      const hs = hands
        .slice(0)
        .sort((a, b) => {
          const ax = a?.center?.x ?? 0.5;
          const bx = b?.center?.x ?? 0.5;
          return ax - bx;
        });

      const left = hs.length >= 1 ? hs[0]! : null;
      const right = hs.length >= 2 ? hs[1]! : null;

      const sep = right && left ? (right.center.x ?? 0.5) - (left.center.x ?? 0.5) : 0;
      const twoHands = Boolean(right && left && sep > 0.12);
      const rPinch = clamp01(twoHands ? right?.pinch ?? 0 : 0);
      const lPinch = clamp01(left?.pinch ?? 0);
      const guitarOn = rPinch > 0.12;
      const bassOn = lPinch > 0.06;
      const now = Tone.now();

      // Timbre/brightness (0=darker, 1=brighter)
      const bright = clamp01(twoHands && right ? 1 - right.center.y : 0.5);
      this.droneFilter.frequency.rampTo(lerp(90, 900, bright), 0.10);

      this.droneDrive.distortion = lerp(0.75, 0.99, rPinch);
      try {
        this.droneCheby.set({ order: Math.round(lerp(18, 42, rPinch)) } as any);
      } catch {
      }
      try {
        this.droneCrush.set({ bits: Math.round(lerp(7, 3, rPinch)) } as any);
      } catch {
      }
      this.droneCabNotch.frequency.rampTo(lerp(650, 1050, bright), 0.12);
      try {
        (this.droneCabNotch.gain as any).value = lerp(-10, -4, bright);
      } catch {
      }
      this.droneCabLP.frequency.rampTo(lerp(2400, 5200, bright), 0.14);
      this.dronePostFilter.frequency.rampTo(lerp(70, 1400, bright), 0.12);
      this.dronePostFilter.Q.value = lerp(0.55, 1.25, bright);

      if (guitarOn && !this.droneGateOn) {
        this.droneGateOn = true;
        try {
          this.dronePickFilter.frequency.rampTo(lerp(1200, 2600, bright), 0.01);
          this.dronePickEnv.triggerAttackRelease(0.05, now, lerp(0.10, 0.35, rPinch));
        } catch {
        }
      }
      if (!guitarOn) this.droneGateOn = false;

      // Pitch: very narrow low ranges.
      const rx = clamp01(twoHands && right ? right.center.x : 0.5);
      const lx = clamp01(left ? left.center.x : 0.5);

      // Right hand: "guitar" layer (still low, but above the sub bass).
      const guitarMidi = this.quantizeCMinorInRange(rx, 26, 38, "low");
      const guitarFreq = Tone.Frequency(guitarMidi, "midi").toFrequency();

      // Left hand: sub bass layer (narrow ultra-low).
      const bassMidi = this.quantizeCMinorInRange(lx, 12, 26, "bass");
      const bassFreq = Tone.Frequency(bassMidi, "midi").toFrequency();

      const glide = lerp(0.06, 0.14, clamp01(1 - Math.max(rPinch, lPinch)));

      try {
        this.droneOsc.frequency.rampTo(guitarFreq, glide);
      } catch {
      }
      try {
        this.droneBassOsc.frequency.rampTo(bassFreq, glide);
      } catch {
      }

      // Gain: right pinch is the main gate, left pinch adds/subs the bass layer.
      const guitarVel = clamp01(0.02 + rPinch * 0.55);
      const bassVel = clamp01((bassOn ? 0.06 : 0.01) + lPinch * 0.85);

      try {
        this.droneGain.gain.rampTo(guitarOn ? guitarVel : 0, 0.03);
      } catch {
      }
      try {
        this.droneBassGain.gain.rampTo(bassOn ? bassVel : 0, 0.05);
      } catch {
      }
      try {
        this.droneBassDryGain.gain.rampTo(bassOn ? bassVel * 0.75 : 0, 0.05);
      } catch {
      }

      // Bass tone: keep it mostly dark; open slightly with right-hand brightness.
      this.droneBassFilter.frequency.rampTo(lerp(90, 380, bright), 0.12);

      const targetMaster = control.kill ? 0.0001 : 0.65;
      this.master.gain.rampTo(targetMaster, 0.06);

      // Short-circuit: in DRONE mode we only drive the dedicated oscillator.
      return;
    }

    const cutoff = expRange01(control.rightX, 120, 5200);
    const q = lerp(0.7, 14.0, clamp01(control.rightY));

    const wet = clamp01(control.rightPinch);
    const drive = clamp01(control.rightSpeed);

    const hatDensity = clamp01(control.leftX);
    const bassAct = clamp01(control.leftY);

    const kickWeight = clamp01(control.leftPinch);

    const build = clamp01(control.build);

    const morph = clamp01(control.rightPinch);
    const bite = clamp01(control.rightY);

    // Arrangement timeline (Transport-timed). Used as caps/multipliers so hands still matter.
    const bpm = this.cfg.bpm || 120;
    const secPerBar = (60 / Math.max(1, bpm)) * 4;
    const barsSinceStart = this.introStartSec > 0 ? (Tone.Transport.seconds - this.introStartSec) / Math.max(1e-3, secPerBar) : 0;
    // Loop after the long intro. Keep it stable and musical.
    const loopBar = Math.max(0, barsSinceStart - AudioEngine.INTRO_BARS);
    const loopPos = ((loopBar % AudioEngine.LOOP_BARS) + AudioEngine.LOOP_BARS) % AudioEngine.LOOP_BARS;

    // Sections (8-bar loop):
    // 0..3 groove, 4 break, 5 build, 6..7 drop/peak.
    const inBreak = loopPos >= 4 && loopPos < 5;
    const inBuild = loopPos >= 5 && loopPos < 6;
    const inDrop = loopPos >= 6;

    // Intro caps: start very filtered/dry, then open.
    const introOpen = clamp01(barsSinceStart / AudioEngine.INTRO_BARS);
    const introFx = ramp01(barsSinceStart, 0.75, AudioEngine.INTRO_BARS);
    const introEnergy = ramp01(barsSinceStart, 0.5, AudioEngine.INTRO_BARS);

    const sectionEnergy = inBreak ? 0.45 : inBuild ? 0.85 : inDrop ? 1.15 : 1.0;
    const sectionPerc = inBreak ? 0.35 : inBuild ? 0.75 : inDrop ? 1.10 : 1.0;

    // Acid activity + accent intensity
    this.leadDensity = clamp01(lerp(0.25, 0.95, build) + control.rightSpeed * 0.15);
    this.leadAccent = clamp01(lerp(0.15, 0.75, build));

    // Simple lead + pad brightness and presence
    this.simpleLeadPre.frequency.rampTo(lerp(600, 3800, morph), 0.08);
    this.padPre.frequency.rampTo(lerp(260, 1800, clamp01(build * 0.65 + control.leftY * 0.35)), 0.15);

    // Global "old track" filter open: cap the user's cutoff early, then gradually release.
    const cutoffCap = expRange01(introOpen, 180, 5200);
    this.filter.frequency.rampTo(Math.min(cutoff, cutoffCap), 0.05);
    this.filter.Q.rampTo(q, 0.05);

    const wetOut = clamp01(wet * introFx);
    this.delay.wet.rampTo(lerp(0.02, 0.32, wetOut), 0.05);
    this.delay.feedback.rampTo(lerp(0.18, 0.52, wetOut), 0.05);

    this.reverb.wet.rampTo(lerp(0.02, 0.38, clamp01(wetOut + this.midiRev * 0.65)), 0.05);
    this.reverb.decay = lerp(2.0, 6.0, wetOut);
    this.reverb.preDelay = lerp(0.005, 0.03, wetOut);

    const driveOut = clamp01((drive + this.midiMod * 0.65) * (0.65 + 0.55 * introEnergy) * sectionEnergy);
    this.drive.distortion = lerp(0.06, 0.75, driveOut);

    if (this.selectedVoice === 0) {
      this.kick.pitchDecay = lerp(0.018, 0.055, morph);
      this.kick.octaves = lerp(6, 10, bite);
      this.kickPre.frequency.rampTo(lerp(120, 420, morph), 0.05);
    }

    if (this.selectedVoice === 1) {
      this.hat.resonance = lerp(1800, 7800, morph);
      this.hat.modulationIndex = lerp(18, 55, bite);
      this.hatPre.frequency.rampTo(lerp(420, 2200, morph), 0.05);
    }

    if (this.selectedVoice === 2) {
      this.bass.filterEnvelope.octaves = lerp(2.2, 4.2, morph);
      this.bass.filter.Q.value = lerp(0.9, 2.8, bite);
      this.bassPre.frequency.rampTo(lerp(160, 820, morph), 0.05);
    }

    if (this.selectedVoice === 3) {
      this.stab.set({
        envelope: { attack: 0.005, decay: lerp(0.08, 0.28, morph), sustain: 0.0, release: 0.08 }
      } as any);
      this.stabPre.frequency.rampTo(lerp(700, 3200, morph), 0.05);
    }

    if (this.selectedVoice === 4) {
      this.lead.filterEnvelope.octaves = lerp(1.4, 4.2, morph);
      this.lead.filter.Q.value = lerp(4.5, 14.0, bite);
      this.leadPre.frequency.rampTo(lerp(450, 2400, morph), 0.05);
      this.leadPre.Q.value = lerp(0.6, 2.2, bite);
    }

    if (this.selectedVoice === 5) {
      this.simpleLead.filterEnvelope.octaves = lerp(1.2, 3.0, morph);
      this.simpleLead.filter.Q.value = lerp(0.8, 6.0, bite);
      this.simpleLeadPre.frequency.rampTo(lerp(500, 5200, morph), 0.08);
      this.simpleLeadPre.Q.value = lerp(0.5, 1.4, bite);
    }

    if (this.selectedVoice === 6) {
      this.padPre.frequency.rampTo(lerp(220, 2600, morph), 0.18);
      this.reverb.wet.rampTo(lerp(0.06, 0.55, clamp01(build * 0.8 + morph * 0.2)), 0.15);
    }

    const buildLift = build * 0.35;

    // Density shaped by intro + arrangement sections.
    this.hatProb = clamp01((lerp(0.15, 0.98, hatDensity) + buildLift) * introEnergy * sectionPerc);
    this.bassProb = clamp01((lerp(0.18, 0.92, bassAct) + buildLift * 0.6) * introEnergy * sectionEnergy);

    // Volumes also follow the arrangement (breakdowns pull back, drops push forward).
    this.kick.volume.value = lerp(-6, 1.0, kickWeight) + (inBreak ? -2.5 : inDrop ? 0.5 : 0);
    this.hat.volume.value = lerp(-20, -10, hatDensity) + (inBreak ? -4.0 : inDrop ? 0.75 : 0);
    this.bass.volume.value = lerp(-14, -7, bassAct) + (inBreak ? -3.0 : inDrop ? 0.5 : 0);
    this.stab.volume.value = this.sceneId === "geometry" ? -16 : -18;
    this.lead.volume.value = lerp(-22, -14, clamp01(control.build)) + (inBreak ? -4.0 : inDrop ? 0.6 : 0);
    this.simpleLead.volume.value = lerp(-26, -16, clamp01(build));
    this.pad.volume.value = lerp(-30, -18, clamp01(build));

    const targetMaster = control.kill ? 0.0001 : 0.9;
    this.master.gain.rampTo(targetMaster, 0.06);
  }

  getWaveforms() {
    const pack = this.wavePack;
    pack.kick = this.waveKick.getValue() as Float32Array;
    pack.hat = this.waveHat.getValue() as Float32Array;
    pack.bass = this.waveBass.getValue() as Float32Array;
    pack.stab = this.waveStab.getValue() as Float32Array;
    pack.lead = this.waveLead.getValue() as Float32Array;
    pack.simpleLead = this.waveSimpleLead.getValue() as Float32Array;
    pack.pad = this.wavePad.getValue() as Float32Array;
    pack.fft = this.fft.getValue() as Float32Array;
    pack.partialsBass = this.partialsBass;
    pack.partialsStab = this.partialsStab;
    pack.partialsLead = this.partialsLead;
    pack.partialsSimpleLead = this.partialsSimpleLead;
    pack.selectedVoice = this.selectedVoice;

    const edit = this.waveEditPack;
    edit.enabled = this.waveEditEnabled;
    edit.target = this.waveEditTarget;
    edit.harmonicIndex = this.waveEditIndex;
    edit.value = this.waveEditValue;

    return pack;
  }

  getPulse() {
    return this.beatPulse;
  }
}
