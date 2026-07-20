import {
  fetchJson,
  type AdminRoom,
  type RegistryRoom,
  UpstreamError,
} from "./admin.js";

export const FAILURE_SCENARIO_IDS = [
  "admission-lock",
  "bot-surge",
  "malicious-input",
  "admission-storm",
  "process-crash",
  "pod-failure",
] as const;

export type FailureScenarioId = typeof FAILURE_SCENARIO_IDS[number];
export type FailureScenarioStatus = "starting" | "active" | "recovering" | "failed";

export interface FailureScenarioRun {
  scenarioId: FailureScenarioId;
  status: FailureScenarioStatus;
  startedAt: string;
  jobId?: string;
  autoRecoverAt?: string;
  evidence?: Record<string, unknown>;
}

export interface FailureScenarioResult {
  at: string;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface RoomFailureScenarioState {
  roomId: string;
  minimumBotsPerRoom: number;
  normalBots: number;
  hackBots: number;
  active?: FailureScenarioRun;
  lastResults: Partial<Record<FailureScenarioId, FailureScenarioResult>>;
}

export interface FailureScenarioState {
  rooms: RoomFailureScenarioState[];
  capabilities: {
    podFailure: boolean;
  };
}

export interface FailureScenarioActionResult {
  roomId: string;
  scenarioId: FailureScenarioId;
  action: "start" | "recover";
  status: "active" | "recovering" | "completed";
  message: string;
  evidence?: Record<string, unknown>;
}

interface BotSummary {
  id: string;
  roomId: string;
  mode: "normal" | "hack";
  connected: boolean;
}

interface BotInventory {
  bots: BotSummary[];
  minimumBotsPerRoom?: number;
}

interface BotJob {
  jobId: string;
  roomId: string;
  total: number;
  completed: number;
  mode: "normal" | "hack";
  state: "running" | "completed" | "cancelled" | "failed";
  createdBotIds?: string[];
  error?: string;
}

interface MutableRun extends FailureScenarioRun {
  autoRecoverAtMs?: number;
}

const ADMISSION_STORM_REQUESTS = 90;
const ADMISSION_STORM_RECOVERY_MS = 16_000;
const BOT_SURGE_SIZE = 25;
const MALICIOUS_BOT_COUNT = 3;
const SURVEV_PROTOCOL_VERSION = 1021;

export const isFailureScenarioId = (value: string): value is FailureScenarioId =>
  FAILURE_SCENARIO_IDS.some((scenarioId) => scenarioId === value);

const scenarioConflict = (active: MutableRun): UpstreamError => new UpstreamError(
  409,
  { error: "scenario_already_active", activeScenarioId: active.scenarioId },
  "scenario_already_active",
);

export class FailureScenarioController {
  private readonly activeRuns = new Map<string, MutableRun>();
  private readonly lastResults = new Map<
    string,
    Partial<Record<FailureScenarioId, FailureScenarioResult>>
  >();

  constructor(
    private readonly orchestrator: string,
    private readonly botRunner: string,
    private readonly now: () => number = Date.now,
  ) {}

  async getState(
    rooms: AdminRoom[],
    scalingAvailable: boolean,
  ): Promise<FailureScenarioState> {
    this.expireAutomaticRuns();
    const inventory = await this.botInventory();
    await Promise.all([...this.activeRuns.entries()].map(async ([roomId, run]) => {
      if (!run.jobId) return;
      const job = await fetchJson<BotJob>(
        `${this.botRunner}/bots/jobs/${encodeURIComponent(run.jobId)}`,
      ).catch(() => undefined);
      if (!job) return;
      run.status = job.state === "failed" ? "failed" : job.state === "running" ? "starting" : "active";
      run.evidence = {
        ...run.evidence,
        connected: job.completed,
        requested: job.total,
        jobState: job.state,
        error: job.error,
      };
      this.activeRuns.set(roomId, run);
    }));

    const minimumBotsPerRoom = Math.max(0, Number(inventory.minimumBotsPerRoom ?? 0));
    return {
      rooms: rooms.map((room) => {
        const roomBots = inventory.bots.filter((bot) => bot.roomId === room.id && bot.connected);
        const active = this.activeRuns.get(room.id);
        return {
          roomId: room.id,
          minimumBotsPerRoom,
          normalBots: roomBots.filter((bot) => bot.mode === "normal").length,
          hackBots: roomBots.filter((bot) => bot.mode === "hack").length,
          active: active ? this.publicRun(active) : undefined,
          lastResults: { ...(this.lastResults.get(room.id) ?? {}) },
        };
      }),
      capabilities: { podFailure: scalingAvailable },
    };
  }

  async start(
    record: RegistryRoom,
    room: AdminRoom,
    scenarioId: FailureScenarioId,
    scalingAvailable: boolean,
  ): Promise<FailureScenarioActionResult> {
    this.expireAutomaticRuns();
    const existing = this.activeRuns.get(room.id);
    if (existing) throw scenarioConflict(existing);

    const run: MutableRun = {
      scenarioId,
      status: "starting",
      startedAt: new Date(this.now()).toISOString(),
    };
    this.activeRuns.set(room.id, run);

    try {
      switch (scenarioId) {
        case "admission-lock": {
          const appliedToLivePod = await this.setJoinLocked(record, true);
          run.status = "active";
          run.evidence = { joinLocked: true, appliedToLivePod };
          return this.started(room.id, run, "신규 플레이어 입장을 차단했습니다.");
        }
        case "bot-surge": {
          const available = Math.max(0, room.maxPlayers - room.players.length - 2);
          const count = Math.min(BOT_SURGE_SIZE, available);
          if (count < 1) {
            throw new UpstreamError(409, { error: "room_has_no_bot_capacity" }, "room_has_no_bot_capacity");
          }
          const job = await this.startBotJob(room.id, count, "normal");
          run.jobId = job.jobId;
          run.status = "starting";
          run.evidence = { requestedBots: count, jobState: job.state };
          return this.started(room.id, run, `실접속 부하 봇 ${count}명을 빠르게 투입하고 있습니다.`);
        }
        case "malicious-input": {
          const job = await this.startBotJob(room.id, MALICIOUS_BOT_COUNT, "hack");
          run.jobId = job.jobId;
          run.status = "starting";
          run.evidence = {
            requestedBots: MALICIOUS_BOT_COUNT,
            inputMessagesPerBotPerSecond: 660,
            jobState: job.state,
          };
          return this.started(room.id, run, "비정상 입력을 보내는 프로토콜 클라이언트를 투입했습니다.");
        }
        case "admission-storm": {
          const evidence = await this.runAdmissionStorm(record.endpoint, room.id);
          run.status = "active";
          run.autoRecoverAtMs = this.now() + ADMISSION_STORM_RECOVERY_MS;
          run.autoRecoverAt = new Date(run.autoRecoverAtMs).toISOString();
          run.evidence = evidence;
          return this.started(
            room.id,
            run,
            "입장 API 폭주를 발생시켰습니다. 예약 슬롯과 rate limit은 16초 내 자동 복구됩니다.",
          );
        }
        case "process-crash": {
          const evidence = await fetchJson<Record<string, unknown>>(
            `${record.endpoint}/ops/failure/process-crash`,
            { method: "POST" },
            8_000,
          );
          run.status = "recovering";
          run.evidence = evidence;
          return this.started(room.id, run, "게임 child process를 종료했습니다. 자동 복구를 기다리는 중입니다.");
        }
        case "pod-failure": {
          if (!scalingAvailable) {
            throw new UpstreamError(
              409,
              { error: "pod_failure_requires_kubernetes" },
              "pod_failure_requires_kubernetes",
            );
          }
          const evidence = await fetchJson<Record<string, unknown>>(
            `${this.orchestrator}/rooms/${encodeURIComponent(room.id)}/failure`,
            { method: "POST" },
            8_000,
          );
          run.status = "recovering";
          run.evidence = evidence;
          return this.started(room.id, run, "게임 Pod를 삭제했습니다. Room Deployment 자동 복구를 기다리는 중입니다.");
        }
      }
    } catch (error) {
      this.activeRuns.delete(room.id);
      throw error;
    }
  }

  async recover(
    record: RegistryRoom,
    room: AdminRoom,
    scenarioId: FailureScenarioId,
  ): Promise<FailureScenarioActionResult> {
    this.expireAutomaticRuns();
    const run = this.activeRuns.get(room.id);
    if (!run) {
      return this.completed(room.id, scenarioId, "이미 안전 상태입니다.", { idempotent: true });
    }
    if (run.scenarioId !== scenarioId) throw scenarioConflict(run);
    run.status = "recovering";

    switch (scenarioId) {
      case "admission-lock":
        await this.setJoinLocked(record, false);
        return this.completeRun(room.id, run, "신규 플레이어 입장을 다시 허용했습니다.", { joinLocked: false });
      case "bot-surge":
      case "malicious-input": {
        if (run.jobId) {
          const cleanup = await fetchJson<Record<string, unknown>>(
            `${this.botRunner}/bots/jobs/${encodeURIComponent(run.jobId)}/cleanup`,
            { method: "POST" },
            10_000,
          );
          return this.completeRun(room.id, run, "시나리오가 만든 봇만 제거했습니다.", cleanup);
        }
        return this.completeRun(room.id, run, "정리할 시나리오 봇이 없습니다.", { killed: 0 });
      }
      case "admission-storm": {
        const retryAfterMs = Math.max(0, (run.autoRecoverAtMs ?? 0) - this.now());
        if (retryAfterMs > 0) {
          throw new UpstreamError(
            409,
            { error: "scenario_auto_recovery_pending", retryAfterMs },
            "scenario_auto_recovery_pending",
          );
        }
        return this.completeRun(room.id, run, "입장 rate limit과 예약 슬롯이 자동 복구됐습니다.");
      }
      case "process-crash": {
        await this.assertRoomRuntimeRecovered(record);
        return this.completeRun(room.id, run, "게임 process와 snapshot 연결이 정상 복구됐습니다.");
      }
      case "pod-failure": {
        if (room.status !== "running" || !room.podHealthy) {
          throw new UpstreamError(
            409,
            { error: "scenario_recovery_not_ready", roomStatus: room.status },
            "scenario_recovery_not_ready",
          );
        }
        await this.assertRoomRuntimeRecovered(record);
        return this.completeRun(room.id, run, "교체된 Pod와 snapshot 연결이 정상 복구됐습니다.");
      }
    }
  }

  private publicRun(run: MutableRun): FailureScenarioRun {
    const { autoRecoverAtMs: _autoRecoverAtMs, ...publicRun } = run;
    return { ...publicRun, evidence: publicRun.evidence ? { ...publicRun.evidence } : undefined };
  }

  private started(
    roomId: string,
    run: MutableRun,
    message: string,
  ): FailureScenarioActionResult {
    this.activeRuns.set(roomId, run);
    return {
      roomId,
      scenarioId: run.scenarioId,
      action: "start",
      status: run.status === "recovering" ? "recovering" : "active",
      message,
      evidence: run.evidence,
    };
  }

  private completeRun(
    roomId: string,
    run: MutableRun,
    message: string,
    evidence: Record<string, unknown> = run.evidence ?? {},
  ): FailureScenarioActionResult {
    this.activeRuns.delete(roomId);
    this.remember(roomId, run.scenarioId, message, evidence);
    return this.completed(roomId, run.scenarioId, message, evidence);
  }

  private completed(
    roomId: string,
    scenarioId: FailureScenarioId,
    message: string,
    evidence: Record<string, unknown> = {},
  ): FailureScenarioActionResult {
    return { roomId, scenarioId, action: "recover", status: "completed", message, evidence };
  }

  private remember(
    roomId: string,
    scenarioId: FailureScenarioId,
    message: string,
    evidence: Record<string, unknown> = {},
  ): void {
    const roomResults = this.lastResults.get(roomId) ?? {};
    roomResults[scenarioId] = {
      at: new Date(this.now()).toISOString(),
      message,
      evidence: { ...evidence },
    };
    this.lastResults.set(roomId, roomResults);
  }

  private expireAutomaticRuns(): void {
    for (const [roomId, run] of this.activeRuns) {
      if (!run.autoRecoverAtMs || this.now() < run.autoRecoverAtMs) continue;
      this.activeRuns.delete(roomId);
      this.remember(
        roomId,
        run.scenarioId,
        "입장 rate limit과 예약 슬롯이 자동 복구됐습니다.",
        run.evidence,
      );
    }
  }

  private async botInventory(): Promise<BotInventory> {
    return fetchJson<BotInventory>(`${this.botRunner}/bots`);
  }

  private async startBotJob(
    roomId: string,
    count: number,
    mode: "normal" | "hack",
  ): Promise<BotJob> {
    return fetchJson<BotJob>(`${this.botRunner}/bots/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: roomId, count, intervalMs: 50, mode }),
    }, 5_000);
  }

  private async setJoinLocked(record: RegistryRoom, locked: boolean): Promise<boolean> {
    await fetchJson(
      `${this.orchestrator}/rooms/${encodeURIComponent(record.roomId)}/join-lock`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locked }),
      },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const applied = await fetchJson(
        `${record.endpoint}/ops/join-lock/${locked}`,
        { method: "POST" },
        2_000,
      ).then(() => true, () => false);
      if (applied) return true;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async runAdmissionStorm(
    endpoint: string,
    roomId: string,
  ): Promise<Record<string, unknown>> {
    const results = await Promise.all(Array.from({ length: ADMISSION_STORM_REQUESTS }, async (_, index) => {
      try {
        const response = await fetch(`${endpoint}/api/find_game`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(3_000),
          body: JSON.stringify({
            region: "local",
            zones: ["local"],
            version: SURVEV_PROTOCOL_VERSION,
            playerCount: 1,
            autoFill: true,
            gameModeIdx: 2,
            opsiaSessionId: `scenario-storm-${roomId}-${this.now()}-${index}`,
          }),
        });
        const body = await response.json().catch(() => ({})) as { res?: unknown[]; error?: string };
        return { status: response.status, accepted: Boolean(body.res?.length), error: body.error };
      } catch (error) {
        return { status: 0, accepted: false, error: error instanceof Error ? error.message : "request_failed" };
      }
    }));
    return {
      requests: results.length,
      accepted: results.filter((result) => result.accepted).length,
      rateLimited: results.filter((result) => result.status === 429).length,
      rejected: results.filter((result) => !result.accepted && result.status !== 429).length,
      automaticRecoverySeconds: ADMISSION_STORM_RECOVERY_MS / 1_000,
    };
  }

  private async assertRoomRuntimeRecovered(record: RegistryRoom): Promise<void> {
    try {
      await fetchJson(`${record.endpoint}/healthz`, undefined, 2_000);
      await fetchJson(`${record.endpoint}/ops/snapshot`, undefined, 2_000);
    } catch {
      throw new UpstreamError(
        409,
        { error: "scenario_recovery_not_ready" },
        "scenario_recovery_not_ready",
      );
    }
  }
}
