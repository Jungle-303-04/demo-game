import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export const GAME_OPERATION_SUBJECTS = [
  "GitRevisionObserved",
  "ManifestRendered",
  "ReleasePolicyEvaluated",
  "CanaryScheduled",
  "CanaryReady",
  "ValidationLoadStarted",
  "MetricGateEvaluated",
  "PromotionBlocked",
  "PromotionApproved",
  "SnapshotSaveStarted",
  "SnapshotSaveCompleted",
  "SnapshotSaveCoalesced",
  "SnapshotBacklogDetected",
  "MemoryPressureObserved",
  "ContainerOOMKilled",
  "EvidenceBundleSealed",
  "RoomCandidateScheduled",
  "RoomCandidateReady",
  "RoomSnapshotSeeded",
  "RoomJournalCaughtUp",
  "RoomChecksumMatched",
  "RoomChecksumMismatched",
  "RoomEpochFenced",
  "RoomGatewayCutover",
  "RoomInputReplayCompleted",
  "RoomPostVerificationCompleted",
  "RoomOldPodDrained",
  "RoomHandoffFailed",
  "SafePrMerged",
  "GitOpsRevisionObserved",
  "RolloutWaveStarted",
  "RolloutWaveCompleted",
  "RolloutWaveBlocked",
  "PostVerificationCompleted",
] as const;

export type GameOperationSubject = typeof GAME_OPERATION_SUBJECTS[number];

export interface GameOperationEvent {
  event_id: string;
  subject: GameOperationSubject;
  source: string;
  workspace_id: string;
  correlation_id: string;
  causation_id?: string;
  created_at: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export interface OperationEventTransport {
  /** Must resolve only after the event is durably accepted. */
  persist(event: GameOperationEvent): Promise<void>;
}

export interface OperationEventQuery {
  operationId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface ReadableOperationEventTransport extends OperationEventTransport {
  read(query?: OperationEventQuery): Promise<GameOperationEvent[]>;
  /** Returns the complete bounded local retention window for outbox recovery. */
  readRetained(): Promise<GameOperationEvent[]>;
}

const normalizeEventQuery = (query: OperationEventQuery = {}): Required<OperationEventQuery> => {
  const afterSequence = query.afterSequence ?? 0;
  const limit = query.limit ?? 200;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("invalid_event_cursor");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid_event_limit");
  return { operationId: query.operationId ?? "", afterSequence, limit };
};

const selectEvents = (events: GameOperationEvent[], query: OperationEventQuery = {}): GameOperationEvent[] => {
  const normalized = normalizeEventQuery(query);
  return events
    .filter((event) => (!normalized.operationId || event.correlation_id === normalized.operationId)
      && event.sequence > normalized.afterSequence)
    // Cursor reads must return the first page after the cursor. Returning the
    // newest page would create an unrecoverable gap whenever more than `limit`
    // events accumulated while a consumer was disconnected.
    .slice(0, normalized.limit)
    .map((event) => structuredClone(event));
};

const OPSIA_SUBJECTS: Partial<Record<GameOperationSubject, string>> = {
  ReleasePolicyEvaluated: "release.policy.evaluated",
  CanaryScheduled: "canary.scheduled",
  CanaryReady: "canary.ready",
  ValidationLoadStarted: "validation_load.started",
  MetricGateEvaluated: "metric_gate.evaluated",
  PromotionBlocked: "promotion.blocked",
  PromotionApproved: "promotion.approved",
  SnapshotSaveStarted: "snapshot.save.started",
  SnapshotSaveCompleted: "snapshot.save.completed",
  SnapshotSaveCoalesced: "snapshot.save.coalesced",
  SnapshotBacklogDetected: "snapshot.backlog.detected",
  MemoryPressureObserved: "memory_pressure.observed",
  ContainerOOMKilled: "container.oom_killed",
  EvidenceBundleSealed: "evidence.bundle.sealed",
  RoomCandidateScheduled: "room.candidate.scheduled",
  RoomCandidateReady: "room.candidate.ready",
  RoomSnapshotSeeded: "room.snapshot.seeded",
  RoomJournalCaughtUp: "room.journal.caught_up",
  RoomChecksumMatched: "room.checksum.matched",
  RoomChecksumMismatched: "room.checksum.mismatched",
  RoomEpochFenced: "room.epoch.fenced",
  RoomGatewayCutover: "room.gateway.cutover",
  RoomInputReplayCompleted: "room.input_replay.completed",
  RoomPostVerificationCompleted: "room.post_verification.completed",
  RoomOldPodDrained: "room.old_pod.drained",
  RoomHandoffFailed: "room.handoff.failed",
  SafePrMerged: "safe_pr.merged",
  GitOpsRevisionObserved: "gitops.revision.observed",
  RolloutWaveStarted: "rollout.wave.started",
  RolloutWaveCompleted: "rollout.wave.completed",
  RolloutWaveBlocked: "rollout.wave.blocked",
  PostVerificationCompleted: "post_verification.completed",
};

const OPSIA_COMMON_FIELDS = new Set([
  "operation_id", "operation_sequence", "workflow_run_id", "application_id",
  "workspace_id", "cluster_id", "namespace", "git_revision", "status", "observed_at",
  "room_id", "resource_ref", "room_epoch", "server_tick", "reason_code", "evidence_ids",
  "unavailable_reason", "details",
]);

const OPSIA_SUBJECT_FIELDS: Partial<Record<GameOperationSubject, readonly string[]>> = {
  ReleasePolicyEvaluated: ["policy_name", "decision"],
  CanaryScheduled: ["canary_id"],
  CanaryReady: ["canary_id", "ready_replicas", "desired_replicas"],
  ValidationLoadStarted: ["session_count", "bot_count"],
  MetricGateEvaluated: ["metric_name", "observed_value", "threshold_value", "comparator", "passed"],
  PromotionBlocked: ["gate_name"], PromotionApproved: ["gate_name"],
  SnapshotSaveStarted: ["pod_uid", "queue_depth"],
  SnapshotSaveCompleted: ["pod_uid", "duration_ms", "state_checksum", "payload_bytes", "memory_bytes"],
  SnapshotSaveCoalesced: ["coalesced_count", "pending_requests"],
  SnapshotBacklogDetected: ["inflight_saves", "pending_saves", "oldest_age_ms", "backlog_threshold"],
  MemoryPressureObserved: ["working_set_bytes", "memory_limit_bytes"],
  ContainerOOMKilled: ["pod_uid", "container_name", "exit_code", "restart_count"],
  EvidenceBundleSealed: ["bundle_id", "evidence_count"],
  RoomCandidateScheduled: ["candidate_revision"], RoomCandidateReady: ["readiness_probe"],
  RoomSnapshotSeeded: ["state_checksum", "payload_bytes"],
  RoomJournalCaughtUp: ["active_tick", "candidate_tick", "lag_ticks"],
  RoomChecksumMatched: ["state_checksum"],
  RoomChecksumMismatched: ["expected_checksum", "actual_checksum"],
  RoomEpochFenced: ["old_epoch"], RoomGatewayCutover: ["sessions"],
  RoomInputReplayCompleted: ["replayed_inputs"],
  RoomPostVerificationCompleted: ["session_continuity", "state_checksum"],
  RoomOldPodDrained: ["drain_duration_ms"],
  RoomHandoffFailed: ["failed_stage", "rollback"],
  SafePrMerged: ["pr_url", "merge_commit_sha"],
  GitOpsRevisionObserved: ["observed_revision", "desired_revision"],
  RolloutWaveStarted: ["wave_number", "total_waves"],
  RolloutWaveCompleted: ["wave_number", "total_waves"],
  RolloutWaveBlocked: ["wave_number", "failed_stage"],
  PostVerificationCompleted: ["passed", "checks"],
};

const normalizedResourceRef = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (!["kind", "name", "uid"].every((key) => typeof input[key] === "string" && String(input[key]).length > 0)) {
    return undefined;
  }
  return {
    kind: input.kind,
    name: input.name,
    uid: input.uid,
    ...(input.resource_version || input.resourceVersion
      ? { resource_version: input.resource_version ?? input.resourceVersion }
      : {}),
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
  };
};

export const toOpsiaGameOperationEvent = (event: GameOperationEvent): Record<string, unknown> => {
  const subject = OPSIA_SUBJECTS[event.subject];
  if (!subject) throw new Error(`opsia_subject_not_supported:${event.subject}`);
  const allowed = new Set([...OPSIA_COMMON_FIELDS, ...(OPSIA_SUBJECT_FIELDS[event.subject] ?? [])]);
  const payload: Record<string, unknown> = {};
  const details: Record<string, unknown> = event.payload.details && typeof event.payload.details === "object"
    ? structuredClone(event.payload.details as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (key === "resource_ref") {
      const resource = normalizedResourceRef(value);
      if (resource) payload.resource_ref = resource;
    } else if (allowed.has(key) && key !== "details" && value !== undefined) {
      payload[key] = structuredClone(value);
    } else if (key !== "details" && value !== undefined) {
      details[key] = structuredClone(value);
    }
  }
  payload.evidence_ids ??= [];
  payload.details = details;
  for (const required of [
    "operation_id", "operation_sequence", "workflow_run_id", "application_id", "workspace_id",
    "cluster_id", "namespace", "git_revision", "status", "observed_at",
  ]) {
    if (payload[required] === undefined || payload[required] === "") {
      throw new Error(`opsia_event_required_field_missing:${required}`);
    }
  }
  return {
    event_id: event.event_id,
    subject,
    source: event.source,
    workspace_id: event.workspace_id,
    correlation_id: event.correlation_id,
    ...(event.causation_id ? { causation_id: event.causation_id } : {}),
    created_at: event.created_at,
    payload,
    schema_version: 1,
  };
};

export class MemoryOperationEventTransport implements ReadableOperationEventTransport {
  readonly events: GameOperationEvent[] = [];
  async persist(event: GameOperationEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
  async read(query: OperationEventQuery = {}): Promise<GameOperationEvent[]> {
    return selectEvents(this.events, query);
  }
  async readRetained(): Promise<GameOperationEvent[]> {
    return this.events.map((event) => structuredClone(event));
  }
}

/**
 * Local event authority used by the orchestrator. Redis Streams preserves the
 * producer order across process restarts; downstream Opsia delivery can retry
 * by event_id without ever becoming part of the gameplay transaction.
 */
export class RedisOperationEventTransport implements ReadableOperationEventTransport {
  private readonly client: RedisClientType;
  private connectPromise?: Promise<void>;

  constructor(
    redisUrl: string,
    private readonly stream = "opsia:game-operation-events",
    private readonly maxEntries = 10_000,
  ) {
    if (!redisUrl) throw new Error("operation_event_redis_url_required");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 100) {
      throw new Error("operation_event_stream_limit_invalid");
    }
    this.client = createClient({ url: redisUrl });
    this.client.on("error", (error) => {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "operation_event_redis_error", detail: { message: String(error) } })}\n`);
    });
  }

  private async connect(): Promise<void> {
    if (this.client.isOpen) return;
    this.connectPromise ??= this.client.connect().then(() => undefined).finally(() => {
      this.connectPromise = undefined;
    });
    await this.connectPromise;
  }

  async persist(event: GameOperationEvent): Promise<void> {
    await this.connect();
    await this.client.xAdd(this.stream, "*", { event: JSON.stringify(event) });
    // Trimming is deliberately after the durable append. A trim failure may
    // retain extra history but must not turn an accepted XADD into a failed
    // publish. Otherwise the publisher could reuse its sequence even though
    // the first event is already visible to cursor readers.
    try {
      await this.client.xTrim(this.stream, "MAXLEN", this.maxEntries, { strategyModifier: "~" });
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        level: "warn",
        event: "operation_event_stream_trim_failed",
        detail: { message: String(error) },
      })}\n`);
    }
  }

  async read(query: OperationEventQuery = {}): Promise<GameOperationEvent[]> {
    normalizeEventQuery(query);
    return selectEvents(await this.readAllEvents(), query);
  }

  async readRetained(): Promise<GameOperationEvent[]> {
    return (await this.readAllEvents()).map((event) => structuredClone(event));
  }

  private async readAllEvents(): Promise<GameOperationEvent[]> {
    await this.connect();
    const entries = await this.client.xRange(this.stream, "-", "+");
    const events: GameOperationEvent[] = [];
    for (const entry of entries) {
      const serialized = entry.message.event;
      if (!serialized) continue;
      try {
        const parsed = JSON.parse(serialized) as GameOperationEvent;
        if (parsed && typeof parsed.event_id === "string" && typeof parsed.sequence === "number") events.push(parsed);
      } catch {
        // A malformed legacy entry remains auditable in Redis but must not
        // prevent newer, valid operation events from being queried.
      }
    }
    return events;
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}

export class HttpOperationEventTransport implements OperationEventTransport {
  constructor(
    private readonly endpoint: string,
    private readonly agentToken?: string,
  ) {}

  async persist(event: GameOperationEvent): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.agentToken ? { "x-agent-token": this.agentToken } : {}),
      },
      body: JSON.stringify(toOpsiaGameOperationEvent(event)),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`operation_event_persist_failed:${response.status}`);
  }
}

/**
 * Persists to the local authority first, then relays remotely without making a
 * transient projection outage roll back an otherwise healthy game handoff.
 */
export class OutboxOperationEventTransport implements OperationEventTransport {
  private readonly pending = new Map<string, GameOperationEvent>();
  private relayRunning = false;
  private relayError?: string;
  private retryTimer?: NodeJS.Timeout;
  private retryDelayMs = 1_000;

  constructor(
    private readonly durable: OperationEventTransport,
    private readonly relay: OperationEventTransport,
  ) {}

  async persist(event: GameOperationEvent): Promise<void> {
    await this.durable.persist(event);
    this.pending.set(event.event_id, structuredClone(event));
    this.kickRelay();
  }

  /**
   * Re-enqueues locally durable events after an orchestrator restart. Opsia's
   * event_id deduplication makes replay safe when a previous ACK was lost.
   */
  replay(events: readonly GameOperationEvent[]): void {
    for (const event of events) this.pending.set(event.event_id, structuredClone(event));
    this.kickRelay();
  }

  private kickRelay(): void {
    if (this.relayRunning || this.retryTimer || this.pending.size === 0) return;
    this.relayRunning = true;
    void this.drain().finally(() => {
      this.relayRunning = false;
      // persist()/replay() can enqueue after drain observed an empty map but
      // before this finally callback. Their kick sees relayRunning=true, so
      // re-check here to avoid a permanently stranded outbox entry.
      this.kickRelay();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const entry = this.pending.entries().next().value as [string, GameOperationEvent] | undefined;
      if (!entry) return;
      try {
        await this.relay.persist(entry[1]);
        this.pending.delete(entry[0]);
        this.relayError = undefined;
        this.retryDelayMs = 1_000;
      } catch (error) {
        this.relayError = error instanceof Error ? error.message : "operation_event_relay_failed";
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.kickRelay();
        }, delay);
        this.retryTimer.unref?.();
        return;
      }
    }
  }

  status(): { relayError?: string; pending: number } {
    return { relayError: this.relayError, pending: this.pending.size };
  }
}

export interface OperationEventContext {
  operationId: string;
  workspaceId: string;
  workflowRunId?: string;
  applicationId?: string;
  source?: string;
}

/**
 * Creates a strictly ordered causation chain and persists each event before
 * notifying local projections. UI state therefore never gets ahead of the
 * operation event authority.
 */
export class OperationEventPublisher {
  private readonly sequenceByOperation = new Map<string, number>();
  private readonly tailByOperation = new Map<string, string>();
  private readonly listeners = new Set<(event: GameOperationEvent) => void>();
  private publishTail: Promise<void> = Promise.resolve();

  constructor(private readonly transport: OperationEventTransport) {}

  subscribe(listener: (event: GameOperationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(
    context: OperationEventContext,
    subject: GameOperationSubject,
    payload: Record<string, unknown>,
  ): Promise<GameOperationEvent> {
    let resolveEvent!: (event: GameOperationEvent) => void;
    let rejectEvent!: (error: unknown) => void;
    const result = new Promise<GameOperationEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    this.publishTail = this.publishTail.then(async () => {
      const sequence = (this.sequenceByOperation.get(context.operationId) ?? 0) + 1;
      const event: GameOperationEvent = {
        event_id: `evt_${randomUUID()}`,
        subject,
        source: context.source ?? "demo-game/room-orchestrator",
        workspace_id: context.workspaceId,
        correlation_id: context.operationId,
        causation_id: this.tailByOperation.get(context.operationId),
        created_at: new Date().toISOString(),
        sequence,
        payload: structuredClone({
          ...payload,
          operation_id: context.operationId,
          operation_sequence: sequence,
          workspace_id: context.workspaceId,
          observed_at: payload.observed_at ?? new Date().toISOString(),
        }),
      };
      // Reserve the producer position before I/O. A connection can fail after
      // Redis accepted XADD but before its response reaches us; sequence reuse
      // is unsafe for `sequence > cursor` readers, whereas a gap is harmless.
      this.sequenceByOperation.set(context.operationId, sequence);
      this.tailByOperation.set(context.operationId, event.event_id);
      await this.transport.persist(event);
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch (error) {
          // Projection/UI listeners are best-effort consumers of the durable
          // authority. Their failure must not roll a healthy room back.
          process.stderr.write(`${JSON.stringify({
            level: "error",
            event: "operation_event_listener_failed",
            detail: { eventId: event.event_id, message: String(error) },
          })}\n`);
        }
      }
      resolveEvent(event);
    }).catch((error) => {
      rejectEvent(error);
    });
    return result;
  }
}
