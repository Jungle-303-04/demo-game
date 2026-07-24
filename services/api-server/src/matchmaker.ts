import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { withControlToken } from "../../control-plane-auth.js";
import type { RoomRegistryRecord } from "../../room-orchestrator/src/registry.js";
type StructuredLog = {
  level: "info" | "warn" | "error";
  event: string;
  timestamp: string;
  namespace: string;
  resource_kind: string;
  resource_name: string;
  service: string;
  sli: string;
  symptom: string;
  outcome: "accepted" | "rejected";
  reason?: string;
  room_id?: string;
  capacity_per_second: number;
  duration_ms: number;
  detail?: Record<string, unknown>;
};

export interface RoomDirectory { list(): Promise<RoomRegistryRecord[]>; }

type TelemetryIdentity = {
  namespace: string;
  resourceKind: string;
  resourceName: string;
  service: string;
  sli: string;
  symptom: string;
};

const telemetryIdentity = (): TelemetryIdentity => {
  const resourceName = process.env.OPSIA_WORKLOAD_NAME ?? "api-server";
  return {
    namespace: process.env.POD_NAMESPACE ?? "sandbox",
    resourceKind: process.env.OPSIA_RESOURCE_KIND ?? "Deployment",
    resourceName,
    service: process.env.OPSIA_SERVICE_NAME ?? resourceName,
    sli: process.env.OPSIA_SLI_NAME ?? "admission",
    symptom: process.env.OPSIA_SLI_SYMPTOM ?? "admission_failure",
  };
};

export class HttpRoomDirectory implements RoomDirectory {
  constructor(private readonly orchestratorUrl: string, private readonly controlToken = "") {}
  async list(): Promise<RoomRegistryRecord[]> {
    const response = await fetch(`${this.orchestratorUrl}/rooms`, withControlToken({
      signal: AbortSignal.timeout(1_500),
    }, this.controlToken));
    if (!response.ok) throw new Error(`room_registry_unavailable:${response.status}`);
    const records = (await response.json() as { rooms: RoomRegistryRecord[] }).rooms;
    return Promise.all(records.map(async (room): Promise<RoomRegistryRecord> => {
      if (room.status === "inactive" || room.status === "ended") return room;
      try {
        const summaryResponse = await fetch(`${room.endpoint}/summary`, { signal: AbortSignal.timeout(1_000) });
        if (!summaryResponse.ok) return { ...room, status: "inactive", players: 0, alive: 0 };
        const summary = await summaryResponse.json() as {
          status?: string;
          players?: number;
          alive?: number;
          joinLocked?: boolean;
        };
        return {
          ...room,
          status: summary.status === "running" ? "running" : "waiting",
          players: Number(summary.players ?? 0),
          alive: Number(summary.alive ?? 0),
          joinLocked: room.joinLocked === true || summary.joinLocked === true,
        };
      } catch {
        return { ...room, status: "inactive", players: 0, alive: 0 };
      }
    }));
  }
}

export class Matchmaker {
  readonly registry = new Registry();
  private readonly attempts: Array<{ at: number; failed: boolean }> = [];
  private readonly admittedAt: number[] = [];
  private readonly identity = telemetryIdentity();
  private readonly requests = new Counter({ name: "find_game_requests_total", help: "Matchmaking requests", labelNames: ["outcome"] as const, registers: [this.registry] });
  private readonly failureRatio = new Gauge({ name: "find_game_fail_ratio", help: "Recent matchmaking failure ratio", registers: [this.registry] });
  private readonly opsiaFailureRatio = new Gauge({
    name: "opsia_sli_failure_ratio",
    help: "Standardized workload SLI failure ratio for Opsia/Kyro correlation",
    labelNames: [
      "namespace",
      "resource_kind",
      "resource_name",
      "service",
      "sli",
      "symptom",
    ] as const,
    registers: [this.registry],
  });
  private readonly opsiaRequests = new Counter({
    name: "opsia_sli_requests_total",
    help: "Standardized workload SLI request count for Opsia/Kyro verification",
    labelNames: [
      "namespace",
      "resource_kind",
      "resource_name",
      "service",
      "sli",
      "symptom",
      "outcome",
    ] as const,
    registers: [this.registry],
  });
  private readonly inflight = new Gauge({ name: "find_game_inflight", help: "Matchmaking requests currently executing", registers: [this.registry] });
  private readonly capacity = new Gauge({ name: "find_game_capacity_per_second", help: "Configured admission capacity for this API process", registers: [this.registry] });
  private readonly duration = new Histogram({
    name: "find_game_request_duration_seconds",
    help: "Matchmaking request duration by terminal outcome",
    labelNames: ["outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3],
    registers: [this.registry],
  });

  constructor(private readonly directory: RoomDirectory, private readonly maxPerSecond = 25, private readonly now: () => number = Date.now, private readonly log: (entry: StructuredLog) => void = () => undefined) {
    this.capacity.set(maxPerSecond);
    this.opsiaFailureRatio.labels(
      this.identity.namespace,
      this.identity.resourceKind,
      this.identity.resourceName,
      this.identity.service,
      this.identity.sli,
      this.identity.symptom,
    ).set(0);
  }

  async findGame(sessionId: string, nickname: string, requestedRoomId?: string): Promise<RoomRegistryRecord> {
    const startedAt = performance.now();
    this.inflight.inc();
    const now = this.now();
    const attempt = { at: now, failed: false };
    this.attempts.push(attempt);
    this.trimAttempts(now);
    this.updateFailureRatio();
    try {
      const recentAdmitted = this.admittedAt.filter((at) => at > now - 1_000);
      this.admittedAt.splice(0, this.admittedAt.length, ...recentAdmitted);
      if (recentAdmitted.length >= this.maxPerSecond) {
        return this.reject(sessionId, nickname, "rate_limited", attempt, startedAt);
      }

      // Reserve capacity before the directory probe. Rejected requests remain
      // in the failure window, but do not consume another second of capacity.
      this.admittedAt.push(now);
      let listed: RoomRegistryRecord[];
      try {
        listed = await this.directory.list();
      } catch {
        return this.reject(sessionId, nickname, "directory_unavailable", attempt, startedAt);
      }
      const rooms = listed.filter((room) =>
        room.status === "running"
        && room.joinLocked !== true
        && Number(room.players) < Number(room.spec?.maxPlayers ?? 100)
      );
      if (rooms.length === 0) {
        return this.reject(
          sessionId,
          nickname,
          requestedRoomId ? "room_unavailable" : "no_room",
          attempt,
          startedAt,
        );
      }
      const room = requestedRoomId
        ? rooms.find((candidate) => candidate.roomId === requestedRoomId)
        : [...rooms].sort((a, b) => a.players - b.players || a.ordinal - b.ordinal)[0];
      if (!room) {
        return this.reject(
          sessionId,
          nickname,
          requestedRoomId ? "room_unavailable" : "no_room",
          attempt,
          startedAt,
        );
      }
      this.requests.labels("accepted").inc();
      this.opsiaRequests.labels(
        this.identity.namespace,
        this.identity.resourceKind,
        this.identity.resourceName,
      this.identity.service,
      this.identity.sli,
      this.identity.symptom,
      "success",
      ).inc();
      const durationMs = performance.now() - startedAt;
      this.duration.labels("accepted").observe(durationMs / 1_000);
      this.logAdmission({
        level: "info",
        event: "find_game_admitted",
        outcome: "accepted",
        roomId: room.roomId,
        durationMs,
      });
      return room;
    } finally {
      this.inflight.dec();
    }
  }

  refreshMetrics(): void {
    this.trimAttempts(this.now());
    this.updateFailureRatio();
  }

  private reject(
    sessionId: string,
    nickname: string,
    reason: string,
    attempt: { at: number; failed: boolean },
    startedAt: number,
  ): never {
    attempt.failed = true;
    this.updateFailureRatio();
    this.requests.labels(reason).inc();
    this.opsiaRequests.labels(
      this.identity.namespace,
      this.identity.resourceKind,
      this.identity.resourceName,
      this.identity.service,
      this.identity.sli,
      this.identity.symptom,
      "failure",
    ).inc();
    const durationMs = performance.now() - startedAt;
    this.duration.labels(reason).observe(durationMs / 1_000);
    this.logAdmission({
      level: "warn",
      event: "find_game_rejected",
      outcome: "rejected",
      reason,
      durationMs,
    });
    throw new Error(`find_game_rejected:${reason}`);
  }

  private updateFailureRatio(): void {
    const total = this.attempts.length;
    const ratio = total ? this.attempts.filter((entry) => entry.failed).length / total : 0;
    this.failureRatio.set(ratio);
    this.opsiaFailureRatio.labels(
      this.identity.namespace,
      this.identity.resourceKind,
      this.identity.resourceName,
      this.identity.service,
      this.identity.sli,
      this.identity.symptom,
    ).set(ratio);
  }

  private logAdmission(input: {
    level: StructuredLog["level"];
    event: string;
    outcome: StructuredLog["outcome"];
    reason?: string;
    roomId?: string;
    durationMs: number;
  }): void {
    this.log({
      level: input.level,
      event: input.event,
      timestamp: new Date(this.now()).toISOString(),
      namespace: this.identity.namespace,
      resource_kind: this.identity.resourceKind,
      resource_name: this.identity.resourceName,
      service: this.identity.service,
      sli: this.identity.sli,
      symptom: this.identity.symptom,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.roomId ? { room_id: input.roomId } : {}),
      capacity_per_second: this.maxPerSecond,
      duration_ms: Number(input.durationMs.toFixed(3)),
    });
  }

  private trimAttempts(now: number): void {
    this.attempts.splice(
      0,
      this.attempts.length,
      ...this.attempts.filter((entry) => entry.at > now - 1_000),
    );
  }
}
