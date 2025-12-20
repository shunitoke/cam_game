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

type HarmonyClip = {
  bars: number;
  padLow: number;
  padHigh: number;
  lead: number;
  source: string;
};

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
  private waveKick: Float32Array | null = null;
  private waveHat: Float32Array | null = null;
  private waveBass: Float32Array | null = null;
  private waveStab: Float32Array | null = null;
  private waveLead: Float32Array | null = null;
  private wavePad: Float32Array | null = null;

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
  private forceHalfTimeBar = 32;
  private forceQuarterTimeBar = 64;
  private forcedHalfTime = false;
  private forcedQuarterTime = false;

  private pulse = 0;

  private fxHold = 0;

  private sampleActivityAtMs: Record<string, number> = {
    kick: 0,
    hat: 0,
    clap: 0,
    snare: 0,
    rim: 0,
    openhat: 0,
    pad: 0,
    lead: 0
  };
  private sampleActivityLevel: Record<string, number> = {
    kick: 0,
    hat: 0,
    clap: 0,
    snare: 0,
    rim: 0,
    openhat: 0,
    pad: 0,
    lead: 0
  };

  private padGate = 0;
  private padGain = 0;
  private padFreq = 220;
  private padBright = 0.5;
  private padDetune = 0.01;

  private leadGain = 0;
  private leadFreq = 440;
  private leadBright = 0.5;
  private leadProb = 0;
  private leadBaseHz = 440;
  private autoPadHoldUntilMs = 0;
  private autoPadGainTarget = 0;
  private autoPadBright = 0.6;
  private autoPadFreq = 220;
  private autoLeadHoldUntilMs = 0;
  private autoLeadGainTarget = 0;
  private autoLeadFreq = 440;
  private autoLeadBright = 0.7;
  private lastAutoPadBar = -8;
  private lastAutoLeadBar = -8;

  private garageMelBus: GainNode | null = null;
  private garageMelFilter: BiquadFilterNode | null = null;
  private garageMelDrive: WaveShaperNode | null = null;
  private garageMelOscs: Array<{ osc: OscillatorNode; gain: GainNode; ratio: number }> = [];
  private garageMelNotesHz: number[] = [midiToHz(61), midiToHz(64), midiToHz(67), midiToHz(69)];
  private readonly garageMelodyPattern = [
    1.0, 0, 0.65, 0,
    0.5, 0, 0.85, 0,
    0.55, 0, 0.4, 0,
    0.6, 0, 0.35, 0
  ];
  private readonly garageMelodyNotes = [2, 0, 1, 0, 3, 1, 2, 0, 1, 3, 2, 1, 3, 0, 2, 1];

  private padEnv = 0;
  private leadEnv = 0;
  private padDrive: WaveShaperNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private padBus: GainNode | null = null;
  private padOscs: Array<{ osc: OscillatorNode; gain: GainNode; ratio: number }> = [];
  private padTargetAmp = 0;
  private padAmp = 0;
  private padNextBar = 0;
  private padBaseHz = 110;
  private padChordLowHz = midiToHz(49);
  private padChordHighHz = midiToHz(56);

  private bassBus: GainNode | null = null;
  private bassFilter: BiquadFilterNode | null = null;
  private bassDrive: WaveShaperNode | null = null;
  private bassSend: GainNode | null = null;
  private bassSendConnected = false;
  private bassOscs: Array<{ osc: OscillatorNode; gain: GainNode; ratio: number; level: number }> = [];
  private bassRootHz = midiToHz(37);
  private bassAltHz = midiToHz(40);
  private bassLastFreq = 0;
  private readonly bassPattern = [
    1.0, 0, 0, 0,
    0.65, 0, 0.35, 0,
    0.9, 0, 0.45, 0,
    0.7, 0, 0.4, 0
  ];

  private leadDrive: WaveShaperNode | null = null;
  private leadFilter: BiquadFilterNode | null = null;
  private leadBus: GainNode | null = null;
  private leadLastStep = -1;

  private arrangementStage: 0 | 1 | 2 = 0;
  private raveTotalBars = 0;
  private readonly stageKickBar = 4;
  private readonly stageSynthBar = 8;
  private breakdownActive = false;
  private breakdownUntilBar = 0;
  private nextBreakdownBar = 12;
  private breakdownSpanBars = 4;
  private breakdownLevel = 0;
  private flowScene: 0 | 1 | 2 | 3 = 0;
  private sceneHatBoost = 1;
  private scenePercBoost = 1;
  private sceneLeadBoost = 1;
  private sceneFxBoost = 0;
  private scenePadBrightBoost = 0;
  private readonly harmonyProgression: HarmonyClip[] = [
    // Locrian pack – Progression 2 (moody tension)
    { bars: 4, padLow: 49, padHigh: 55, lead: 61, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_I°" }, // I°
    { bars: 4, padLow: 59, padHigh: 65, lead: 71, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_vii°" }, // vii°
    { bars: 4, padLow: 52, padHigh: 59, lead: 64, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_iii" }, // iii
    { bars: 4, padLow: 57, padHigh: 64, lead: 69, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_vi" }, // vi
    { bars: 4, padLow: 50, padHigh: 57, lead: 62, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_ii" }, // ii
    { bars: 4, padLow: 50, padHigh: 57, lead: 62, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_ii_repeat" }, // ii
    { bars: 4, padLow: 49, padHigh: 55, lead: 61, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_I°_return" }, // I°
    { bars: 4, padLow: 52, padHigh: 59, lead: 64, source: "C#_Locrian_I_vii°_iii_vi_ii_ii_I_iii_P2_iii_return" }, // iii
    // Locrian pack – Progression 13 (darker lift)
    { bars: 4, padLow: 54, padHigh: 61, lead: 66, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_IV" }, // IV
    { bars: 4, padLow: 57, padHigh: 64, lead: 69, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_VI" }, // vi
    { bars: 4, padLow: 50, padHigh: 57, lead: 62, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_II" }, // ii
    { bars: 4, padLow: 49, padHigh: 55, lead: 61, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_I°" }, // I°
    { bars: 4, padLow: 49, padHigh: 55, lead: 61, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_I°_hold" }, // I° hold
    { bars: 4, padLow: 55, padHigh: 62, lead: 67, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_V" }, // V
    { bars: 4, padLow: 52, padHigh: 59, lead: 64, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_III" }, // iii
    { bars: 4, padLow: 59, padHigh: 65, lead: 71, source: "C#_Locrian_IV_vi_ii_I_I_V_iii_vii°_P13_vii°" } // vii°
  ];
  private harmonyIndex = 0;
  private harmonyBarStart = 0;
  private readonly macroPadLiftDurationMs = 8000;
  private readonly macroPercBoostDurationMs = 6000;
  private readonly macroFxBlastDurationMs = 5500;
  private macroPadLiftUntilMs = 0;
  private macroPercBoostUntilMs = 0;
  private macroFxBlastUntilMs = 0;
  private macroPadLiftLevel = 0;
  private macroPercBoostLevel = 0;
  private macroFxBlastLevel = 0;

  private resetArrangementStages() {
    this.arrangementStage = 0;
    this.raveTotalBars = 0;
    this.breakdownActive = false;
    this.breakdownUntilBar = 0;
    this.nextBreakdownBar = 12;
    this.breakdownSpanBars = 4;
    this.breakdownLevel = 0;
    this.applyFlowScene(0);
    this.harmonyIndex = 0;
    this.harmonyBarStart = 0;
    this.applyHarmonyState(this.harmonyIndex);
  }
  private applyFlowScene(scene: 0 | 1 | 2 | 3) {
    this.flowScene = scene;
    if (scene === 0) {
      this.sceneHatBoost = 0.5;
      this.scenePercBoost = 0.3;
      this.sceneLeadBoost = 0.25;
      this.scenePadBrightBoost = -0.1;
      this.sceneFxBoost = 0.1;
    } else if (scene === 1) {
      this.sceneHatBoost = 1;
      this.scenePercBoost = 0.8;
      this.sceneLeadBoost = 0.6;
      this.scenePadBrightBoost = 0;
      this.sceneFxBoost = 0.2;
    } else if (scene === 2) {
      this.sceneHatBoost = 1.3;
      this.scenePercBoost = 1.1;
      this.sceneLeadBoost = 1.2;
      this.scenePadBrightBoost = 0.2;
      this.sceneFxBoost = 0.4;
    } else {
      this.sceneHatBoost = 0.9;
      this.scenePercBoost = 0.7;
      this.sceneLeadBoost = 1.0;
      this.scenePadBrightBoost = 0.3;
      this.sceneFxBoost = 0.65;
    }
  }

  private applyHarmonyState(index: number) {
    const chord = this.harmonyProgression[index] ?? this.harmonyProgression[0]!;
    this.padChordLowHz = midiToHz(chord.padLow);
    this.padChordHighHz = midiToHz(chord.padHigh);
    this.padBaseHz = this.padChordLowHz;
    this.leadBaseHz = midiToHz(chord.lead);
    this.bassRootHz = midiToHz(chord.padLow - 12);
    this.bassAltHz = midiToHz(chord.padHigh - 12);
    const root = chord.padLow;
    const upper = chord.padHigh;
    const lead = chord.lead;
    const technoStack = [
      root - 5,          // sub fifth for tension
      root + 6,          // tritone bite
      upper + 2,         // lifted add9 color
      lead + 7,          // soaring 11th-ish
      root + 11          // sharp fifth shimmer
    ];
    this.garageMelNotesHz = technoStack.map((n) => midiToHz(n));
  }

  private updateHarmonyTimeline(bar: number) {
    const chord = this.harmonyProgression[this.harmonyIndex];
    if (!chord) return;
    const nextChange = this.harmonyBarStart + chord.bars;
    if (bar < nextChange) return;
    this.harmonyIndex = (this.harmonyIndex + 1) % this.harmonyProgression.length;
    this.harmonyBarStart = nextChange;
    this.applyHarmonyState(this.harmonyIndex);
  }

  private updateArrangementStageProgress() {
    if (this.arrangementStage === 0 && this.raveTotalBars >= this.stageKickBar) {
      this.arrangementStage = 1;
      this.applyFlowScene(1);
    }
    if (this.arrangementStage === 1 && this.raveTotalBars >= this.stageSynthBar) {
      this.arrangementStage = 2;
      this.applyFlowScene(2);
    }
    if (this.arrangementStage >= 2 && this.raveTotalBars % 16 === 0) {
      const nextScene = ((this.flowScene + 1) % 4) as 0 | 1 | 2 | 3;
      this.applyFlowScene(nextScene);
    }
  }

  private stageMix(targetStage: number, fadeBars: number) {
    if (this.arrangementStage < targetStage) return 0;
    if (this.arrangementStage > targetStage) return 1;
    const start =
      targetStage <= 1 ? this.stageKickBar : targetStage === 2 ? this.stageSynthBar : this.stageSynthBar;
    const barsSince = Math.max(0, this.raveTotalBars - start);
    return clamp(barsSince / Math.max(1, fadeBars), 0, 1);
  }

  private updateBreakdownState(bar: number) {
    if (this.breakdownActive && bar >= this.breakdownUntilBar) {
      this.breakdownActive = false;
      this.nextBreakdownBar = bar + 12 + Math.floor(this.rand01() * 10);
    }
    if (!this.breakdownActive && this.arrangementStage >= 1 && bar >= this.nextBreakdownBar) {
      this.breakdownActive = true;
      this.breakdownSpanBars = this.rand01() < 0.45 ? 6 : 4;
      this.breakdownUntilBar = bar + this.breakdownSpanBars;
    }
  }

  private drumSat: WaveShaperNode | null = null;

  private triggerMacroPadLift(strength: number) {
    const nowMs = performance.now();
    const extra = this.macroPadLiftDurationMs * (0.4 + 0.6 * strength);
    this.macroPadLiftUntilMs = Math.max(this.macroPadLiftUntilMs, nowMs) + extra;
  }

  private triggerMacroPercBoost(strength: number) {
    const nowMs = performance.now();
    const extra = this.macroPercBoostDurationMs * (0.45 + 0.55 * strength);
    this.macroPercBoostUntilMs = Math.max(this.macroPercBoostUntilMs, nowMs) + extra;
  }

  private triggerMacroFxBlast(strength: number) {
    const nowMs = performance.now();
    const extra = this.macroFxBlastDurationMs * (0.5 + 0.5 * strength);
    this.macroFxBlastUntilMs = Math.max(this.macroFxBlastUntilMs, nowMs) + extra;
  }

  private markSample(name: string, gain: number) {
    const now = performance.now();
    this.sampleActivityAtMs[name] = now;
    const prev = this.sampleActivityLevel[name] ?? 0;
    const g = Math.max(0, Math.min(1, gain));
    this.sampleActivityLevel[name] = Math.max(prev * 0.6, g);
  }

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
    // 3 half-time (kick on 1+3 only, FX-lean)
    // 4 hats-only (no kick + no snare, percussion stays)
    // 5 hat-break (quarter-time kick, hats whisper, FX burst)
    const r = this.rand01();
    // Variants should be able to happen even with no hands.
    if (r < 0.38) return 1;
    if (r < 0.64) return 2;
    if (r < 0.82) return 3;
    if (r < 0.92) return 4;
    return 5;
  }

  private maybeAdvanceBarVariant(bar: number, section: number, dens: number, fillOn: boolean) {
    const applyVariant = (variant: number, lenBars: number) => {
      this.raveBarVariant = variant;
      this.raveVariantUntilBar = bar + lenBars;
      this.raveLastVariantBar = bar;
      if (variant === 3) {
        this.triggerMacroFxBlast(clamp(0.55 + dens * 0.3, 0, 1));
      } else if (variant === 5) {
        this.triggerMacroFxBlast(clamp(0.75 + dens * 0.2, 0, 1));
      }
      const rr = this.rand01();
      const cooldown = rr < 0.20 ? 16 : rr < 0.70 ? 12 : 8;
      this.raveNextVariantBar = bar + Math.max(lenBars, cooldown);
    };

    if (fillOn) return;

    if (!this.forcedHalfTime && bar >= this.forceHalfTimeBar && section >= 1) {
      this.forcedHalfTime = true;
      applyVariant(3, 4);
      return;
    }
    if (!this.forcedQuarterTime && bar >= this.forceQuarterTimeBar && section >= 2) {
      this.forcedQuarterTime = true;
      applyVariant(5, 4);
      return;
    }

    if (bar < this.raveNextVariantBar) return;

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
      const variant = this.pickBarVariant(section, dens);
      const len = variant === 3 || variant === 5 ? 4 : 1;
      applyVariant(variant, len);
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

    const fillChance = 0.18 + 0.10 * (this.raveSection === 2 ? 1 : 0);
    if (this.raveFillUntilBar <= bar && this.rand01() < fillChance) {
      const rr = this.rand01();
      this.raveFillType = rr < 0.52 ? 1 : rr < 0.82 ? 2 : 3;
      const len = this.raveFillType === 3 ? 2 : 1;
      this.raveFillUntilBar = bar + len;
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

  private lastDrumLpFreq = 0;
  private lastDrumGain = 0;

  private lastFxCut = 0;
  private lastFxQ = 0;
  private lastFxDelayTime = 0;
  private lastFxDelayFb = 0;
  private lastFxDelayMix = 0;

  private lastRumbleSend = 0;
  private lastRumbleFb = 0;
  private lastRumbleDelay = 0;
  private lastRumbleLp = 0;
  private lastRumbleHp = 0;

  private idleAmt = 0;

  // MIDI synth override (pad/lead) for performance mode when keys not mapped to drums
  private midiNote: number | null = null;
  private midiVel = 0;
  private midiPadNote: number | null = null;
  private midiLeadNote: number | null = null;
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

  private ensureBassSynth() {
    if (!this.ctx || !this.master) return;

    if (!this.bassBus) {
      this.bassBus = this.ctx.createGain();
      this.bassBus.gain.value = 0.0;
      this.bassFilter = this.ctx.createBiquadFilter();
      this.bassFilter.type = "lowpass";
      this.bassFilter.frequency.value = 320;
      this.bassFilter.Q.value = 0.9;
      this.bassDrive = this.ctx.createWaveShaper();
      this.bassDrive.curve = makeDriveCurve(0.32);
      this.bassDrive.oversample = "2x";
      this.bassBus.connect(this.bassFilter);
      this.bassFilter.connect(this.bassDrive);
      this.bassDrive.connect(this.master);
    }

    if (this.bassDrive && this.rumbleSend && !this.bassSend) {
      this.bassSend = this.ctx.createGain();
      this.bassSend.gain.value = 0.0;
      this.bassDrive.connect(this.bassSend);
      this.bassSend.connect(this.rumbleSend);
      this.bassSendConnected = true;
    } else if (this.bassSend && this.rumbleSend && !this.bassSendConnected) {
      this.bassSend.connect(this.rumbleSend);
      this.bassSendConnected = true;
    }

    if (this.bassOscs.length === 0 && this.bassBus) {
      const voices: Array<{ ratio: number; level: number }> = [
        { ratio: 1, level: 0.35 },
        { ratio: 0.5, level: 0.12 }
      ];
      for (const voice of voices) {
        const osc = this.ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = Math.max(20, this.bassRootHz * voice.ratio);
        const gain = this.ctx.createGain();
        gain.gain.value = voice.level;
        osc.connect(gain);
        gain.connect(this.bassBus);
        osc.start();
        this.bassOscs.push({ osc, gain, ratio: voice.ratio, level: voice.level });
      }
    }
  }

  private disposeBassSynth() {
    for (const voice of this.bassOscs) {
      try {
        voice.osc.stop();
      } catch {
      }
      try {
        voice.osc.disconnect();
      } catch {
      }
      try {
        voice.gain.disconnect();
      } catch {
      }
    }
    this.bassOscs = [];
    this.bassSendConnected = false;
    try {
      this.bassSend?.disconnect();
    } catch {
    }
    try {
      this.bassDrive?.disconnect();
    } catch {
    }
    try {
      this.bassFilter?.disconnect();
    } catch {
    }
    try {
      this.bassBus?.disconnect();
    } catch {
    }
    this.bassSend = null;
    this.bassDrive = null;
    this.bassFilter = null;
    this.bassBus = null;
  }

  private ensureGarageMelSynth() {
    if (!this.ctx || !this.master) return;

    if (!this.garageMelBus) {
      this.garageMelBus = this.ctx.createGain();
      this.garageMelBus.gain.value = 0;
      this.garageMelFilter = this.ctx.createBiquadFilter();
      this.garageMelFilter.type = "bandpass";
      this.garageMelFilter.frequency.value = 1400;
      this.garageMelFilter.Q.value = 2.8;
      this.garageMelDrive = this.ctx.createWaveShaper();
      this.garageMelDrive.curve = makeDriveCurve(0.28);
      this.garageMelDrive.oversample = "2x";
      this.garageMelBus.connect(this.garageMelFilter);
      this.garageMelFilter.connect(this.garageMelDrive);
      this.garageMelDrive.connect(this.master);
    }

    if (this.garageMelOscs.length === 0 && this.garageMelBus) {
      const voices: Array<{ type: OscillatorType; ratio: number; level: number }> = [
        { type: "sawtooth", ratio: 1, level: 0.35 },
        { type: "square", ratio: 0.5, level: 0.18 }
      ];
      for (const voice of voices) {
        const osc = this.ctx.createOscillator();
        osc.type = voice.type;
        osc.frequency.value = this.garageMelNotesHz[0] ?? this.leadBaseHz;
        const gain = this.ctx.createGain();
        gain.gain.value = voice.level;
        osc.connect(gain);
        gain.connect(this.garageMelBus);
        osc.start();
        this.garageMelOscs.push({ osc, gain, ratio: voice.ratio });
      }
    }
  }

  private disposeGarageMelSynth() {
    for (const voice of this.garageMelOscs) {
      try {
        voice.osc.stop();
      } catch {
      }
      try {
        voice.osc.disconnect();
      } catch {
      }
      try {
        voice.gain.disconnect();
      } catch {
      }
    }
    this.garageMelOscs = [];
    try {
      this.garageMelDrive?.disconnect();
    } catch {
    }
    try {
      this.garageMelFilter?.disconnect();
    } catch {
    }
    try {
      this.garageMelBus?.disconnect();
    } catch {
    }
    this.garageMelDrive = null;
    this.garageMelFilter = null;
    this.garageMelBus = null;
  }

  private triggerGarageMelody(time: number, weight: number, step: number, dens: number, section: number) {
    if (!this.ctx) return;
    this.ensureGarageMelSynth();
    if (!this.garageMelBus || !this.garageMelOscs.length) return;

    const noteIndex = this.garageMelodyNotes[step % this.garageMelodyNotes.length] ?? 0;
    const hz = this.garageMelNotesHz[noteIndex % this.garageMelNotesHz.length] ?? this.leadBaseHz;
    for (const voice of this.garageMelOscs) {
      const target = hz * voice.ratio;
      try {
        voice.osc.frequency.setTargetAtTime(target, time, 0.01);
      } catch {
        voice.osc.frequency.value = target;
      }
    }

    if (this.garageMelFilter) {
      const cut = Math.min(5200, hz * (2.2 + dens * 1.6 + section * 0.18));
      try {
        this.garageMelFilter.frequency.setTargetAtTime(cut, time, 0.02);
      } catch {
        this.garageMelFilter.frequency.value = cut;
      }
      this.garageMelFilter.Q.value = 2.2 + dens * 1.4;
    }

    const accent = clamp(0.22 + weight * 0.28 + dens * 0.12, 0, 0.55);
    const attack = 0.008;
    const decay = 0.24 + dens * 0.10;

    try {
      this.garageMelBus.gain.cancelScheduledValues(time);
      this.garageMelBus.gain.setValueAtTime(Math.max(1e-4, this.garageMelBus.gain.value), time);
      this.garageMelBus.gain.linearRampToValueAtTime(accent, time + attack);
      this.garageMelBus.gain.exponentialRampToValueAtTime(0.001, time + decay);
    } catch {
      this.garageMelBus.gain.value = accent;
    }

    this.markSample("lead", accent);
  }

  private maybeTriggerAutoSynths(section: number, dens: number) {
    if (this.mode !== "performance") return;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!this.midiPadNote && this.raveTotalBars >= 4) {
      const gap = section >= 2 ? 4 : 8;
      if (this.raveBar - this.lastAutoPadBar >= gap) {
        this.triggerAutoPad(nowMs, section, dens);
      }
    }
  }

  private triggerAutoPad(nowMs: number, section: number, dens: number) {
    const sustain = 4200 + section * 1200 + dens * 800;
    const gain = clamp(0.28 + section * 0.16 + dens * 0.25, 0, 0.9);
    const bright = clamp(0.45 + section * 0.18 + dens * 0.1, 0, 1);
    const useHigh = section >= 2 && this.rand01() > 0.4;
    this.autoPadHoldUntilMs = nowMs + sustain;
    this.autoPadGainTarget = gain;
    this.autoPadBright = bright;
    this.autoPadFreq = useHigh ? this.padChordHighHz : this.padChordLowHz;
    this.lastAutoPadBar = this.raveBar;
  }

  private triggerBassNote(time: number, weight: number, step: number, section: number, dens: number) {
    if (!this.ctx) return;
    this.ensureBassSynth();
    if (!this.bassOscs.length || !this.bassBus) return;

    const useAlt = step === 6 || step === 14 || (section >= 2 && (step & 4) === 4);
    const baseHz = useAlt ? this.bassAltHz : this.bassRootHz;
    for (const voice of this.bassOscs) {
      const target = Math.max(20, baseHz * voice.ratio);
      try {
        voice.osc.frequency.setTargetAtTime(target, time, 0.02);
      } catch {
        voice.osc.frequency.value = target;
      }
      voice.gain.gain.value = voice.level;
    }

    const sectionLift = this.stageMix(2, 4);
    const accent = clamp(weight * (0.35 + 0.65 * sectionLift) * (0.6 + dens * 0.4), 0, 1);
    const peak = accent * 0.32;
    const attack = 0.01;
    const decay = this.breakdownActive ? 0.22 : 0.32;

    try {
      this.bassBus.gain.cancelScheduledValues(time);
      this.bassBus.gain.setValueAtTime(Math.max(1e-4, this.bassBus.gain.value), time);
      this.bassBus.gain.linearRampToValueAtTime(peak, time + attack);
      this.bassBus.gain.exponentialRampToValueAtTime(0.0008, time + decay);
    } catch {
      this.bassBus.gain.value = peak;
    }

    if (this.bassSend) {
      const sendPeak = peak * 0.4;
      try {
        this.bassSend.gain.cancelScheduledValues(time);
        this.bassSend.gain.setValueAtTime(0, time);
        this.bassSend.gain.linearRampToValueAtTime(sendPeak, time + 0.03);
        this.bassSend.gain.exponentialRampToValueAtTime(0.001, time + decay + 0.12);
      } catch {
        this.bassSend.gain.value = sendPeak;
      }
    }
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
    this.raveNextSectionBar = 4;
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
      if (!this.started) return;

      const now = this.ctx.currentTime;
      // In drone mode, don't run the RAVE scheduler or mark drum activity (avoids kick light).
      if (this.mode !== "performance") {
        this.raveNextStepT = now;
        this.raveStep = 0;
        this.raveBar = 0;
        return;
      }

      const bpm = this.raveBpm;
      const secPerStep = 60 / Math.max(1e-6, bpm) / 4;
      const lookahead = 0.12;

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
          this.updateBreakdownState(this.raveBar);
        }
        this.scheduleRaveStep(this.raveNextStepT, this.raveStep);
        this.raveStep = (this.raveStep + 1) & 15;
        if (this.raveStep === 0) {
          this.raveBar++;
          this.raveTotalBars++;
          this.updateArrangementStageProgress();
          this.updateHarmonyTimeline(this.raveTotalBars);
        }
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

  private fireSample(time: number, buffer: AudioBuffer, gain = 1.0, playbackRate = 1.0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;

    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, gain);

    src.connect(g);
    if (this.drumGain) g.connect(this.drumGain);
    src.start(time);
    src.stop(time + Math.min(2.0, buffer.duration + 0.1));
  }

  private fireKick(time: number, gain = 1.0) {
    if (!this.sampleKick) return;
    if (!this.ctx) return;
    this.markSample("kick", gain);
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
    gMain.gain.value = Math.max(0, gain * 0.85);
    const gSend = ctx.createGain();
    gSend.gain.value = 0.45;

    src.connect(gMain);
    src.connect(gSend);
    if (this.drumGain) gMain.connect(this.drumGain);
    if (this.rumbleSend) gSend.connect(this.rumbleSend);

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
    const hatBoost = this.sceneHatBoost * (1 + this.macroPercBoostLevel * 0.8);
    const percBoost = this.scenePercBoost * (1 + this.macroPercBoostLevel * 0.9);
    const introSlope = clamp(this.raveTotalBars / Math.max(1, this.stageKickBar), 0, 1);
    const kickMix = Math.min(1, this.stageMix(1, 4) + introSlope * 0.5);
    const hatMix = Math.min(1, kickMix * hatBoost);
    const percMix = clamp((kickMix - 0.25) / 0.75, 0, 1) * percBoost;
    let kickAccent = 1;
    const triggerKick = (when: number, gain: number) => {
      if (kickMix <= 0.02) return;
      this.fireKick(when, gain * kickMix * kickAccent);
    };

    const bar = this.raveBar;
    const section = this.raveSection;
    const fillOn = this.raveFillUntilBar > bar;
    const groove = this.raveGroove | 0;

    this.maybeTriggerAutoSynths(section, dens);

    const variantOn = this.raveVariantUntilBar > bar;
    const variant = variantOn ? (this.raveBarVariant | 0) : 0;

    let kick = step === 0 || step === 4 || step === 8 || step === 12;
    let offHat = step === 2 || step === 6 || step === 10 || step === 14;
    let hat16 = (step & 1) === 1;
    let openHat = step === 14;

    // Sparse minimal punctuation
    let rim = step === 10 || (groove === 2 && step === 6);
    let snare = step === 12;
    let hatMixScale = 1;
    let percMixScale = 1;
    let suppressFillHat = false;
    let suppressFillRim = false;
    let garageMute = false;
    let bassScale = 1;

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
        snare = false;
        rim = false;
        hatMixScale = 0.55;
        percMixScale = 0.25;
        garageMute = true;
        bassScale = 0.7;
        kickAccent = 0.9;
        this.triggerMacroFxBlast(clamp(0.55 + dens * 0.25, 0, 1));
        if (this.fxFilter) {
          try {
            this.fxFilter.frequency.setTargetAtTime(5200, time, 0.02);
            this.fxFilter.Q.setTargetAtTime(2.4, time, 0.05);
          } catch {
            this.fxFilter.frequency.value = 5200;
            this.fxFilter.Q.value = 2.4;
          }
        }
        if (this.fxDelayMix && this.fxDelayFb) {
          try {
            this.fxDelayMix.gain.setTargetAtTime(0.22, time, 0.03);
            this.fxDelayFb.gain.setTargetAtTime(0.48, time, 0.03);
          } catch {
            this.fxDelayMix.gain.value = 0.22;
            this.fxDelayFb.gain.value = 0.48;
          }
        }
      } else if (variant === 4) {
        // Hats-only: keep hat grid, drop kick + snare for a bar.
        kick = false;
        kickAllowed = false;
        snare = false;
        // Rim can stay (quiet) as punctuation.
        rim = rim && section >= 2 && dens > 0.25;
      } else if (variant === 5) {
        // Quarter-time kick (1 only), keep whisper hats, add FX emphasis.
        kick = step === 0;
        offHat = step === 6 || step === 14;
        hat16 = false;
        openHat = false;
        snare = false;
        rim = false;
        suppressFillHat = true;
        suppressFillRim = true;
        hatMixScale = 0.25;
        percMixScale = 0.1;
        garageMute = true;
        bassScale = 0.4;
        kickAccent = 0.85;
        this.triggerMacroFxBlast(0.85);
        if (this.fxFilter) {
          try {
            this.fxFilter.frequency.setTargetAtTime(4200, time, 0.02);
            this.fxFilter.Q.setTargetAtTime(3.2, time, 0.04);
          } catch {
            this.fxFilter.frequency.value = 4200;
            this.fxFilter.Q.value = 3.2;
          }
        }
        if (this.fxDelayMix && this.fxDelayFb) {
          try {
            this.fxDelayMix.gain.setTargetAtTime(0.28, time, 0.02);
            this.fxDelayFb.gain.setTargetAtTime(0.55, time, 0.02);
          } catch {
            this.fxDelayMix.gain.value = 0.28;
            this.fxDelayFb.gain.value = 0.55;
          }
        }
      }
    }

    const fillHat = !suppressFillHat && fillOn && (this.raveFillType === 1 || this.raveFillType === 3) && (step >= 10 && hat16);
    const fillRim = !suppressFillRim && fillOn && this.raveFillType === 2 && (step >= 12 && (step & 1) === 1);

    if (kickAllowed && kick) {
      triggerKick(time, 1.0);
    }

    const inBreak = this.breakdownActive;

    if (!fillOn && !inBreak) {
      if (groove === 1) {
        if (kickAllowed && step === 7 && section >= 1 && dens > 0.25) triggerKick(time, 0.16);
        if (kickAllowed && step === 15 && section >= 2 && dens > 0.45) triggerKick(time, 0.14);
      }
      if (groove === 2) {
        if (kickAllowed && step === 3 && section >= 2 && dens > 0.55) triggerKick(time, 0.15);
      }
      if (groove === 3) {
        if (kickAllowed && step === 11 && section >= 1 && dens > 0.40) triggerKick(time, 0.12);
      }
    }

    // Occasional pre-push only at phrase end
    if (kickAllowed && fillOn && step === 15 && this.raveFillType === 3) {
      triggerKick(time, 0.22);
    }

    // Hats
    const hatBreakMix = (inBreak ? hatMix * 0.6 : hatMix) * hatMixScale;
    const percBreakMix = (inBreak ? percMix * 0.55 : percMix) * percMixScale;

    if (offHat && this.sampleHat && hatBreakMix > 0.02) {
      // Base velocity with RNG variation
      const baseV = section === 0 ? 0.16 : section === 1 ? 0.18 : 0.205;
      const v = (baseV + (this.rand01() - 0.5) * 0.04) * hatBreakMix; // ±0.02 variation
      const r = 0.98 + this.rand01() * 0.06; // 0.98–1.04 pitch variation
      if (v > 0.001) {
        this.markSample("hat", v);
        this.fireSample(time, this.sampleHat, v, r);
      }
    }

    if (!fillOn && this.sampleHat && hatBreakMix > 0.02 && !inBreak) {
      const ghostOn = (section >= 1 && dens > 0.25) || (section >= 2 && dens > 0.12);
      if (ghostOn) {
        const micro = step === 6 || step === 14 ? 0.006 : 0.0;
        if (groove === 1 && (step === 9 || step === 13)) {
          const v = (0.055 + 0.045 * dens + (this.rand01() - 0.5) * 0.03) * hatMix;
          const r = 1.06 + this.rand01() * 0.08;
          if (v > 0.001) {
            this.markSample("hat", v);
            this.fireSample(time + micro, this.sampleHat, v, r);
          }
        }
        if (groove === 3 && step === 5) {
          const v = (0.050 + 0.040 * dens + (this.rand01() - 0.5) * 0.03) * hatMix;
          const r = 1.04 + this.rand01() * 0.08;
          if (v > 0.001) {
            this.markSample("hat", v);
            this.fireSample(time + micro, this.sampleHat, v, r);
          }
        }
      }
    }

    // 16th hats come in gradually and with pinch
    if (hat16 && this.sampleHat && hatBreakMix > 0.02) {
      const on = (section >= 1 && dens > 0.35) || (section >= 2 && dens > 0.22);
      if (on) {
        const v = (0.045 + 0.085 * dens + (this.rand01() - 0.5) * 0.04) * hatBreakMix;
        const r = 1.03 + 0.03 * section + this.rand01() * 0.05;
        if (v > 0.001) {
          this.markSample("hat", v);
          this.fireSample(time, this.sampleHat, v, r);
        }
      }
    }

    // Open hat on the offbeat when density rises
    if (openHat && this.sampleOpenHat && !inBreak) {
      const m = Math.min(1, Math.max(0, (dens - 0.35) / 0.65));
      if (section >= 2 && m > 0.06 && hatMix > 0.02) {
        const v = (0.06 + 0.12 * m + (this.rand01() - 0.5) * 0.05) * hatMix;
        const r = 0.96 + this.rand01() * 0.08;
        if (v > 0.001) {
          this.markSample("openhat", v);
          this.fireSample(time, this.sampleOpenHat, v, r);
        }
      }
    }

    // Rim/snare: keep it minimal, no clap
    if (rim && this.sampleRim && percBreakMix > 0.02) {
      if (section >= 1 && dens > 0.15) {
        const v = (0.08 + 0.10 * dens) * percBreakMix;
        this.markSample("rim", v);
        this.fireSample(time, this.sampleRim, v, 1.0);
      }
    }
    if (snare && this.sampleSnare && percBreakMix > 0.02) {
      // snare comes in later (avoid pop/party clap vibe)
      if (section >= 1) {
        const v = ((section === 1 ? 0.11 : 0.14) + 0.14 * dens) * percBreakMix;
        this.markSample("snare", v);
        this.fireSample(time + 0.004, this.sampleSnare, v, 1.0);
      }
    }

    if (!fillOn && this.sampleSnare && groove === 2 && section >= 2 && dens > 0.35 && percBreakMix > 0.02) {
      if (step === 11) {
        const v = (0.06 + 0.05 * dens) * percBreakMix;
        this.markSample("snare", v);
        this.fireSample(time + 0.002, this.sampleSnare, v, 1.0);
      }
    }

    // Fills
    if (fillHat && this.sampleHat && hatBreakMix > 0.02) {
      const rr = this.raveFillType === 3 ? 1.18 : 1.14;
      const v = 0.12 * hatBreakMix;
      this.markSample("hat", v);
      this.fireSample(time, this.sampleHat, v, rr);
    }
    if (fillRim && this.sampleRim && percMix > 0.02) {
      const v = 0.12 * percMix;
      this.markSample("rim", v);
      this.fireSample(time, this.sampleRim, v, 1.0);
    }

    const garageWeight = this.garageMelodyPattern[step] ?? 0;
    if (!garageMute && garageWeight > 0 && !inBreak && section >= 1) {
      const dens = Math.min(1, Math.max(0, this.lastRightPinch));
      this.triggerGarageMelody(time, garageWeight, step, dens, section);
    }

    const bassWeight = this.bassPattern[step] ?? 0;
    if (bassWeight > 0 && !inBreak && this.raveTotalBars >= 24) {
      const dens = Math.min(1, Math.max(0, this.lastRightPinch));
      const breakdownScale = this.breakdownActive ? 0.45 : 1;
      const energy = Math.max(kickMix, 0.28);
      const weight = bassWeight * breakdownScale * energy * bassScale;
      this.triggerBassNote(time, weight, step, section, dens);
      this.markSample("bass", Math.min(1, weight * 0.5));
    }
  }

  async start() {
    if (this.started) return;

    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;
    this.resetArrangementStages();

    // Worklet module: prefer TS in dev (hot reload) and fall back to bundled JS for hosted builds.
    const workletUrl = (ext: "ts" | "js") => new URL(`./worklets/droneProcessor.${ext}`, import.meta.url);
    const primaryExt: "ts" | "js" = import.meta.env.DEV ? "ts" : "js";
    const fallbackExt: "ts" | "js" = primaryExt === "ts" ? "js" : "ts";

    let loaded = false;
    let addErr: unknown = null;
    for (const ext of [primaryExt, fallbackExt]) {
      if (loaded) break;
      try {
        await ctx.audioWorklet.addModule(workletUrl(ext));
        loaded = true;
      } catch (err) {
        addErr = err;
      }
    }
    if (!loaded) {
      throw new Error(`Failed to load drone worklet (tried .${primaryExt} and .${fallbackExt}): ${addErr}`);
    }

    const node = new AudioWorkletNode(ctx, "drone-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    this.node = node;
    node.port.onmessage = (ev) => {
      const data: any = ev.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "activity" && typeof data.name === "string") {
        const level = Number(data.level ?? 0);
        this.markSample(data.name, clamp(level, 0, 1));
      }
    };

    const master = ctx.createGain();
    master.gain.value = 0.48;
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
    this.ensureBassSynth();

    // Ensure audio starts immediately after user gesture.
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    this.started = true;

    // Seed drone guitar auto-swell scheduler.
    this.droneGtrNextSwellT = ctx.currentTime + 1.5;
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
    this.resetArrangementStages();

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

  private updateFromControl(control: ControlState) {
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
    const nowMs = now;
    const macroStep = (current: number, target: number) => {
      const rate = target > current ? 0.32 : 0.08;
      return current + (target - current) * rate;
    };
    const padLiftTarget = nowMs < this.macroPadLiftUntilMs ? 1 : 0;
    const percBoostTarget = nowMs < this.macroPercBoostUntilMs ? 1 : 0;
    const fxBlastTarget = nowMs < this.macroFxBlastUntilMs ? 1 : 0;
    this.macroPadLiftLevel = macroStep(this.macroPadLiftLevel, padLiftTarget);
    this.macroPercBoostLevel = macroStep(this.macroPercBoostLevel, percBoostTarget);
    this.macroFxBlastLevel = macroStep(this.macroFxBlastLevel, fxBlastTarget);

    // Base pitch: In DRONE mode allow left-hand/midi to shift pitch; in RAVE keep fixed.
    const baseHz =
      this.mode === "drone"
        ? this.currentMidi != null
          ? midiToHz(this.currentMidi)
          : expRange01(control.leftX, 55, 220)
        : this.padBaseHz;

    const cutoff = expRange01(control.rightY, 120, 6200);
    const fxBoost = this.sceneFxBoost + this.macroFxBlastLevel * 0.9;
    const percBoost = this.scenePercBoost * (1 + this.macroPercBoostLevel * 0.9);
    const hatBoost = this.sceneHatBoost * (1 + this.macroPercBoostLevel * 0.8);
    // Drive/texture: build + right pinch + FX macros
    const drive = clamp(0.1 + control.build * 1.25 + control.rightPinch * 0.6 + fxBoost * 0.6, 0, 2.4);

    // LFO
    const lfoHz = expRange01(control.rightX, 0.05, 3.2);
    const lfoAmt = clamp(0.015 + control.leftPinch * 0.28, 0, 0.65);

    // Envelope / texture
    const attack = expRange01(1 - control.leftY, 0.006, 0.18);
    const release = expRange01(1 - control.leftY, 0.06, 0.9);
    const detune = clamp(0.0015 + control.build * 0.008 + control.rightSpeed * 0.004, 0, 0.02);
    const sub = clamp(0.12 + control.build * 0.55 + this.macroPadLiftLevel * 0.2, 0, 0.95);
    const noiseRaw = clamp(0.01 + control.rightPinch * 0.08 + fxBoost * 0.05, 0, 0.25);
    const baseHzMod = this.mode === "drone" ? 0 : noiseRaw;

    // Delay as space: right pinch opens mix, build increases feedback.
    const delayTime = expRange01(control.rightX, 0.09, 0.42);
    const delayFb = clamp(0.18 + control.build * 0.55, 0, 0.86);
    const delayMixRaw = clamp(0.03 + control.rightPinch * 0.22, 0, 0.35);
    const delayMix =
      this.mode === "drone"
        ? 0.08 + 0.12 * clamp(control.build, 0, 1)
        : clamp(delayMixRaw + fxBoost * 0.15, 0, 0.65);

    const rPinchRaw = clamp(control.rightPinch, 0, 1);
    const rPinch = rPinchRaw <= 0.30 ? 0 : clamp((rPinchRaw - 0.30) / 0.70, 0, 1);

    // Rhythm (worklet stepper): slow pulse you can "wake up" with build.
    const bpm = expRange01(control.leftX, 44, 92);
    const pulseAmtRaw = clamp(0.04 + control.build * 0.55, 0, 0.85);
    const pulseAmt = this.mode === "drone" ? 0 : pulseAmtRaw;
    const pulseDecay = expRange01(1 - control.leftY, 0.04, 0.26);

    const tickAmtRaw = 0;
    const tickAmt = this.mode === "drone" ? 0 : tickAmtRaw;
    const tickDecay = expRange01(1 - control.rightY, 0.01, 0.11);
    const tickTone = expRange01(control.rightY, 400, 5200);

    const synthStage = this.stageMix(2, 4);

    // Pad/lead controls (performance mode only). MIDI override for 42/43/44.
    if (this.mode === "performance") {
      const midiPadOn = this.midiPadNote != null;
      const midiLeadOn = this.midiLeadNote != null;
      const autoPadActive = !midiPadOn && nowMs < this.autoPadHoldUntilMs;
      const autoLeadActive = !midiLeadOn && nowMs < this.autoLeadHoldUntilMs;

      if (midiPadOn) {
        // map note 42/44 to pad
        const n = this.midiPadNote!;
        this.padGain = 0.34;
        this.padGate = 1;
        const padHz = n === 44 ? this.padChordHighHz : this.padChordLowHz;
        this.padFreq = padHz;
        this.padBright = 0.52;
        this.padDetune = 0.01;
      } else if (autoPadActive) {
        this.padGain = this.autoPadGainTarget;
        this.padGate = 1;
        this.padFreq = this.autoPadFreq;
        this.padBright = this.autoPadBright;
        this.padDetune = 0.01;
      } else {
        this.padGain = 0;
        this.padGate = 0;
      }

      if (midiLeadOn) {
        this.leadGain = 0.24;
        this.leadFreq = this.leadBaseHz;
        this.leadBright = 0.58;
        this.leadProb = 1;
      } else if (autoLeadActive) {
        this.leadGain = this.autoLeadGainTarget;
        this.leadFreq = this.autoLeadFreq;
        this.leadBright = this.autoLeadBright;
        this.leadProb = 1;
      } else {
        this.leadGain = 0;
        this.leadProb = 0;
        this.leadBright = 0.2;
      }
    } else {
      // In drone mode, keep pad/lead quiet.
      this.padGain = 0;
      this.padGate = 0;
      this.leadGain = 0;
      this.leadProb = 0;
    }

    // Guitar (right hand): pinch = pluck trigger, X = pitch, Y = brightness
    const guitarFreq = expRange01(control.rightX, 82, 392);
    const guitarBright = clamp(control.rightY, 0, 1);
    const pluckRaw = rPinch > 0.65 && this.lastRightPinch <= 0.65 ? 1 : 0;
    const pluck = this.mode === "drone" ? 0 : pluckRaw;
    this.lastRightPinch = rPinch;
    const guitarGate = this.mode === "drone" ? rPinch : 0;

    // RAVE: map tempo + drum tone to hands
    if (this.mode === "performance") {
      this.raveBpm = expRange01(control.leftX, 126, 152);
      if (this.drumLP) {
        const tA = this.ctx?.currentTime ?? 0;
        const target = expRange01(control.rightY, 1400, 14000);
        if (Math.abs(target - this.lastDrumLpFreq) > 8) {
          this.lastDrumLpFreq = target;
          try {
            this.drumLP.frequency.setTargetAtTime(target, tA, 0.035);
          } catch {
            this.drumLP.frequency.value = target;
          }
        }
      }
      if (this.drumGain) {
        const tA = this.ctx?.currentTime ?? 0;
        const target = 0.78 + 0.22 * clamp(1 - control.build, 0, 1);
        if (Math.abs(target - this.lastDrumGain) > 0.004) {
          this.lastDrumGain = target;
          try {
            this.drumGain.gain.setTargetAtTime(target, tA, 0.05);
          } catch {
            this.drumGain.gain.value = target;
          }
        }
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
      this.fxHold = Math.max(0, Math.min(1, this.fxHold + (rPinch - this.fxHold) * 0.15));

      const fx = this.fxHold;
      const cut = expRange01(1 - control.rightY, 180, 14000);
      const q = 0.6 + 6.0 * fx * clamp(control.build, 0, 1) + baseQ;
      if (this.fxFilter) {
        this.fxFilter.type = fx > 0.6 ? "bandpass" : "lowpass";
        const tA = this.ctx?.currentTime ?? 0;
        if (Math.abs(cut - this.lastFxCut) > 8) {
          this.lastFxCut = cut;
          try {
            this.fxFilter.frequency.setTargetAtTime(cut, tA, 0.04);
          } catch {
            this.fxFilter.frequency.value = cut;
          }
        }
        if (Math.abs(q - this.lastFxQ) > 0.02) {
          this.lastFxQ = q;
          try {
            this.fxFilter.Q.setTargetAtTime(q, tA, 0.04);
          } catch {
            this.fxFilter.Q.value = q;
          }
        }
      }

      if (this.fxDrive) {
        (this.fxDrive as any).curve = makeDriveCurve(0.15 + 0.85 * fx + baseDrive);
      }

      if (this.fxDelay && this.fxDelayFb && this.fxDelayMix) {
        const tA = this.ctx?.currentTime ?? 0;
        {
          const target = expRange01(control.rightX, 0.12, 0.38);
          if (Math.abs(target - this.lastFxDelayTime) > 0.002) {
            this.lastFxDelayTime = target;
            try {
              this.fxDelay.delayTime.setTargetAtTime(target, tA, 0.045);
            } catch {
              this.fxDelay.delayTime.value = target;
            }
          }
        }
        {
          const target = 0.25 + 0.55 * fx + baseDelayFb;
          if (Math.abs(target - this.lastFxDelayFb) > 0.004) {
            this.lastFxDelayFb = target;
            try {
              this.fxDelayFb.gain.setTargetAtTime(target, tA, 0.06);
            } catch {
              this.fxDelayFb.gain.value = target;
            }
          }
        }
        {
          const target = 0.00 + 0.55 * fx + baseDelay;
          if (Math.abs(target - this.lastFxDelayMix) > 0.004) {
            this.lastFxDelayMix = target;
            try {
              this.fxDelayMix.gain.setTargetAtTime(target, tA, 0.06);
            } catch {
              this.fxDelayMix.gain.value = target;
            }
          }
        }
      }

      if (this.rumbleSend && this.rumbleFb && this.rumbleDelay) {
        const b = clamp(control.build, 0, 1);
        const dens = clamp(control.rightPinch, 0, 1);
        const tA = this.ctx?.currentTime ?? 0;
        {
          const target = 0.02 + 0.22 * b + baseRumble;
          if (Math.abs(target - this.lastRumbleSend) > 0.004) {
            this.lastRumbleSend = target;
            try {
              this.rumbleSend.gain.setTargetAtTime(target, tA, 0.06);
            } catch {
              this.rumbleSend.gain.value = target;
            }
          }
        }
        {
          const target = 0.50 + 0.35 * b + baseRumbleFb;
          if (Math.abs(target - this.lastRumbleFb) > 0.004) {
            this.lastRumbleFb = target;
            try {
              this.rumbleFb.gain.setTargetAtTime(target, tA, 0.06);
            } catch {
              this.rumbleFb.gain.value = target;
            }
          }
        }
        {
          const target = expRange01(control.rightX, 0.18, 0.34);
          if (Math.abs(target - this.lastRumbleDelay) > 0.002) {
            this.lastRumbleDelay = target;
            try {
              this.rumbleDelay.delayTime.setTargetAtTime(target, tA, 0.05);
            } catch {
              this.rumbleDelay.delayTime.value = target;
            }
          }
        }
        if (this.rumbleLP) {
          const target = expRange01(control.rightY, 120, 260);
          if (Math.abs(target - this.lastRumbleLp) > 0.8) {
            this.lastRumbleLp = target;
            try {
              this.rumbleLP.frequency.setTargetAtTime(target, tA, 0.08);
            } catch {
              this.rumbleLP.frequency.value = target;
            }
          }
        }
        if (this.rumbleHP) {
          const target = 28 + 18 * (1 - dens);
          if (Math.abs(target - this.lastRumbleHp) > 0.8) {
            this.lastRumbleHp = target;
            try {
              this.rumbleHP.frequency.setTargetAtTime(target, tA, 0.08);
            } catch {
              this.rumbleHP.frequency.value = target;
            }
          }
        }
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
            const wave = 0.5 + 0.5 * Math.sin(t * 0.55);
            const live = 0.24 * (0.80 + 0.20 * wave);
            const idle = 0.12;
            const bassTarget = kill ? 0 : (live * (1 - this.idleAmt) + idle * this.idleAmt);
            try {
              this.droneBassGain.gain.setTargetAtTime(bassTarget, t, 0.08);
            } catch {
              this.droneBassGain.gain.value = bassTarget;
            }
          }
          if (this.droneBassLP) {
            const wob = 0.5 + 0.5 * Math.sin(t * 0.18);
            const cut = 90 + 35 * wob;
            const q = 0.55;
            if (Math.abs(cut - this.lastBassCut) > 0.5) {
              this.lastBassCut = cut;
              try {
                this.droneBassLP.frequency.setTargetAtTime(cut, t, 0.10);
              } catch {
                this.droneBassLP.frequency.value = cut;
              }
            }
            if (Math.abs(q - this.lastBassQ) > 0.02) {
              this.lastBassQ = q;
              try {
                this.droneBassLP.Q.setTargetAtTime(q, t, 0.10);
              } catch {
                this.droneBassLP.Q.value = q;
              }
            }
          }

          // Bass pitch: deep + mostly constant (small slow drift).
          {
            const drift = 0.5 + 0.5 * Math.sin(t * 0.11);
            const rate = 0.22 + 0.012 * drift;
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

          // Bass drive: keep minimal to avoid overload.
          if (this.droneBassDrive) {
            const amt = 0.10;
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

                  const gap = 3.0 + 9.0 * this.rand01();
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

    const params = {
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
      noise: noiseRaw,
      delayTime,
      delayFb,
      delayMix,
      bpm,
      pulseAmt,
      pulseDecay,
      tickAmt,
      tickDecay,
      tickTone,
      padFreq: this.padFreq,
      padGain: this.padGain,
      padBright: this.padBright,
      padGate: this.padGate,
      padDetune: this.padDetune,
      leadFreq: this.leadFreq,
      leadGain: this.leadGain,
      leadBright: this.leadBright,
      leadProb: this.leadProb,
      guitarFreq,
      guitarPluck: pluck,
      guitarBright,
      guitarGate
    };

    this.node.port.postMessage(params);

    this.node.port.postMessage({ type: "gate", gate });
  }

  update(control: ControlState) {
    this.updateFromControl(control);
  }

  handleMidi(events: MidiEvent[]) {
    if (!events.length) return;

    // In performance, map drums AND let other notes drive pad/lead.
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
        if (e.note === 38 && this.sampleHat) {
          this.markSample("hat", 0.20 * vel);
          this.fireSample(t, this.sampleHat, 0.20 * vel, 1.03);
        }
        if (e.note === 39 && this.sampleClap) {
          this.markSample("clap", 0.45 * vel);
          this.fireSample(t, this.sampleClap, 0.45 * vel, 1.0);
        }
        if (e.note === 37 && this.sampleSnare) {
          this.markSample("snare", 0.32 * vel);
          this.fireSample(t, this.sampleSnare, 0.32 * vel, 1.0);
        }
        if (e.note === 40 && this.sampleRim) {
          this.markSample("rim", 0.18 * vel);
          this.fireSample(t, this.sampleRim, 0.18 * vel, 1.0);
        }
        if (e.note === 41) {
          // Bass key (HUD highlight only – synth bass is procedural)
          this.markSample("bass", 0.35 * vel);
        }

        // Optional: open hat / crash-ish on FX key
        if (e.note === 47 && this.sampleOpenHat) {
          this.markSample("openhat", 0.22 * vel);
          this.fireSample(t, this.sampleOpenHat, 0.22 * vel, 1.0);
        }
        if (e.note === 45) {
          this.triggerMacroPadLift(v);
        }
        if (e.note === 46) {
          this.triggerMacroPercBoost(v);
          if (this.sampleClap) {
            const rollCount = 3 + Math.floor(this.rand01() * 3);
            for (let i = 0; i < rollCount; i++) {
              const dt = 0.02 * i;
              this.markSample("clap", 0.25 * vel);
              this.fireSample(t + dt, this.sampleClap, 0.25 * vel, 1.08 + 0.01 * i);
            }
          }
        }
        if (e.note === 47) {
          this.triggerMacroFxBlast(v);
        }

        // Pad/lead MIDI: 42/44 -> pad, 43 -> lead
        if (e.note === 42 || e.note === 44) {
          this.midiPadNote = e.note;
          this.midiVel = v;
        } else if (e.note === 43) {
          this.midiLeadNote = e.note;
          this.midiVel = v;
        }
      }
    }

    for (const e of events) {
      if (e.type === "noteon") {
        if (this.mode === "performance") {
          this.midiNote = e.note;
          this.midiVel = clamp(e.velocity, 0, 1);
          this.gate = Math.max(this.gate, this.midiVel);
        } else {
          this.currentMidi = e.note;
          this.gate = Math.max(this.gate, clamp(e.velocity, 0, 1));
        }
      }
      if (e.type === "noteoff") {
        if (this.mode === "performance") {
          if (this.midiNote === e.note) {
            this.midiNote = null;
            this.midiVel = 0;
            this.gate = 0;
          }
          if (e.note === this.midiPadNote) this.midiPadNote = null;
          if (e.note === this.midiLeadNote) this.midiLeadNote = null;
        } else if (this.currentMidi === e.note) {
          this.currentMidi = null;
          this.gate = 0;
        }
      }
    }
  }

// ...
  // Compatibility helpers for existing HUD code.
  getActivity() {
    return {
      atMs: this.sampleActivityAtMs,
      level: this.sampleActivityLevel
    };
  }

  getWaveforms() {
    if (!this.analyser) return null;

    const fftSize = this.analyser.frequencyBinCount;
    if (!this.fftBuf || this.fftBuf.length !== fftSize) {
      this.fftBuf = new Float32Array(fftSize) as unknown as Float32Array<ArrayBuffer>;
    }
    if (!this.waveBuf || this.waveBuf.length !== 256) {
      this.waveBuf = new Float32Array(256) as unknown as Float32Array<ArrayBuffer>;
    }
    if (!this.waveKick || this.waveKick.length !== 256) this.waveKick = new Float32Array(256);
    if (!this.waveHat || this.waveHat.length !== 256) this.waveHat = new Float32Array(256);
    if (!this.waveBass || this.waveBass.length !== 256) this.waveBass = new Float32Array(256);
    if (!this.waveStab || this.waveStab.length !== 256) this.waveStab = new Float32Array(256);
    if (!this.waveLead || this.waveLead.length !== 256) this.waveLead = new Float32Array(256);
    if (!this.wavePad || this.wavePad.length !== 256) this.wavePad = new Float32Array(256);

    try {
      this.analyser.getFloatFrequencyData(this.fftBuf);
      this.analyser.getFloatTimeDomainData(this.waveBuf);
    } catch {
      return null;
    }

    // Split main mix into pseudo-stems by filtering.
    const split = (src: Float32Array, dst: Float32Array, lowHz: number, highHz: number, mix: number) => {
      let prev = 0;
      const sr = this.ctx?.sampleRate ?? 48000;
      const dt = 1 / Math.max(1, sr);
      const rcLow = lowHz > 0 ? 1 / (2 * Math.PI * lowHz) : 0;
      const rcHigh = highHz > 0 ? 1 / (2 * Math.PI * highHz) : 0;
      const alphaHP = rcLow > 0 ? rcLow / (rcLow + dt) : 0;
      const alphaLP = rcHigh > 0 ? dt / (rcHigh + dt) : 1;
      let hp = 0;
      let lp = 0;
      for (let i = 0; i < dst.length; i++) {
        const s = src[i] ?? 0;
        let v = s;
        if (lowHz > 0) {
          hp = alphaHP * (hp + v - prev);
          v = hp;
        }
        if (highHz > 0 && highHz < 20000) {
          lp = lp + alphaLP * (v - lp);
          v = lp;
        }
        prev = s;
        dst[i] = v * mix;
      }
    };

    split(this.waveBuf, this.waveKick, 40, 180, 1.0);
    split(this.waveBuf, this.waveHat, 1800, 0, 0.9);
    split(this.waveBuf, this.waveBass, 60, 320, 0.85);
    split(this.waveBuf, this.waveStab, 320, 1600, 0.8);
    split(this.waveBuf, this.waveLead, 900, 4200, 0.75);
    split(this.waveBuf, this.wavePad, 220, 1400, 0.7);

    if (this.padEnv > 1e-3 && this.padGain > 1e-3) {
      const lvl = Math.min(1, this.padEnv * this.padGain * 0.85);
      this.markSample("pad", lvl);
    }
    if (this.leadEnv > 1e-3 && this.leadGain > 1e-3) {
      const lvl = Math.min(1, this.leadEnv * this.leadGain * 0.9);
      this.markSample("lead", lvl);
    }

    return {
      mode: this.mode,
      kick: this.waveKick,
      hat: this.waveHat,
      bass: this.waveBass,
      stab: this.waveStab,
      lead: this.waveLead,
      pad: this.wavePad,
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
