export type MidiEvent =
  | { type: "noteon"; channel: number; note: number; velocity: number }
  | { type: "noteoff"; channel: number; note: number; velocity: number }
  | { type: "cc"; channel: number; controller: number; value: number };

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

export class MidiInput {
  private access: MIDIAccess | null = null;
  private inputs: MIDIInput[] = [];
  private queue: MidiEvent[] = [];
  private qHead = 0;
  private qTail = 0;
  private qSize = 0;

  private supported = true;
  private lastError: string | null = null;

  private lastRefreshAt = 0;
  private lastFastRefreshAt = 0;

  private lastMessageAt = 0;
  private lastStateChangeAt = 0;
  private lastAutoRestartAt = 0;

  private lastAccessInputsSize = 0;

  private maxQueue = 512;

  private push(e: MidiEvent) {
    if (!this.queue.length) {
      this.queue = new Array(this.maxQueue);
      this.qHead = 0;
      this.qTail = 0;
      this.qSize = 0;
    }
    this.queue[this.qTail] = e;
    this.qTail = (this.qTail + 1) % this.maxQueue;
    if (this.qSize < this.maxQueue) {
      this.qSize++;
    } else {
      // full: drop oldest
      this.qHead = (this.qHead + 1) % this.maxQueue;
    }
  }

  async start() {
    if (!navigator.requestMIDIAccess) {
      this.supported = false;
      this.lastError = "WebMIDI unsupported";
      return;
    }
    if (this.access) return;

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => {
        // Force an immediate refresh on hot-plug events.
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.lastStateChangeAt = now;
        this.lastRefreshAt = 0;
        this.lastFastRefreshAt = 0;
        this.refreshInputs();
      };
      this.lastError = null;
      this.refreshInputs();
    } catch (e) {
      this.access = null;
      this.lastError = (e as any)?.message ? String((e as any).message) : "MIDI access denied";
    }
  }

  stop() {
    for (const i of this.inputs) {
      i.onmidimessage = null;
    }
    this.inputs = [];
    this.access = null;
    this.queue = [];
    this.qHead = 0;
    this.qTail = 0;
    this.qSize = 0;
    this.lastError = null;
    this.lastRefreshAt = 0;
    this.lastFastRefreshAt = 0;
    this.lastMessageAt = 0;
    this.lastStateChangeAt = 0;
    this.lastAutoRestartAt = 0;
  }

  private async restartAccess() {
    // Best-effort: drop the current MIDIAccess and request again.
    // This is a workaround for Chrome occasionally losing message delivery after hot-plug.
    try {
      if (this.access) this.access.onstatechange = null;
    } catch {
    }
    this.refreshInputs();
    this.access = null;
    await this.start();
  }

  refresh() {
    this.refreshInputs();
  }

  getStatus() {
    // Some environments don't fire onstatechange reliably; re-scan occasionally.
    if (this.access) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      // Re-scan more aggressively when we have 0 inputs (common after unplug/replug).
      if (this.inputs.length === 0) {
        if (now - this.lastFastRefreshAt > 450) {
          this.lastFastRefreshAt = now;
          this.lastRefreshAt = now;
          this.refreshInputs();
        }
      } else if (now - this.lastRefreshAt > 1500) {
        this.lastRefreshAt = now;
        this.refreshInputs();
      }

      // Chrome recovery: after a reconnect, a port can appear but never deliver messages
      // until the page reloads. If we've seen a statechange and have inputs, but no
      // messages have arrived since that change, re-request MIDIAccess once (with backoff).
      const msgAt = this.lastMessageAt;
      const scAt = this.lastStateChangeAt;
      const graceMs = 1400;
      const backoffMs = 8000;
      const shouldRecover =
        this.inputs.length > 0 &&
        scAt > 0 &&
        now - scAt > graceMs &&
        msgAt < scAt &&
        now - this.lastAutoRestartAt > backoffMs;
      if (shouldRecover) {
        this.lastAutoRestartAt = now;
        void this.restartAccess();
      }

      // Chrome recovery (stuck at 0 inputs): sometimes access.inputs stays empty after replug
      // until MIDIAccess is requested again.
      const zeroGraceMs = 1400;
      const stuckAtZero =
        this.inputs.length === 0 &&
        scAt > 0 &&
        now - scAt > zeroGraceMs &&
        now - this.lastAutoRestartAt > backoffMs;
      if (stuckAtZero) {
        this.lastAutoRestartAt = now;
        void this.restartAccess();
      }
    }
    return {
      supported: this.supported,
      inputs: this.inputs.length,
      error: this.lastError,
      names: this.inputs.map((i) => i.name || "(unnamed)")
    };
  }

  consume(maxEvents = 64): MidiEvent[] {
    if (!this.qSize) return [];
    const n = Math.min(maxEvents, this.qSize);
    const out: MidiEvent[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.queue[this.qHead]!;
      this.qHead = (this.qHead + 1) % this.maxQueue;
    }
    this.qSize -= n;
    return out;
  }

  pending() {
    return this.qSize;
  }

  dropOldest(count: number) {
    const n = Math.min(Math.max(0, Math.floor(count)), this.qSize);
    if (!n) return;
    this.qHead = (this.qHead + n) % this.maxQueue;
    this.qSize -= n;
  }

  private refreshInputs() {
    const access = this.access;
    if (!access) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const accessCount = access.inputs ? Array.from(access.inputs.values()).length : 0;
    if (accessCount !== this.lastAccessInputsSize) {
      this.lastAccessInputsSize = accessCount;
      this.lastStateChangeAt = now;
    }

    // Clean up old ports (Chrome can keep stale objects alive after unplug/replug)
    for (const i of this.inputs) {
      i.onmidimessage = null;
      const anyI = i as any;
      if (typeof anyI.close === "function") {
        try {
          void anyI.close();
        } catch {
        }
      }
    }

    this.inputs = Array.from(access.inputs.values()).filter((i) => {
      const anyI = i as any;
      const state = typeof anyI.state === "string" ? String(anyI.state) : "connected";
      // Keep only actively connected ports; Chrome can report connection="closed" transiently.
      return state === "connected";
    });
    this.lastError = null;
    for (const input of this.inputs) {
      const handler = (ev: MIDIMessageEvent) => this.onMessage(ev);
      // Set handler immediately (works in many browsers)
      input.onmidimessage = handler;

      // Some browsers/devices require explicit open(); rebind handler after open resolves.
      const anyI = input as any;
      if (typeof anyI.open === "function") {
        void anyI
          .open()
          .then(() => {
            input.onmidimessage = handler;
          })
          .catch(() => {
            // non-fatal; status will show 0 events if device doesn't open
          });
      }
    }
  }

  private onMessage(ev: MIDIMessageEvent) {
    this.lastMessageAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const d = ev.data;
    if (!d || d.length === 0) return;

    const status = d[0] ?? 0;

    // Ignore system realtime (clock/active sensing/etc.) to avoid flooding the main thread.
    // These are single-byte messages (0xF8..0xFF) and not relevant for our controls.
    if (status >= 0xf8) return;

    if (d.length < 2) return;

    const type = status & 0xf0;
    const channel = status & 0x0f;

    const data1 = d[1] ?? 0;
    const data2 = d.length > 2 ? d[2] ?? 0 : 0;

    if (type === 0x90) {
      const vel = data2;
      if (vel === 0) {
        this.push({ type: "noteoff", channel, note: data1, velocity: 0 });
      } else {
        this.push({ type: "noteon", channel, note: data1, velocity: clamp01(vel / 127) });
      }
      return;
    }

    if (type === 0x80) {
      this.push({ type: "noteoff", channel, note: data1, velocity: clamp01(data2 / 127) });
      return;
    }

    if (type === 0xb0) {
      this.push({ type: "cc", channel, controller: data1, value: clamp01(data2 / 127) });
    }
  }
}
