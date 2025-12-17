export type Vec2 = { x: number; y: number };

export type HandLabel = "Left" | "Right" | "Unknown";

export type HandPose = {
  label: HandLabel;
  score: number;
  landmarks?: Vec2[];
  center: Vec2;
  wrist: Vec2;
  pinch: number;
  open: boolean;
  fist: boolean;
  speed: number;
};

export type HandsFrame = {
  count: number;
  hands: HandPose[];
};

export type ControlState = {
  t: number;
  dt: number;

  hands?: HandsFrame;

  audioViz?: {
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
  };

  beatPulse?: number;

  rightX: number;
  rightY: number;
  rightPinch: number;
  rightSpeed: number;

  leftX: number;
  leftY: number;
  leftPinch: number;
  leftSpeed: number;

  build: number;

  kill: boolean;

  events: {
    reset: boolean;
    sceneDelta: -1 | 0 | 1;
  };
};
