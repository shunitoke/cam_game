import * as Tone from "tone";

import type { ControlState } from "../control/types";
import type { MidiEvent } from "../midi/midiInput";

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
  private started = false;

  private mode: "performance" | "drone" = "performance";
  private gestureOn = false;
  private gestureNote: string | null = null;
  private gestureVoice: "bass" | "stab" | "lead" | "simpleLead" | "pad" | null = null;

  private gestureMidi: number | null = null;
  private gestureLastPolyT = 0;

  private raveLeadEnabled = false;

  private droneCMinorNotes: number[] | null = null;

  private midiSamplesLoadStarted = false;
  private midiSamplesLoaded = false;

  private midiScheduleT = 0;

  private master = new Tone.Gain(1.25);
  private limiter = new Tone.Limiter(-0.5);

  private drive = new Tone.Distortion(0.1);
  private filter = new Tone.Filter(900, "lowpass");

  private droneOsc = new Tone.Oscillator({ type: "sine", frequency: 220 });
  private droneFilter = new Tone.Filter({ type: "lowpass", frequency: 1200, Q: 0.25 });
  private droneGain = new Tone.Gain(0);

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

  private genEnabled = true;
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

  private introKick = 1.0;
  private introHat = 0.0;
  private introClap = 0.0;
  private introBass = 0.0;
  private introLead = 0.0;
  private introPad = 0.0;

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
    this.droneGain.connect(this.reverb);

    this.applyCustomWaveforms();

    Tone.Transport.bpm.value = cfg.bpm;
    Tone.Transport.timeSignature = [4, 4];
    (Tone.Transport as any).swing = 0;
    (Tone.Transport as any).swingSubdivision = "8n";

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
      if (this.genEnabled) return;
      this.kick.triggerAttackRelease("C1", "8n", time, 0.95);
      this.beatPulse = 1;
    }, "4n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.genEnabled) return;
      const g = this.introHat;
      if (g <= 0.001) return;
      const dens = Math.max(0.05, this.hatProb);
      this.hat.triggerAttackRelease("16n", time, 0.22 * g * dens);
      if (dens > 0.35) {
        this.hat.triggerAttackRelease("16n", time + Tone.Time("16n").toSeconds(), 0.16 * g * dens);
      }
    }, "8n");

    const bassNotes = ["C1", "C1", "G0", "C1", "D#1", "C1", "G0", "A#0"];
    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.genEnabled) return;
      const g = this.introBass;
      if (g <= 0.001) return;
      const step = this.bassStep++ % bassNotes.length;
      const dens = this.bassProb;
      const play = dens >= 0.55 ? true : step % 2 === 0;
      if (!play) return;
      this.bass.triggerAttackRelease(bassNotes[step]!, "16n", time, 0.55 * g);
    }, "8n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.genEnabled) return;
      const bar = String(Tone.Transport.position).split(":")[0];
      const barNum = Number(bar);
      if (!Number.isFinite(barNum)) return;
      const g = this.introLead;
      if (g <= 0.001) return;
      if (barNum % 2 === 1) {
        this.stab.triggerAttackRelease(["C4", "G4"], "8n", time, 0.18 * g);
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
      if (this.genEnabled) return;
      const pos = String(Tone.Transport.position).split(":");
      const barNum = Number(pos[0]);
      const patt = barNum % 4 < 2 ? pattA : pattB;
      const acc = barNum % 4 < 2 ? accentA : accentB;
      const sld = barNum % 4 < 2 ? slideA : slideB;

      const step = this.leadStep % 16;
      this.leadStep++;

      const semi = patt[step];
      if (semi < 0) return;

      if (Math.random() > this.leadDensity) return;

      const g = this.introLead;
      if (g <= 0.001) return;

      const isAccent = acc[step] === 1 && Math.random() < this.leadAccent;
      const isSlide = sld[step] === 1;
      const vel = (isAccent ? 0.32 : 0.16) * g;

      const note = root.transpose(semi).toNote();
      if (this.raveLeadEnabled) {
        this.lead.triggerAttackRelease(note, isSlide ? "8n" : "16n", time, vel);
      }
    }, "16n");

    const leadMel = ["E4", "G4", "A4", "G4", "D4", "E4", "B3", "D4"];
    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.genEnabled) return;
      const g = this.introLead;
      if (g <= 0.001) return;
      const step = this.simpleLeadStep++ % leadMel.length;
      const note = leadMel[step]!;
      this.simpleLead.triggerAttackRelease(note, "4n", time, 0.16 * g);
    }, "2n", "0");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.genEnabled) return;
      const bar = String(Tone.Transport.position).split(":")[0];
      const barNum = Number(bar);
      if (!Number.isFinite(barNum)) return;
      const g = this.introPad;
      if (g <= 0.001) return;
      const chord = barNum % 4 < 2 ? ["C4", "G4", "A#4", "D5"] : ["A#3", "F4", "G4", "C5"];
      this.pad.triggerAttackRelease(chord, "1m", time, 0.09 * g);
    }, "2m", "0");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (this.genEnabled) return;
      const g = this.introClap;
      if (g <= 0.001) return;
      this.clap.triggerAttackRelease("16n", time, 0.52 * g);
    }, "2n", "4n");

    Tone.Transport.scheduleRepeat((time: number) => {
      if (!this.genEnabled) return;

      const pos = String(Tone.Transport.position).split(":");
      const barNum = Number(pos[0]);
      const step = wrapInt(this.genStep++, this.genSteps);
      const rot = this.genRot + (Number.isFinite(barNum) && barNum % 4 === 3 ? 1 : 0);

      const hatP = Math.max(0, Math.min(this.genSteps, this.genHatP));
      const clapP = Math.max(0, Math.min(this.genSteps, this.genClapP));
      const percP = Math.max(0, Math.min(this.genSteps, this.genPercP));

      const beat = Number(pos[1]);
      const sixteenth = Number(pos[2]);

      const hatPat = euclid(this.genSteps, hatP, rot + 3);
      const clapPat = euclid(this.genSteps, clapP, rot + 8);
      const percPat = euclid(this.genSteps, percP, rot + 1);

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
        const rootMidi = Math.max(24, Math.min(84, this.genRootMidi));
        const root = Tone.Frequency(rootMidi, "midi");
        const semi = [0, 0, 7, 0, 10, 7][step % 6] ?? 0;
        const note = root.transpose(semi).toNote();
        this.bass.triggerAttackRelease(note, "16n", time, (fillOn ? 0.72 : 0.60) * gBass);
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
      if (!this.genEnabled) return;
      const bar = String(Tone.Transport.position).split(":")[0];
      const barNum = Number(bar);
      if (!Number.isFinite(barNum)) return;
      if (barNum % 4 === 0) {
        const chord = ["C4", "G4", "A#4", "D5"];
        this.pad.triggerAttackRelease(chord, "1m", time, 0.07);
      }
    }, "1m", "0");

    Tone.Transport.scheduleRepeat(() => {
      this.beatPulse = Math.max(0, this.beatPulse - 0.18);
    }, "16n");

    this.midiNoteName = Array.from({ length: 128 }, (_, n) => Tone.Frequency(n, "midi").toNote());
    this.midiTriad = Array.from({ length: 128 }, (_, n) => {
      if (n < 0 || n > 127) return null;
      const root = this.midiNoteName[n]!;
      const fifth = this.midiNoteName[Math.min(127, n + 7)]!;
      const octave = this.midiNoteName[Math.min(127, n + 12)]!;
      return [root, fifth, octave];
    });
  }

  setMode(mode: "performance" | "drone") {
    if (this.mode === mode) return;
    this.mode = mode;

    if (this.started) {
      if (mode === "performance") {
        Tone.Transport.start();
        this.introT = 0;
        this.introOn = true;
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

  async start() {
    if (this.started) return;
    await Tone.start();
    await this.loadMidiSamples();
    await Tone.loaded();
    await this.reverb.ready;

    try {
      this.droneOsc.start();
    } catch {
    }

    if (this.mode === "performance") {
      Tone.Transport.start();
      this.introT = 0;
      this.introOn = true;
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
          const bar = String(Tone.Transport.position).split(":")[0];
          const barNum = Number(bar);
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
  }

  private getDroneCMinorNotes() {
    if (this.droneCMinorNotes) return this.droneCMinorNotes;
    const notes: number[] = [];
    const base = 36;
    const max = 84;
    const scale = [0, 2, 3, 5, 7, 8, 10];
    for (let o = 0; o <= 6; o++) {
      const root = base + o * 12;
      for (let i = 0; i < scale.length; i++) {
        const n = root + scale[i]!;
        if (n < base) continue;
        if (n > max) continue;
        notes.push(n);
      }
    }
    if (!notes.length) notes.push(base);
    this.droneCMinorNotes = notes;
    return notes;
  }

  private quantizeCMinor(x01: number) {
    const x = clamp01(x01);
    const notes = this.getDroneCMinorNotes();
    const idx = Math.min(notes.length - 1, Math.max(0, Math.round(x * (notes.length - 1))));
    return notes[idx]!;
  }

  update(control: ControlState) {
    if (this.mode === "performance" && this.introOn) {
      this.introT += control.dt;
      const bpm = this.cfg.bpm || 120;
      const secPerBar = (60 / Math.max(1, bpm)) * 4;
      const bars = this.introT / Math.max(1e-3, secPerBar);

      this.introKick = 1.0;
      this.introHat = ramp01(bars, 2, 8);
      this.introBass = ramp01(bars, 4, 12);
      this.introClap = ramp01(bars, 6, 14);
      this.introLead = ramp01(bars, 8, 18);
      this.introPad = ramp01(bars, 12, 28);

      if (bars > 32) {
        this.introOn = false;
        this.introHat = 1;
        this.introBass = 1;
        this.introClap = 1;
        this.introLead = 1;
        this.introPad = 1;
      }
    }

    this.selectedVoice = Math.min(6, Math.max(0, Math.floor(control.leftX * 7)));

    this.updateWaveEdit(control);

    if (this.mode === "drone") {
      const hands = control.hands?.hands ?? [];
      const right = hands.find((h) => h.label === "Right") ?? null;
      const left = hands.find((h) => h.label === "Left") ?? null;

      const pinch = clamp01(right?.pinch ?? control.rightPinch);
      const on = pinch > 0.12;
      const now = Tone.now();

      // Timbre/brightness (0=darker, 1=brighter)
      const ry = clamp01(right?.center?.y ?? control.rightY);
      const bright = clamp01(1 - ry);
      this.droneFilter.frequency.rampTo(lerp(220, 5200, bright), 0.08);

      // Pitch from rightX (plus small influence from leftY).
      const rx = clamp01(right?.center?.x ?? control.rightX);
      const ly = clamp01(left?.center?.y ?? control.leftY);
      const midi = this.quantizeCMinor(clamp01(rx * 0.92 + (1 - ly) * 0.08));
      const freq = Tone.Frequency(midi, "midi").toFrequency();
      const vel = clamp01(0.02 + pinch * 0.55);
      const glide = lerp(0.05, 0.11, clamp01(1 - pinch));

      try {
        this.droneOsc.frequency.rampTo(freq, glide);
      } catch {
      }

      try {
        this.droneGain.gain.rampTo(on ? vel : 0, 0.03);
      } catch {
      }

      const targetMaster = control.kill ? 0.0001 : 0.85;
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

    // Acid activity + accent intensity
    this.leadDensity = clamp01(lerp(0.25, 0.95, build) + control.rightSpeed * 0.15);
    this.leadAccent = clamp01(lerp(0.15, 0.75, build));

    // Simple lead + pad brightness and presence
    this.simpleLeadPre.frequency.rampTo(lerp(600, 3800, morph), 0.08);
    this.padPre.frequency.rampTo(lerp(260, 1800, clamp01(build * 0.65 + control.leftY * 0.35)), 0.15);

    this.filter.frequency.rampTo(cutoff, 0.05);
    this.filter.Q.rampTo(q, 0.05);

    this.delay.wet.rampTo(lerp(0.02, 0.32, wet), 0.05);
    this.delay.feedback.rampTo(lerp(0.18, 0.52, wet), 0.05);

    this.reverb.wet.rampTo(lerp(0.02, 0.38, clamp01(wet + this.midiRev * 0.65)), 0.05);
    this.reverb.decay = lerp(2.0, 6.0, wet);
    this.reverb.preDelay = lerp(0.005, 0.03, wet);

    this.drive.distortion = lerp(0.06, 0.75, clamp01(drive + this.midiMod * 0.65));

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

    this.hatProb = clamp01(lerp(0.15, 0.98, hatDensity) + buildLift);
    this.bassProb = clamp01(lerp(0.18, 0.92, bassAct) + buildLift * 0.6);

    this.kick.volume.value = lerp(-6, 1.0, kickWeight);
    this.hat.volume.value = lerp(-20, -10, hatDensity);
    this.bass.volume.value = lerp(-14, -7, bassAct);
    this.stab.volume.value = this.sceneId === "geometry" ? -16 : -18;
    this.lead.volume.value = lerp(-22, -14, clamp01(control.build));
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
