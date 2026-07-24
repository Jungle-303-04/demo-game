import { randomUUID } from "node:crypto";

export type AdmissionLoadPhase =
  | "ramping"
  | "saturated"
  | "stopped"
  | "safety_timeout"
  | "failed";

export interface AdmissionLoadStatus {
  jobId: string;
  roomId: string;
  phase: AdmissionLoadPhase;
  startedAt: string;
  expiresAt?: string;
  targetRps: number;
  maximumRps: number;
  requests: number;
  accepted: number;
  rateLimited: number;
  rejected: number;
  requestRps: number;
  acceptedRps: number;
  rejectedRps: number;
  successRatePercent: number;
  failureRatePercent: number;
  responseP95Ms: number;
  incidentTriggered: boolean;
  saturationReason?: "failure_threshold" | "maximum_load";
  error?: string;
}

export interface AdmissionLoadService {
  start(roomId: string): AdmissionLoadStatus;
  status(jobId: string): AdmissionLoadStatus | undefined;
  stop(jobId: string): AdmissionLoadStatus;
}

interface AdmissionSample {
  at: number;
  accepted: boolean;
  rateLimited: boolean;
  durationMs: number;
}

interface AdmissionJob {
  jobId: string;
  roomId: string;
  phase: AdmissionLoadPhase;
  startedAtMs: number;
  expiresAtMs?: number;
  targetRps: number;
  maximumRps: number;
  requests: number;
  issued: number;
  accepted: number;
  rateLimited: number;
  rejected: number;
  nextRampAtMs: number;
  incidentTriggered: boolean;
  saturationReason?: "failure_threshold" | "maximum_load";
  error?: string;
  samples: AdmissionSample[];
  controller: AbortController;
}

export interface AdmissionLoadControllerOptions {
  endpoint: string;
  initialRps?: number;
  rampStepRps?: number;
  rampIntervalMs?: number;
  maximumRps?: number;
  failureThreshold?: number;
  metricWindowMs?: number;
  safetyTtlMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const boundedInteger = (value: number, minimum: number, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name}_invalid`);
  return value;
};

const percentile95 = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

const trimSlash = (value: string): string => value.replace(/\/+$/, "");
const LOAD_LOOP_INTERVAL_MS = 100;
export const ADMISSION_METRIC_WINDOW_MS = 60_000;

export class AdmissionLoadController implements AdmissionLoadService {
  private readonly endpoint: string;
  private readonly initialRps: number;
  private readonly rampStepRps: number;
  private readonly rampIntervalMs: number;
  private readonly maximumRps: number;
  private readonly failureThreshold: number;
  private readonly metricWindowMs: number;
  private readonly safetyTtlMs: number | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly jobs = new Map<string, AdmissionJob>();
  private activeJobId: string | undefined;

  constructor(options: AdmissionLoadControllerOptions) {
    const endpoint = new URL(options.endpoint);
    if (!/^https?:$/.test(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password) {
      throw new Error("admission_load_endpoint_invalid");
    }
    this.endpoint = trimSlash(endpoint.toString());
    // The presentation incident is deliberately a capacity regression, not a
    // process crash. One api-server Pod admits 25 requests/s, so a fixed 40
    // requests/s yields a visible rejection ratio; the normal two-Pod Service
    // has 50 requests/s of aggregate capacity and remains healthy.
    this.initialRps = boundedInteger(options.initialRps ?? 40, 1, 1_000, "admission_initial_rps");
    this.rampStepRps = boundedInteger(options.rampStepRps ?? 10, 1, 1_000, "admission_ramp_step_rps");
    this.rampIntervalMs = boundedInteger(options.rampIntervalMs ?? 5_000, 500, 60_000, "admission_ramp_interval_ms");
    this.maximumRps = boundedInteger(options.maximumRps ?? 40, this.initialRps, 5_000, "admission_maximum_rps");
    this.failureThreshold = options.failureThreshold ?? 0.2;
    // Kyro's canonical SLI recording rule uses
    // rate(opsia_sli_requests_total[1m]). Matching that interval here keeps
    // the operator UI and platform evidence on the same observation window.
    this.metricWindowMs = boundedInteger(
      options.metricWindowMs ?? ADMISSION_METRIC_WINDOW_MS,
      1_000,
      120_000,
      "admission_metric_window_ms",
    );
    // Operators normally stop the load after the GitOps scale-out is
    // verified. The mandatory TTL prevents an abandoned presentation from
    // applying admission pressure indefinitely.
    this.safetyTtlMs = boundedInteger(
      options.safetyTtlMs ?? 30 * 60_000,
      10_000,
      30 * 60_000,
      "admission_safety_ttl_ms",
    );
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 3_000, 100, 30_000, "admission_request_timeout_ms");
    if (this.failureThreshold <= 0 || this.failureThreshold >= 1) {
      throw new Error("admission_load_ratio_invalid");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  start(roomId: string): AdmissionLoadStatus {
    if (!/^room-\d+$/.test(roomId)) throw new Error("admission_load_room_invalid");
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    if (active && !["stopped", "safety_timeout", "failed"].includes(active.phase)) {
      throw new Error("admission_load_already_running");
    }
    const now = this.now();
    const job: AdmissionJob = {
      jobId: `admission-${randomUUID()}`,
      roomId,
      phase: "ramping",
      startedAtMs: now,
      expiresAtMs: this.safetyTtlMs ? now + this.safetyTtlMs : undefined,
      targetRps: this.initialRps,
      maximumRps: this.maximumRps,
      requests: 0,
      issued: 0,
      accepted: 0,
      rateLimited: 0,
      rejected: 0,
      nextRampAtMs: now + this.rampIntervalMs,
      incidentTriggered: false,
      samples: [],
      controller: new AbortController(),
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    void this.run(job);
    return this.publicStatus(job);
  }

  status(jobId: string): AdmissionLoadStatus | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.publicStatus(job) : undefined;
  }

  stop(jobId: string): AdmissionLoadStatus {
    const job = this.job(jobId);
    if (!job.controller.signal.aborted) job.controller.abort();
    job.phase = "stopped";
    if (this.activeJobId === jobId) this.activeJobId = undefined;
    return this.publicStatus(job);
  }

  private async run(job: AdmissionJob): Promise<void> {
    let carry = 0;
    let previous = this.now();
    try {
      while (!job.controller.signal.aborted) {
        const now = this.now();
        if (job.expiresAtMs !== undefined && now >= job.expiresAtMs) {
          job.phase = "safety_timeout";
          job.controller.abort();
          if (this.activeJobId === job.jobId) this.activeJobId = undefined;
          return;
        }
        const elapsedMs = Math.max(1, now - previous);
        previous = now;
        // Do not replay traffic debt after the event loop stalls. A load
        // generator that catches up with a large burst would manufacture a
        // different failure mode than the intended sustained 40 RPS.
        if (elapsedMs > LOAD_LOOP_INTERVAL_MS * 2.5) carry = 0;
        const effectiveElapsedMs = elapsedMs > LOAD_LOOP_INTERVAL_MS * 2.5
          ? LOAD_LOOP_INTERVAL_MS
          : elapsedMs;
        const perTickLimit = Math.max(
          1,
          Math.ceil(job.targetRps * LOAD_LOOP_INTERVAL_MS / 1_000),
        );
        carry = Math.min(
          perTickLimit,
          carry + job.targetRps * effectiveElapsedMs / 1_000,
        );
        const count = Math.floor(carry);
        carry -= count;
        for (let index = 0; index < count; index += 1) void this.issue(job);
        this.evaluateRamp(job);
        await this.sleep(LOAD_LOOP_INTERVAL_MS);
      }
    } catch (error) {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : "admission_load_failed";
      job.controller.abort();
      if (this.activeJobId === job.jobId) this.activeJobId = undefined;
    }
  }

  private async issue(job: AdmissionJob): Promise<void> {
    if (job.controller.signal.aborted) return;
    const startedAt = this.now();
    let accepted = false;
    let rateLimited = false;
    try {
      job.issued += 1;
      const sequence = job.issued;
      const response = await this.fetchImpl(`${this.endpoint}/api/find-game`, {
        method: "POST",
        // Each synthetic admission represents a different new client. Closing
        // the connection also lets the Kubernetes Service distribute the same
        // load across a newly added api-server Pod instead of pinning one pool.
        headers: { "content-type": "application/json", connection: "close" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        body: JSON.stringify({
          sessionId: `${job.jobId}-${sequence}`,
          nickname: `Admission_${sequence}`,
        }),
      });
      accepted = response.ok;
      rateLimited = response.status === 429;
    } catch {
      // A timeout or transport failure is a real rejected admission sample.
    }
    job.requests += 1;
    if (accepted) job.accepted += 1;
    else if (rateLimited) job.rateLimited += 1;
    else job.rejected += 1;
    job.samples.push({
      at: this.now(),
      accepted,
      rateLimited,
      durationMs: Math.max(0, this.now() - startedAt),
    });
    const retentionCutoff = this.now() - this.metricWindowMs * 6;
    while (job.samples[0] && job.samples[0].at < retentionCutoff) job.samples.shift();
  }

  private evaluateRamp(job: AdmissionJob): void {
    if ((job.phase !== "ramping" && job.phase !== "saturated") || this.now() < job.nextRampAtMs) return;
    const status = this.publicStatus(job);
    if (status.failureRatePercent >= this.failureThreshold * 100) {
      job.phase = "saturated";
      job.incidentTriggered = true;
      job.saturationReason = "failure_threshold";
    }
    if (job.targetRps >= job.maximumRps) {
      // Keep maximum pressure applied until the operator explicitly recovers
      // the scenario. Crossing the first failure threshold is an incident
      // signal, not a reason to stop increasing pressure.
      job.nextRampAtMs = this.now() + this.rampIntervalMs;
      return;
    }
    job.targetRps = Math.min(job.maximumRps, job.targetRps + this.rampStepRps);
    job.nextRampAtMs = this.now() + this.rampIntervalMs;
  }

  private samples(job: AdmissionJob, after = this.now() - this.metricWindowMs): AdmissionSample[] {
    return job.samples.filter((sample) => sample.at >= after);
  }

  private publicStatus(job: AdmissionJob, after?: number): AdmissionLoadStatus {
    const samples = this.samples(job, after);
    const accepted = samples.filter((sample) => sample.accepted).length;
    const rateLimited = samples.filter((sample) => sample.rateLimited).length;
    const rejected = samples.length - accepted - rateLimited;
    const windowStart = after ?? Math.max(job.startedAtMs, this.now() - this.metricWindowMs);
    const seconds = Math.max(1, (this.now() - windowStart) / 1_000);
    return {
      jobId: job.jobId,
      roomId: job.roomId,
      phase: job.phase,
      startedAt: new Date(job.startedAtMs).toISOString(),
      expiresAt: job.expiresAtMs === undefined ? undefined : new Date(job.expiresAtMs).toISOString(),
      targetRps: job.targetRps,
      maximumRps: job.maximumRps,
      requests: job.requests,
      accepted: job.accepted,
      rateLimited: job.rateLimited,
      rejected: job.rejected,
      requestRps: Number((samples.length / seconds).toFixed(1)),
      acceptedRps: Number((accepted / seconds).toFixed(1)),
      rejectedRps: Number(((rateLimited + rejected) / seconds).toFixed(1)),
      successRatePercent: Number((samples.length ? accepted / samples.length * 100 : 100).toFixed(1)),
      failureRatePercent: Number((samples.length ? (rateLimited + rejected) / samples.length * 100 : 0).toFixed(1)),
      responseP95Ms: Number(percentile95(samples.map((sample) => sample.durationMs)).toFixed(1)),
      incidentTriggered: job.incidentTriggered,
      saturationReason: job.saturationReason,
      error: job.error,
    };
  }

  private job(jobId: string): AdmissionJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("admission_load_job_not_found");
    return job;
  }
}
