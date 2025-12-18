# Cam Techno Performance (MVP)

Browser-based interactive techno/electronic performance instrument:

- Camera (laptop webcam) detects **two hands**
- Hands modulate **in-app techno generator** (Tone.js)
- Hands modulate **reactive visuals** (Three.js)
- Gestures: **pinch**, **open palms reset**, **fist kill**, **open-palm swipe** to change scenes
- Optional: **MIDI keyboard/controller input** (Web MIDI)

## Run

1. Install deps

```bash
npm install
```

2. Start dev server

```bash
npm run dev
```

3. Open the shown URL, allow camera.

4. Click **Enter Performance** (browser requires a user gesture).

## Browser / Permissions

- Camera access is required for hand tracking.
- Audio starts only after a user gesture (click).
- MIDI requires a browser with Web MIDI support (Chrome/Edge) and permission to use MIDI devices.

## Controls (MVP)

### Roles

- **Right hand = Sound / FX**
- **Left hand = Groove / Mix**

### Continuous (always-on)

- **Right X**: master low-pass cutoff (left = darker, right = brighter)
- **Right Y**: resonance / bite (down = softer, up = sharper)
- **Right pinch** (thumb-index distance): FX wet (delay+reverb macro)
- **Right speed**: drive/distortion amount

- **Left X**: hat density (quantized per beat)
- **Left Y**: bass activity (quantized per beat)
- **Left pinch**: kick weight (sub/attack macro)
- **Two-hands distance**: build/drop macro (more width, FX, intensity)

### Discrete gestures (safe)

- **Fist (either hand, hold)**: kill/mute (release returns smoothly)
- **Open palms (both hands, hold ~0.5s)**: safe reset to stable groove

### Scene switching

- **Open left palm** (navigation modifier) + **swipe left/right**: previous/next scene

### WaveLab edit mode

- **WaveLab only**: pinch with **both hands** and hold ~0.5s to toggle edit mode
- **Left hand X**: harmonic index (0..15)
- **Left hand Y**: harmonic amplitude
- **Right pinch (hold)**: write/apply the current harmonic value
- **Left fist (hold)**: clear current target waveform (bass/stab)

## Scenes

- **Scene 1: Particles**
- **Scene 2: Geometry tunnel/grid**
- **Scene 3: Plasma**
- **Scene 4: DomainWarp**
- **Scene 5: Cellular**
- **Scene 6: Tunnel**
- **Scene 7: Quasicrystals**
- **Scene 8: ReactionDiffusion**
- **Scene 9: DLA**
- **Scene 10: Bifurcation**
- **Scene 11: WaveLab (per-voice waveforms + timbre morph)**
- **Scene 12: Physics (springs/cloth)**
- **Scene 13: Lloyd**
- **Scene 14: RRT**
- **Scene 15: Arboretum**
- **Scene 16: Koch**
- **Scene 17: BoS Warp (fBm + domain warping)**
- **Scene 18: Kaleidoscope**
- **Scene 19: Metaballs**
- **Scene 20: ASCII**

### ASCII scene (camera silhouette)

- Uses the live camera feed to draw a **silhouette in ASCII glyphs**.
- Keeps the background intentionally **open** (mostly edges + light fill).
- Adds **trail/smear distortion** that reacts to the kick.

## UI

- **Prev Scene / Next Scene**: switch scenes
- **Safe Mode**: reduces GPU + tracking load (recommended on weak iGPU/APU)
- **Overlay**: toggle hand skeleton overlay rendering
- **MODE**:
  - **RAVE**: main performance mode (groove runs)
  - **DRONE**: gesture-only sound mode (no groove; sound comes from pinch/motion)

## MIDI

MIDI input is enabled automatically when you click **Enter Performance**.

- Notes:
  - The app shows a **bottom-right MIDI keyboard overlay** when a device is detected.
  - **Note On/Off** triggers musical events (see mapping below).
  - Visual FX are intentionally minimal: only the dedicated **FX** key triggers a tiny burst.
- CC mappings:
  - **CC1 (mod wheel)**: adds extra distortion (drive)
  - **CC74**: bit-crush amount (lo-fi)
  - **CC71**: drum sample low-pass cutoff
  - **CC91**: increases reverb wet
  - **CC64 (sustain)**: toggle generative mode on/off (if your controller sends it)

### NanoKey2 quick mapping (recommended)

The NanoKey2 mapping is **one octave only** (36–47). Use **OCT - / OCT +** to land on **C1..B1**.

- **36–47 (C1–B1)**: performance keys
  - **36**: KICK
  - **37**: SNARE
  - **38**: HAT
  - **39**: CLAP
  - **40**: PERC
  - **41**: BASS hit
  - **42**: STAB hit
  - **43**: MELODY hit
  - **44**: PAD (hold)
  - **45**: FILL (brief intensity boost)
  - **46**: GEN toggle (generative groove on/off)
  - **47**: FX (tiny visual burst)

If drum samples fail to load (network/CORS), the app falls back to synth drums so the keys still make sound.

### Local samples (optional)

You can override the built-in one-shot drum samples with your own **local** WAV files.

- Install path:
  - `public/samples/user/909/`
- Filenames (must match exactly):
  - `kick.wav`
  - `snare.wav`
  - `hihat.wav`
  - `clap.wav`
  - `cowbell.wav`
  - `tom.wav` (used for PERC)

If these files are missing, the app automatically falls back to the hosted 909 samples and/or synth fallback so it always makes sound.

Important: this folder is gitignored (`public/samples/user/`) so you don’t accidentally commit/redistribute third-party samples.

### Music start behavior

On start, the music begins with a **basic kick**, then gradually fades in hats, bass, clap, melody, and pad over ~30 bars.

### DRONE mode (gesture sound)

If you switch **MODE** to **DRONE**, the groove is stopped and sound is generated only from hand gestures (primarily pinch-gated sustained tone).

## Notes

- Best results: good frontal light, hands in frame, avoid overexposed background.
- If tracking drops: controls freeze and risky FX backs off.
- Visual backdrops for plane-based scenes are scaled to be **fullscreen**.

## Performance postmortem / note to next agent

This project hit persistent UI stalls / Long Tasks during live use. We attempted incremental optimizations and added safety mechanisms, but the core freeze behavior was not fully eliminated.

### What profiling showed

- In Chrome Performance traces, the biggest Long Tasks were dominated by `@mediapipe/tasks-vision` (HandLandmarker) WASM work inside `HandTracker.update()` (synchronous `detectForVideo`).
- MediaPipe HandLandmarker `detectForVideo()` is synchronous on web and blocks the UI thread. The official docs explicitly recommend using WebWorkers for real-time camera usage.
- Secondary load contributors existed too (Tone.js Transport callbacks, analyzer reads, WebGL render), but the “hard” multi-hundred-ms stalls were mainly MediaPipe WASM.

### What we tried (and why it still wasn’t enough)

- Reduced camera resolution/FPS and inference frequency, adaptive throttling, dynamic hand count reduction.
- Audio engine throttling (reduced scheduling density in LOW mode), throttled analyzer reads.
- Added watchdogs:
  - pause inference for a cooldown after an expensive `detectForVideo` call (`inf cool`)
  - auto-recreate the `HandLandmarker` instance on repeated stalls
  - manual + automatic full page reload (equivalent to closing/reopening tab), because that was the most reliable “reset” for the user

These mitigations improved stability but could not guarantee stall-free operation because the underlying inference call is still synchronous and can spike unpredictably.

### Recommended rewrite direction

- Move MediaPipe inference off the main thread:
  - run `detectForVideo` inside a WebWorker (per MediaPipe docs)
  - pass frames via `ImageBitmap`/`OffscreenCanvas` patterns (or a worker-friendly pipeline)
  - main thread should only render + apply the latest stable hand state
- Keep strict subsystem boundaries:
  - main loop orchestrator (time budget + backpressure)
  - camera capture module
  - inference worker module
  - audio engine module
  - visuals module
- Treat “quality” settings as dynamic, not a global toggle:
  - adaptively degrade when over budget
  - recover slowly when under budget
- Keep tooling:
  - in-app HUD (FPS, dt/raw dt, LT/GC counters, per-subsystem timings)
  - one-click safe reset/reload for live performance

