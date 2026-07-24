import {
  fetchJson,
  type AdminRoom,
  type RegistryRoom,
  UpstreamError,
} from "./admin.js";
import {
  AdmissionLoadController,
  type AdmissionLoadService,
  type AdmissionLoadStatus,
} from "./admission-load.js";

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
  mode: "normal" | "surge" | "hack";
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
  mode: "normal" | "surge" | "hack";
  state: "running" | "completed" | "cancelled" | "failed";
  createdBotIds?: string[];
  error?: string;
}

interface MutableRun extends FailureScenarioRun {
  autoRecoverAtMs?: number;
  jobIds?: string[];
  surgeBotsRequested?: number;
  surgeMaxBots?: number;
  surgeNextRampAtMs?: number;
  surgeHoldUntilMs?: number;
  surgePeakTickP95Ms?: number;
}

const BOT_SURGE_INITIAL_SIZE = 25;
const BOT_SURGE_RAMP_SIZE = 10;
const BOT_SURGE_MAX_ADDITIONAL_BOTS = 60;
const BOT_SURGE_RESERVED_PLAYER_SLOTS = 10;
const BOT_SURGE_TARGET_TICK_P95_MS = 60;
const BOT_SURGE_RAMP_INTERVAL_MS = 3_000;
const BOT_SURGE_HOLD_MS = 10_000;
const MALICIOUS_BOT_COUNT = 3;
const numberFromEnvironment = (
  name: string,
  fallback: number,
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name.toLowerCase()}_invalid`);
  return parsed;
};

export const isFailureScenarioId = (value: string): value is FailureScenarioId =>
  FAILURE_SCENARIO_IDS.some((scenarioId) => scenarioId === value);

const scenarioConflict = (active: MutableRun): UpstreamError => new UpstreamError(
  409,
  { error: "scenario_already_active", activeScenarioId: active.scenarioId },
  "scenario_already_active",
);

export class FailureScenarioController {
  private readonly activeRuns = new Map<string, MutableRun>();
  private readonly advancingBotSurges = new Set<string>();
  private lastBotInventory: BotInventory = { bots: [] };
  private readonly lastResults = new Map<
    string,
    Partial<Record<FailureScenarioId, FailureScenarioResult>>
  >();

  private readonly admissionLoad: AdmissionLoadService;
  private readonly admissionEndpoint: string;

  constructor(
    private readonly orchestrator: string,
    private readonly botRunner: string,
    private readonly now: () => number = Date.now,
    admissionEndpoint = process.env.API_SERVER_URL ?? "http://api-server:8081",
    admissionLoad?: AdmissionLoadService,
    admissionLoadEndpoint = process.env.ADMISSION_GATEWAY_URL ?? admissionEndpoint,
  ) {
    this.admissionEndpoint = admissionEndpoint.replace(/\/+$/, "");
    this.admissionLoad = admissionLoad ?? new AdmissionLoadController({
      endpoint: admissionLoadEndpoint,
      now,
      initialRps: numberFromEnvironment("ADMISSION_LOAD_INITIAL_RPS", 40),
      rampStepRps: numberFromEnvironment("ADMISSION_LOAD_RAMP_STEP_RPS", 40),
      rampIntervalMs: numberFromEnvironment("ADMISSION_LOAD_RAMP_INTERVAL_MS", 2_000),
      maximumRps: numberFromEnvironment("ADMISSION_LOAD_MAXIMUM_RPS", 400),
      failureThreshold: numberFromEnvironment("ADMISSION_LOAD_FAILURE_THRESHOLD", 0.2),
      failureConfirmations: numberFromEnvironment("ADMISSION_LOAD_FAILURE_CONFIRMATIONS", 2),
      minimumSamples: numberFromEnvironment("ADMISSION_LOAD_MINIMUM_SAMPLES", 20),
    });
  }

  async getState(
    rooms: AdminRoom[],
    scalingAvailable: boolean,
  ): Promise<FailureScenarioState> {
    this.expireAutomaticRuns();
    const roomsById = new Map(rooms.map((room) => [room.id, room]));
    await Promise.all([...this.activeRuns.entries()].map(async ([roomId, run]) => {
      if (run.scenarioId === "admission-storm") {
        await this.syncAdmissionRun(roomId, run);
        return;
      }
      if (run.scenarioId === "bot-surge") {
        await this.advanceBotSurge(roomId, run, roomsById.get(roomId));
        return;
      }
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
    for (const [roomId, run] of [...this.activeRuns]) {
      if (run.status !== "failed") continue;
      this.activeRuns.delete(roomId);
      this.remember(
        roomId,
        run.scenarioId,
        "시나리오 실행이 실패했습니다. 새 시나리오를 다시 실행할 수 있습니다.",
        run.evidence,
      );
    }
    const inventory = await this.botInventory();

    const minimumBotsPerRoom = Math.max(0, Number(inventory.minimumBotsPerRoom ?? 0));
    return {
      rooms: rooms.map((room) => {
        const roomBots = inventory.bots.filter((bot) => bot.roomId === room.id && bot.connected);
        const active = this.activeRuns.get(room.id);
        return {
          roomId: room.id,
          minimumBotsPerRoom,
          normalBots: roomBots.filter((bot) => bot.mode !== "hack").length,
          hackBots: roomBots.filter((bot) => bot.mode === "hack").length,
          active: active ? this.publicRun(active) : undefined,
          lastResults: { ...(this.lastResults.get(room.id) ?? {}) },
        };
      }),
      capabilities: { podFailure: scalingAvailable },
    };
  }

  admissionStatus(): {
    active: boolean;
    failureRatePercent: number;
    targetRps: number;
    requestRps: number;
    incidentTriggered: boolean;
  } {
    for (const run of this.activeRuns.values()) {
      if (run.scenarioId !== "admission-storm" || !run.jobId) continue;
      const status = this.admissionLoad.status(run.jobId);
      if (!status) continue;
      return {
        active: !["stopped", "safety_timeout", "failed"].includes(status.phase),
        failureRatePercent: status.failureRatePercent,
        targetRps: status.targetRps,
        requestRps: status.requestRps,
        incidentTriggered: status.incidentTriggered,
      };
    }
    return {
      active: false,
      failureRatePercent: 0,
      targetRps: 0,
      requestRps: 0,
      incidentTriggered: false,
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
    if (existing?.status === "failed") {
      this.activeRuns.delete(room.id);
      this.remember(
        room.id,
        existing.scenarioId,
        "시나리오 실행이 실패했습니다. 새 시나리오를 다시 실행할 수 있습니다.",
        existing.evidence,
      );
    }
    else if (existing) {
      if (existing.scenarioId === scenarioId) {
        return this.started(room.id, existing, "이미 같은 장애 시나리오가 실행 중입니다.");
      }
      throw scenarioConflict(existing);
    }

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
          const available = Math.max(
            0,
            room.maxPlayers - room.players.length - BOT_SURGE_RESERVED_PLAYER_SLOTS,
          );
          const maxBots = Math.min(BOT_SURGE_MAX_ADDITIONAL_BOTS, available);
          const count = Math.min(BOT_SURGE_INITIAL_SIZE, maxBots);
          if (count < 1) {
            throw new UpstreamError(409, { error: "room_has_no_bot_capacity" }, "room_has_no_bot_capacity");
          }
          const job = await this.startBotJob(room.id, count, "surge");
          run.jobId = job.jobId;
          run.jobIds = [job.jobId];
          run.surgeBotsRequested = count;
          run.surgeMaxBots = maxBots;
          run.surgeNextRampAtMs = this.now() + BOT_SURGE_RAMP_INTERVAL_MS;
          run.surgePeakTickP95Ms = room.metrics.tickP95Ms;
          run.status = "starting";
          run.evidence = {
            phase: "ramping",
            requestedBots: count,
            maximumBots: maxBots,
            targetTickP95Ms: BOT_SURGE_TARGET_TICK_P95_MS,
            currentTickP95Ms: room.metrics.tickP95Ms,
            jobState: job.state,
          };
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
          if ([...this.activeRuns.entries()].some(([activeRoomId, active]) =>
            activeRoomId !== room.id && active.scenarioId === "admission-storm")) {
            throw new Error("admission_load_already_running");
          }
          const load = this.admissionLoad.start(room.id);
          run.jobId = load.jobId;
          run.status = "active";
          run.evidence = {
            ...this.admissionEvidence(load),
            failureMode: "capacity-regression",
            failureTarget: "api-server",
            loadPath: "login-gateway",
            loadStrategy: "adaptive-ramp-until-failure",
            rootCauseHypothesis: "admission-capacity-reduced-after-deployment",
            deploymentChangeExpected: "replica-count-reduction",
            rcaSignals: [
              "deployment-change",
              "admission-failure-rate",
              "find-game-rejected-log",
            ],
            existingSessionsExpected: "unaffected",
            recoveryOwner: "gitops-scale",
          };
          return this.started(
            room.id,
            run,
            `${load.targetRps} RPS부터 실패가 재현될 때까지 로비 입장 부하를 빠르게 올립니다.`,
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
    room: AdminRoom | undefined,
    scenarioId: FailureScenarioId,
  ): Promise<FailureScenarioActionResult> {
    this.expireAutomaticRuns();
    const roomId = record.roomId;
    const run = this.activeRuns.get(roomId);
    if (!run) {
      return this.completed(roomId, scenarioId, "이미 안전 상태입니다.", { idempotent: true });
    }
    if (run.scenarioId !== scenarioId) throw scenarioConflict(run);

    switch (scenarioId) {
      case "admission-lock":
        run.status = "recovering";
        await this.setJoinLocked(record, false);
        return this.completeRun(roomId, run, "신규 플레이어 입장을 다시 허용했습니다.", { joinLocked: false });
      case "bot-surge":
      case "malicious-input": {
        run.status = "recovering";
        if (run.jobId || run.jobIds?.length) {
          const cleanup = await this.cleanupBotJobs(run);
          return this.completeRun(roomId, run, "시나리오가 만든 봇만 제거했습니다.", cleanup);
        }
        return this.completeRun(roomId, run, "정리할 시나리오 봇이 없습니다.", { killed: 0 });
      }
      case "admission-storm": {
        if (!run.jobId) throw new Error("admission_load_job_not_found");
        run.status = "recovering";
        const beforeStop = this.admissionLoad.status(run.jobId);
        const stopped = this.admissionLoad.stop(run.jobId);
        return this.completeRun(roomId, run, "입장 부하를 즉시 중단했습니다. 기존 게임 세션은 그대로 유지됩니다.", {
          ...run.evidence,
          ...this.admissionEvidence(stopped),
          loadStopped: true,
          failureRateAtStopPercent: beforeStop?.failureRatePercent ?? stopped.failureRatePercent,
          saturationRps: beforeStop?.targetRps ?? stopped.targetRps,
          incidentObserved: beforeStop?.incidentTriggered ?? stopped.incidentTriggered,
          recoveryPerformed: false,
          recoveryVerified: false,
          recoveryOwner: "gitops-scale",
        });
      }
      case "process-crash": {
        run.status = "recovering";
        await this.assertRoomRuntimeRecovered(record);
        return this.completeRun(roomId, run, "게임 process와 snapshot 연결이 정상 복구됐습니다.");
      }
      case "pod-failure": {
        run.status = "recovering";
        if (!room) throw new Error("pod_failure_room_state_required");
        if (room.status !== "running" || !room.podHealthy) {
          throw new UpstreamError(
            409,
            { error: "scenario_recovery_not_ready", roomStatus: room.status },
            "scenario_recovery_not_ready",
          );
        }
        await this.assertRoomRuntimeRecovered(record);
        return this.completeRun(roomId, run, "교체된 Pod와 snapshot 연결이 정상 복구됐습니다.");
      }
    }
  }

  private publicRun(run: MutableRun): FailureScenarioRun {
    const {
      autoRecoverAtMs: _autoRecoverAtMs,
      jobIds: _jobIds,
      surgeBotsRequested: _surgeBotsRequested,
      surgeMaxBots: _surgeMaxBots,
      surgeNextRampAtMs: _surgeNextRampAtMs,
      surgeHoldUntilMs: _surgeHoldUntilMs,
      surgePeakTickP95Ms: _surgePeakTickP95Ms,
      ...publicRun
    } = run;
    return { ...publicRun, evidence: publicRun.evidence ? { ...publicRun.evidence } : undefined };
  }

  private async advanceBotSurge(
    roomId: string,
    run: MutableRun,
    room: AdminRoom | undefined,
  ): Promise<void> {
    if (!room || this.advancingBotSurges.has(roomId)) return;
    this.advancingBotSurges.add(roomId);
    try {
      const jobIds = run.jobIds?.length ? run.jobIds : run.jobId ? [run.jobId] : [];
      const currentJobId = jobIds.at(-1);
      if (currentJobId) {
        const job = await fetchJson<BotJob>(
          `${this.botRunner}/bots/jobs/${encodeURIComponent(currentJobId)}`,
        ).catch(() => undefined);
        if (!job) return;
        if (job.state === "failed") {
          run.status = "failed";
          run.evidence = { ...run.evidence, jobState: job.state, error: job.error };
          return;
        }
        const requestedBots = run.surgeBotsRequested ?? job.total;
        run.status = job.state === "running" ? "starting" : "active";
        run.evidence = {
          ...run.evidence,
          connected: Math.max(0, requestedBots - job.total) + job.completed,
          requested: requestedBots,
          jobState: job.state,
        };
        if (job.state === "running") return;
      }

      const tickP95Ms = room.metrics.tickP95Ms;
      run.surgePeakTickP95Ms = Math.max(run.surgePeakTickP95Ms ?? 0, tickP95Ms);
      run.evidence = {
        ...run.evidence,
        currentTickP95Ms: tickP95Ms,
        peakTickP95Ms: run.surgePeakTickP95Ms,
      };

      const now = this.now();
      if (run.surgeHoldUntilMs !== undefined) {
        if (now < run.surgeHoldUntilMs) {
          run.status = "active";
          return;
        }
        try {
          const cleanup = await this.cleanupBotJobs(run);
          this.completeRun(roomId, run, "Tick 부하 유지가 끝나 장애 봇을 자동으로 정리했습니다.", {
            ...run.evidence,
            ...cleanup,
            automaticRecovery: true,
          });
        } catch (error) {
          run.status = "recovering";
          run.evidence = {
            ...run.evidence,
            cleanupError: error instanceof Error ? error.message : "bot_cleanup_failed",
          };
        }
        return;
      }

      const requestedBots = run.surgeBotsRequested ?? 0;
      const maximumBots = run.surgeMaxBots ?? requestedBots;
      const targetReached = tickP95Ms >= BOT_SURGE_TARGET_TICK_P95_MS;
      if (targetReached || requestedBots >= maximumBots) {
        run.surgeHoldUntilMs = now + BOT_SURGE_HOLD_MS;
        run.autoRecoverAtMs = run.surgeHoldUntilMs;
        run.autoRecoverAt = new Date(run.surgeHoldUntilMs).toISOString();
        run.status = "active";
        run.evidence = {
          ...run.evidence,
          phase: "holding",
          targetReached,
          holdSeconds: BOT_SURGE_HOLD_MS / 1_000,
        };
        return;
      }

      if (now < (run.surgeNextRampAtMs ?? 0)) return;
      const count = Math.min(BOT_SURGE_RAMP_SIZE, maximumBots - requestedBots);
      if (count < 1) return;
      const job = await this.startBotJob(roomId, count, "surge");
      run.jobId = job.jobId;
      run.jobIds = [...jobIds, job.jobId];
      run.surgeBotsRequested = requestedBots + count;
      run.surgeNextRampAtMs = now + BOT_SURGE_RAMP_INTERVAL_MS;
      run.status = "starting";
      run.evidence = {
        ...run.evidence,
        phase: "ramping",
        requestedBots: run.surgeBotsRequested,
        jobState: job.state,
      };
    } catch (error) {
      run.status = "failed";
      run.evidence = {
        ...run.evidence,
        error: error instanceof Error ? error.message : "bot_surge_advance_failed",
      };
    } finally {
      if (this.activeRuns.has(roomId)) this.activeRuns.set(roomId, run);
      this.advancingBotSurges.delete(roomId);
    }
  }

  private async cleanupBotJobs(run: MutableRun): Promise<Record<string, unknown>> {
    const jobIds = run.jobIds?.length ? run.jobIds : run.jobId ? [run.jobId] : [];
    const cleanups: Record<string, unknown>[] = [];
    // Keep the primary job explicit: it is the stable cleanup key for the
    // original scenario run, while later ramp jobs are cleaned separately.
    if (run.jobId) {
      cleanups.push(await fetchJson<Record<string, unknown>>(
        `${this.botRunner}/bots/jobs/${encodeURIComponent(run.jobId)}/cleanup`,
        { method: "POST" },
        10_000,
      ));
    }
    const extraJobIds = jobIds.filter((jobId) => jobId !== run.jobId);
    cleanups.push(...await Promise.all(extraJobIds.map((jobId) => fetchJson<Record<string, unknown>>(
      `${this.botRunner}/bots/jobs/${encodeURIComponent(jobId)}/cleanup`,
      { method: "POST" },
      10_000,
    ))));
    return {
      killed: cleanups.reduce((total, cleanup) => total + Number(cleanup.killed ?? 0), 0),
      remaining: cleanups.reduce((total, cleanup) => total + Number(cleanup.remaining ?? 0), 0),
      cleanedJobs: jobIds.length,
      jobIds,
    };
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
      if (run.scenarioId === "bot-surge") continue;
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
    try {
      // The scenario dashboard must stay responsive even while the bot runner
      // is being restarted or the game cluster is saturated. Bot population is
      // supplementary display data here, so fall back to the cached inventory
      // quickly instead of holding the entire incident view for four seconds.
      const inventory = await fetchJson<BotInventory>(`${this.botRunner}/bots`, undefined, 750);
      this.lastBotInventory = inventory;
      return inventory;
    } catch {
      // A surge can briefly saturate the bot runner while game telemetry is
      // still valid. Keep the last known inventory so the scenario control
      // loop continues ramping and can still perform automatic cleanup.
      return this.lastBotInventory;
    }
  }

  private async syncAdmissionRun(roomId: string, run: MutableRun): Promise<void> {
    if (!run.jobId) return;
    const status = this.admissionLoad.status(run.jobId);
    if (!status) {
      run.status = "failed";
      run.evidence = { ...run.evidence, phase: "unavailable", error: "admission_load_job_not_found" };
      return;
    }
    run.evidence = this.admissionEvidence(status, run.evidence);
    const health = await fetchJson<{ status?: string }>(
      `${this.admissionEndpoint}/healthz`,
      undefined,
      600,
    ).catch(() => undefined);
    run.evidence = {
      ...run.evidence,
      admissionServerStatus: health?.status === "ok" ? "healthy" : "unreachable",
      existingSessionsExpected: "unaffected",
      recoveryOwner: "gitops-scale",
    };
    run.status = status.phase === "failed" ? "failed" : "active";
    if (status.phase === "safety_timeout") {
      this.completeRun(roomId, run, "안전 제한 시간에 도달해 장애 부하만 중단했습니다. 서비스 복구로 처리하지 않습니다.", {
        ...run.evidence,
        safetyTimeout: true,
        recoveryVerified: false,
      });
    }
  }

  private admissionEvidence(
    status: AdmissionLoadStatus,
    source: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...source,
      successRatePercent: status.successRatePercent,
      failureRatePercent: status.failureRatePercent,
      requestRps: status.requestRps,
      acceptedRps: status.acceptedRps,
      rejectedRps: status.rejectedRps,
      responseP95Ms: status.responseP95Ms,
      initialRps: status.initialRps,
      targetRps: status.targetRps,
      rampStepRps: status.rampStepRps,
      rampIntervalMs: status.rampIntervalMs,
      maximumRps: status.maximumRps,
      failureThresholdPercent: status.failureThresholdPercent,
      totalRequests: status.requests,
      phase: status.phase,
      incidentTriggered: status.incidentTriggered,
      saturationReason: status.saturationReason,
      ...(status.expiresAt ? { safetyExpiresAt: status.expiresAt } : {}),
    };
  }

  private async startBotJob(
    roomId: string,
    count: number,
    mode: "normal" | "surge" | "hack",
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
