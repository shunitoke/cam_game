import "./style.css";

import type { DroneWorkletEngine } from "./music/droneWorkletEngine";
import { ControlBus } from "./control/controlBus";
import { HandTracker } from "./vision/handTracker";
import { VisualEngine } from "./visual/visualEngine";
import { HandOverlay2D } from "./visual/handOverlay2d";
import { MidiInput } from "./midi/midiInput";

const BPM_DEFAULT = 132;
let uiHidden = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function midiNoteName(n: number) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const pc = ((n % 12) + 12) % 12;
  const oct = Math.floor(n / 12) - 1;
  return `${names[pc]}${oct}`;
}

function midiRole(n: number) {
  if (n >= 36 && n <= 40) return "DRUM";
  if (n >= 41 && n <= 44) return "INST";
  if (n === 45 || n === 46) return "MACRO";
  if (n === 47) return "FX";
  return "";
}

function keyNameFromCode(code: string) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Semicolon") return ";";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backquote") return "`";
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Minus") return "-";
  if (code === "Equal") return "=";
  return code;
}

async function main() {
  const app = document.getElementById("app");
  if (!app) throw new Error("#app not found");

  const canvas = el("canvas");
  app.appendChild(canvas);

  const overlayCanvas = el("canvas", "overlay");
  app.appendChild(overlayCanvas);

  const ui = el("div", "ui");
  const panel = el("div", "panel");
  const controlsRow = el("div", "row controls");
  const togglesRow = el("div", "row toggles");

  const startBtn = el("button");
  startBtn.textContent = "Enter Performance";

  const stopBtn = el("button");
  stopBtn.textContent = "Stop";
  stopBtn.disabled = true;

  const hideUiBtn = el("button");
  hideUiBtn.textContent = "HIDE UI";
  hideUiBtn.title = "Hide/show all controls";
  hideUiBtn.disabled = true;

  const prevBtn = el("button");
  prevBtn.textContent = "PREV";
  prevBtn.title = "Previous Scene";
  prevBtn.disabled = true;

  const nextBtn = el("button");
  nextBtn.textContent = "NEXT";
  nextBtn.title = "Next Scene";
  nextBtn.disabled = true;

  const camBtn = el("button");
  camBtn.textContent = "CAM: ON";
  camBtn.title = "Toggle camera tracking";
  camBtn.disabled = true;
  let camOn = true;
  let overlayOn = true;

  const autoplayBtn = el("button");
  autoplayBtn.title = "Automatically switch scenes (RAVE mode only)";
  autoplayBtn.disabled = true;

  const sceneBadge = el("span", "badge");
  sceneBadge.textContent = "Scene: Particles";

  const status = el("div");
  status.innerHTML = `<small>Camera: <span id="cam">idle</span> · Audio: <span id="aud">idle</span> · MIDI: <span id="midi">idle</span> · Hands: <span id="hands">0</span></small>`;

  const hud = el("div");
  hud.style.position = "fixed";
  hud.style.left = "10px";
  hud.style.bottom = "10px";
  hud.style.zIndex = "9999";
  hud.style.padding = "8px 10px";
  hud.style.borderRadius = "10px";
  hud.style.background = "rgba(0,0,0,0.55)";
  hud.style.color = "rgba(255,255,255,0.92)";
  hud.style.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  hud.style.pointerEvents = "none";
  hud.style.whiteSpace = "normal";
  hud.style.width = "420px";
  hud.style.maxWidth = "calc(100vw - 20px)";
  hud.style.boxSizing = "border-box";
  hud.style.overflow = "hidden";

  const gestureHint = el("div");
  gestureHint.style.padding = "8px 10px";
  gestureHint.style.borderRadius = "0px";
  gestureHint.style.background = "rgba(0,0,0,0.18)";
  gestureHint.style.border = "1px solid rgba(120, 255, 230, 0.18)";
  gestureHint.style.color = "rgba(223, 253, 245, 0.92)";
  gestureHint.style.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  gestureHint.style.whiteSpace = "pre-wrap";
  gestureHint.style.overflowWrap = "anywhere";
  (gestureHint.style as any).wordBreak = "break-word";
  gestureHint.style.opacity = "0.92";
  gestureHint.textContent = "Gestures\n- Pinch: hold\n- Move: change\n";

  const hudText = el("div");
  hudText.style.whiteSpace = "pre-wrap";
  hudText.style.overflowWrap = "anywhere";
  (hudText.style as any).wordBreak = "break-word";
  hudText.textContent = "HUD";

  const handsPrompt = el("div");
  handsPrompt.textContent = "Show your hands to play";
  handsPrompt.style.position = "fixed";
  handsPrompt.style.left = "50%";
  handsPrompt.style.top = "14%";
  handsPrompt.style.transform = "translateX(-50%)";
  handsPrompt.style.padding = "10px 14px";
  handsPrompt.style.borderRadius = "10px";
  handsPrompt.style.background = "rgba(0,0,0,0.55)";
  handsPrompt.style.color = "#fff";
  handsPrompt.style.font = "600 14px/1.1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  handsPrompt.style.letterSpacing = "0.2px";
  handsPrompt.style.zIndex = "9999";
  handsPrompt.style.pointerEvents = "none";
  handsPrompt.style.display = "none";
  document.body.appendChild(handsPrompt);

  const hudMeter = el("canvas") as HTMLCanvasElement;
  hudMeter.width = 420;
  hudMeter.height = 56;
  hudMeter.style.display = "block";
  hudMeter.style.marginTop = "6px";
  hudMeter.style.width = "100%";
  hudMeter.style.height = "56px";

  const hudMeterCtx = hudMeter.getContext("2d");

  hud.appendChild(hudText);
  hud.appendChild(hudMeter);

  const updateGestureHint = (mode: "performance" | "drone") => {
    if (mode === "drone") {
      gestureHint.textContent =
        "Gestures (DRONE)\n" +
        "- Keys: pitch\n" +
        "- Left (BASS): pinch = level, X = pitch, Y = tone\n" +
        "- Right (GUITAR): pinch = level, X = pitch, Y = brightness\n";
    } else {
      gestureHint.textContent =
        "Gestures (RAVE)\n" +
        "- Left X: tempo\n" +
        "- Right Y: drum tone\n" +
        "- Right pinch: FX drive\n" +
        "- Left pinch: pad gate";
    }
  };

  let noHandsSinceMs: number | null = null;

  const hints = el("details", "hints");
  const hintsSummary = el("summary");
  hintsSummary.textContent = "Hints";
  const hintsBody = el("div", "hintsBody");
  hints.appendChild(hintsSummary);
  hints.appendChild(hintsBody);

  controlsRow.appendChild(startBtn);
  controlsRow.appendChild(stopBtn);

  const modeBtn = el("button") as HTMLButtonElement;
  modeBtn.textContent = "MODE: RAVE";
  controlsRow.appendChild(modeBtn);
  togglesRow.appendChild(prevBtn);
  togglesRow.appendChild(nextBtn);
  togglesRow.appendChild(camBtn);
  togglesRow.appendChild(autoplayBtn);

  panel.appendChild(controlsRow);
  panel.appendChild(togglesRow);
  panel.appendChild(status);
  panel.appendChild(gestureHint);
  panel.appendChild(hints);
  ui.appendChild(panel);
  document.body.appendChild(ui);
  document.body.appendChild(hud);

  // Floating dock for UI toggle (stays visible when UI hidden)
  const uiDock = el("div");
  uiDock.style.position = "fixed";
  uiDock.style.top = "10px";
  uiDock.style.right = "10px";
  uiDock.style.zIndex = "10001";
  uiDock.style.display = "flex";
  uiDock.style.gap = "8px";
  uiDock.style.pointerEvents = "auto";
  uiDock.appendChild(hideUiBtn);
  document.body.appendChild(uiDock);

  const videoWrap = el("div", "videoPreview");
  const video = el("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  videoWrap.appendChild(video);
  document.body.appendChild(videoWrap);

  const midiOverlay = el("div", "midiOverlay");
  midiOverlay.style.display = "none";
  const midiOverlayHeader = el("div", "midiOverlayHeader");
  const midiOverlayTitle = el("div", "midiOverlayTitle");
  midiOverlayTitle.textContent = "MIDI";
  const midiOverlaySub = el("div", "midiOverlaySub");
  midiOverlaySub.textContent = "(no device)";
  const midiOverlayAct = el("div", "midiOverlaySub");
  midiOverlayAct.textContent = "activity: -";
  midiOverlayHeader.appendChild(midiOverlayTitle);
  midiOverlayHeader.appendChild(midiOverlaySub);
  midiOverlayHeader.appendChild(midiOverlayAct);
  midiOverlay.appendChild(midiOverlayHeader);

  const midiOverlayMap = el("div", "midiOverlayMap");
  midiOverlay.appendChild(midiOverlayMap);

  const midiOverlayLegend = el("div", "midiOverlayLegend");
  midiOverlayLegend.innerHTML = `
    <div class="midiLegendRow">
      <b>One-octave performance</b> (36–47):
      36 KICK · 37 SNARE · 38 HAT · 39 CLAP · 40 RIM ·
      41 BASS · 42 PAD · 43 LEAD · 44 PAD ·
      45 PAD LIFT · 46 PERC ROLL · 47 FX SWEEP/BURST
    </div>`;
  midiOverlay.appendChild(midiOverlayLegend);
  document.body.appendChild(midiOverlay);

  const camSpan = status.querySelector("#cam") as HTMLSpanElement;
  const audSpan = status.querySelector("#aud") as HTMLSpanElement;
  const midiSpan = status.querySelector("#midi") as HTMLSpanElement;
  const handsSpan = status.querySelector("#hands") as HTMLSpanElement;

  const controlBus = new ControlBus();
  const visuals = new VisualEngine(canvas, { video });

  const sceneHints: Record<string, { title: string; items: Array<[string, string]> }> = {
    particles: {
      title: "Particles",
      items: [
        ["Left", "flow"],
        ["Right", "space"],
        ["Pinch", "boost"],
        ["Build", "density"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    geometry: {
      title: "Geometry",
      items: [
        ["Right", "depth"],
        ["Pinch", "warp"],
        ["Build", "layers"],
        ["MIDI", "pulse"],
        ["R", "reset"]
      ]
    },
    cabinet: {
      title: "Cabinet",
      items: [
        ["Right X", "portal twist"],
        ["Right Y", "motion"],
        ["Right pinch", "glow/bump"],
        ["Right speed", "detail"],
        ["Build", "drive"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    logPolar: {
      title: "LogPolar",
      items: [
        ["Right Y", "speed"],
        ["Build", "drive"],
        ["R", "reset"]
      ]
    },
    warp: {
      title: "DomainWarp",
      items: [
        ["Pinch", "ink"],
        ["Right speed", "warp"],
        ["Right Y", "speed"],
        ["Build", "detail"],
        ["MIDI", "shock"],
        ["LOW", "octave"],
        ["R", "reset"]
      ]
    },
    cellular: {
      title: "Cellular",
      items: [
        ["Pinch", "glow"],
        ["Right speed", "jitter"],
        ["Right X", "scale"],
        ["Right Y", "sharp"],
        ["Build", "density"],
        ["MIDI", "edge"],
        ["R", "reset"]
      ]
    },
    sea: {
      title: "Sea",
      items: [
        ["Right Y", "speed"],
        ["Right pinch", "wave height"],
        ["Right X", "wave freq"],
        ["Left Y", "camera"],
        ["Build", "atmosphere"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    coyote: {
      title: "CoyoteFractal",
      items: [
        ["Right X", "yaw"],
        ["Left Y", "pitch"],
        ["Right pinch", "chaos"],
        ["Right speed", "detail"],
        ["Build", "drive"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    nikos: {
      title: "NikosMarch",
      items: [
        ["Right Y", "speed"],
        ["Right speed", "steps"],
        ["Build", "storm"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    drone: {
      title: "Drone",
      items: [
        ["Right pinch", "mouse down"],
        ["Right X", "mouse X"],
        ["Right Y", "mouse Y"],
        ["Right speed", "iters"],
        ["Build", "contrast"],
        ["R", "reset"]
      ]
    },
    quasi: {
      title: "Quasicrystals",
      items: [
        ["Right", "pattern"],
        ["Pinch", "shimmer"],
        ["Build", "structure"],
        ["MIDI", "spark"],
        ["R", "reset"]
      ]
    },
    dla: {
      title: "DLA",
      items: [
        ["Build", "growth"],
        ["Left", "bias"],
        ["MIDI", "speed"],
        ["LOW", "stable"],
        ["R", "reset"]
      ]
    },
    bif: {
      title: "Bifurcation",
      items: [
        ["Right", "sweep"],
        ["Build", "branches"],
        ["MIDI", "pulse"],
        ["R", "reset"]
      ]
    },
    wavelab: {
      title: "WaveLab",
      items: [
        ["Left", "voice"],
        ["Right", "space"],
        ["Wave edit", "partials"],
        ["Build", "motion"],
        ["R", "clear"]
      ]
    },
    physics: {
      title: "Physics",
      items: [
        ["Pinch", "grab"],
        ["Fast", "tear"],
        ["Build", "weight"],
        ["R", "rebuild"]
      ]
    },
    lloyd: {
      title: "Lloyd",
      items: [
        ["Right", "relax"],
        ["Pinch", "strength"],
        ["Build", "energy"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    rrt: {
      title: "RRT",
      items: [
        ["Right", "bias"],
        ["Build", "expand"],
        ["MIDI", "burst"],
        ["R", "reset"]
      ]
    },
    arboretum: {
      title: "Arboretum",
      items: [
        ["Right", "wind"],
        ["Build", "density"],
        ["MIDI", "pulse"],
        ["R", "reset"]
      ]
    },
    koch: {
      title: "Koch",
      items: [
        ["Right", "depth"],
        ["Build", "recursion"],
        ["MIDI", "pulse"],
        ["R", "reset"]
      ]
    },
    bosWarp: {
      title: "BoS Warp",
      items: [
        ["Right", "scale"],
        ["Pinch", "warp"],
        ["Build", "detail"],
        ["MIDI", "burst"],
        ["LOW", "octaves"],
        ["R", "reset"]
      ]
    },
    kaleidoscope: {
      title: "Kaleidoscope",
      items: [
        ["Right", "zoom"],
        ["Pinch", "twist"],
        ["Build", "segments"],
        ["MIDI", "burst"],
        ["LOW", "detail"],
        ["R", "reset"]
      ]
    },
    metaballs: {
      title: "Metaballs",
      items: [
        ["Right", "zoom"],
        ["Pinch", "glow"],
        ["Build", "blobs"],
        ["MIDI", "burst"],
        ["LOW", "blobs"],
        ["R", "reset"]
      ]
    },
    ascii: {
      title: "ASCII",
      items: [
        ["Camera", "glyphs"],
        ["Pinch", "smear"],
        ["Build", "ink"],
        ["MIDI", "smear"],
        ["R", "reset"]
      ]
    }
  };

  const renderHints = (sceneId: string, sceneName: string) => {
    const h = sceneHints[sceneId];
    const title = h?.title ?? sceneName;
    const sceneItems = h?.items ?? null;

    hintsSummary.textContent = `Hints: ${title}`;
    hintsBody.innerHTML = `
      ${
        sceneItems
          ? `
      <div class="hintGrid">
        ${sceneItems.map(([k, v]) => `<div><b>${k}</b></div><div>${v}</div>`).join("\n")}
      </div>`
          : `<div style="opacity:0.85;"><small>(no scene hints)</small></div>`
      }
      <div style="margin-top:8px; opacity:0.85;"><small>Scene: <b>${sceneName}</b> · Switch: <b>PREV/NEXT</b> or <b>←/→</b></small></div>
    `;
  };

  renderHints(visuals.current.id, visuals.current.name);

  const overlay = new HandOverlay2D(overlayCanvas);
  overlay.setMaxDpr(1.25);
  let audio: DroneWorkletEngine | null = null;
  let audioMode: "performance" | "drone" = "performance";
  updateGestureHint(audioMode);
  const tracker = new HandTracker({ maxHands: 2, mirrorX: true });
  tracker.setWantLandmarks(overlayOn);
  const midi = new MidiInput();

  const AUTOPLAY_KEY = "cam_game_autoplay";
  let autoplayOn = true;
  try {
    const v = window.localStorage.getItem(AUTOPLAY_KEY);
    if (v === "0") autoplayOn = false;
  } catch {
  }
  const autoplayIntervalMs = 18000;
  let lastAutoSceneAt = performance.now();

  const setAutoplayOn = (on: boolean) => {
    autoplayOn = on;
    autoplayBtn.textContent = autoplayOn ? "AUTOPLAY: ON" : "AUTOPLAY: OFF";
    try {
      window.localStorage.setItem(AUTOPLAY_KEY, autoplayOn ? "1" : "0");
    } catch {
    }
    lastAutoSceneAt = performance.now();
  };
  setAutoplayOn(autoplayOn);

  const applySceneDelta = (delta: -1 | 1) => {
    // DRONE mode is locked to the exclusive drone scene.
    if (audioMode === "drone") {
      const s = visuals.setScene("drone");
      sceneBadge.textContent = `Scene: ${s.name}`;
      renderHints(s.id, s.name);
      audio?.setScene(s.id);
      lastAutoSceneAt = performance.now();
      return s;
    }

    // In performance mode, skip over the drone scene during cycling/autoplay.
    let s = visuals.nextScene(delta);
    let guard = 0;
    while (s.id === "drone" && guard++ < 6) {
      s = visuals.nextScene(delta);
    }
    sceneBadge.textContent = `Scene: ${s.name}`;
    renderHints(s.id, s.name);
    audio?.setScene(s.id);
    lastAutoSceneAt = performance.now();
    return s;
  };

  let hudOn = true;
  let camTrackOn = true;
  let camInferOn = true;
  let audioVizOn = true;
  let gpuRenderOn = true;
  let audioOn = true;

  let fpsEma = 0;
  let longFrames = 0;
  let lastHudAt = 0;
  let lastDtMs = 16.7;
  let lastRawDtMs = 16.7;

  let tTrackerMs = 0;
  let tMidiMs = 0;
  let tVizMs = 0;
  let tAudioMs = 0;
  let tVisualsMs = 0;
  let tTickMs = 0;

  let lastVisualUpdateAt = 0;

  let audioUpdateTimer: number | null = null;
  let lastControlForAudio: any = null;

  let lastOverlayDrawAt = 0;

  let autoLowVision = false;
  let autoLowVisionSince = 0;

  const ema = (prev: number, next: number, a: number) => (prev ? prev + (next - prev) * a : next);

  let lastTickAt = performance.now();
  let tickCount = 0;
  let lastErr: string | null = null;
  let lastRej: string | null = null;
  let lastWebglLostAt = 0;
  let longTaskCount = 0;
  let longTaskMs = 0;
  let gcCount = 0;
  let gcMs = 0;

  const midiHeld = new Set<number>();
  const midiVel = new Map<number, number>();
  const midiFlashT = new Map<number, number>();
  const midiHeldSince = new Map<number, number>();
  const midiKeyEls = new Map<number, HTMLDivElement>();
  const midiMin = 36;
  const midiMax = 47;

  const keyboardHeldCodes = new Set<string>();
  const keyboardCodeToNote = new Map<string, number>();
  const keyboardNoteToCode = new Map<number, string>();
  {
    // QWERTY-friendly 12-key row mapping -> 36..47
    // A W S E D F T G Y H U J
    const codes = [
      "KeyA",
      "KeyW",
      "KeyS",
      "KeyE",
      "KeyD",
      "KeyF",
      "KeyT",
      "KeyG",
      "KeyY",
      "KeyH",
      "KeyU",
      "KeyJ"
    ];
    for (let i = 0; i < codes.length; i++) {
      const note = midiMin + i;
      keyboardCodeToNote.set(codes[i]!, note);
      keyboardNoteToCode.set(note, codes[i]!);
    }
  }

  {
    const drumLabel = (n: number) => {
      if (n === 36) return "KICK";
      if (n === 37) return "SNARE";
      if (n === 38) return "HAT";
      if (n === 39) return "CLAP";
      if (n === 40) return "PERC";
      if (n === 41) return "BASS";
      if (n === 42) return "STAB";
      if (n === 43) return "LEAD";
      if (n === 44) return "PAD";
      if (n === 45) return "FILL";
      if (n === 46) return "GEN";
      if (n === 47) return "FX";
      return "";
    };
    for (let n = midiMin; n <= midiMax; n++) {
      const k = el("div", "midiKey");
      k.dataset.note = String(n);
      const code = keyboardNoteToCode.get(n);
      if (code) k.dataset.kb = keyNameFromCode(code);
      const d = drumLabel(n);
      const bot = d ? `${n} ${d}` : String(n);
      k.innerHTML = `<div class="midiKeyTop">${midiNoteName(n)}</div><div class="midiKeyBot">${bot}</div>`;
      midiOverlayMap.appendChild(k);
      midiKeyEls.set(n, k);
    }
  }

  let midiOverlayWasOn = false;
  let midiLastEventAt = 0;
  let midiEventsSince = 0;
  let midiRateWindowStart = 0;
  let midiRate = 0;

  let overlayMode: "midi" | "keyboard" = "keyboard";

  const releaseAllKeyboardNotes = () => {
    if (!audio) {
      keyboardHeldCodes.clear();
      return;
    }

    for (const code of keyboardHeldCodes) {
      const note = keyboardCodeToNote.get(code);
      if (note == null) continue;
      try {
        audio.handleMidi([{ type: "noteoff", channel: 0, note, velocity: 0 }]);
      } catch {
      }
      midiHeld.delete(note);
      midiVel.set(note, 0);
    }
    keyboardHeldCodes.clear();
  };

  const releaseAllMidiNotes = () => {
    if (!audio) {
      midiHeld.clear();
      midiHeldSince.clear();
      return;
    }
    const ev: any[] = [];
    for (const note of midiHeld) {
      ev.push({ type: "noteoff", channel: 0, note, velocity: 0 });
      midiVel.set(note, 0);
    }
    midiHeld.clear();
    midiHeldSince.clear();
    if (ev.length) {
      try {
        audio.handleMidi(ev as any);
      } catch {
      }
    }
  };

  let running = false;
  let lastT = performance.now();
  let wasHidden = document.visibilityState !== "visible";

  let beatViz = 0;

  let lastAudioVizAt = 0;
  let lastAudioViz: any = null;

  const applyAudioMode = (
    mode: "performance" | "drone",
    options: { forceScene?: boolean } = {}
  ) => {
    const prevMode = audioMode;
    audioMode = mode;

    modeBtn.textContent = mode === "drone" ? "MODE: DRONE" : "MODE: RAVE";
    updateGestureHint(mode);
    audio?.setMode(mode);

    const shouldResetScene = options.forceScene || prevMode !== mode;
    if (mode === "drone") {
      if (shouldResetScene) {
        const s = visuals.setScene("drone");
        sceneBadge.textContent = `Scene: ${s.name}`;
        renderHints(s.id, s.name);
        audio?.setScene(s.id);
      }
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    } else {
      if (shouldResetScene) {
        const s = visuals.setScene("particles");
        sceneBadge.textContent = `Scene: ${s.name}`;
        renderHints(s.id, s.name);
        audio?.setScene(s.id);
      }
      prevBtn.disabled = !running;
      nextBtn.disabled = !running;
    }

    if (shouldResetScene) {
      lastAutoSceneAt = performance.now();
    }
  };

  let stallScore = 0;
  let lastAutoTrackerRestartAt = 0;
  let severeStallScore = 0;
  let lastAutoReloadAt = 0;
  let reloadRequested = false;

  const requestReload = (reason: string) => {
    if (reloadRequested) return;
    reloadRequested = true;

    try {
      lastErr = `reload:${reason}`;
    } catch {
    }

    try {
      running = false;
    } catch {
    }

    try {
      void audio?.stop();
    } catch {
    }
    try {
      tracker.stop();
    } catch {
    }
    try {
      midi.stop();
    } catch {
    }
    try {
      video.srcObject = null;
    } catch {
    }
    try {
      void video.pause();
    } catch {
    }

    window.setTimeout(() => {
      window.location.reload();
    }, 60);
  };

  canvas.addEventListener(
    "webglcontextlost",
    (e) => {
      e.preventDefault();
      running = false;
      lastWebglLostAt = performance.now();
      camSpan.textContent = "on";
      audSpan.textContent = "off";
      stopBtn.disabled = true;
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      sceneBadge.textContent = "Scene: (GPU reset)";
      void audio?.stop();
    },
    { passive: false }
  );

  canvas.addEventListener("webglcontextrestored", () => {
    sceneBadge.textContent = `Scene: ${visuals.current.name}`;
  });

  window.addEventListener("error", (ev) => {
    try {
      lastErr = ev.error instanceof Error ? ev.error.message : String((ev as any).message ?? ev);
    } catch {
      lastErr = "unknown error";
    }
  });
  window.addEventListener("unhandledrejection", (ev) => {
    try {
      const r: any = (ev as any).reason;
      lastRej = r instanceof Error ? r.message : String(r);
    } catch {
      lastRej = "unhandled rejection";
    }
  });

  try {
    const anyWin: any = window as any;
    if (typeof anyWin.PerformanceObserver === "function") {
      const po = new anyWin.PerformanceObserver((list: any) => {
        try {
          const entries = list.getEntries?.() ?? [];
          for (const e of entries) {
            longTaskCount++;
            const d = typeof e?.duration === "number" ? e.duration : 0;
            longTaskMs += d;
          }
        } catch {
          // ignore
        }
      });
      po.observe({ entryTypes: ["longtask"] });

      try {
        const poGc = new anyWin.PerformanceObserver((list: any) => {
          try {
            const entries = list.getEntries?.() ?? [];
            for (const e of entries) {
              gcCount++;
              const d = typeof e?.duration === "number" ? e.duration : 0;
              gcMs += d;
            }
          } catch {
            // ignore
          }
        });
        poGc.observe({ entryTypes: ["gc"] });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const tick = (t: number) => {
    if (!running) return;

    try {
      tickCount++;
      lastTickAt = performance.now();

      // If the page is hidden/occluded, browsers can throttle rAF to a few FPS or even
      // seconds per frame. Reset timing and skip heavy work to avoid massive dt spikes.
      const vis = document.visibilityState;
      if (vis !== "visible") {
        lastT = t;
        lastDtMs = 0;
        return;
      }

      // Clamp dt so a long pause (tab switch, breakpoint, throttling) doesn't explode sim.
      const rawDt = Math.max(0.001, (t - lastT) / 1000);
      const dt = Math.min(0.05, rawDt);
      lastT = t;

      lastDtMs = dt * 1000;
      lastRawDtMs = rawDt * 1000;

      const nowMs = performance.now();
      if (camTrackOn && camInferOn && rawDt > 0.22) {
        stallScore += 1;
      } else {
        stallScore = Math.max(0, stallScore - 0.25);
      }
      if (stallScore >= 3 && nowMs - lastAutoTrackerRestartAt > 15000) {
        lastAutoTrackerRestartAt = nowMs;
        stallScore = 0;
        const trAny: any = tracker as any;
        void trAny.restartLandmarker?.();
      }

      if (camTrackOn && camInferOn && rawDt > 0.45) {
        severeStallScore += 1;
      } else {
        severeStallScore = Math.max(0, severeStallScore - 0.2);
      }
      if (
        severeStallScore >= 4 &&
        nowMs - lastAutoReloadAt > 45000 &&
        nowMs - lastAutoTrackerRestartAt < 20000
      ) {
        lastAutoReloadAt = nowMs;
        severeStallScore = 0;
        requestReload("auto");
        return;
      }

      const fpsNow = 1 / Math.max(1e-6, rawDt);
      fpsEma = fpsEma ? fpsEma + (fpsNow - fpsEma) * 0.06 : fpsNow;
      if (rawDt > 0.033) longFrames++;

      const tickStart = performance.now();

      const t0 = performance.now();
      const hands = camTrackOn ? tracker.update(t, dt) : { count: 0, hands: [] };
      const t1 = performance.now();
      tTrackerMs = ema(tTrackerMs, t1 - t0, 0.12);
      handsSpan.textContent = String(hands.count);

      {
        const nowMs = performance.now();
        if (hands.count > 0) {
          noHandsSinceMs = null;
          handsPrompt.style.display = "none";
        } else {
          if (noHandsSinceMs == null) noHandsSinceMs = nowMs;
          const show = nowMs - noHandsSinceMs > 800;
          handsPrompt.style.display = show ? "block" : "none";
        }
      }

      // Auto LOW mode disabled (manual control only).
      autoLowVision = false;
      autoLowVisionSince = 0;

      if (camTrackOn) {
        const nowOv = performance.now();
        const minOverlayIntervalMs = 50;
        if (!lastOverlayDrawAt || nowOv - lastOverlayDrawAt >= minOverlayIntervalMs) {
          lastOverlayDrawAt = nowOv;
          overlay.draw(hands.hands);
        }
      } else {
        overlay.draw([]);
      }

      const control = controlBus.update({ t, dt, hands });

      // Render the HUD meter at full rAF speed (independent from the throttled HUD text).
      // Uses lastAudioViz which is already throttled upstream.
      if (hudOn && audioVizOn) {
        try {
          renderHudMeter();
        } catch {
          // ignore
        }
      }

    const midiT0 = performance.now();
    const midiStatus = midi.getStatus();
    if (!midiStatus.supported) {
      midiSpan.textContent = "off";
      midiSpan.title = "WebMIDI unsupported in this browser";
    } else if (midiStatus.error) {
      midiSpan.textContent = "err";
      midiSpan.title = `MIDI error: ${midiStatus.error}`;
    } else if (!midiStatus.inputs) {
      midiSpan.textContent = "on(0)";
      midiSpan.title = "No MIDI inputs detected";
    } else {
      midiSpan.textContent = `on(${midiStatus.inputs})`;
      midiSpan.title = `Inputs: ${midiStatus.names.join(", ")}`;
    }

    const overlayOnNow = running && !uiHidden;
    if (overlayOnNow !== midiOverlayWasOn) {
      midiOverlayWasOn = overlayOnNow;
      midiOverlay.style.display = overlayOnNow ? "block" : "none";
    }

    overlayMode = !!midiStatus.supported && !midiStatus.error && midiStatus.inputs > 0 ? "midi" : "keyboard";
    if (overlayMode === "midi") {
      releaseAllKeyboardNotes();
    }
    if (overlayOnNow) {
      if (overlayMode === "midi") {
        midiOverlayTitle.textContent = "NanoKey2";
        midiOverlaySub.textContent = midiStatus.names.length ? midiStatus.names.join(", ") : "MIDI device";
      } else {
        midiOverlayTitle.textContent = "Keyboard";
        midiOverlaySub.textContent = "A W S E D F T G Y H U J";
      }
    }

    if (!midiRateWindowStart) midiRateWindowStart = t;
    if (t - midiRateWindowStart > 800) {
      const secs = Math.max(0.001, (t - midiRateWindowStart) / 1000);
      midiRate = midiEventsSince / secs;
      midiEventsSince = 0;
      midiRateWindowStart = t;
    }
    if (midiLastEventAt > 0) {
      const ageMs = Math.max(0, t - midiLastEventAt);
      midiOverlayAct.textContent = `activity: ${ageMs < 999 ? Math.round(ageMs) + "ms" : (ageMs / 1000).toFixed(1) + "s"} · ${midiRate.toFixed(1)}/s`;
    } else {
      midiOverlayAct.textContent = `activity: - · ${midiRate.toFixed(1)}/s`;
    }

    // Process MIDI in chunks to avoid frame stalls on event storms
    let burst = 0;
    const pending = midi.pending();
    if (pending > 320) {
      // If we start dropping events, we can lose noteoff and get stuck held keys.
      // Fail-safe: release held notes before truncating the queue.
      releaseAllMidiNotes();
      midi.dropOldest(pending - 320);
    }

    const midiStart = performance.now();
    const midiBudgetMs = 1.25;
    if (overlayMode === "midi") {
      while (performance.now() - midiStart < midiBudgetMs) {
        const midiEvents = midi.consume(32);
        if (!midiEvents.length) break;
        midiEventsSince += midiEvents.length;
        for (const e of midiEvents) {
          midiLastEventAt = t;
          if (e.type === "noteon" && e.note === 47) burst += 0.08 + 0.12 * e.velocity;
          if (e.type === "noteon") {
            midiHeld.add(e.note);
            midiVel.set(e.note, clamp01(e.velocity));
            midiFlashT.set(e.note, t);
            midiHeldSince.set(e.note, t);
          }
          if (e.type === "noteoff") {
            midiHeld.delete(e.note);
            midiVel.set(e.note, clamp01(e.velocity));
            midiHeldSince.delete(e.note);
          }
        }
        audio?.handleMidi(midiEvents);
      }
    }

    // Preferred: flash based on actual sample events (worklet engine).
    // If the engine provides getActivity(), this is the authoritative source for "sample is playing".
    if (midiOverlayWasOn) {
      try {
        const act = (audio as any)?.getActivity?.();
        if (act && act.atMs && act.level) {
          const nowMs = performance.now();
          const ageMs = 160;
          const hit = (name: string, note: number, minLevel: number) => {
            const at = act.atMs[name] ?? 0;
            const lvl = act.level[name] ?? 0;
            if (at > 0 && nowMs - at <= ageMs && lvl >= minLevel) {
              midiFlashT.set(note, t);
              midiVel.set(note, Math.max(midiVel.get(note) ?? 0, clamp01(lvl)));
            }
          };

          hit("kick", 36, 0);
          hit("snare", 37, 0);
          hit("hat", 38, 0);
          hit("clap", 39, 0);
          hit("rim", 40, 0);
          hit("bass", 41, 0);
          hit("openhat", 47, 0);
          hit("pad", 42, 0);
          hit("pad", 44, 0);
          hit("lead", 43, 0);
        }
      } catch {
      }
    }

    // Safety: auto-release stuck notes (missed noteoff, device disconnect, dropped events).
    // Keep this generous so normal playing doesn't get cut.
    const maxHoldMs = 1800;
    if (overlayMode === "midi" && midiHeld.size) {
      for (const note of midiHeld) {
        const since = midiHeldSince.get(note);
        if (since != null && t - since > maxHoldMs) {
          midiHeld.delete(note);
          midiHeldSince.delete(note);
          midiVel.set(note, 0);
          try {
            audio?.handleMidi([{ type: "noteoff", channel: 0, note, velocity: 0 }]);
          } catch {
          }
        }
      }
    }
    const midiT1 = performance.now();
    tMidiMs = ema(tMidiMs, midiT1 - midiT0, 0.12);

    if (midiOverlayWasOn) {
      for (let n = midiMin; n <= midiMax; n++) {
        const k = midiKeyEls.get(n);
        if (!k) continue;
        const held = midiHeld.has(n);
        const role = midiRole(n);
        k.classList.toggle("held", held);
        k.dataset.role = role;

        const top = k.querySelector(".midiKeyTop") as HTMLDivElement | null;
        if (top) {
          top.textContent = overlayMode === "midi" ? midiNoteName(n) : (k.dataset.kb ?? "");
        }

        const ft = midiFlashT.get(n) ?? -999;
        const flash = ft > 0 ? Math.max(0, 1 - (t - ft) / 160) : 0;
        const vel = midiVel.get(n) ?? 0;
        const a = held ? 0.9 : 0.18 + 0.72 * flash;
        const glow = flash;
        k.style.opacity = String(a);
        k.style.setProperty("--midiVel", String(vel));
        k.style.setProperty("--midiFlash", String(glow));
      }
    }

    if (burst > 0) {
      visuals.triggerBurst(Math.min(1.5, burst));
    }

    const vizT0 = performance.now();
    let audioViz: any = null;
    const wantOverlayFlashFromAudio = midiOverlayWasOn;
    if (audioVizOn || wantOverlayFlashFromAudio) {
      const now = performance.now();
      // Throttle analyzer reads: Tone's getValue() often allocates typed arrays and can
      // cause GC/LongTasks if called every frame.
      const minIntervalMs = 66;
      if (!lastAudioVizAt || now - lastAudioVizAt >= minIntervalMs) {
        lastAudioVizAt = now;
        lastAudioViz = audio?.getWaveforms() ?? null;
      }
      audioViz = lastAudioViz;
    }
    const vizT1 = performance.now();
    tVizMs = ema(tVizMs, vizT1 - vizT0, 0.12);

    const controlWithViz = control as any;

    // Drone-mode interface tremble + random key flicker based on overload intensity.
    const resetDroneGlitch = () => {
      ui.style.transform = "";
      hud.style.transform = "";
      midiOverlay.style.transform = "";
      midiOverlay.style.filter = "";
      for (const key of midiKeyEls.values()) {
        key.style.boxShadow = "";
        key.style.filter = "";
        key.style.transform = "";
      }
    };

    if (audioMode === "drone" && audioViz) {
      const pinch = clamp01((controlWithViz as any)?.rightPinch ?? 0);
      const wave = (audioViz as any).kick as Float32Array | undefined;
      let rms = 0;
      if (wave && wave.length) {
        const n = Math.min(256, wave.length);
        let sum = 0;
        for (let i = 0; i < n; i += 2) {
          const v = wave[i] ?? 0;
          sum += v * v;
        }
        rms = Math.sqrt(sum / Math.max(1, n / 2));
      }
      const baseIntensity = 0.1 + pinch * 0.2;
      const intensity = Math.min(1, Math.max(baseIntensity, rms * 14 * (1 + pinch * 0.6)));
      const jiggle = intensity > 0.02;
      const shake = intensity * 18 * (1 + pinch * 0.8);
      const rot = intensity * 3.4 * (1 + pinch * 0.6);
      const spread = 1 + intensity * 0.04 + pinch * 0.05;
      const dx = jiggle ? (Math.random() - 0.5) * shake : 0;
      const dy = jiggle ? (Math.random() - 0.5) * shake : 0;
      ui.style.transform = jiggle ? `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${spread})` : "";
      hud.style.transform = jiggle
        ? `translate(${dx * 0.7}px, ${dy * 0.7}px) rotate(${rot * 0.6}deg) scale(${1 + intensity * 0.02})`
        : "";
      // Keyboard tilts opposite direction for contrast and stretches outward.
      const kDx = jiggle ? -dx * (1.1 + pinch * 0.2) : 0;
      const kDy = jiggle ? dy * (0.9 + pinch * 0.2) : 0;
      midiOverlay.style.transform = jiggle
        ? `translate(${kDx}px, ${kDy}px) rotate(${-rot * 1.2}deg) scale(${1 + intensity * 0.05 + pinch * 0.05})`
        : "";
      midiOverlay.style.filter = jiggle ? `contrast(${1 + intensity * 1.5}) saturate(${1 + intensity})` : "";

      const flashChance = Math.min(0.95, intensity * 0.9 + 0.05);
      const glow = `0 0 ${10 + intensity * 25}px rgba(255,150,60,${0.4 + 0.5 * intensity})`;
      for (const key of midiKeyEls.values()) {
        const active = Math.random() < flashChance;
        const flicker = active ? 1 + intensity + pinch * 0.5 : 0.4 + intensity * 0.6;
        const hueShift = active ? 40 + intensity * 60 + pinch * 80 : 32;
        key.style.boxShadow = active ? glow : "0 0 6px rgba(200,120,40,0.35)";
        key.style.filter = `brightness(${flicker}) contrast(${1.0 + intensity * 0.4}) hue-rotate(${hueShift}deg)`;
        key.style.opacity = String(0.35 + intensity * 0.6);
        key.style.transform = active
          ? `rotate(${(Math.random() - 0.5) * rot * 2}deg) scale(${1 + pinch * 0.3})`
          : `scale(${1 + pinch * 0.1})`;
      }
    } else {
      resetDroneGlitch();
    }

    // In RAVE, rely on actual instrument triggers (handled earlier via getActivity). No extra auto flashes here.

    const beatPulse = audio?.getPulse?.() ?? 0;
    if (audioViz) {
      controlWithViz.audioViz = audioViz;

      const kick = (audioViz as any).kick as Float32Array | undefined;
      let peak = 0;
      if (kick && kick.length) {
        const n = Math.min(256, kick.length);
        for (let i = 0; i < n; i += 4) {
          const v = Math.abs(kick[i] ?? 0);
          if (v > peak) peak = v;
        }
      }

      const fft = (audioViz as any).fft as Float32Array | undefined;
      let low = 0;
      if (fft && fft.length) {
        const bins = Math.min(24, fft.length);
        let acc = 0;
        for (let i = 0; i < bins; i++) {
          acc += Math.max(-120, fft[i] ?? -120);
        }
        low = acc / Math.max(1, bins);
      }

      const target = Math.min(1, Math.max(peak * 3.5, low * 1.25));
      const dt = Math.min(0.033, (control as any).dt ?? 0.016);
      const a = 1 - Math.exp(-dt * 26);
      beatViz = beatViz + (target - beatViz) * a;
      beatViz = Math.max(0, beatViz - dt * 1.75);
      beatViz = Math.max(0, beatViz - (control as any).dt * 1.75);
    }

    const bpOut = Math.max(beatPulse, beatViz);
    (control as any).beatPulse = bpOut;
    lastControlForAudio = controlWithViz;

    const sceneDelta = controlWithViz.events.sceneDelta;
    if (sceneDelta !== 0) {
      applySceneDelta(sceneDelta as any);
    }

    if (autoplayOn && audioMode === "performance") {
      const nowAuto = performance.now();
      if (nowAuto - lastAutoSceneAt >= autoplayIntervalMs) {
        applySceneDelta(1);
      }
    }

    if (controlWithViz.events.reset) {
      audio?.reset();
      visuals.reset();
    }

      const vT0 = performance.now();
      // Rendering at full rAF speed can starve Tone's scheduler on some machines.
      // Cap visual updates in the foreground.
      const nowVis = performance.now();
      const targetFps = 45;
      const minVisualIntervalMs = 1000 / Math.max(1, targetFps);
      if (!lastVisualUpdateAt || nowVis - lastVisualUpdateAt >= minVisualIntervalMs) {
        lastVisualUpdateAt = nowVis;
        visuals.update(controlWithViz);
      }
      const vT1 = performance.now();
      tVisualsMs = ema(tVisualsMs, vT1 - vT0, 0.12);

      const tickEnd = performance.now();
      tTickMs = ema(tTickMs, tickEnd - tickStart, 0.12);

    } catch (e) {
      lastErr = errMsg(e);
      console.error(e);
    } finally {
      if (running) requestAnimationFrame(tick);
    }
  };

  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState !== "visible";
    if (hidden !== wasHidden) {
      wasHidden = hidden;
      // Reset timers so returning to the tab doesn't produce a huge dt.
      lastT = performance.now();
      lastTickAt = performance.now();
    }
  });

  const renderHud = () => {
    if (!hudOn || uiHidden) {
      hud.style.display = "none";
      return;
    }
    hud.style.display = "block";
    updateGestureHint(audioMode);

    const now = performance.now();
    const age = Math.max(0, now - lastTickAt);
    const vis = document.visibilityState;

    const vAny: any = visuals as any;
    const rs = typeof vAny.getRenderStats === "function" ? vAny.getRenderStats() : null;
    const renderAgeMs = rs?.lastRenderAt ? Math.max(0, now - rs.lastRenderAt) : 0;
    const renderFrames = typeof rs?.renderFrameCount === "number" ? rs.renderFrameCount : 0;

    const mem: any = (performance as any).memory;
    const heapMb = mem?.usedJSHeapSize ? mem.usedJSHeapSize / (1024 * 1024) : null;
    const heapLimitMb = mem?.jsHeapSizeLimit ? mem.jsHeapSizeLimit / (1024 * 1024) : null;
    const heapStr = heapMb != null ? `${heapMb.toFixed(1)}${heapLimitMb ? "/" + heapLimitMb.toFixed(0) : ""} MB` : "n/a";

    const lostStr = lastWebglLostAt ? `webglLost ${Math.round((now - lastWebglLostAt) / 1000)}s ago` : "webgl ok";
    const lt = longTaskCount ? `${longTaskCount} / ${Math.round(longTaskMs)}ms` : "0";
    const gc = gcCount ? `${gcCount} / ${Math.round(gcMs)}ms` : "0";

    const trAny: any = tracker as any;
    const infPauseMs = camTrackOn && camInferOn ? (trAny.getInferPauseMs?.(now) ?? 0) : 0;
    const infLastMs = camTrackOn && camInferOn ? (trAny.getLastInferMs?.() ?? 0) : 0;
    const infBackend = camTrackOn && camInferOn ? (trAny.getInferBackend?.() ?? "main") : "off";
    const workerErr = camTrackOn && camInferOn ? (trAny.getWorkerError?.() ?? null) : null;

    const audAny: any = audio as any;
    const audErr = audioOn ? (audAny?.getLastError?.() ?? null) : null;
    const infStr =
      !camInferOn
        ? "off"
        : infPauseMs > 0
          ? `cool ${Math.round(infPauseMs)}ms`
          : `on ${infBackend} ${Math.round(infLastMs)}ms`;

    hudText.textContent =
      `FPS ${fpsEma.toFixed(1)}  dt ${lastDtMs.toFixed(1)}ms (raw ${lastRawDtMs.toFixed(1)})  long ${longFrames}` +
      `\nage ${age.toFixed(0)}ms  ticks ${tickCount}  vis ${vis}  rAge ${renderAgeMs.toFixed(0)}ms  rFrames ${renderFrames}` +
      `\nheap ${heapStr}` +
      `\nLT ${lt}  GC ${gc}  ${lostStr}` +
      `\nms tick ${tTickMs.toFixed(1)}  vis ${tVisualsMs.toFixed(1)}  aud ${tAudioMs.toFixed(1)}  viz ${tVizMs.toFixed(1)}  cam ${tTrackerMs.toFixed(1)}  midi ${tMidiMs.toFixed(1)}` +
      `\ncam ${camTrackOn ? "on" : "off"}  inf ${infStr}  viz ${audioVizOn ? "on" : "off"}  gpu ${gpuRenderOn ? "on" : "off"}  aud ${audioOn ? "on" : "off"}` +
      `${workerErr ? `\nworkerErr ${workerErr}` : ""}` +
      `${audErr ? `\naudioErr ${audErr}` : ""}` +
      `\nerr ${lastErr ?? "-"}` +
      `\nrej ${lastRej ?? "-"}` +
      `\nkeys: Ctrl/Alt + H HUD  C cam  I inf  V viz  G gpu  A aud  P reload  R reset`;
  };

  const renderHudMeter = () => {
    if (!hudOn || uiHidden) return;
    if (!audioVizOn) return;
    if (!hudMeterCtx) return;

    const cssW = Math.max(260, Math.min(720, Math.floor(hud.getBoundingClientRect().width)));
    const cssH = 56;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (hudMeter.width !== w || hudMeter.height !== h) {
      hudMeter.width = w;
      hudMeter.height = h;
    }

    const ctx = hudMeterCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pack: any = lastAudioViz as any;
    const fft: Float32Array | undefined = pack?.fft;
    const wave: Float32Array | undefined =
      pack?.kick ||
      pack?.bass ||
      pack?.hat ||
      pack?.lead ||
      pack?.simpleLead ||
      pack?.pad ||
      pack?.stab;

    const padL = 0;
    const padT = 0;
    const ww = w - padL;
    const hh = h - padT;
    const midY = padT + hh * 0.52;

    if (fft && fft.length >= 8) {
      const startBin = 1;
      const endBin = fft.length;
      const span = Math.max(1, endBin - startBin);

      const bars = Math.max(32, Math.min(96, Math.floor(ww / Math.max(3, 4.0 * dpr))));
      const baseY = padT + hh * 0.55;

      const lnA = Math.log(Math.max(2, startBin));
      const lnB = Math.log(Math.max(startBin + 1, endBin));
      const lnSpan = Math.max(1e-6, lnB - lnA);

      // Compute per-band peak dB (max pooling) using log-spaced bins.
      let maxDb = -Infinity;
      const bandDb = new Array<number>(bars);
      for (let bi = 0; bi < bars; bi++) {
        const t0 = bi / bars;
        const t1 = (bi + 1) / bars;

        const i0 = startBin + Math.floor(Math.exp(lnA + t0 * lnSpan));
        const i1 = startBin + Math.floor(Math.exp(lnA + t1 * lnSpan));
        const a = Math.max(startBin, Math.min(endBin - 1, i0));
        const b = Math.max(a + 1, Math.min(endBin, i1));

        let peak = -Infinity;
        for (let k = a; k < b; k++) {
          const db = fft[k] ?? -120;
          if (db > peak) peak = db;
        }

        // Gentle HF tilt so mids/highs are readable without dominating.
        const centerT = (bi + 0.5) / bars;
        const tiltDb = centerT * 14;
        const adj = peak + tiltDb;
        bandDb[bi] = adj;
        if (adj > maxDb) maxDb = adj;
      }

      if (!Number.isFinite(maxDb)) maxDb = -60;
      const topDb = Math.min(-10, maxDb - 4);
      const minDb = Math.max(-120, topDb - 80);
      const invRange = 1 / Math.max(1e-6, topDb - minDb);

      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = "rgba(255,255,255,0.65)";

      for (let bi = 0; bi < bars; bi++) {
        const t = bi / Math.max(1, bars - 1);
        let m = (bandDb[bi]! - minDb) * invRange;
        m = Math.min(1, Math.max(0, m));
        m = Math.pow(m, 0.75);

        const x = padL + t * ww;
        const y = baseY - m * (hh * 0.52);
        ctx.beginPath();
        ctx.moveTo(x, baseY);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }

    if (wave && wave.length >= 8) {
      const n = Math.min(128, wave.length);
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = "rgba(0,255,220,0.75)";
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, wave[i] ?? 0));
        const x = padL + (i / Math.max(1, n - 1)) * ww;
        const y = midY - v * (hh * 0.36);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };

  // Update HUD even if requestAnimationFrame gets throttled or stops.
  window.setInterval(() => {
    try {
      renderHud();
    } catch {
      // ignore
    }
  }, 250);

  const errMsg = (e: unknown) => {
    if (e instanceof Error) return e.message;
    try {
      return String(e);
    } catch {
      return "unknown error";
    }
  };

  const start = async () => {
    startBtn.disabled = true;
    startBtn.textContent = "Entering...";
    camSpan.title = "";
    audSpan.title = "";
    midiSpan.title = "";

    camSpan.textContent = "starting";
    try {
      await tracker.start(video);
      camSpan.textContent = "on";
    } catch (e) {
      camSpan.textContent = "error";
      camSpan.title = `Camera error: ${errMsg(e)}`;
      startBtn.disabled = false;
      startBtn.textContent = "Enter Performance";
      return;
    }

    try {
      await midi.start();
    } catch (e) {
      midiSpan.textContent = "err";
      midiSpan.title = `MIDI error: ${errMsg(e)}`;
    }

    const ms = midi.getStatus();
    if (!ms.supported) {
      midiSpan.textContent = "off";
      midiSpan.title = "WebMIDI unsupported in this browser";
    } else if (ms.error) {
      midiSpan.textContent = "err";
      midiSpan.title = `MIDI error: ${ms.error}`;
    } else if (!ms.inputs) {
      midiSpan.textContent = "on(0)";
      midiSpan.title = "No MIDI inputs detected";
    } else {
      midiSpan.textContent = `on(${ms.inputs})`;
      midiSpan.title = `Inputs: ${ms.names.join(", ")}`;
    }

    audSpan.textContent = "starting";
    try {
      if (!audio) {
        const mod: any = await import("./music/droneWorkletEngine");
        audio = new mod.DroneWorkletEngine();
        if (typeof mod?.AUDIO_ENGINE_VERSION === "string") {
          audSpan.title = `AudioEngine: ${mod.AUDIO_ENGINE_VERSION}`;
        }
      }

      const a = audio;
      if (!a) throw new Error("AudioEngine not initialized");

      applyAudioMode(audioMode, { forceScene: true });

      try {
        await a.start();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 250));
        await a.start();
      }

      audSpan.textContent = "on";
    } catch (err) {
      audSpan.textContent = "error";
      const extra =
        typeof (audio as any)?.getLastError === "function" ? String((audio as any).getLastError() ?? "") : "";
      audSpan.title = `Audio error: ${errMsg(err)}${extra ? `\nEngine: ${extra}` : ""}`;
      console.error(err);
      startBtn.disabled = false;
      return;
    }

    running = true;
    stopBtn.disabled = false;
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    camBtn.disabled = false;
    hideUiBtn.disabled = false;
    autoplayBtn.disabled = false;
    startBtn.textContent = "Enter Performance";
    lastT = performance.now();
    lastAutoSceneAt = performance.now();

    if (audioUpdateTimer !== null) {
      try {
        window.clearInterval(audioUpdateTimer);
      } catch {
      }
      audioUpdateTimer = null;
    }
    if (audioOn) {
      audioUpdateTimer = window.setInterval(() => {
        try {
          if (!running || !audioOn) return;
          const c = lastControlForAudio;
          if (!c) return;
          const aT0 = performance.now();
          audio?.update(c);
          const aT1 = performance.now();
          tAudioMs = ema(tAudioMs, aT1 - aT0, 0.12);
        } catch {
          // ignore
        }
      }, 33);
    }

    requestAnimationFrame(tick);
  };

  const stop = async () => {
    running = false;
    stopBtn.disabled = true;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    camBtn.disabled = true;
    hideUiBtn.disabled = true;
    autoplayBtn.disabled = true;
    if (audioUpdateTimer !== null) {
      try {
        window.clearInterval(audioUpdateTimer);
      } catch {
      }
      audioUpdateTimer = null;
    }
    await audio?.stop();
    tracker.stop();
    midi.stop();
    audSpan.textContent = "off";
    camSpan.textContent = "off";
    midiSpan.textContent = "off";
    startBtn.disabled = false;
  };

  startBtn.addEventListener("click", () => {
    void start().catch((e) => {
      console.error(e);
      startBtn.disabled = false;
      startBtn.textContent = "Enter Performance";
      if (camSpan.textContent === "starting") {
        camSpan.textContent = "error";
        camSpan.title = `Camera error: ${errMsg(e)}`;
      }
      if (audSpan.textContent === "starting") {
        audSpan.textContent = "error";
        audSpan.title = `Audio error: ${errMsg(e)}`;
      }
    });
  });

  stopBtn.addEventListener("click", () => {
    void stop().catch((e) => console.error(e));
  });

  modeBtn.addEventListener("click", () => {
    const nextMode = audioMode === "drone" ? "performance" : "drone";
    applyAudioMode(nextMode, { forceScene: true });
  });

  prevBtn.addEventListener("click", () => {
    applySceneDelta(-1);
  });

  nextBtn.addEventListener("click", () => {
    applySceneDelta(1);
  });

  const setUiHidden = (hidden: boolean) => {
    uiHidden = hidden;
    // Main panels (top/left), MIDI keyboard (bottom/right), HUD (bottom/left).
    ui.style.display = hidden ? "none" : "block";
    midiOverlay.style.display = hidden ? "none" : (midiOverlayWasOn ? "block" : "none");
    hud.style.display = hidden ? "none" : (hudOn ? "block" : "none");
  };

  hideUiBtn.addEventListener("click", () => {
    setUiHidden(!uiHidden);
    hideUiBtn.textContent = uiHidden ? "SHOW UI" : "HIDE UI";
  });

  camBtn.addEventListener("click", () => {
    camOn = !camOn;
    camBtn.textContent = camOn ? "CAM: ON" : "CAM: OFF";
    if (!camOn) {
      try {
        tracker.stop();
        video.srcObject = null;
        video.pause();
      } catch {
      }
      try {
        videoWrap.style.display = "none";
      } catch {}
      camSpan.textContent = "off";
      handsSpan.textContent = "0";
      tracker.setWantLandmarks(false);
    } else {
      camSpan.textContent = "starting";
      void tracker
        .start(video)
        .then(() => {
          camSpan.textContent = "on";
          videoWrap.style.display = "block";
          tracker.setWantLandmarks(true);
        })
        .catch((err) => {
          camOn = false;
          camBtn.textContent = "CAM: OFF";
          camSpan.textContent = "error";
          camSpan.title = `Camera error: ${errMsg(err)}`;
        });
    }
  });

  autoplayBtn.addEventListener("click", () => {
    setAutoplayOn(!autoplayOn);
  });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;

    const service = e.ctrlKey || e.altKey || e.metaKey;

    if (service) {
      if (e.key.toLowerCase() === "h") {
        hudOn = !hudOn;
      }
      if (e.key.toLowerCase() === "c") {
        camTrackOn = !camTrackOn;
        if (!camTrackOn) {
          try {
            tracker.stop();
          } catch {
          }
          try {
            video.srcObject = null;
          } catch {
          }
          try {
            video.pause();
          } catch {
          }
          try {
            videoWrap.style.display = "none";
          } catch {
          }
          camSpan.textContent = "off";
          handsSpan.textContent = "0";
        } else {
          try {
            videoWrap.style.display = "block";
          } catch {
          }
          camSpan.textContent = "starting";
          void tracker
            .start(video)
            .then(() => {
              camSpan.textContent = "on";
            })
            .catch((err) => {
              camTrackOn = false;
              camSpan.textContent = "error";
              camSpan.title = `Camera error: ${errMsg(err)}`;
            });
        }
      }
      if (e.key.toLowerCase() === "i") {
        camInferOn = !camInferOn;
        tracker.setInferEnabled(camInferOn);
      }
      if (e.key.toLowerCase() === "v") {
        audioVizOn = !audioVizOn;
      }
      if (e.key.toLowerCase() === "g") {
        gpuRenderOn = !gpuRenderOn;
        visuals.setRenderEnabled(gpuRenderOn);
      }
      if (e.key.toLowerCase() === "a") {
        if (!audio) return;
        audioOn = !audioOn;
        if (!audioOn) {
          if (audioUpdateTimer !== null) {
            try {
              window.clearInterval(audioUpdateTimer);
            } catch {
            }
            audioUpdateTimer = null;
          }
          void audio.stop();
          audSpan.textContent = "off";
        } else {
          audSpan.textContent = "starting";
          applyAudioMode(audioMode);
          audio.setSafeMode(false);
          void audio.start();
          audSpan.textContent = "on";
          if (audioUpdateTimer === null && running) {
            audioUpdateTimer = window.setInterval(() => {
              try {
                if (!running || !audioOn) return;
                const c = lastControlForAudio;
                if (!c) return;
                const aT0 = performance.now();
                audio?.update(c);
                const aT1 = performance.now();
                tAudioMs = ema(tAudioMs, aT1 - aT0, 0.12);
              } catch {
                // ignore
              }
            }, 33);
          }
        }
      }
      if (e.key.toLowerCase() === "p") {
        requestReload("manual");
      }

      if (e.key === "ArrowLeft") {
        applySceneDelta(-1);
      }
      if (e.key === "ArrowRight") {
        applySceneDelta(1);
      }
      if (e.key.toLowerCase() === "r") {
        audio?.reset();
        visuals.reset();
      }

      return;
    }

    const note = keyboardCodeToNote.get(e.code);
    if (note == null) return;
    if (!running) return;
    if (!audio) return;
    if (overlayMode !== "keyboard") return;
    if (keyboardHeldCodes.has(e.code)) return;
    keyboardHeldCodes.add(e.code);

    // Musical keys should not trigger browser/UI shortcuts.
    e.preventDefault();

    const vel = 0.9;
    midiLastEventAt = performance.now();
    midiEventsSince += 1;
    midiHeld.add(note);
    midiVel.set(note, vel);
    midiFlashT.set(note, midiLastEventAt);

    if (note === 47) {
      visuals.triggerBurst(0.08 + 0.12 * vel);
    }

    audio.handleMidi([{ type: "noteon", channel: 0, note, velocity: vel }]);
  });

  window.addEventListener("keyup", (e) => {
    const note = keyboardCodeToNote.get(e.code);
    if (note == null) return;
    if (!audio) return;
    if (overlayMode !== "keyboard") return;
    if (!keyboardHeldCodes.has(e.code)) return;
    keyboardHeldCodes.delete(e.code);

    midiLastEventAt = performance.now();
    midiEventsSince += 1;
    midiHeld.delete(note);
    midiVel.set(note, 0);
    midiFlashT.set(note, midiLastEventAt);

    audio.handleMidi([{ type: "noteoff", channel: 0, note, velocity: 0 }]);
  });

  window.addEventListener("blur", () => {
    releaseAllKeyboardNotes();
    releaseAllMidiNotes();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      releaseAllKeyboardNotes();
      releaseAllMidiNotes();
    }
  });
}

void main();
