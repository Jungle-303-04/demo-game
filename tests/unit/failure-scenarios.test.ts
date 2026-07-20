import assert from "node:assert/strict";
import test from "node:test";
import {
  type AdminRoom,
  type RegistryRoom,
  UpstreamError,
} from "../../services/ops-console/src/admin.js";
import {
  FAILURE_SCENARIO_IDS,
  FailureScenarioController,
  isFailureScenarioId,
} from "../../services/ops-console/src/failure-scenarios.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const installFetch = (
  context: { after(callback: () => void): void },
  handler: FetchHandler,
): void => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    return handler(url, init);
  }) as typeof fetch;
};

const requestBody = (init?: RequestInit): Record<string, unknown> => {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected_json_request_body");
  return JSON.parse(body) as Record<string, unknown>;
};

const registryRoom = (overrides: Partial<RegistryRoom> = {}): RegistryRoom => ({
  roomId: "room-0",
  ordinal: 0,
  podName: "game-0",
  endpoint: "http://game-0",
  status: "running",
  players: 10,
  alive: 10,
  strictMode: false,
  joinLocked: false,
  statusChangedAt: "2026-07-20T00:00:00.000Z",
  ...overrides,
});

const adminRoom = (overrides: Partial<AdminRoom> = {}): AdminRoom => ({
  id: "room-0",
  name: "Faction Front",
  description: "test room",
  region: "Seoul / ap-northeast-2",
  map: "Faction Island",
  mode: "Faction 50v50",
  maxPlayers: 100,
  status: "running",
  matchPhase: "in_match",
  players: [],
  podName: "game-0",
  podIp: "not exposed",
  node: "cluster managed",
  serviceUrl: "/play/room-0/",
  imageTag: "survev-game:test",
  redisKey: "room:room-0:snapshot",
  snapshotAgeSeconds: 0,
  snapshotCapturedAt: Date.parse("2026-07-20T00:00:00.000Z"),
  tickRate: 40,
  uptimeSeconds: 120,
  seed: 1234,
  mapLayout: {
    width: 880,
    height: 880,
    shoreInset: 0,
    grassInset: 0,
    rivers: [],
    places: [],
    objects: [],
  },
  podHealthy: true,
  desiredReplicas: 1,
  readyReplicas: 1,
  joinLocked: false,
  createdAt: "2026-07-20T00:00:00.000Z",
  zone: { x: 50, y: 50, radius: 45, nextX: 50, nextY: 50, nextRadius: 35 },
  metrics: {
    cpuPercent: 10,
    memoryMb: 256,
    memoryLimitMb: 2_048,
    networkInKbps: null,
    networkOutKbps: null,
    tickP95Ms: 8,
    websocketCount: 10,
    redisOpsPerSecond: null,
    telemetryLagMs: 100,
    inputAccepted: 100,
    inputRejected: 0,
  },
  ...overrides,
});

test("failure scenario IDs are closed and one room permits only one active run", async (context) => {
  assert.deepEqual(FAILURE_SCENARIO_IDS, [
    "admission-lock",
    "bot-surge",
    "malicious-input",
    "admission-storm",
    "process-crash",
    "pod-failure",
  ]);
  assert.equal(isFailureScenarioId("admission-lock"), true);
  assert.equal(isFailureScenarioId("arbitrary-shell-command"), false);

  let botJobRequests = 0;
  installFetch(context, (url, init) => {
    if (url === "http://orchestrator/rooms/room-0/join-lock") {
      assert.equal(init?.method, "PUT");
      return json({ room: { joinLocked: requestBody(init).locked } });
    }
    if (url.startsWith("http://game-0/ops/join-lock/")) return json({ applied: true });
    if (url === "http://bots/bots/jobs") {
      botJobRequests += 1;
      return json({ error: "unexpected_bot_job" }, 500);
    }
    return json({ error: `unexpected_url:${url}` }, 500);
  });

  const controller = new FailureScenarioController("http://orchestrator", "http://bots");
  const record = registryRoom();
  const room = adminRoom();
  await controller.start(record, room, "admission-lock", false);

  await assert.rejects(
    controller.start(record, room, "bot-surge", false),
    (error: unknown) => error instanceof UpstreamError
      && error.status === 409
      && (error.body as { error?: string; activeScenarioId?: string }).error === "scenario_already_active"
      && (error.body as { activeScenarioId?: string }).activeScenarioId === "admission-lock",
  );
  assert.equal(botJobRequests, 0);

  await controller.recover(record, room, "admission-lock");
});

test("admission lock updates the persistent and live controls and recovery is idempotent", async (context) => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  installFetch(context, (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? requestBody(init) : undefined,
    });
    if (url === "http://orchestrator/rooms/room-0/join-lock") return json({ room: { joinLocked: true } });
    if (url.startsWith("http://game-0/ops/join-lock/")) return json({ applied: true });
    return json({ error: `unexpected_url:${url}` }, 500);
  });

  const controller = new FailureScenarioController("http://orchestrator", "http://bots");
  const record = registryRoom();
  const room = adminRoom();
  const started = await controller.start(record, room, "admission-lock", false);
  assert.equal(started.status, "active");
  assert.deepEqual(started.evidence, { joinLocked: true, appliedToLivePod: true });

  const recovered = await controller.recover(record, room, "admission-lock");
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.evidence, { joinLocked: false });
  assert.deepEqual(calls, [
    {
      url: "http://orchestrator/rooms/room-0/join-lock",
      method: "PUT",
      body: { locked: true },
    },
    { url: "http://game-0/ops/join-lock/true", method: "POST", body: undefined },
    {
      url: "http://orchestrator/rooms/room-0/join-lock",
      method: "PUT",
      body: { locked: false },
    },
    { url: "http://game-0/ops/join-lock/false", method: "POST", body: undefined },
  ]);

  const callCount = calls.length;
  const repeated = await controller.recover(record, room, "admission-lock");
  assert.equal(repeated.status, "completed");
  assert.deepEqual(repeated.evidence, { idempotent: true });
  assert.equal(calls.length, callCount);
});

test("bot surge tracks its exact job and cleanup never falls back to room-wide bot removal", async (context) => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  installFetch(context, (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? requestBody(init) : undefined,
    });
    if (url === "http://bots/bots/jobs" && init?.method === "POST") {
      return json({
        jobId: "load-room-0-exact",
        roomId: "room-0",
        total: 25,
        completed: 0,
        mode: "normal",
        state: "running",
      }, 202);
    }
    if (url === "http://bots/bots") {
      return json({
        minimumBotsPerRoom: 10,
        bots: [{ id: "baseline-bot", roomId: "room-0", mode: "normal", connected: true }],
      });
    }
    if (url === "http://bots/bots/jobs/load-room-0-exact" && init?.method !== "POST") {
      return json({
        jobId: "load-room-0-exact",
        roomId: "room-0",
        total: 25,
        completed: 25,
        mode: "normal",
        state: "completed",
        createdBotIds: ["scenario-bot-1", "scenario-bot-2"],
      });
    }
    if (url === "http://bots/bots/jobs/load-room-0-exact/cleanup" && init?.method === "POST") {
      return json({ jobId: "load-room-0-exact", killed: 25, preserved: ["baseline-bot"] });
    }
    return json({ error: `unexpected_url:${url}` }, 500);
  });

  const controller = new FailureScenarioController("http://orchestrator", "http://bots");
  const record = registryRoom();
  const room = adminRoom({ players: Array.from({ length: 10 }, () => ({})) as AdminRoom["players"] });
  const started = await controller.start(record, room, "bot-surge", false);
  assert.equal(started.status, "active");
  assert.deepEqual(calls[0], {
    url: "http://bots/bots/jobs",
    method: "POST",
    body: { room: "room-0", count: 25, intervalMs: 50, mode: "normal" },
  });

  const state = await controller.getState([room], false);
  assert.equal(state.rooms[0]?.active?.scenarioId, "bot-surge");
  assert.equal(state.rooms[0]?.active?.status, "active");
  assert.equal(state.rooms[0]?.active?.evidence?.jobState, "completed");

  const recovered = await controller.recover(record, room, "bot-surge");
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.evidence?.killed, 25);
  assert.equal(
    calls.filter((call) => call.url === "http://bots/bots/jobs/load-room-0-exact/cleanup" && call.method === "POST").length,
    1,
  );
  assert.equal(calls.some((call) => call.url === "http://bots/bots/kill"), false);
});

test("pod failure is capability-gated before mutation and verifies runtime recovery", async (context) => {
  const calls: string[] = [];
  installFetch(context, (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "http://orchestrator/rooms/room-0/failure") {
      return json({ roomId: "room-0", podName: "game-0", status: "recovery_requested" }, 202);
    }
    if (url === "http://game-0/healthz") return json({ status: "ok" });
    if (url === "http://game-0/ops/snapshot") return json({ roomId: "room-0", capturedAt: Date.now() });
    return json({ error: `unexpected_url:${url}` }, 500);
  });

  const controller = new FailureScenarioController("http://orchestrator", "http://bots");
  const record = registryRoom();
  const room = adminRoom();
  await assert.rejects(
    controller.start(record, room, "pod-failure", false),
    (error: unknown) => error instanceof UpstreamError
      && error.status === 409
      && (error.body as { error?: string }).error === "pod_failure_requires_kubernetes",
  );
  assert.deepEqual(calls, []);

  const started = await controller.start(record, room, "pod-failure", true);
  assert.equal(started.status, "recovering");
  assert.deepEqual(calls, ["POST http://orchestrator/rooms/room-0/failure"]);

  const recovered = await controller.recover(record, room, "pod-failure");
  assert.equal(recovered.status, "completed");
  assert.deepEqual(calls, [
    "POST http://orchestrator/rooms/room-0/failure",
    "GET http://game-0/healthz",
    "GET http://game-0/ops/snapshot",
  ]);
});

test("admission storm reports accepted, rate-limited, and other rejected requests and expires automatically", async (context) => {
  let now = Date.parse("2026-07-20T01:00:00.000Z");
  let stormRequests = 0;
  installFetch(context, (url, init) => {
    if (url === "http://game-0/api/find_game") {
      stormRequests += 1;
      assert.equal(init?.method, "POST");
      const body = requestBody(init);
      assert.equal(body.version, 1021);
      assert.match(String(body.opsiaSessionId), /^scenario-storm-room-0-/);
      if (stormRequests <= 12) return json({ res: [{ gameId: "game-0" }] });
      if (stormRequests <= 72) return json({ error: "rate_limited" }, 429);
      return json({ error: "full" }, 503);
    }
    if (url === "http://bots/bots") return json({ bots: [], minimumBotsPerRoom: 10 });
    return json({ error: `unexpected_url:${url}` }, 500);
  });

  const controller = new FailureScenarioController("http://orchestrator", "http://bots", () => now);
  const record = registryRoom();
  const room = adminRoom();
  const started = await controller.start(record, room, "admission-storm", false);
  assert.equal(stormRequests, 90);
  assert.deepEqual(started.evidence, {
    requests: 90,
    accepted: 12,
    rateLimited: 60,
    rejected: 18,
    automaticRecoverySeconds: 16,
  });

  await assert.rejects(
    controller.recover(record, room, "admission-storm"),
    (error: unknown) => error instanceof UpstreamError
      && error.status === 409
      && (error.body as { error?: string }).error === "scenario_auto_recovery_pending",
  );

  now += 16_001;
  const state = await controller.getState([room], false);
  assert.equal(state.rooms[0]?.active, undefined);
  assert.deepEqual(state.rooms[0]?.lastResults["admission-storm"]?.evidence, started.evidence);
});

test("process crash remains recovering until both health and snapshot checks pass", async (context) => {
  let runtimeRecovered = false;
  const calls: string[] = [];
  installFetch(context, (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "http://game-0/ops/failure/process-crash") {
      return json({ status: "crash_requested", previousPid: 101 }, 202);
    }
    if (url === "http://game-0/healthz") {
      return runtimeRecovered ? json({ status: "ok", pid: 202 }) : json({ status: "initializing" }, 503);
    }
    if (url === "http://game-0/ops/snapshot") {
      return json({ roomId: "room-0", capturedAt: Date.now(), pid: 202 });
    }
    return json({ error: `unexpected_url:${url}` }, 500);
  });

  const controller = new FailureScenarioController("http://orchestrator", "http://bots");
  const record = registryRoom();
  const room = adminRoom();
  const started = await controller.start(record, room, "process-crash", false);
  assert.equal(started.status, "recovering");
  assert.deepEqual(started.evidence, { status: "crash_requested", previousPid: 101 });

  await assert.rejects(
    controller.recover(record, room, "process-crash"),
    (error: unknown) => error instanceof UpstreamError
      && error.status === 409
      && (error.body as { error?: string }).error === "scenario_recovery_not_ready",
  );
  assert.equal(calls.includes("GET http://game-0/ops/snapshot"), false);

  runtimeRecovered = true;
  const recovered = await controller.recover(record, room, "process-crash");
  assert.equal(recovered.status, "completed");
  assert.equal(calls.filter((call) => call === "GET http://game-0/healthz").length, 2);
  assert.equal(calls.filter((call) => call === "GET http://game-0/ops/snapshot").length, 1);
});
