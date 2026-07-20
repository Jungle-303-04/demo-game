import { randomUUID } from "node:crypto";
import {
  type GameOperationEvent,
  type OperationEventContext,
  OperationEventPublisher,
} from "./events.js";

export const CANARY_ROOM_ID = "canary-room";

export interface CanaryValidationTarget {
  canaryId: string;
  roomId: string;
  endpoint: string;
  revision: string;
  redisKeyPrefix: string;
  redisDatabase: number;
  workflowRunId?: string;
  applicationId?: string;
}

export interface CanaryIsolationPolicy {
  roomId: typeof CANARY_ROOM_ID;
  endpointOrigin: string;
  redisKeyPrefix: string;
  redisDatabase: number;
  liveRedisDatabases: readonly number[];
}

export const DEFAULT_CANARY_ISOLATION_POLICY: CanaryIsolationPolicy = Object.freeze({
  roomId: CANARY_ROOM_ID,
  endpointOrigin: "http://canary-room:8001",
  redisKeyPrefix: "room:canary-room:",
  redisDatabase: 1,
  liveRedisDatabases: Object.freeze([0]),
});

export interface KubernetesTerminationStatus {
  reason: string;
  exitCode: number;
  finishedAt?: string;
}

export interface KubernetesContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  terminated?: KubernetesTerminationStatus;
  lastTerminated?: KubernetesTerminationStatus;
}

export interface KubernetesEventObservation {
  uid: string;
  reason: string;
  type?: string;
  message?: string;
  observedAt?: string;
  involvedObjectUid?: string;
}

export interface CanaryPodObservation {
  observedAt: string;
  pod: {
    kind: "Pod";
    name: string;
    uid: string;
    resourceVersion?: string;
    phase: string;
    /** Immutable identity observed from Pod labels/annotations. */
    canaryId: string;
    /** Build revision observed from the Pod image/deployment metadata. */
    revision: string;
    /** Immutable digest parsed from the game container's runtime imageID. */
    imageDigest: string;
  };
  readyReplicas: number;
  desiredReplicas: number;
  containers: readonly KubernetesContainerStatus[];
  events: readonly KubernetesEventObservation[];
  isolation: {
    roomId: string;
    fleet: string;
    publicEnabled: boolean;
    matchmakingEnabled: boolean;
    redisKeyPrefix: string;
    redisDatabase: number;
  };
  /** Resource limit read from the observed Pod spec, not a guessed value. */
  memoryLimitBytes?: number;
}

export interface KubernetesCanaryObservationSource {
  observe(input: {
    namespace: string;
    canaryId: string;
    roomId: typeof CANARY_ROOM_ID;
    signal: AbortSignal;
  }): Promise<CanaryPodObservation>;
}

export interface CanaryMetricsScrape {
  observedAt: string;
  url: string;
  body: string;
}

export interface CanaryMetricsSource {
  scrape(input: {
    endpoint: string;
    roomId: typeof CANARY_ROOM_ID;
    signal: AbortSignal;
  }): Promise<CanaryMetricsScrape>;
}

export interface BotValidationRun {
  jobId: string;
  botCount: number;
  sessionCount: number;
  evidenceIds?: readonly string[];
  stop(signal: AbortSignal): Promise<void>;
}

export interface BotValidationStarter {
  start(input: {
    roomId: typeof CANARY_ROOM_ID;
    botCount: number;
    intervalMs: number;
    signal: AbortSignal;
  }): Promise<BotValidationRun>;
}

type FetchLike = typeof fetch;

const metricsEndpoint = (endpoint: string): URL => {
  const url = new URL(endpoint);
  url.pathname = "/metrics";
  url.search = "";
  url.hash = "";
  return url;
};

const boundedResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("canary_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("canary_response_too_large");
        throw new Error("canary_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

/** Reads the real Prometheus exposition from the isolated game server. */
export class HttpCanaryMetricsSource implements CanaryMetricsSource {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly maxResponseBytes = 1_048_576,
  ) {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > 8_388_608) {
      throw new Error("canary_metrics_response_limit_invalid");
    }
  }

  async scrape(input: {
    endpoint: string;
    roomId: typeof CANARY_ROOM_ID;
    signal: AbortSignal;
  }): Promise<CanaryMetricsScrape> {
    const metricsUrl = metricsEndpoint(input.endpoint);
    const response = await this.fetchImpl(metricsUrl, {
      method: "GET",
      headers: { accept: "text/plain, application/openmetrics-text" },
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`canary_metrics_http_${response.status}`);
    if (response.redirected) throw new Error("canary_metrics_redirect_forbidden");
    const observedUrl = response.url ? new URL(response.url).toString() : metricsUrl.toString();
    if (observedUrl !== metricsUrl.toString()) throw new Error("canary_metrics_response_url_mismatch");
    return {
      observedAt: new Date().toISOString(),
      url: observedUrl,
      body: await boundedResponseText(response, this.maxResponseBytes),
    };
  }
}

interface BotJobResponse {
  jobId: string;
  roomId: string;
  total: number;
  completed: number;
  createdBotIds: readonly string[];
  state: "running" | "completed" | "cancelled" | "failed";
  error?: string;
}

const parseBotJobResponse = (value: unknown): BotJobResponse => {
  if (!value || typeof value !== "object") throw new Error("bot_validation_response_invalid");
  const record = value as Record<string, unknown>;
  if (
    typeof record.jobId !== "string" || record.jobId.length === 0 ||
    record.roomId !== CANARY_ROOM_ID ||
    !Number.isSafeInteger(record.total) || Number(record.total) < 1 ||
    !Number.isSafeInteger(record.completed) || Number(record.completed) < 0 ||
    Number(record.completed) > Number(record.total) || !Array.isArray(record.createdBotIds) ||
    !record.createdBotIds.every((id) => typeof id === "string" && id.length > 0) ||
    !["running", "completed", "cancelled", "failed"].includes(String(record.state))
  ) {
    throw new Error("bot_validation_response_invalid");
  }
  return {
    jobId: record.jobId,
    roomId: record.roomId,
    total: Number(record.total),
    completed: Number(record.completed),
    createdBotIds: record.createdBotIds,
    state: record.state as BotJobResponse["state"],
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
};

export interface HttpBotValidationStarterOptions {
  maxResponseBytes?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const defaultAbortableSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("bot_validation_aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("bot_validation_aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/** Starts and cleans up a bounded Bot Runner job; it never accepts a game endpoint. */
export class HttpBotValidationStarter implements BotValidationStarter {
  private readonly baseUrl: URL;
  private readonly maxResponseBytes: number;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(
    endpoint: string,
    private readonly controlToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    options: HttpBotValidationStarterOptions = {},
  ) {
    this.baseUrl = new URL(endpoint);
    if (!/^https?:$/.test(this.baseUrl.protocol) || !this.baseUrl.hostname) {
      throw new Error("bot_validation_endpoint_invalid");
    }
    if (!controlToken) throw new Error("bot_validation_control_token_required");
    this.maxResponseBytes = options.maxResponseBytes ?? 262_144;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxPolls = options.maxPolls ?? 240;
    this.sleep = options.sleep ?? defaultAbortableSleep;
    if (
      !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 1_048_576 || !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 0 || this.pollIntervalMs > 5_000 ||
      !Number.isSafeInteger(this.maxPolls) || this.maxPolls < 1 || this.maxPolls > 1_000
    ) {
      throw new Error("bot_validation_options_invalid");
    }
  }

  private async getJob(jobId: string, signal: AbortSignal): Promise<BotJobResponse> {
    const url = new URL(`/bots/jobs/${encodeURIComponent(jobId)}`, this.baseUrl);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.controlToken}` },
      redirect: "error",
      signal,
    });
    if (!response.ok || response.redirected) throw new Error(`bot_validation_status_http_${response.status}`);
    const job = parseBotJobResponse(JSON.parse(await boundedResponseText(response, this.maxResponseBytes)));
    if (job.jobId !== jobId) throw new Error("bot_validation_job_identity_mismatch");
    return job;
  }

  private async connectedSessions(job: BotJobResponse, signal: AbortSignal): Promise<number> {
    const url = new URL("/bots", this.baseUrl);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.controlToken}` },
      redirect: "error",
      signal,
    });
    if (!response.ok || response.redirected) throw new Error(`bot_validation_bots_http_${response.status}`);
    const payload = JSON.parse(await boundedResponseText(response, this.maxResponseBytes)) as unknown;
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).bots)) {
      throw new Error("bot_validation_bots_response_invalid");
    }
    const created = new Set(job.createdBotIds);
    return ((payload as Record<string, unknown>).bots as unknown[]).filter((value) => {
      if (!value || typeof value !== "object") return false;
      const bot = value as Record<string, unknown>;
      return bot.roomId === CANARY_ROOM_ID && bot.connected === true &&
        typeof bot.id === "string" && created.has(bot.id);
    }).length;
  }

  private async cleanupJob(jobId: string, signal: AbortSignal): Promise<void> {
    const cleanupUrl = new URL(`/bots/jobs/${encodeURIComponent(jobId)}/cleanup`, this.baseUrl);
    const cleanup = await this.fetchImpl(cleanupUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.controlToken}` },
      redirect: "error",
      signal,
    });
    if (!cleanup.ok || cleanup.redirected) throw new Error(`bot_validation_cleanup_http_${cleanup.status}`);
    const cleanupPayload = JSON.parse(await boundedResponseText(cleanup, this.maxResponseBytes)) as unknown;
    if (
      !cleanupPayload || typeof cleanupPayload !== "object" ||
      (cleanupPayload as Record<string, unknown>).cleaned !== true
    ) {
      throw new Error("bot_validation_cleanup_incomplete");
    }
  }

  async start(input: {
    roomId: typeof CANARY_ROOM_ID;
    botCount: number;
    intervalMs: number;
    signal: AbortSignal;
  }): Promise<BotValidationRun> {
    if (input.roomId !== CANARY_ROOM_ID) throw new Error("bot_validation_live_room_forbidden");
    const startUrl = new URL("/bots/jobs", this.baseUrl);
    const response = await this.fetchImpl(startUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        room: CANARY_ROOM_ID,
        count: input.botCount,
        intervalMs: input.intervalMs,
        mode: "normal",
      }),
      redirect: "error",
      signal: input.signal,
    });
    if (response.status !== 202 || response.redirected) {
      throw new Error(`bot_validation_start_http_${response.status}`);
    }
    let job = parseBotJobResponse(JSON.parse(await boundedResponseText(response, this.maxResponseBytes)));
    if (job.total !== input.botCount) throw new Error("bot_validation_requested_count_mismatch");

    try {
      let connected = 0;
      for (let attempt = 0; attempt < this.maxPolls; attempt++) {
        if (attempt > 0) job = await this.getJob(job.jobId, input.signal);
        if (job.total !== input.botCount) throw new Error("bot_validation_requested_count_mismatch");
        if (job.state === "failed") throw new Error(`bot_validation_job_failed:${job.error ?? "unknown"}`);
        if (job.state === "cancelled") throw new Error("bot_validation_job_cancelled");
        if (
          job.state === "completed" && job.completed === job.total &&
          job.createdBotIds.length === job.total
        ) {
          connected = await this.connectedSessions(job, input.signal);
          if (connected === job.total) break;
        }
        if (attempt + 1 >= this.maxPolls) throw new Error("bot_validation_load_not_ready");
        await this.sleep(this.pollIntervalMs, input.signal);
      }
      if (connected !== job.total) throw new Error("bot_validation_load_not_ready");

      return {
        jobId: job.jobId,
        botCount: job.createdBotIds.length,
        sessionCount: connected,
        evidenceIds: [`bot-job:${job.jobId}`],
        stop: (signal) => this.cleanupJob(job.jobId, signal),
      };
    } catch (error) {
      try {
        await this.cleanupJob(job.jobId, AbortSignal.timeout(5_000));
      } catch (cleanupError) {
        const reason = error instanceof Error ? error.message : "bot_validation_start_failed";
        const cleanupReason = cleanupError instanceof Error ? cleanupError.message : "bot_validation_cleanup_failed";
        throw new Error(`${reason};cleanup:${cleanupReason}`);
      }
      throw error;
    }
  }
}

export interface CanaryValidationOptions {
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  maxReadinessPolls?: number;
  validationPollIntervalMs?: number;
  validationPolls?: number;
  requestTimeoutMs?: number;
  botLoadTimeoutMs?: number;
  botCount?: number;
  botIntervalMs?: number;
  maxSnapshotInflight?: number;
  maxSnapshotPending?: number;
  maxSnapshotWriteDurationSeconds?: number;
  maxSnapshotFailuresTotal?: number;
  maxSnapshotTimeoutsTotal?: number;
  memoryPressureRatio?: number;
  maxMemoryRatio?: number;
}

interface ResolvedCanaryValidationOptions {
  readinessTimeoutMs: number;
  readinessPollIntervalMs: number;
  maxReadinessPolls: number;
  validationPollIntervalMs: number;
  validationPolls: number;
  requestTimeoutMs: number;
  botLoadTimeoutMs: number;
  botCount: number;
  botIntervalMs: number;
  maxSnapshotInflight: number;
  maxSnapshotPending: number;
  maxSnapshotWriteDurationSeconds: number;
  maxSnapshotFailuresTotal: number;
  maxSnapshotTimeoutsTotal: number;
  memoryPressureRatio: number;
  maxMemoryRatio: number;
}

const resolveOptions = (input: CanaryValidationOptions): ResolvedCanaryValidationOptions => {
  const options: ResolvedCanaryValidationOptions = {
    readinessTimeoutMs: input.readinessTimeoutMs ?? 60_000,
    readinessPollIntervalMs: input.readinessPollIntervalMs ?? 2_000,
    maxReadinessPolls: input.maxReadinessPolls ?? 30,
    validationPollIntervalMs: input.validationPollIntervalMs ?? 2_000,
    validationPolls: input.validationPolls ?? 5,
    requestTimeoutMs: input.requestTimeoutMs ?? 3_000,
    botLoadTimeoutMs: input.botLoadTimeoutMs ?? 60_000,
    botCount: input.botCount ?? 10,
    botIntervalMs: input.botIntervalMs ?? 300,
    maxSnapshotInflight: input.maxSnapshotInflight ?? 1,
    maxSnapshotPending: input.maxSnapshotPending ?? 0,
    maxSnapshotWriteDurationSeconds: input.maxSnapshotWriteDurationSeconds ?? 2,
    maxSnapshotFailuresTotal: input.maxSnapshotFailuresTotal ?? 0,
    maxSnapshotTimeoutsTotal: input.maxSnapshotTimeoutsTotal ?? 0,
    memoryPressureRatio: input.memoryPressureRatio ?? 0.8,
    maxMemoryRatio: input.maxMemoryRatio ?? 0.9,
  };
  const integerBounds: ReadonlyArray<[keyof ResolvedCanaryValidationOptions, number, number]> = [
    ["readinessTimeoutMs", 1, 300_000],
    ["readinessPollIntervalMs", 0, 30_000],
    ["maxReadinessPolls", 1, 1_000],
    ["validationPollIntervalMs", 0, 30_000],
    ["validationPolls", 1, 1_000],
    ["requestTimeoutMs", 1, 30_000],
    ["botLoadTimeoutMs", 1, 300_000],
    ["botCount", 1, 500],
    ["botIntervalMs", 50, 5_000],
  ];
  for (const [key, minimum, maximum] of integerBounds) {
    const value = options[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`canary_option_invalid:${key}`);
    }
  }
  for (const key of [
    "maxSnapshotInflight",
    "maxSnapshotPending",
    "maxSnapshotFailuresTotal",
    "maxSnapshotTimeoutsTotal",
  ] as const) {
    const value = options[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`canary_option_invalid:${key}`);
  }
  if (!Number.isFinite(options.maxSnapshotWriteDurationSeconds) || options.maxSnapshotWriteDurationSeconds < 0) {
    throw new Error("canary_option_invalid:maxSnapshotWriteDurationSeconds");
  }
  if (
    !Number.isFinite(options.memoryPressureRatio) || options.memoryPressureRatio <= 0 ||
    options.memoryPressureRatio > 1 || !Number.isFinite(options.maxMemoryRatio) ||
    options.maxMemoryRatio <= 0 || options.maxMemoryRatio > 1 ||
    options.memoryPressureRatio > options.maxMemoryRatio
  ) {
    throw new Error("canary_option_invalid:memory_ratio");
  }
  return options;
};

interface PrometheusSample {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

const parseLabels = (input: string): Record<string, string> => {
  const labels: Record<string, string> = {};
  const expression = /([a-zA-Z_][a-zA-Z\d_]*)="((?:\\.|[^"\\])*)"(?:,|$)/gy;
  let cursor = 0;
  while (cursor < input.length) {
    expression.lastIndex = cursor;
    const match = expression.exec(input);
    if (!match || match.index !== cursor) throw new Error("canary_metrics_labels_invalid");
    labels[match[1]!] = match[2]!
      .replaceAll("\\n", "\n")
      .replaceAll("\\\"", "\"")
      .replaceAll("\\\\", "\\");
    cursor = expression.lastIndex;
  }
  return labels;
};

const parsePrometheus = (body: string): PrometheusSample[] => {
  const samples: PrometheusSample[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z\d_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({
      name: match[1]!,
      labels: match[2] ? parseLabels(match[2]) : {},
      value,
    });
  }
  return samples;
};

const metricValue = (
  samples: readonly PrometheusSample[],
  name: string,
  roomId: string,
  allowUnlabelled: boolean,
): number | undefined => {
  const values = samples
    .filter((sample) => {
      if (sample.name !== name) return false;
      if (sample.labels.room === roomId) return true;
      return allowUnlabelled && sample.labels.room === undefined;
    })
    .map((sample) => sample.value);
  return values.length ? Math.max(...values) : undefined;
};

interface MetricObservation {
  observedAt: string;
  snapshotInflight?: number;
  snapshotPending?: number;
  snapshotWriteDurationSeconds?: number;
  snapshotFailuresTotal?: number;
  snapshotTimeoutsTotal?: number;
  snapshotCircuitOpen?: number;
  snapshotHandoffEnabled?: number;
  memoryWorkingSetBytes?: number;
  memoryMetricName?: string;
}

const metricObservation = (scrape: CanaryMetricsScrape, roomId: string): MetricObservation => {
  if (!Number.isFinite(Date.parse(scrape.observedAt))) throw new Error("canary_metrics_timestamp_invalid");
  const samples = parsePrometheus(scrape.body);
  const containerMemory = metricValue(samples, "container_memory_working_set_bytes", roomId, true);
  const processMemory = metricValue(samples, "process_resident_memory_bytes", roomId, true);
  const observation: MetricObservation = {
    observedAt: scrape.observedAt,
    snapshotInflight: metricValue(samples, "game_snapshot_inflight", roomId, false),
    snapshotPending: metricValue(samples, "game_snapshot_pending", roomId, false),
    snapshotWriteDurationSeconds: metricValue(samples, "game_snapshot_write_duration_seconds", roomId, false),
    snapshotFailuresTotal: metricValue(samples, "game_snapshot_failures_total", roomId, false),
    snapshotTimeoutsTotal: metricValue(samples, "game_snapshot_timeouts_total", roomId, false),
    snapshotCircuitOpen: metricValue(samples, "game_snapshot_circuit_open", roomId, false),
    snapshotHandoffEnabled: metricValue(samples, "game_snapshot_handoff_enabled", roomId, false),
    memoryWorkingSetBytes: containerMemory ?? processMemory,
    memoryMetricName: containerMemory !== undefined
      ? "container_memory_working_set_bytes"
      : processMemory !== undefined
      ? "process_resident_memory_bytes"
      : undefined,
  };
  for (const [key, value] of Object.entries(observation)) {
    if (typeof value === "number" && value < 0) throw new Error(`canary_metric_invalid:${key}`);
  }
  for (const key of [
    "snapshotInflight",
    "snapshotPending",
    "snapshotFailuresTotal",
    "snapshotTimeoutsTotal",
    "snapshotCircuitOpen",
    "snapshotHandoffEnabled",
    "memoryWorkingSetBytes",
  ] as const) {
    const value = observation[key];
    if (value !== undefined && !Number.isSafeInteger(value)) throw new Error(`canary_metric_invalid:${key}`);
  }
  for (const key of ["snapshotCircuitOpen", "snapshotHandoffEnabled"] as const) {
    const value = observation[key];
    if (value !== undefined && value !== 0 && value !== 1) throw new Error(`canary_metric_invalid:${key}`);
  }
  return observation;
};

const requiredMetricNames: ReadonlyArray<[keyof MetricObservation, string]> = [
  ["snapshotInflight", "game_snapshot_inflight"],
  ["snapshotPending", "game_snapshot_pending"],
  ["snapshotWriteDurationSeconds", "game_snapshot_write_duration_seconds"],
  ["snapshotFailuresTotal", "game_snapshot_failures_total"],
  ["snapshotTimeoutsTotal", "game_snapshot_timeouts_total"],
  ["snapshotCircuitOpen", "game_snapshot_circuit_open"],
  ["snapshotHandoffEnabled", "game_snapshot_handoff_enabled"],
  ["memoryWorkingSetBytes", "container_memory_working_set_bytes|process_resident_memory_bytes"],
];

interface OomObservation {
  podUid: string;
  containerName: string;
  exitCode: number;
  restartCount: number;
  eventUid?: string;
  observedAt: string;
}

const observedOom = (observation: CanaryPodObservation): OomObservation | undefined => {
  for (const container of observation.containers) {
    const termination = container.terminated?.reason === "OOMKilled"
      ? container.terminated
      : container.lastTerminated?.reason === "OOMKilled"
      ? container.lastTerminated
      : undefined;
    if (!termination) continue;
    const event = observation.events.find((candidate) =>
      candidate.reason === "OOMKilled" && candidate.involvedObjectUid === observation.pod.uid
    );
    return {
      podUid: observation.pod.uid,
      containerName: container.name,
      exitCode: termination.exitCode,
      restartCount: container.restartCount,
      eventUid: event?.uid,
      observedAt: [termination.finishedAt, event?.observedAt, observation.observedAt]
        .find((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!))) ?? observation.observedAt,
    };
  }
  return undefined;
};

const validatePodObservation = (observation: CanaryPodObservation): void => {
  if (
    observation.pod.kind !== "Pod" || !observation.pod.name || !observation.pod.uid ||
    !observation.pod.phase || !observation.pod.canaryId || !observation.pod.revision ||
    !/^sha256:[a-f\d]{64}$/.test(observation.pod.imageDigest) ||
    !Number.isFinite(Date.parse(observation.observedAt)) ||
    !Number.isSafeInteger(observation.readyReplicas) || observation.readyReplicas < 0 ||
    !Number.isSafeInteger(observation.desiredReplicas) || observation.desiredReplicas < 0 ||
    observation.readyReplicas > observation.desiredReplicas || !observation.isolation ||
    !Array.isArray(observation.containers) || !Array.isArray(observation.events)
  ) {
    throw new Error("canary_kubernetes_observation_invalid");
  }
  if (
    observation.memoryLimitBytes !== undefined &&
    (!Number.isSafeInteger(observation.memoryLimitBytes) || observation.memoryLimitBytes <= 0)
  ) {
    throw new Error("canary_kubernetes_memory_limit_invalid");
  }
  for (const container of observation.containers) {
    if (
      !container.name || typeof container.ready !== "boolean" ||
      !Number.isSafeInteger(container.restartCount) || container.restartCount < 0
    ) {
      throw new Error("canary_kubernetes_container_status_invalid");
    }
    for (const termination of [container.terminated, container.lastTerminated]) {
      if (!termination) continue;
      if (
        !termination.reason || !Number.isSafeInteger(termination.exitCode) || termination.exitCode < 0 ||
        (termination.finishedAt !== undefined && !Number.isFinite(Date.parse(termination.finishedAt)))
      ) {
        throw new Error("canary_kubernetes_termination_status_invalid");
      }
    }
  }
  for (const event of observation.events) {
    if (
      !event.uid || !event.reason ||
      (event.observedAt !== undefined && !Number.isFinite(Date.parse(event.observedAt)))
    ) {
      throw new Error("canary_kubernetes_event_invalid");
    }
  }
};

const podReady = (observation: CanaryPodObservation): boolean =>
  observation.pod.phase === "Running" &&
  observation.desiredReplicas > 0 &&
  observation.readyReplicas === observation.desiredReplicas &&
  observation.containers.length > 0 &&
  observation.containers.every((container) => container.ready);

const resourceRef = (observation: CanaryPodObservation, endpoint: string): Record<string, unknown> => ({
  kind: observation.pod.kind,
  name: observation.pod.name,
  uid: observation.pod.uid,
  ...(observation.pod.resourceVersion ? { resourceVersion: observation.pod.resourceVersion } : {}),
  endpoint,
});

const endpointOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password ||
    (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash
  ) {
    throw new Error("canary_endpoint_invalid");
  }
  return url.origin;
};

const validatePolicy = (policy: CanaryIsolationPolicy): void => {
  if (policy.roomId !== CANARY_ROOM_ID) throw new Error("canary_policy_room_invalid");
  const url = new URL(endpointOrigin(policy.endpointOrigin));
  if (url.hostname !== CANARY_ROOM_ID) {
    throw new Error("canary_policy_endpoint_not_isolated");
  }
  if (policy.redisKeyPrefix !== `room:${CANARY_ROOM_ID}:`) {
    throw new Error("canary_policy_redis_prefix_not_isolated");
  }
  if (
    !Number.isSafeInteger(policy.redisDatabase) || policy.redisDatabase < 0 ||
    policy.liveRedisDatabases.includes(policy.redisDatabase)
  ) {
    throw new Error("canary_policy_redis_database_not_isolated");
  }
};

const validateTarget = (target: CanaryValidationTarget, policy: CanaryIsolationPolicy): void => {
  if (!target.canaryId || !target.revision) throw new Error("canary_target_identity_required");
  if (target.roomId !== CANARY_ROOM_ID || target.roomId !== policy.roomId) {
    throw new Error("canary_live_room_forbidden");
  }
  if (endpointOrigin(target.endpoint) !== endpointOrigin(policy.endpointOrigin)) {
    throw new Error("canary_live_endpoint_forbidden");
  }
  if (target.redisKeyPrefix !== policy.redisKeyPrefix) {
    throw new Error("canary_redis_prefix_not_isolated");
  }
  if (
    target.redisDatabase !== policy.redisDatabase ||
    policy.liveRedisDatabases.includes(target.redisDatabase)
  ) {
    throw new Error("canary_redis_database_not_isolated");
  }
};

const observedIsolationError = (
  observation: CanaryPodObservation,
  target: CanaryValidationTarget,
  policy: CanaryIsolationPolicy,
): string | undefined => {
  const isolation = observation.isolation;
  if (observation.pod.canaryId !== target.canaryId) return "observed_canary_id_mismatch";
  if (observation.pod.revision !== target.revision) return "observed_canary_revision_mismatch";
  if (isolation.roomId !== CANARY_ROOM_ID || isolation.roomId !== target.roomId) {
    return "observed_canary_room_mismatch";
  }
  if (isolation.fleet !== "canary") return "observed_canary_fleet_mismatch";
  if (isolation.publicEnabled) return "observed_canary_public_enabled";
  if (isolation.matchmakingEnabled) return "observed_canary_matchmaking_enabled";
  if (isolation.redisKeyPrefix !== policy.redisKeyPrefix) return "observed_canary_redis_prefix_mismatch";
  if (
    isolation.redisDatabase !== policy.redisDatabase ||
    policy.liveRedisDatabases.includes(isolation.redisDatabase)
  ) {
    return "observed_canary_redis_database_mismatch";
  }
  return undefined;
};

interface MetricGate {
  metricName: string;
  observedValue: number;
  thresholdValue: number;
  comparator: "<=" | ">=";
  passed: boolean;
  details?: Record<string, unknown>;
}

export interface CanaryValidationResult {
  operationId: string;
  approved: boolean;
  reasonCode?: string;
  unavailableReason?: string;
  evidenceBundleId: string;
  evidenceIds: readonly string[];
  podUid?: string;
  imageDigest?: string;
}

export interface CanaryValidationDependencies {
  events: OperationEventPublisher;
  metrics: CanaryMetricsSource;
  kubernetes: KubernetesCanaryObservationSource;
  bots: BotValidationStarter;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/**
 * Safety-first Canary controller. It only reads real observations and returns a
 * blocked decision whenever a required value is absent; it never synthesizes a
 * metric, OOM, or process failure.
 */
export class CanaryValidationCoordinator {
  private readonly options: ResolvedCanaryValidationOptions;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private activeOperation?: string;

  constructor(
    private readonly dependencies: CanaryValidationDependencies,
    options: CanaryValidationOptions = {},
    private readonly isolation: CanaryIsolationPolicy = DEFAULT_CANARY_ISOLATION_POLICY,
    private readonly workspaceId = "demo-game",
    private readonly clusterId = "game-server",
    private readonly namespace = "sandbox",
  ) {
    validatePolicy(isolation);
    this.options = resolveOptions(options);
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = dependencies.now ?? Date.now;
  }

  private async bounded<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label}_timeout`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async observePod(target: CanaryValidationTarget): Promise<CanaryPodObservation> {
    const observation = await this.bounded("canary_kubernetes_observation", (signal) =>
      this.dependencies.kubernetes.observe({
        namespace: this.namespace,
        canaryId: target.canaryId,
        roomId: CANARY_ROOM_ID,
        signal,
      })
    );
    validatePodObservation(observation);
    return observation;
  }

  async validate(target: CanaryValidationTarget, requestedOperationId?: string): Promise<CanaryValidationResult> {
    validateTarget(target, this.isolation);
    if (this.activeOperation) throw new Error("canary_validation_already_running");
    const operationId = requestedOperationId ?? `op_${randomUUID()}`;
    this.activeOperation = operationId;
    try {
      return await this.validateOperation(target, operationId);
    } finally {
      this.activeOperation = undefined;
    }
  }

  private async validateOperation(
    target: CanaryValidationTarget,
    operationId: string,
  ): Promise<CanaryValidationResult> {
    const context: OperationEventContext = {
      operationId,
      workspaceId: this.workspaceId,
      workflowRunId: target.workflowRunId ?? operationId,
      applicationId: target.applicationId ?? "demo-game",
    };
    const common = {
      workflow_run_id: context.workflowRunId,
      application_id: context.applicationId,
      cluster_id: this.clusterId,
      namespace: this.namespace,
      room_id: target.roomId,
      git_revision: target.revision,
    };
    const startedAt = new Date(this.now()).toISOString();
    const evidenceIds: string[] = [];
    const unavailableReasons: string[] = [];
    const publish = async (
      subject: Parameters<OperationEventPublisher["publish"]>[1],
      payload: Record<string, unknown>,
    ): Promise<GameOperationEvent> => {
      const event = await this.dependencies.events.publish(context, subject, payload);
      evidenceIds.push(event.event_id);
      return event;
    };

    await publish("CanaryScheduled", {
      ...common,
      canary_id: target.canaryId,
      status: "running",
      details: {
        endpoint: target.endpoint,
        redis_key_prefix: target.redisKeyPrefix,
        redis_database: target.redisDatabase,
      },
    });

    let latestPod: CanaryPodObservation | undefined;
    let observedImageDigest: string | undefined;
    let readinessFailure: string | undefined;
    const readinessStarted = this.now();
    for (let attempt = 0; attempt < this.options.maxReadinessPolls; attempt++) {
      if (this.now() - readinessStarted >= this.options.readinessTimeoutMs) break;
      try {
        latestPod = await this.observePod(target);
        readinessFailure = undefined;
        if (observedImageDigest && latestPod.pod.imageDigest !== observedImageDigest) {
          readinessFailure = "observed_canary_image_digest_changed";
          break;
        }
        observedImageDigest = latestPod.pod.imageDigest;
        const isolationError = observedIsolationError(latestPod, target, this.isolation);
        if (isolationError) {
          readinessFailure = isolationError;
          break;
        }
        const oom = observedOom(latestPod);
        if (oom) {
          if (!oom.eventUid) unavailableReasons.push("kubernetes_oom_event_uid_missing");
          await this.publishOom(publish, common, latestPod, target, oom);
          await this.publishGate(publish, common, "container_oom_killed", 1, 0, "<=", false, {
            observation: "kubernetes_container_status",
          });
          return this.finalize(
            context,
            common,
            target,
            false,
            "container_oom_killed",
            evidenceIds,
            unavailableReasons,
            startedAt,
            latestPod,
          );
        }
        if (podReady(latestPod)) break;
      } catch (error) {
        readinessFailure = error instanceof Error ? error.message : "canary_kubernetes_observation_unavailable";
      }
      if (attempt + 1 < this.options.maxReadinessPolls && this.options.readinessPollIntervalMs > 0) {
        await this.sleep(this.options.readinessPollIntervalMs);
      }
    }

    if (!latestPod || !podReady(latestPod) || readinessFailure) {
      const unavailable = readinessFailure ?? "canary_readiness_timeout";
      const isolationFailure = unavailable.startsWith("observed_canary_");
      if (isolationFailure) {
        await this.publishGate(publish, common, "canary_isolation_policy", 0, 1, ">=", false, {
          observation: "kubernetes_isolation_policy",
          reason: unavailable,
        });
      } else if (latestPod && !readinessFailure) {
        await this.publishGate(
          publish,
          common,
          "canary_readiness",
          latestPod.readyReplicas,
          latestPod.desiredReplicas,
          ">=",
          false,
        );
      } else {
        unavailableReasons.push(unavailable);
        await this.publishAvailabilityGate(
          publish,
          common,
          latestPod ? latestPod.readyReplicas : null,
          latestPod ? latestPod.desiredReplicas : null,
          "canary_readiness",
          unavailable,
        );
      }
      return this.finalize(
        context,
        common,
        target,
        false,
        isolationFailure
          ? "canary_isolation_mismatch"
          : readinessFailure
          ? "canary_observation_unavailable"
          : "canary_readiness_timeout",
        evidenceIds,
        unavailableReasons,
        startedAt,
        latestPod,
      );
    }

    await publish("CanaryReady", {
      ...common,
      canary_id: target.canaryId,
      ready_replicas: latestPod.readyReplicas,
      desired_replicas: latestPod.desiredReplicas,
      resource_ref: resourceRef(latestPod, target.endpoint),
      status: "completed",
    });

    let botRun: BotValidationRun | undefined;
    let cleanupAttempted = false;
    try {
      try {
        botRun = await this.bounded("canary_validation_load_start", (signal) =>
          this.dependencies.bots.start({
            roomId: CANARY_ROOM_ID,
            botCount: this.options.botCount,
            intervalMs: this.options.botIntervalMs,
            signal,
          }),
          this.options.botLoadTimeoutMs,
        );
        if (
          !botRun.jobId || !Number.isSafeInteger(botRun.botCount) || botRun.botCount < 1 ||
          !Number.isSafeInteger(botRun.sessionCount) || botRun.sessionCount < 0 ||
          botRun.botCount !== this.options.botCount || botRun.sessionCount !== botRun.botCount
        ) {
          throw new Error("canary_validation_load_response_invalid");
        }
        evidenceIds.push(...(botRun.evidenceIds ?? []));
        await publish("ValidationLoadStarted", {
          ...common,
          resource_ref: resourceRef(latestPod, target.endpoint),
          session_count: botRun.sessionCount,
          bot_count: botRun.botCount,
          status: "running",
          details: { bot_job_id: botRun.jobId },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "canary_validation_load_unavailable";
        unavailableReasons.push(reason);
        await this.publishAvailabilityGate(publish, common, null, null, "validation_load", reason);
        return this.finalize(
          context,
          common,
          target,
          false,
          "validation_load_unavailable",
          evidenceIds,
          unavailableReasons,
          startedAt,
          latestPod,
        );
      }

      const observations: MetricObservation[] = [];
      let hardFailure: string | undefined;
      let oom: OomObservation | undefined;
      let backlog: {
        firstObservedAt: number;
        lastObservedAt: number;
        maxInflight: number;
        maxPending: number;
        pod: CanaryPodObservation;
      } | undefined;
      let memoryPressure: {
        workingSetBytes: number;
        memoryLimitBytes: number;
        metricSource?: string;
        observedAt: string;
        pod: CanaryPodObservation;
      } | undefined;

      for (let attempt = 0; attempt < this.options.validationPolls; attempt++) {
        try {
          latestPod = await this.observePod(target);
          if (latestPod.pod.imageDigest !== observedImageDigest) {
            hardFailure = "observed_canary_image_digest_changed";
            break;
          }
          const isolationError = observedIsolationError(latestPod, target, this.isolation);
          if (isolationError) {
            hardFailure = isolationError;
            break;
          }
          oom = observedOom(latestPod);
          if (oom) {
            if (!oom.eventUid) unavailableReasons.push("kubernetes_oom_event_uid_missing");
            hardFailure = "container_oom_killed";
            break;
          }
          if (!podReady(latestPod)) {
            hardFailure = "canary_became_unready";
            break;
          }

          const scrape = await this.bounded("canary_metrics_scrape", (signal) =>
            this.dependencies.metrics.scrape({
              endpoint: target.endpoint,
              roomId: CANARY_ROOM_ID,
              signal,
            })
          );
          if (new URL(scrape.url).toString() !== metricsEndpoint(target.endpoint).toString()) {
            throw new Error("canary_metrics_source_endpoint_mismatch");
          }
          const observation = metricObservation(scrape, target.roomId);
          observations.push(observation);
          const missing = requiredMetricNames
            .filter(([key]) => observation[key] === undefined)
            .map(([, name]) => name);
          if (missing.length) unavailableReasons.push(...missing.map((name) => `metric_missing:${name}`));
          if (!latestPod.memoryLimitBytes || !Number.isFinite(latestPod.memoryLimitBytes)) {
            unavailableReasons.push("kubernetes_memory_limit_missing");
          }

          const inflight = observation.snapshotInflight;
          const pending = observation.snapshotPending;
          if (
            inflight !== undefined && pending !== undefined &&
            (inflight > this.options.maxSnapshotInflight || pending > this.options.maxSnapshotPending)
          ) {
            const observedAt = Date.parse(observation.observedAt);
            backlog = backlog
              ? {
                ...backlog,
                lastObservedAt: observedAt,
                maxInflight: Math.max(backlog.maxInflight, inflight),
                maxPending: Math.max(backlog.maxPending, pending),
              }
              : {
                firstObservedAt: observedAt,
                lastObservedAt: observedAt,
                maxInflight: inflight,
                maxPending: pending,
                pod: latestPod,
              };
          }

          if (
            observation.memoryWorkingSetBytes !== undefined &&
            latestPod.memoryLimitBytes &&
            observation.memoryWorkingSetBytes / latestPod.memoryLimitBytes >= this.options.memoryPressureRatio
          ) {
            if (!memoryPressure || observation.memoryWorkingSetBytes > memoryPressure.workingSetBytes) {
              memoryPressure = {
                workingSetBytes: observation.memoryWorkingSetBytes,
                memoryLimitBytes: latestPod.memoryLimitBytes,
                metricSource: observation.memoryMetricName,
                observedAt: observation.observedAt,
                pod: latestPod,
              };
            }
          }
        } catch (error) {
          unavailableReasons.push(
            error instanceof Error ? error.message : "canary_validation_observation_unavailable",
          );
          break;
        }

        if (attempt + 1 < this.options.validationPolls && this.options.validationPollIntervalMs > 0) {
          await this.sleep(this.options.validationPollIntervalMs);
        }
      }

      if (backlog) {
        const trigger = backlog.maxPending > this.options.maxSnapshotPending ? "pending" : "inflight";
        const threshold = trigger === "pending"
          ? this.options.maxSnapshotPending
          : this.options.maxSnapshotInflight;
        await publish("SnapshotBacklogDetected", {
          ...common,
          resource_ref: resourceRef(backlog.pod, target.endpoint),
          pod_uid: backlog.pod.pod.uid,
          inflight_saves: backlog.maxInflight,
          pending_saves: backlog.maxPending,
          oldest_age_ms: Math.max(0, backlog.lastObservedAt - backlog.firstObservedAt),
          backlog_threshold: threshold,
          observed_at: new Date(backlog.firstObservedAt).toISOString(),
          status: "observed",
          reason_code: "snapshot_backlog",
          details: { trigger },
        });
      }

      if (memoryPressure) {
        await publish("MemoryPressureObserved", {
          ...common,
          resource_ref: resourceRef(memoryPressure.pod, target.endpoint),
          working_set_bytes: memoryPressure.workingSetBytes,
          memory_limit_bytes: memoryPressure.memoryLimitBytes,
          observed_at: memoryPressure.observedAt,
          status: "observed",
          details: {
            ratio: memoryPressure.workingSetBytes / memoryPressure.memoryLimitBytes,
            metric_source: memoryPressure.metricSource,
          },
        });
      }

      if (oom) await this.publishOom(publish, common, latestPod, target, oom);

      cleanupAttempted = true;
      try {
        await this.bounded("canary_validation_load_cleanup", (signal) => botRun!.stop(signal));
      } catch (error) {
        unavailableReasons.push(error instanceof Error ? error.message : "canary_validation_cleanup_unavailable");
      }

      if (oom) {
        await this.publishGate(publish, common, "container_oom_killed", 1, 0, "<=", false, {
          observation: "kubernetes_container_status",
        });
        return this.finalize(
          context,
          common,
          target,
          false,
          "container_oom_killed",
          evidenceIds,
          unavailableReasons,
          startedAt,
          latestPod,
        );
      }

      if (hardFailure) {
        const isIsolationFailure = hardFailure.startsWith("observed_canary_");
        await this.publishGate(
          publish,
          common,
          isIsolationFailure ? "canary_isolation_policy" : "canary_readiness",
          isIsolationFailure ? 0 : latestPod.readyReplicas,
          isIsolationFailure ? 1 : latestPod.desiredReplicas,
          ">=",
          false,
          {
          observation: isIsolationFailure ? "kubernetes_isolation_policy" : "kubernetes_readiness",
          reason: hardFailure,
          },
        );
        return this.finalize(
          context,
          common,
          target,
          false,
          isIsolationFailure ? "canary_isolation_mismatch" : hardFailure,
          evidenceIds,
          unavailableReasons,
          startedAt,
          latestPod,
        );
      }

      const uniqueUnavailable = [...new Set(unavailableReasons)];
      if (!observations.length || uniqueUnavailable.length) {
        const reason = uniqueUnavailable.join(",") || "canary_metrics_unavailable";
        await this.publishAvailabilityGate(publish, common, null, null, "metrics_availability", reason);
        return this.finalize(
          context,
          common,
          target,
          false,
          "metric_observation_unavailable",
          evidenceIds,
          uniqueUnavailable.length ? uniqueUnavailable : [reason],
          startedAt,
          latestPod,
        );
      }

      const gates = this.metricGates(observations, latestPod);
      for (const gate of gates) {
        await this.publishGate(
          publish,
          common,
          gate.metricName,
          gate.observedValue,
          gate.thresholdValue,
          gate.comparator,
          gate.passed,
          gate.details,
        );
      }
      const failedGate = gates.find((gate) => !gate.passed);
      return this.finalize(
        context,
        common,
        target,
        !failedGate,
        failedGate ? `metric_gate_failed:${failedGate.metricName}` : undefined,
        evidenceIds,
        unavailableReasons,
        startedAt,
        latestPod,
      );
    } finally {
      if (botRun && !cleanupAttempted) {
        await this.bounded("canary_validation_load_cleanup", (signal) => botRun!.stop(signal)).catch(() => undefined);
      }
    }
  }

  private metricGates(
    observations: readonly MetricObservation[],
    pod: CanaryPodObservation,
  ): MetricGate[] {
    const maximum = (key: keyof MetricObservation): number =>
      Math.max(...observations.map((observation) => Number(observation[key])));
    const minimum = (key: keyof MetricObservation): number =>
      Math.min(...observations.map((observation) => Number(observation[key])));
    const memoryLimit = pod.memoryLimitBytes!;
    const memoryRatio = maximum("memoryWorkingSetBytes") / memoryLimit;
    const gates: MetricGate[] = [
      {
        metricName: "game_snapshot_inflight",
        observedValue: maximum("snapshotInflight"),
        thresholdValue: this.options.maxSnapshotInflight,
        comparator: "<=",
        passed: maximum("snapshotInflight") <= this.options.maxSnapshotInflight,
      },
      {
        metricName: "game_snapshot_pending",
        observedValue: maximum("snapshotPending"),
        thresholdValue: this.options.maxSnapshotPending,
        comparator: "<=",
        passed: maximum("snapshotPending") <= this.options.maxSnapshotPending,
      },
      {
        metricName: "game_snapshot_write_duration_seconds",
        observedValue: maximum("snapshotWriteDurationSeconds"),
        thresholdValue: this.options.maxSnapshotWriteDurationSeconds,
        comparator: "<=",
        passed: maximum("snapshotWriteDurationSeconds") <= this.options.maxSnapshotWriteDurationSeconds,
      },
      {
        metricName: "game_snapshot_failures_total",
        observedValue: maximum("snapshotFailuresTotal"),
        thresholdValue: this.options.maxSnapshotFailuresTotal,
        comparator: "<=",
        passed: maximum("snapshotFailuresTotal") <= this.options.maxSnapshotFailuresTotal,
      },
      {
        metricName: "game_snapshot_timeouts_total",
        observedValue: maximum("snapshotTimeoutsTotal"),
        thresholdValue: this.options.maxSnapshotTimeoutsTotal,
        comparator: "<=",
        passed: maximum("snapshotTimeoutsTotal") <= this.options.maxSnapshotTimeoutsTotal,
      },
      {
        metricName: "game_snapshot_circuit_open",
        observedValue: maximum("snapshotCircuitOpen"),
        thresholdValue: 0,
        comparator: "<=",
        passed: maximum("snapshotCircuitOpen") <= 0,
      },
      {
        metricName: "game_snapshot_handoff_enabled",
        observedValue: minimum("snapshotHandoffEnabled"),
        thresholdValue: 1,
        comparator: ">=",
        passed: minimum("snapshotHandoffEnabled") >= 1,
      },
      {
        metricName: "canary_memory_working_set_ratio",
        observedValue: memoryRatio,
        thresholdValue: this.options.maxMemoryRatio,
        comparator: "<=",
        passed: memoryRatio <= this.options.maxMemoryRatio,
        details: {
          working_set_bytes: maximum("memoryWorkingSetBytes"),
          memory_limit_bytes: memoryLimit,
          metric_source: observations.at(-1)?.memoryMetricName,
        },
      },
    ];
    return gates;
  }

  private async publishOom(
    publish: (
      subject: Parameters<OperationEventPublisher["publish"]>[1],
      payload: Record<string, unknown>,
    ) => Promise<GameOperationEvent>,
    common: Record<string, unknown>,
    pod: CanaryPodObservation,
    target: CanaryValidationTarget,
    oom: OomObservation,
  ): Promise<void> {
    await publish("ContainerOOMKilled", {
      ...common,
      resource_ref: resourceRef(pod, target.endpoint),
      pod_uid: oom.podUid,
      container_name: oom.containerName,
      exit_code: oom.exitCode,
      restart_count: oom.restartCount,
      evidence_ids: oom.eventUid ? [oom.eventUid] : [],
      observed_at: oom.observedAt,
      status: "observed",
      reason_code: "container_oom_killed",
      details: oom.eventUid ? { kubernetes_event_uid: oom.eventUid } : {},
    });
  }

  private async publishGate(
    publish: (
      subject: Parameters<OperationEventPublisher["publish"]>[1],
      payload: Record<string, unknown>,
    ) => Promise<GameOperationEvent>,
    common: Record<string, unknown>,
    metricName: string,
    observedValue: number,
    thresholdValue: number,
    comparator: "<=" | ">=",
    passed: boolean,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await publish("MetricGateEvaluated", {
      ...common,
      metric_name: metricName,
      observed_value: observedValue,
      threshold_value: thresholdValue,
      comparator,
      passed,
      status: passed ? "completed" : "blocked",
      ...(details ? { details } : {}),
    });
  }

  private async publishAvailabilityGate(
    publish: (
      subject: Parameters<OperationEventPublisher["publish"]>[1],
      payload: Record<string, unknown>,
    ) => Promise<GameOperationEvent>,
    common: Record<string, unknown>,
    observedValue: number | null,
    thresholdValue: number | null,
    metricName: string,
    unavailableReason: string,
  ): Promise<void> {
    await publish("MetricGateEvaluated", {
      ...common,
      metric_name: metricName,
      ...(observedValue !== null ? { observed_value: observedValue } : {}),
      ...(thresholdValue !== null ? { threshold_value: thresholdValue } : {}),
      comparator: "available",
      passed: false,
      status: "blocked",
      unavailable_reason: unavailableReason,
    });
  }

  private async finalize(
    context: OperationEventContext,
    common: Record<string, unknown>,
    target: CanaryValidationTarget,
    approved: boolean,
    reasonCode: string | undefined,
    evidenceIds: string[],
    unavailableReasons: readonly string[],
    startedAt: string,
    pod?: CanaryPodObservation,
  ): Promise<CanaryValidationResult> {
    const uniqueUnavailable = [...new Set(unavailableReasons)];
    const decision = await this.dependencies.events.publish(
      context,
      approved ? "PromotionApproved" : "PromotionBlocked",
      {
        ...common,
        gate_name: "canary_validation",
        ...(pod ? { resource_ref: resourceRef(pod, target.endpoint) } : {}),
        ...(pod ? { image_digest: pod.pod.imageDigest } : {}),
        status: approved ? "completed" : "blocked",
        ...(reasonCode ? { reason_code: reasonCode } : {}),
        ...(uniqueUnavailable.length ? { unavailable_reason: uniqueUnavailable.join(",") } : {}),
        evidence_ids: [...evidenceIds],
      },
    );
    evidenceIds.push(decision.event_id);

    const bundleId = `bundle_${context.operationId}`;
    await this.dependencies.events.publish(context, "EvidenceBundleSealed", {
      ...common,
      ...(pod ? { resource_ref: resourceRef(pod, target.endpoint) } : {}),
      ...(pod ? { image_digest: pod.pod.imageDigest } : {}),
      bundle_id: bundleId,
      evidence_count: evidenceIds.length,
      evidence_ids: [...evidenceIds],
      status: "completed",
      ...(uniqueUnavailable.length ? { unavailable_reason: uniqueUnavailable.join(",") } : {}),
      details: {
        completeness: uniqueUnavailable.length ? "partial" : "complete",
        missing_reasons: uniqueUnavailable,
        observed_from: startedAt,
        observed_to: new Date(this.now()).toISOString(),
      },
    });

    return {
      operationId: context.operationId,
      approved,
      ...(reasonCode ? { reasonCode } : {}),
      ...(uniqueUnavailable.length ? { unavailableReason: uniqueUnavailable.join(",") } : {}),
      evidenceBundleId: bundleId,
      evidenceIds: [...evidenceIds],
      ...(pod ? { podUid: pod.pod.uid } : {}),
      ...(pod ? { imageDigest: pod.pod.imageDigest } : {}),
    };
  }
}
