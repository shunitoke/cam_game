import "./style.css";
import { ControlBus } from "./control/controlBus";
import { HandTracker } from "./vision/handTracker";
import { VisualEngine } from "./visual/visualEngine";
import { HandOverlay2D } from "./visual/handOverlay2d";
import { MidiInput } from "./midi/midiInput";
const BPM_DEFAULT = 132;
function el(tag, className) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    return node;
}
function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}
function midiNoteName(n) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const pc = ((n % 12) + 12) % 12;
    const oct = Math.floor(n / 12) - 1;
    return `${names[pc]}${oct}`;
}
function midiRole(n) {
    if (n >= 36 && n <= 40)
        return "DRUM";
    if (n >= 41 && n <= 44)
        return "INST";
    if (n === 45 || n === 46)
        return "MACRO";
    if (n === 47)
        return "FX";
    return "";
}
function keyNameFromCode(code) {
    if (code.startsWith("Key"))
        return code.slice(3);
    if (code.startsWith("Digit"))
        return code.slice(5);
    if (code === "Semicolon")
        return ";";
    if (code === "Comma")
        return ",";
    if (code === "Period")
        return ".";
    if (code === "Slash")
        return "/";
    if (code === "Backquote")
        return "`";
    if (code === "BracketLeft")
        return "[";
    if (code === "BracketRight")
        return "]";
    if (code === "Minus")
        return "-";
    if (code === "Equal")
        return "=";
    return code;
}
async function main() {
    const app = document.getElementById("app");
    if (!app)
        throw new Error("#app not found");
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
    const safeBtn = el("button");
    safeBtn.textContent = "SAFE: OFF";
    safeBtn.title = "Safe Mode";
    safeBtn.disabled = true;
    let safeMode = false;
    const overlayBtn = el("button");
    overlayBtn.textContent = "OVR: ON";
    overlayBtn.title = "Hand Overlay";
    overlayBtn.disabled = true;
    let overlayOn = true;
    const sceneBadge = el("span", "badge");
    sceneBadge.textContent = "Scene: Particles";
    const status = el("div");
    status.innerHTML = `<small>Camera: <span id="cam">idle</span> · Audio: <span id="aud">idle</span> · MIDI: <span id="midi">idle</span> · Hands: <span id="hands">0</span></small>`;
    const hints = el("details", "hints");
    const hintsSummary = el("summary");
    hintsSummary.textContent = "Hints";
    const hintsBody = el("div", "hintsBody");
    hints.appendChild(hintsSummary);
    hints.appendChild(hintsBody);
    controlsRow.appendChild(startBtn);
    controlsRow.appendChild(stopBtn);
    const modeBtn = el("button");
    modeBtn.textContent = "MODE: RAVE";
    controlsRow.appendChild(modeBtn);
    controlsRow.appendChild(prevBtn);
    controlsRow.appendChild(nextBtn);
    controlsRow.appendChild(sceneBadge);
    togglesRow.appendChild(safeBtn);
    togglesRow.appendChild(overlayBtn);
    panel.appendChild(controlsRow);
    panel.appendChild(togglesRow);
    panel.appendChild(status);
    panel.appendChild(hints);
    ui.appendChild(panel);
    document.body.appendChild(ui);
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
    const camSpan = status.querySelector("#cam");
    const audSpan = status.querySelector("#aud");
    const midiSpan = status.querySelector("#midi");
    const handsSpan = status.querySelector("#hands");
    const controlBus = new ControlBus();
    const visuals = new VisualEngine(canvas, { video });
    const sceneHints = {
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
                ["SAFE mode", "lower octaves"],
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
                ["SAFE mode", "lower steps"],
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
                ["SAFE mode", "lower sim res"],
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
                ["SAFE mode", "lower-res but stable"],
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
        circleTree: {
            title: "CircleTree",
            items: [
                ["Right hand", "layout / flow"],
                ["Build", "complexity"],
                ["MIDI note", "burst"],
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
    const renderHints = (sceneId, sceneName) => {
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
    let audio = null;
    let audioMode = "performance";
    const tracker = new HandTracker({ maxHands: 2, mirrorX: true });
    const midi = new MidiInput();
    const midiHeld = new Set();
    const midiVel = new Map();
    const midiFlashT = new Map();
    const midiKeyEls = new Map();
    const midiMin = 36;
    const midiMax = 47;
    const keyboardHeldCodes = new Set();
    const keyboardCodeToNote = new Map();
    const keyboardNoteToCode = new Map();
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
            keyboardCodeToNote.set(codes[i], note);
            keyboardNoteToCode.set(note, codes[i]);
        }
    }
    {
        const drumLabel = (n) => {
            if (n === 36)
                return "KICK";
            if (n === 37)
                return "SNARE";
            if (n === 38)
                return "HAT";
            if (n === 39)
                return "CLAP";
            if (n === 40)
                return "PERC";
            if (n === 41)
                return "BASS";
            if (n === 42)
                return "STAB";
            if (n === 43)
                return "LEAD";
            if (n === 44)
                return "PAD";
            if (n === 45)
                return "FILL";
            if (n === 46)
                return "GEN";
            if (n === 47)
                return "FX";
            return "";
        };
        for (let n = midiMin; n <= midiMax; n++) {
            const k = el("div", "midiKey");
            k.dataset.note = String(n);
            const code = keyboardNoteToCode.get(n);
            if (code)
                k.dataset.kb = keyNameFromCode(code);
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
    let overlayMode = "keyboard";
    let running = false;
    let lastT = performance.now();
    canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        running = false;
        camSpan.textContent = "on";
        audSpan.textContent = "off";
        stopBtn.disabled = true;
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        safeBtn.disabled = true;
        sceneBadge.textContent = "Scene: (GPU reset)";
        void audio?.stop();
    }, { passive: false });
    canvas.addEventListener("webglcontextrestored", () => {
        sceneBadge.textContent = `Scene: ${visuals.current.name}`;
    });
    const tick = (t) => {
        if (!running)
            return;
        const dt = Math.max(0.001, (t - lastT) / 1000);
        lastT = t;
        const hands = tracker.update(t, dt);
        handsSpan.textContent = String(hands.count);
        overlay.draw(hands.hands);
        const control = controlBus.update({ t, dt, hands });
        const midiStatus = midi.getStatus();
        if (!midiStatus.supported) {
            midiSpan.textContent = "off";
            midiSpan.title = "WebMIDI unsupported in this browser";
        }
        else if (midiStatus.error) {
            midiSpan.textContent = "err";
            midiSpan.title = `MIDI error: ${midiStatus.error}`;
        }
        else if (!midiStatus.inputs) {
            midiSpan.textContent = "on(0)";
            midiSpan.title = "No MIDI inputs detected";
        }
        else {
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
            }
            else {
                midiOverlayTitle.textContent = "Keyboard";
                midiOverlaySub.textContent = "A W S E D F T G Y H U J";
            }
        }
        if (!midiRateWindowStart)
            midiRateWindowStart = t;
        if (t - midiRateWindowStart > 800) {
            const secs = Math.max(0.001, (t - midiRateWindowStart) / 1000);
            midiRate = midiEventsSince / secs;
            midiEventsSince = 0;
            midiRateWindowStart = t;
        }
        if (midiLastEventAt > 0) {
            const ageMs = Math.max(0, t - midiLastEventAt);
            midiOverlayAct.textContent = `activity: ${ageMs < 999 ? Math.round(ageMs) + "ms" : (ageMs / 1000).toFixed(1) + "s"} · ${midiRate.toFixed(1)}/s`;
        }
        else {
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
                if (!midiEvents.length)
                    break;
                midiEventsSince += midiEvents.length;
                for (const e of midiEvents) {
                    midiLastEventAt = t;
                    if (e.type === "noteon" && e.note === 47)
                        burst += 0.08 + 0.12 * e.velocity;
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
        if (midiOverlayWasOn) {
            for (let n = midiMin; n <= midiMax; n++) {
                const k = midiKeyEls.get(n);
                if (!k)
                    continue;
                const held = midiHeld.has(n);
                const role = midiRole(n);
                k.classList.toggle("held", held);
                k.dataset.role = role;
                const top = k.querySelector(".midiKeyTop");
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
        const audioViz = audio?.getWaveforms();
        const beatPulse = audio?.getPulse?.() ?? 0;
        if (audioViz)
            control.audioViz = audioViz;
        control.beatPulse = beatPulse;
        const controlWithViz = control;
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
        audio?.update(controlWithViz);
        visuals.update(controlWithViz);
        requestAnimationFrame(tick);
    };
    const start = async () => {
        startBtn.disabled = true;
        camSpan.textContent = "starting";
        await tracker.start(video);
        camSpan.textContent = "on";
        await midi.start();
        const ms = midi.getStatus();
        if (!ms.supported) {
            midiSpan.textContent = "off";
            midiSpan.title = "WebMIDI unsupported in this browser";
        }
        else if (ms.error) {
            midiSpan.textContent = "err";
            midiSpan.title = `MIDI error: ${ms.error}`;
        }
        else if (!ms.inputs) {
            midiSpan.textContent = "on(0)";
            midiSpan.title = "No MIDI inputs detected";
        }
        else {
            midiSpan.textContent = `on(${ms.inputs})`;
            midiSpan.title = `Inputs: ${ms.names.join(", ")}`;
        }
        audSpan.textContent = "starting";
        if (!audio) {
            const mod = await import("./music/audioEngine");
            audio = new mod.AudioEngine({ bpm: BPM_DEFAULT });
        }
        audio.setMode(audioMode);
        await audio.start();
        audSpan.textContent = "on";
        running = true;
        stopBtn.disabled = false;
        prevBtn.disabled = false;
        nextBtn.disabled = false;
        safeBtn.disabled = false;
        overlayBtn.disabled = false;
        lastT = performance.now();
        requestAnimationFrame(tick);
    };
    const stop = async () => {
        running = false;
        stopBtn.disabled = true;
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        safeBtn.disabled = true;
        overlayBtn.disabled = true;
        await audio?.stop();
        tracker.stop();
        midi.stop();
        audSpan.textContent = "off";
        startBtn.disabled = false;
    };
    startBtn.addEventListener("click", () => {
        void start().catch((e) => {
            console.error(e);
            startBtn.disabled = false;
            camSpan.textContent = "error";
            audSpan.textContent = "error";
        });
    });
    stopBtn.addEventListener("click", () => {
        void stop().catch((e) => console.error(e));
    });
    modeBtn.addEventListener("click", () => {
        audioMode = audioMode === "drone" ? "performance" : "drone";
        modeBtn.textContent = audioMode === "drone" ? "MODE: DRONE" : "MODE: RAVE";
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
    safeBtn.addEventListener("click", () => {
        safeMode = !safeMode;
        safeBtn.textContent = safeMode ? "SAFE: ON" : "SAFE: OFF";
        visuals.setSafeMode(safeMode);
        tracker.setSafeMode(safeMode);
        overlay.setLowPower(safeMode);
        overlay.setMaxDpr(safeMode ? 1.0 : 1.25);
    });
    overlayBtn.addEventListener("click", () => {
        overlayOn = !overlayOn;
        overlayBtn.textContent = overlayOn ? "OVR: ON" : "OVR: OFF";
        overlay.setEnabled(overlayOn);
    });
    window.addEventListener("keydown", (e) => {
        if (e.repeat)
            return;
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
        const note = keyboardCodeToNote.get(e.code);
        if (note == null)
            return;
        if (!running)
            return;
        if (!audio)
            return;
        if (overlayMode !== "keyboard")
            return;
        if (keyboardHeldCodes.has(e.code))
            return;
        keyboardHeldCodes.add(e.code);
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
        if (note == null)
            return;
        if (!audio)
            return;
        if (overlayMode !== "keyboard")
            return;
        if (!keyboardHeldCodes.has(e.code))
            return;
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
