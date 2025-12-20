import type { ControlState, HandsFrame, HandPose } from "./types";

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function expSlew(current: number, target: number, dt: number, tau: number) {
  const a = 1 - Math.exp(-dt / Math.max(1e-6, tau));
  return current + (target - current) * a;
}

function findHand(frame: HandsFrame, label: "Left" | "Right"): HandPose | undefined {
  return frame.hands.find((h) => h.label === label) ?? frame.hands.find((h) => h.label === "Unknown");
}

export class ControlBus {
  private state: ControlState;

  private bothOpenMs = 0;
  private lastSceneTriggerT = 0;

  private leftWristPrevX: number | null = null;
  private leftWristVelX = 0;

  constructor() {
    this.state = this.createDefaultState();
  }

  reset() {
    this.state = this.createDefaultState();
    this.bothOpenMs = 0;
    this.lastSceneTriggerT = 0;
    this.leftWristPrevX = null;
    this.leftWristVelX = 0;
  }

  private createDefaultState(): ControlState {
    return {
      t: 0,
      dt: 1 / 60,

      hands: { count: 0, hands: [] },

      rightX: 0.5,
      rightY: 0.85,
      rightPinch: 0,
      rightSpeed: 0,

      leftX: 0.5,
      leftY: 0.5,
      leftPinch: 0,
      leftSpeed: 0,

      build: 0,

      kill: false,

      events: {
        reset: false,
        sceneDelta: 0
      }
    };
  }

  update(input: { t: number; dt: number; hands: HandsFrame }): ControlState {
    const { t, dt, hands } = input;

    const left = findHand(hands, "Left");
    const right = findHand(hands, "Right");

    const nextRightX = right ? clamp01(right.center.x) : 0.5;
    const nextRightY = right ? clamp01(1 - right.center.y) : 0.85;
    const nextRightPinch = right ? clamp01(right.pinch) : 0;
    const nextRightSpeed = right ? clamp01(right.speed) : 0;

    const nextLeftX = left ? clamp01(left.center.x) : 0.5;
    const nextLeftY = left ? clamp01(1 - left.center.y) : 0.5;
    const nextLeftPinch = left ? clamp01(left.pinch) : 0;
    const nextLeftSpeed = left ? clamp01(left.speed) : 0;

    let build = 0;
    if (left && right) {
      const dx = left.center.x - right.center.x;
      const dy = left.center.y - right.center.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      build = clamp01((d - 0.15) / 0.55);
    }

    const kill = Boolean(left?.fist || right?.fist);

    let reset = false;
    if (left?.open && right?.open) {
      this.bothOpenMs += dt * 1000;
      if (this.bothOpenMs > 520) {
        reset = true;
        this.bothOpenMs = 0;
      }
    } else {
      this.bothOpenMs = 0;
    }

    const sceneDelta = this.detectSceneSwipe({ t, dt, left });

    this.state = {
      t,
      dt,

      hands,

      rightX: expSlew(this.state.rightX, nextRightX, dt, 0.06),
      rightY: expSlew(this.state.rightY, nextRightY, dt, 0.06),
      rightPinch: expSlew(this.state.rightPinch, nextRightPinch, dt, 0.05),
      rightSpeed: expSlew(this.state.rightSpeed, nextRightSpeed, dt, 0.10),

      leftX: expSlew(this.state.leftX, nextLeftX, dt, 0.06),
      leftY: expSlew(this.state.leftY, nextLeftY, dt, 0.06),
      leftPinch: expSlew(this.state.leftPinch, nextLeftPinch, dt, 0.05),
      leftSpeed: expSlew(this.state.leftSpeed, nextLeftSpeed, dt, 0.10),

      build: expSlew(this.state.build, build, dt, 0.08),

      kill,

      events: {
        reset,
        sceneDelta
      }
    };

    return this.state;
  }

  private detectSceneSwipe(input: { t: number; dt: number; left?: HandPose }): -1 | 0 | 1 {
    const { t, dt, left } = input;

    if (!left || !left.open) {
      this.leftWristPrevX = null;
      this.leftWristVelX = expSlew(this.leftWristVelX, 0, dt, 0.05);
      return 0;
    }

    const x = left.wrist.x;
    if (this.leftWristPrevX == null) {
      this.leftWristPrevX = x;
      return 0;
    }

    const vx = (x - this.leftWristPrevX) / Math.max(1e-6, dt);
    this.leftWristPrevX = x;

    this.leftWristVelX = expSlew(this.leftWristVelX, vx, dt, 0.05);

    const cooldownMs = 850;
    if (t - this.lastSceneTriggerT < cooldownMs) return 0;

    const threshold = 0.9;
    if (Math.abs(this.leftWristVelX) > threshold) {
      this.lastSceneTriggerT = t;
      return this.leftWristVelX > 0 ? 1 : -1;
    }

    return 0;
  }
}
