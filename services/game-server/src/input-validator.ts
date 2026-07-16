import type { InputPacket, InputResult, Vec2 } from "./types.js";

export interface InputPolicy {
  maxInputsPerSecond: number;
  maxDelta: number;
}

export const LENIENT_POLICY: InputPolicy = { maxInputsPerSecond: 40, maxDelta: 1.2 };
export const STRICT_POLICY: InputPolicy = { maxInputsPerSecond: 20, maxDelta: 0.8 };

interface SessionInputWindow {
  timestamps: number[];
  lastSequence: number;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export class InputValidator {
  private readonly windows = new Map<string, SessionInputWindow>();

  constructor(private readonly policy: InputPolicy, private readonly strictMode: boolean) {}

  validate(sessionId: string, input: InputPacket, now: number): InputResult {
    if (!Number.isInteger(input.sequence) || !isFiniteNumber(input.dx) || !isFiniteNumber(input.dy)) {
      return { accepted: false, reason: "malformed", kick: this.strictMode };
    }

    const magnitude = Math.hypot(input.dx, input.dy);
    if (magnitude > this.policy.maxDelta) {
      return { accepted: false, reason: "movement", kick: this.strictMode };
    }

    const window = this.windows.get(sessionId) ?? { timestamps: [], lastSequence: -1 };
    window.timestamps = window.timestamps.filter((timestamp) => timestamp > now - 1_000);
    if (input.sequence <= window.lastSequence || window.timestamps.length >= this.policy.maxInputsPerSecond) {
      window.timestamps.push(now);
      this.windows.set(sessionId, window);
      return { accepted: false, reason: "rate", kick: this.strictMode };
    }

    window.timestamps.push(now);
    window.lastSequence = input.sequence;
    this.windows.set(sessionId, window);
    return { accepted: true, kick: false };
  }

  forget(sessionId: string): void {
    this.windows.delete(sessionId);
  }
}

export const applyDelta = (position: Vec2, input: InputPacket): Vec2 => ({
  x: Math.max(0, Math.min(100, position.x + input.dx)),
  y: Math.max(0, Math.min(100, position.y + input.dy)),
});
