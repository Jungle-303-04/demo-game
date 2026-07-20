import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.COMPOSE_E2E === "1";
const opsUrl = process.env.OPS_CONSOLE_URL ?? "http://localhost:8085";
const controlToken = process.env.OPS_CONTROL_TOKEN ?? "demo-game-local-control-token";
const controlHeaders = { authorization: `Bearer ${controlToken}` };
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface BotSummary {
  id: string;
  roomId: string;
  mode: "normal" | "hack";
  connected: boolean;
}

interface BotInventory {
  bots: BotSummary[];
  minimumBotsPerRoom: number;
}

interface ScenarioRun {
  scenarioId: string;
  status: string;
  autoRecoverAt?: string;
  evidence?: Record<string, unknown>;
}

interface ScenarioRoomState {
  roomId: string;
  minimumBotsPerRoom: number;
  normalBots: number;
  hackBots: number;
  active?: ScenarioRun;
  lastResults: Record<string, { at: string; evidence?: Record<string, unknown> } | undefined>;
}

interface ScenarioState {
  rooms: ScenarioRoomState[];
  capabilities: { podFailure: boolean };
}

interface ScenarioAction {
  roomId?: string;
  scenarioId?: string;
  action?: string;
  status?: string;
  evidence?: Record<string, unknown>;
  error?: string;
}

interface AdminState {
  rooms: Array<{
    id: string;
    map: string;
    mode: string;
    maxPlayers: number;
    status: string;
    joinLocked: boolean;
    podHealthy: boolean;
    snapshotCapturedAt: number;
    metrics: { inputRejected: number };
  }>;
  capabilities: { scalingAvailable: boolean; maxRooms: number };
}

const waitFor = async (url: string): Promise<void> => {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; last = String(response.status); }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
    await delay(500);
  }
  throw new Error(`service_not_ready:${url}:${last}`);
};

const waitForCondition = async <T>(
  label: string,
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastValue = await probe();
      if (predicate(lastValue)) return lastValue;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const detail = lastError instanceof Error
    ? lastError.message
    : JSON.stringify(lastValue ?? lastError ?? null);
  throw new Error(`${label}_timeout:${detail}`);
};

const getBotInventory = async (): Promise<BotInventory> => {
  const response = await fetch(`${opsUrl}/api/bots`);
  assert.equal(response.status, 200);
  return response.json() as Promise<BotInventory>;
};

const getScenarioState = async (): Promise<ScenarioState> => {
  const response = await fetch(`${opsUrl}/api/admin/scenarios`);
  assert.equal(response.status, 200);
  return response.json() as Promise<ScenarioState>;
};

const getAdminState = async (): Promise<AdminState> => {
  const response = await fetch(`${opsUrl}/api/admin/rooms?compact=1`);
  assert.equal(response.status, 200);
  return response.json() as Promise<AdminState>;
};

const scenarioAction = async (
  roomId: string,
  scenarioId: string,
  action: "start" | "recover",
): Promise<{ status: number; body: ScenarioAction }> => {
  const response = await fetch(
    `${opsUrl}/api/admin/rooms/${roomId}/scenarios/${scenarioId}/${action}`,
    { method: "POST" },
  );
  return { status: response.status, body: await response.json() as ScenarioAction };
};

const connectedRoomBots = (inventory: BotInventory, roomId: string): BotSummary[] =>
  inventory.bots.filter((bot) => bot.roomId === roomId && bot.connected);

const waitForBaselineBots = async (roomIds: string[]): Promise<BotInventory> => waitForCondition(
  "baseline_bots",
  getBotInventory,
  (inventory) => inventory.minimumBotsPerRoom === 10 && roomIds.every((roomId) => {
    const bots = connectedRoomBots(inventory, roomId);
    return bots.length === 10 && bots.every((bot) => bot.mode === "normal");
  }),
  45_000,
  300,
);

const roomScenario = (state: ScenarioState, roomId: string): ScenarioRoomState => {
  const room = state.rooms.find((candidate) => candidate.roomId === roomId);
  assert.ok(room, `missing scenario state for ${roomId}`);
  return room;
};

test("compose starts three actual survev rooms, distributes 30 protocol bots, and exposes playerBarn snapshots", { skip: !enabled }, async () => {
  await waitFor(`${opsUrl}/healthz`);
  await waitFor("http://localhost:8084/healthz");
  await waitFor("http://localhost:8090/healthz");
  const unauthenticatedBots = await fetch("http://localhost:8084/bots");
  assert.equal(unauthenticatedBots.status, 401);
  assert.equal((await fetch("http://localhost:8084/bots", { headers: controlHeaders })).status, 200);
  const unauthenticatedGameOps = await fetch("http://localhost:8090/ops/snapshot");
  assert.equal(unauthenticatedGameOps.status, 401);
  const authenticatedGameOps = await fetch("http://localhost:8090/ops/snapshot", { headers: controlHeaders });
  assert.notEqual(authenticatedGameOps.status, 401);
  let before: { rooms: Array<{ roomId: string }> } | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = await (await fetch(`${opsUrl}/api/rooms`)).json() as Partial<{ rooms: Array<{ roomId: string }> }>;
    if (candidate.rooms?.length === 3) { before = { rooms: candidate.rooms }; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(before, "room_registry_not_ready");
  assert.equal(before.rooms.length, 3);
  const adminState = await getAdminState();
  assert.equal(adminState.rooms.length, 3);
  assert.deepEqual(adminState.rooms.map((room) => [room.id, room.map, room.mode, room.maxPlayers]), [
    ["room-0", "Faction Island", "Faction 50v50", 100],
    ["room-1", "Desert", "Solo FFA", 80],
    ["room-2", "Snow", "Solo FFA", 80],
  ]);
  assert.deepEqual(adminState.capabilities, { scalingAvailable: false, maxRooms: 3 });

  const mapSnapshots = await Promise.all([8090, 8091, 8092].map(async (port) => {
    const response = await fetch(`http://localhost:${port}/ops/snapshot`, { headers: controlHeaders });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ map: { name: string; maxPlayers: number } }>;
  }));
  assert.deepEqual(mapSnapshots.map((snapshot) => snapshot.map.name), ["faction", "desert", "snow"]);
  assert.deepEqual(mapSnapshots.map((snapshot) => snapshot.map.maxPlayers), [100, 80, 80]);
  for (const preview of ["faction", "desert", "snow"]) {
    const response = await fetch(`${opsUrl}/map-previews/${preview}.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
  }

  const invalidCreate = await fetch(`${opsUrl}/api/admin/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "invalid", mode: "solo" }),
  });
  assert.equal(invalidCreate.status, 400);
  assert.deepEqual(await invalidCreate.json(), { error: "unsupported_game_mode" });

  const mismatchedRoomProfile = await fetch(`${opsUrl}/api/admin/rooms/room-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ map: "Snow", mode: "Solo FFA", maxPlayers: 80 }),
  });
  assert.equal(mismatchedRoomProfile.status, 400);
  assert.deepEqual(await mismatchedRoomProfile.json(), { error: "unsupported_game_map" });

  const snapshotAck = await fetch(`${opsUrl}/api/admin/rooms/room-0/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "snapshot" }),
  });
  assert.equal(snapshotAck.status, 202);
  assert.equal(typeof (await snapshotAck.json() as { savedAt?: unknown }).savedAt, "number");

  const stopRejected = await fetch(`${opsUrl}/api/admin/rooms/room-2/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "stop" }),
  });
  assert.equal(stopRejected.status, 400);
  assert.deepEqual(await stopRejected.json(), { error: "room_scaling_requires_kubernetes" });

  const roomIds = before.rooms.map(({ roomId }) => roomId);
  const initialBots = await waitForBaselineBots(roomIds);
  const baselineBotIds = new Map(roomIds.map((roomId) => [
    roomId,
    new Set(connectedRoomBots(initialBots, roomId).map((bot) => bot.id)),
  ]));
  const initialScenarios = await getScenarioState();
  assert.deepEqual(initialScenarios.capabilities, { podFailure: false });
  for (const roomId of roomIds) {
    const state = roomScenario(initialScenarios, roomId);
    assert.equal(state.minimumBotsPerRoom, 10);
    assert.equal(state.normalBots, 10);
    assert.equal(state.hackBots, 0);
    assert.equal(state.active, undefined);
  }

  const lock = await scenarioAction("room-0", "admission-lock", "start");
  assert.equal(lock.status, 202);
  assert.equal(lock.body.status, "active");
  assert.equal(lock.body.evidence?.joinLocked, true);
  const blockedJoin = await fetch("http://localhost:8090/api/find_game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      region: "local",
      zones: ["local"],
      version: 1021,
      playerCount: 1,
      autoFill: true,
      gameModeIdx: 2,
      opsiaSessionId: "compose-lock-session-0001",
    }),
  });
  assert.equal(blockedJoin.status, 200);
  assert.deepEqual(await blockedJoin.json(), { error: "room_join_locked" });
  const publicKeyCannotBypass = await fetch("http://localhost:8090/api/find_game", {
    method: "POST",
    headers: { "content-type": "application/json", "survev-api-key": "opsia-demo-local-only" },
    body: JSON.stringify({
      region: "local",
      zones: ["local"],
      version: 1021,
      playerCount: 1,
      autoFill: true,
      gameModeIdx: 2,
      opsiaSessionId: "compose-key-bypass-0001",
    }),
  });
  assert.equal(publicKeyCannotBypass.status, 200);
  assert.deepEqual(await publicKeyCannotBypass.json(), { error: "room_join_locked" });
  const unlock = await scenarioAction("room-0", "admission-lock", "recover");
  assert.equal(unlock.status, 200);
  assert.equal(unlock.body.status, "completed");
  assert.equal(unlock.body.evidence?.joinLocked, false);
  const admittedAfterRecovery = await fetch("http://localhost:8090/api/find_game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      region: "local",
      zones: ["local"],
      version: 1021,
      playerCount: 1,
      autoFill: true,
      gameModeIdx: 2,
      opsiaSessionId: "compose-unlocked-session-0001",
    }),
  });
  assert.equal(admittedAfterRecovery.status, 200);
  assert.equal((await admittedAfterRecovery.json() as { res?: unknown[] }).res?.length, 1);

  // Start the self-recovering admission storm first so its 16-second window
  // overlaps the bot and process scenarios instead of extending test runtime.
  const storm = await scenarioAction("room-2", "admission-storm", "start");
  assert.equal(storm.status, 202);
  assert.equal(storm.body.status, "active");
  assert.equal(storm.body.evidence?.requests, 90);
  assert.ok(Number(storm.body.evidence?.rateLimited ?? 0) > 0);
  assert.ok(Number(storm.body.evidence?.accepted ?? 0) <= 20);
  const stormState = roomScenario(await getScenarioState(), "room-2");
  assert.equal(stormState.active?.scenarioId, "admission-storm");
  assert.equal(typeof stormState.active?.autoRecoverAt, "string");

  const surge = await scenarioAction("room-0", "bot-surge", "start");
  assert.equal(surge.status, 202);
  assert.equal(surge.body.status, "active");
  const surgeState = await waitForCondition(
    "bot_surge",
    getScenarioState,
    (state) => {
      const room = state.rooms.find((candidate) => candidate.roomId === "room-0");
      return room?.active?.scenarioId === "bot-surge"
        && room.active.status === "active"
        && room.normalBots >= 35;
    },
    20_000,
  );
  assert.equal(roomScenario(surgeState, "room-0").hackBots, 0);
  const surgeRecovery = await scenarioAction("room-0", "bot-surge", "recover");
  assert.equal(surgeRecovery.status, 200);
  assert.equal(surgeRecovery.body.status, "completed");
  assert.equal(surgeRecovery.body.evidence?.killed, 25);
  const afterSurge = await waitForBaselineBots(roomIds);
  for (const id of baselineBotIds.get("room-0") ?? []) {
    assert.ok(connectedRoomBots(afterSurge, "room-0").some((bot) => bot.id === id), `baseline bot ${id} was removed by surge cleanup`);
  }

  const beforeMalicious = await getAdminState();
  const rejectedBefore = beforeMalicious.rooms.find((room) => room.id === "room-1")?.metrics.inputRejected;
  assert.equal(typeof rejectedBefore, "number");
  const malicious = await scenarioAction("room-1", "malicious-input", "start");
  assert.equal(malicious.status, 202);
  assert.equal(malicious.body.status, "active");
  await waitForCondition(
    "malicious_bots",
    getScenarioState,
    (state) => {
      const room = state.rooms.find((candidate) => candidate.roomId === "room-1");
      return room?.active?.scenarioId === "malicious-input"
        && room.active.status === "active"
        && room.hackBots >= 3;
    },
    15_000,
  );
  await waitForCondition(
    "malicious_input_rejections",
    getAdminState,
    (state) => Number(state.rooms.find((room) => room.id === "room-1")?.metrics.inputRejected ?? 0) > Number(rejectedBefore),
    15_000,
  );
  const maliciousRecovery = await scenarioAction("room-1", "malicious-input", "recover");
  assert.equal(maliciousRecovery.status, 200);
  assert.equal(maliciousRecovery.body.status, "completed");
  assert.equal(maliciousRecovery.body.evidence?.killed, 3);
  const afterMalicious = await waitForBaselineBots(roomIds);
  for (const id of baselineBotIds.get("room-1") ?? []) {
    assert.ok(connectedRoomBots(afterMalicious, "room-1").some((bot) => bot.id === id), `baseline bot ${id} was removed by malicious-input cleanup`);
  }

  const crash = await scenarioAction("room-0", "process-crash", "start");
  assert.equal(crash.status, 202);
  assert.equal(crash.body.status, "recovering");
  assert.equal(typeof crash.body.evidence?.pid, "number");
  await waitForCondition(
    "child_process_outage",
    async () => (await fetch("http://localhost:8090/ops/snapshot", { headers: controlHeaders })).status,
    (status) => status === 503,
    5_000,
    50,
  );
  const crashRecovery = await waitForCondition(
    "child_process_recovery",
    () => scenarioAction("room-0", "process-crash", "recover"),
    (result) => result.status === 200 && result.body.status === "completed",
    30_000,
    300,
  );
  assert.equal(crashRecovery.body.scenarioId, "process-crash");
  const restoredSnapshotResponse = await waitForCondition(
    "restored_snapshot",
    () => fetch("http://localhost:8090/ops/snapshot", { headers: controlHeaders }),
    (response) => response.status === 200,
    15_000,
    200,
  );
  const restoredSnapshot = await restoredSnapshotResponse.json() as { map: { name: string } };
  assert.equal(restoredSnapshot.map.name, "faction");

  const podFailure = await scenarioAction("room-0", "pod-failure", "start");
  assert.equal(podFailure.status, 409);
  assert.equal(podFailure.body.error, "pod_failure_requires_kubernetes");

  const recoveredStormState = await waitForCondition(
    "admission_storm_auto_recovery",
    getScenarioState,
    (state) => {
      const room = state.rooms.find((candidate) => candidate.roomId === "room-2");
      return room?.active === undefined && room?.lastResults["admission-storm"] !== undefined;
    },
    25_000,
    300,
  );
  assert.equal(roomScenario(recoveredStormState, "room-2").lastResults["admission-storm"]?.evidence?.requests, 90);

  const finalBots = await waitForBaselineBots(roomIds);
  assert.equal(finalBots.bots.filter((bot) => bot.connected).length, 30);
  const finalScenarioState = await getScenarioState();
  assert.ok(finalScenarioState.rooms.every((room) => room.active === undefined));
  const finalAdminState = await waitForCondition(
    "final_room_health",
    getAdminState,
    (state) => state.rooms.length === 3 && state.rooms.every((room) =>
      room.status === "running" && room.podHealthy && !room.joinLocked),
    30_000,
    300,
  );
  assert.ok(finalAdminState.rooms.every((room) => room.snapshotCapturedAt > 0));
  const snapshots = await waitForCondition(
    "final_player_snapshots",
    () => Promise.all(before.rooms.map(async ({ roomId }) => {
      const response = await fetch(`${opsUrl}/api/ops/snapshot/${roomId}`);
      assert.equal(response.status, 200);
      return (await response.json() as { players: unknown[] }).players;
    })),
    (roomPlayers) => roomPlayers.reduce((total, players) => total + players.length, 0) === 30,
    15_000,
    250,
  );
  assert.equal(snapshots.reduce((total, players) => total + players.length, 0), 30);
  const page = await (await fetch(`${opsUrl}/`)).text();
  assert.match(page, /<title>Opsia Live Games<\/title>/);
  assert.match(page, /<div id="root"><\/div>/);
  assert.match(page, /assets\/index-[^"']+\.js/);
  const scenarioPage = await (await fetch(`${opsUrl}/scenarios`)).text();
  assert.match(scenarioPage, /<title>Opsia Live Games<\/title>/);
  assert.match(scenarioPage, /<div id="root"><\/div>/);
  const participant = await (await fetch("http://localhost:8090/play/room-0/")).text();
  assert.match(participant, /<canvas tabindex="1" id="cvs"><\/canvas>/);
  assert.match(participant, /js\//);
  const scenarioEvents = await (await fetch(`${opsUrl}/api/admin/events`)).json() as {
    events: Array<{ source: string }>;
  };
  assert.ok(scenarioEvents.events.filter((eventEntry) => eventEntry.source === "failure-lab").length >= 9);
  const event = await fetch(`${opsUrl}/api/ops/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "CANARY_STARTED", release: "strict" }) });
  assert.equal(event.status, 202);
  const timeline = await (await fetch(`${opsUrl}/api/timeline`)).json() as { events: Array<{ type: string }> };
  assert.equal(timeline.events[0]?.type, "CANARY_STARTED");
});
