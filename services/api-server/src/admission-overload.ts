export interface AdmissionOverloadStatus {
  armed: boolean;
  tripped: boolean;
  recentRequests: number;
  thresholdRequests: number;
  windowMs: number;
  trippedAt?: string;
}

export interface AdmissionOverloadFuseOptions {
  thresholdRequests?: number;
  windowMs?: number;
  now?: () => number;
  onTrip: (status: AdmissionOverloadStatus) => void;
}

const boundedInteger = (value: number, minimum: number, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_invalid`);
  return value;
};

/**
 * One-shot, explicitly armed failure fuse for the admission server demo.
 * Ordinary traffic never trips it. Once armed, real HTTP admission requests
 * must cross the configured rolling-window threshold before the process is
 * failed by the injected callback.
 */
export class AdmissionOverloadFuse {
  private readonly thresholdRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly onTrip: (status: AdmissionOverloadStatus) => void;
  private requestTimes: number[] = [];
  private armed = false;
  private tripped = false;
  private trippedAtMs: number | undefined;

  constructor(options: AdmissionOverloadFuseOptions) {
    this.thresholdRequests = boundedInteger(
      options.thresholdRequests ?? 35,
      2,
      10_000,
      "admission_overload_threshold",
    );
    this.windowMs = boundedInteger(options.windowMs ?? 1_000, 100, 60_000, "admission_overload_window");
    this.now = options.now ?? Date.now;
    this.onTrip = options.onTrip;
  }

  arm(): AdmissionOverloadStatus {
    this.requestTimes = [];
    this.armed = true;
    this.tripped = false;
    this.trippedAtMs = undefined;
    return this.status();
  }

  disarm(): AdmissionOverloadStatus {
    this.requestTimes = [];
    this.armed = false;
    return this.status();
  }

  observeRequest(): AdmissionOverloadStatus {
    if (!this.armed || this.tripped) return this.status();
    const now = this.now();
    this.requestTimes.push(now);
    const cutoff = now - this.windowMs;
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] <= cutoff) {
      this.requestTimes.shift();
    }
    if (this.requestTimes.length >= this.thresholdRequests) {
      this.tripped = true;
      this.armed = false;
      this.trippedAtMs = now;
      const status = this.status();
      this.onTrip(status);
      return status;
    }
    return this.status();
  }

  status(): AdmissionOverloadStatus {
    const now = this.now();
    const cutoff = now - this.windowMs;
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] <= cutoff) {
      this.requestTimes.shift();
    }
    return {
      armed: this.armed,
      tripped: this.tripped,
      recentRequests: this.requestTimes.length,
      thresholdRequests: this.thresholdRequests,
      windowMs: this.windowMs,
      ...(this.trippedAtMs === undefined ? {} : { trippedAt: new Date(this.trippedAtMs).toISOString() }),
    };
  }
}
