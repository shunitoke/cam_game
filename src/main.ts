import "./style.css";

import type { DroneWorkletEngine } from "./music/droneWorkletEngine";
import { ControlBus } from "./control/controlBus";
import { HandTracker } from "./vision/handTracker";
import { VisualEngine } from "./visual/visualEngine";
import { HandOverlay2D } from "./visual/handOverlay2d";
import { MidiInput } from "./midi/midiInput";

const BPM_DEFAULT = 132;

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

  const prevBtn = el("button");
  prevBtn.textContent = "PREV";
  prevBtn.title = "Previous Scene";
  prevBtn.disabled = true;

  const nextBtn = el("button");
  nextBtn.textContent = "NEXT";
  nextBtn.title = "Next Scene";
  nextBtn.disabled = true;

  const overlayBtn = el("button");
  overlayBtn.textContent = "HANDS: ON";
  overlayBtn.title = "Hand overlay";
  overlayBtn.disabled = true;
  let overlayOn = true;

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

  const gestureHint = el("div");
  gestureHint.style.padding = "8px 10px";
  gestureHint.style.borderRadius = "0px";
  gestureHint.style.background = "rgba(0,0,0,0.18)";
  gestureHint.style.border = "1px solid rgba(120, 255, 230, 0.18)";
  gestureHint.style.color = "rgba(223, 253, 245, 0.92)";
  gestureHint.style.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  gestureHint.style.whiteSpace = "pre";
  gestureHint.style.opacity = "0.92";
  gestureHint.textContent = "Gestures\n- Pinch: hold\n- Move: change\n";

  const hudText = el("div");
  hudText.style.whiteSpace = "pre";
  hudText.textContent = "HUD";

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
        "- A/W/S/E... keys: pitch\n" +
        "- 🤏🫲 Left pinch: gate / level\n" +
        "- 🫲 X: BPM (slow pulse)\n" +
        "- 🫲 Y: envelope (atk/rel)\n" +
        "- 🫲🫱 Both hands: build = more pulse\n" +
        "- 🫱 X: guitar pitch\n" +
        "- 🤏🫱 Right pinch: pluck (guitar) + ticks\n" +
        "- 🫱 Y: brightness\n";
    } else {
      gestureHint.textContent =
        "Gestures (RAVE)\n" +
        "- 🫲 X: tempo (BPM)\n" +
        "- 🫱 Y: drum filter (LPF)\n" +
        "- 🤏🫱 Right pinch: hat density / open hat\n" +
        "- 🫲🫱 Both hands: build = more rumble\n";
    }
  };

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
  controlsRow.appendChild(prevBtn);
  controlsRow.appendChild(nextBtn);
  controlsRow.appendChild(sceneBadge);

  togglesRow.appendChild(overlayBtn);

  panel.appendChild(controlsRow);
  panel.appendChild(togglesRow);
  panel.appendChild(status);
  panel.appendChild(gestureHint);
  panel.appendChild(hints);
  ui.appendChild(panel);
  document.body.appendChild(ui);
  document.body.appendChild(hud);

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
    <div class="midiLegendRow"><b>One-octave performance</b> (36–47): KICK, SNARE, HAT, CLAP, PERC, BASS, STAB, LEAD, PAD, FILL, GEN toggle, FX (visual)</div>
  `;
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
        ["Left hand", "mix / flow"],
        ["Right hand", "space / FX"],
        ["Right pinch", "intensity"],
        ["Build", "more motion + density"],
        ["MIDI note", "burst"],
        ["R", "reset scene"]
      ]
    },
    geometry: {
      title: "Geometry",
      items: [
        ["Right hand", "depth / camera feel"],
        ["Right pinch", "FX / warp"],
        ["Build", "more layers"],
        ["MIDI note", "pulse"],
        ["R", "reset"]
      ]
    },
    plasma: {
      title: "Plasma",
      items: [
        ["Right hand", "palette / drift"],
        ["Right pinch", "contrast / speed"],
        ["Build", "more energy"],
        ["MIDI note", "kick wobble"],
        ["R", "reset"]
      ]
    },
    warp: {
      title: "DomainWarp",
      items: [
        ["Right pinch", "ink / smoothness"],
        ["Right speed", "warp amount"],
        ["Right Y", "speed"],
        ["Build", "detail + intensity"],
        ["MIDI note", "shock / motion"],
        ["LOW mode", "lower octaves"],
        ["R", "reset"]
      ]
    },
    cellular: {
      title: "Cellular",
      items: [
        ["Right pinch", "wet / glow"],
        ["Right speed", "jitter"],
        ["Right X", "scale"],
        ["Right Y", "sharpness"],
        ["Build", "density"],
        ["MIDI note", "edge glow"],
        ["R", "reset"]
      ]
    },
    tunnel: {
      title: "Tunnel",
      items: [
        ["Right pinch", "neon glow"],
        ["Right X", "twist"],
        ["Right Y", "speed"],
        ["Right speed", "quality (steps)"],
        ["Build", "aggression"],
        ["MIDI note", "flash"],
        ["LOW mode", "lower steps"],
        ["R", "reset"]
      ]
    },
    rd: {
      title: "ReactionDiffusion",
      items: [
        ["Right X", "feed"],
        ["Right Y", "kill"],
        ["Right pinch", "brush (paint B)"],
        ["Build", "sim speed"],
        ["MIDI note", "kick agitation"],
        ["LOW mode", "lower sim res"],
        ["R", "reseed"]
      ]
    },
    quasi: {
      title: "Quasicrystals",
      items: [
        ["Right hand", "pattern feel"],
        ["Right pinch", "wet / shimmer"],
        ["Build", "more structure"],
        ["MIDI note", "spark"],
        ["R", "reset"]
      ]
    },
    dla: {
      title: "DLA",
      items: [
        ["Build", "growth speed"],
        ["Left hand", "energy bias"],
        ["MIDI note", "faster climbing"],
        ["LOW mode", "lower-res but stable"],
        ["R", "reset growth"]
      ]
    },
    bif: {
      title: "Bifurcation",
      items: [
        ["Right hand", "parameter sweep"],
        ["Build", "more branches"],
        ["MIDI note", "jump / pulse"],
        ["R", "reset"]
      ]
    },
    wavelab: {
      title: "WaveLab",
      items: [
        ["Left hand", "select voice / mix"],
        ["Right hand", "space / timbre"],
        ["Wave edit", "gestures can edit partials"],
        ["Build", "more motion"],
        ["R", "reset + clear edits"]
      ]
    },
    physics: {
      title: "Physics",
      items: [
        ["Pinch", "grab cloth"],
        ["Fast movement", "rip / tear"],
        ["Build", "heavier motion"],
        ["R", "rebuild cloth"]
      ]
    },
    lloyd: {
      title: "Lloyd",
      items: [
        ["Right hand", "relaxation / pull"],
        ["Pinch", "field strength"],
        ["Build", "more energy"],
        ["MIDI note", "burst"]
      ]
    },
    rrt: {
      title: "RRT",
      items: [
        ["Right hand", "goal bias"],
        ["Build", "faster expansion"],
        ["MIDI note", "branch burst"],
        ["R", "reset"]
      ]
    },
    arboretum: {
      title: "Arboretum",
      items: [
        ["Right hand", "shape / wind"],
        ["Build", "density"],
        ["MIDI note", "growth pulse"],
        ["R", "reset"]
      ]
    },
    koch: {
      title: "Koch",
      items: [
        ["Right hand", "depth / rotation"],
        ["Build", "more recursion"],
        ["MIDI note", "pulse"],
        ["R", "reset"]
      ]
    },
    bosWarp: {
      title: "BoS Warp",
      items: [
        ["Right hand", "scale / speed"],
        ["Right pinch", "warp amount"],
        ["Build", "detail + intensity"],
        ["MIDI note", "burst"],
        ["LOW mode", "fewer octaves"],
        ["R", "reset"]
      ]
    },
    kaleidoscope: {
      title: "Kaleidoscope",
      items: [
        ["Right hand", "zoom / speed"],
        ["Right pinch", "twist"],
        ["Build", "segments + motion"],
        ["MIDI note", "burst"],
        ["LOW mode", "lower detail"],
        ["R", "reset"]
      ]
    },
    metaballs: {
      title: "Metaballs",
      items: [
        ["Right hand", "zoom / speed"],
        ["Right pinch", "threshold / glow"],
        ["Build", "more blobs"],
        ["MIDI note", "burst"],
        ["LOW mode", "fewer blobs"],
        ["R", "reset"]
      ]
    },
    ascii: {
      title: "ASCII",
      items: [
        ["Camera", "silhouette -> glyphs"],
        ["Right pinch", "wet / smear"],
        ["Build", "more ink"],
        ["MIDI note", "kick smear"],
        ["R", "reset"]
      ]
    }
  };

  const renderHints = (sceneId: string, sceneName: string) => {
    const h = sceneHints[sceneId];
    const title = h?.title ?? sceneName;
    const items = h?.items ?? [
      ["Left hand", "mix / select"],
      ["Right hand", "space / FX"],
      ["Build", "energy"],
      ["R", "reset"]
    ];

    hintsSummary.textContent = `Hints: ${title}`;
    hintsBody.innerHTML = `
      <div class="hintGrid">
        ${items.map(([k, v]) => `<div><b>${k}</b></div><div>${v}</div>`).join("\n")}
      </div>
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

  let running = false;
  let lastT = performance.now();
  let wasHidden = document.visibilityState !== "visible";

  let beatViz = 0;

  let lastAudioVizAt = 0;
  let lastAudioViz: any = null;

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
        const trAny: any = tracker as any;
        const inferMs = camTrackOn && camInferOn ? (trAny.getLastInferMs?.() ?? 0) : 0;
        const enable = hands.count > 0 && inferMs >= 18;
        const disable = inferMs > 0 && inferMs <= 12;

        if (!autoLowVision && enable && nowMs - autoLowVisionSince > 600) {
          autoLowVision = true;
          autoLowVisionSince = nowMs;
        } else if (autoLowVision && disable && nowMs - autoLowVisionSince > 900) {
          autoLowVision = false;
          autoLowVisionSince = nowMs;
        }
      }

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

    const overlayOnNow = running;
    if (overlayOnNow !== midiOverlayWasOn) {
      midiOverlayWasOn = overlayOnNow;
      midiOverlay.style.display = overlayOnNow ? "block" : "none";
    }

    overlayMode = !!midiStatus.supported && !midiStatus.error && midiStatus.inputs > 0 ? "midi" : "keyboard";
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
          }
          if (e.type === "noteoff") {
            midiHeld.delete(e.note);
            midiVel.set(e.note, clamp01(e.velocity));
          }
        }
        audio?.handleMidi(midiEvents);
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
        const a = held ? 0.9 : 0.25;
        const glow = 0.15 + 0.85 * flash;
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
      if (audioVizOn) {
        const now = performance.now();
        // Throttle analyzer reads: Tone's getValue() often allocates typed arrays and can
        // cause GC/LongTasks if called every frame.
        const minIntervalMs = autoLowVision ? 120 : 66;
        if (!lastAudioVizAt || now - lastAudioVizAt >= minIntervalMs) {
          lastAudioVizAt = now;
          lastAudioViz = audio?.getWaveforms() ?? null;
        }
        audioViz = lastAudioViz;
      }
      const vizT1 = performance.now();
      tVizMs = ema(tVizMs, vizT1 - vizT0, 0.12);
      const beatPulse = audio?.getPulse?.() ?? 0;
      if (audioViz) {
        (control as any).audioViz = audioViz;

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
        let sum = 0;
        for (let i = 0; i < bins; i++) {
          const db = fft[i] ?? -120;
          const m = Math.min(1, Math.max(0, (db + 120) / 120));
          sum += m;
        }
        low = bins ? sum / bins : 0;
      }

      const target = Math.min(1, Math.max(peak * 3.5, low * 1.25));
      const dt = Math.min(0.033, (control as any).dt ?? 0.016);
      const a = 1 - Math.exp(-dt * 26);
      beatViz = beatViz + (target - beatViz) * a;
      beatViz = Math.max(0, beatViz - dt * 1.75);
    } else {
      beatViz = Math.max(0, beatViz - (control as any).dt * 1.75);
    }

    const bpOut =
      Math.max(beatPulse, beatViz);
    (control as any).beatPulse = bpOut;
    if (running) audSpan.title = `beat: ${bpOut.toFixed(3)}`;
    const controlWithViz = control as any;

    lastControlForAudio = controlWithViz;

    const sceneDelta = controlWithViz.events.sceneDelta;
    if (sceneDelta !== 0) {
      const s = visuals.nextScene(sceneDelta);
      sceneBadge.textContent = `Scene: ${s.name}`;
      renderHints(s.id, s.name);
      audio?.setScene(s.id);
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
    if (!hudOn) {
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
    if (!hudOn) return;
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

      a.setMode(audioMode);

      try {
        await a.start();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 250));
        await a.start();
      }

      audSpan.textContent = "on";
    } catch (e) {
      audSpan.textContent = "error";
      audSpan.title = `Audio error: ${errMsg(e)}`;
      startBtn.disabled = false;
      startBtn.textContent = "Enter Performance";
      return;
    }

    running = true;
    stopBtn.disabled = false;
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    overlayBtn.disabled = false;
    startBtn.textContent = "Enter Performance";
    lastT = performance.now();

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
    overlayBtn.disabled = true;
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
    audioMode = audioMode === "drone" ? "performance" : "drone";
    modeBtn.textContent = audioMode === "drone" ? "MODE: DRONE" : "MODE: RAVE";
    updateGestureHint(audioMode);
    audio?.setMode(audioMode);
  });

  prevBtn.addEventListener("click", () => {
    const s = visuals.nextScene(-1);
    sceneBadge.textContent = `Scene: ${s.name}`;
    renderHints(s.id, s.name);
    audio?.setScene(s.id);
  });

  nextBtn.addEventListener("click", () => {
    const s = visuals.nextScene(1);
    sceneBadge.textContent = `Scene: ${s.name}`;
    renderHints(s.id, s.name);
    audio?.setScene(s.id);
  });

  overlayBtn.addEventListener("click", () => {
    overlayOn = !overlayOn;
    overlayBtn.textContent = overlayOn ? "HANDS: ON" : "HANDS: OFF";
    overlay.setEnabled(overlayOn);
    tracker.setWantLandmarks(overlayOn);
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
          audio.setMode(audioMode);
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
        const s = visuals.nextScene(-1);
        sceneBadge.textContent = `Scene: ${s.name}`;
        renderHints(s.id, s.name);
        audio?.setScene(s.id);
      }
      if (e.key === "ArrowRight") {
        const s = visuals.nextScene(1);
        sceneBadge.textContent = `Scene: ${s.name}`;
        renderHints(s.id, s.name);
        audio?.setScene(s.id);
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
      return;
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
}

void main();
