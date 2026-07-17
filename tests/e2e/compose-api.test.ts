import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.COMPOSE_E2E === "1";
const opsUrl = process.env.OPS_CONSOLE_URL ?? "http://localhost:8085";
const controlToken = process.env.OPS_CONTROL_TOKEN ?? "demo-game-local-control-token";
const controlHeaders = { authorization: `Bearer ${controlToken}` };
const waitFor = async (url: string): Promise<void> => {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; last = String(response.status); }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service_not_ready:${url}:${last}`);
};
const waitForJob = async (roomId: string, jobId: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${opsUrl}/api/admin/rooms/${roomId}/bot-jobs/${jobId}`);
    assert.equal(response.status, 200);
    const job = await response.json() as { state: string; completed: number; total: number };
    if (job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`bot_job_timeout:${jobId}`);
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
  const adminState = await (await fetch(`${opsUrl}/api/admin/rooms`)).json() as {
    rooms: Array<{ id: string }>;
    capabilities: { scalingAvailable: boolean; maxRooms: number };
  };
  assert.equal(adminState.rooms.length, 3);
  assert.deepEqual(adminState.capabilities, { scalingAvailable: false, maxRooms: 3 });

  const invalidCreate = await fetch(`${opsUrl}/api/admin/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "invalid", mode: "solo" }),
  });
  assert.equal(invalidCreate.status, 400);
  assert.deepEqual(await invalidCreate.json(), { error: "unsupported_game_mode" });

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

  const lock = await fetch(`${opsUrl}/api/admin/rooms/room-0/join-lock`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locked: true }),
  });
  assert.ok(lock.status === 200 || lock.status === 202);
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
  const unlock = await fetch(`${opsUrl}/api/admin/rooms/room-0/join-lock`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locked: false }),
  });
  assert.ok(unlock.status === 200 || unlock.status === 202);

  const burst = await Promise.all(Array.from({ length: 90 }, async (_, index) => {
    const response = await fetch("http://localhost:8090/api/find_game", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.77" },
      body: JSON.stringify({
        region: "local",
        zones: ["local"],
        version: 1021,
        playerCount: 1,
        autoFill: true,
        gameModeIdx: 2,
        opsiaSessionId: `compose-burst-session-${String(index).padStart(4, "0")}`,
      }),
    });
    return { status: response.status, body: await response.json() as { res?: unknown[] } };
  }));
  assert.ok(burst.some((result) => result.status === 429));
  assert.ok(burst.filter((result) => result.body.res?.length).length <= 20);

  const killed = await fetch(`${opsUrl}/api/bots/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(killed.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  // Keep a repeated Compose E2E deterministic: a room reset clears its Redis
  // projection but preserves the StatefulSet ordinal/pod.
  for (const { roomId } of before.rooms) {
    const reset = await fetch(`${opsUrl}/api/rooms/${roomId}/end`, { method: "POST" });
    assert.equal(reset.status, 200);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const cancellable = await fetch(`${opsUrl}/api/admin/rooms/room-0/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 8, intervalMs: 600, mode: "normal" }),
  });
  assert.equal(cancellable.status, 202);
  const cancellableJob = await cancellable.json() as { jobId: string };
  await new Promise((resolve) => setTimeout(resolve, 900));
  const cancel = await fetch(`${opsUrl}/api/admin/rooms/room-0/bot-jobs/${cancellableJob.jobId}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 200);
  const remove = await fetch(`${opsUrl}/api/admin/rooms/room-0/bots`, { method: "DELETE" });
  assert.equal(remove.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const cancelled = await waitForJob("room-0", cancellableJob.jobId);
  assert.equal(cancelled.state, "cancelled");

  const loadJobs = await Promise.all(before.rooms.map(async ({ roomId }) => {
    const response = await fetch(`${opsUrl}/api/admin/rooms/${roomId}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 10, intervalMs: 50, mode: "normal" }),
    });
    assert.equal(response.status, 202);
    return { roomId, ...(await response.json() as { jobId: string }) };
  }));
  const completedJobs = await Promise.all(loadJobs.map(({ roomId, jobId }) => waitForJob(roomId, jobId)));
  assert.ok(completedJobs.every((job) => job.state === "completed" && job.completed === job.total));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const bots = await (await fetch(`${opsUrl}/api/bots`)).json() as { bots: unknown[] };
  assert.equal(bots.bots.length, 30);
  const snapshots = await Promise.all(before.rooms.map(async ({ roomId }) => (await (await fetch(`${opsUrl}/api/ops/snapshot/${roomId}`)).json() as { players: unknown[] }).players));
  assert.equal(snapshots.reduce((total, players) => total + players.length, 0), 30);
  const page = await (await fetch(`${opsUrl}/`)).text();
  assert.match(page, /<title>Survev Control Room<\/title>/);
  assert.match(page, /<div id="root"><\/div>/);
  assert.match(page, /assets\/index-[^"']+\.js/);
  const participant = await (await fetch("http://localhost:8090/play/room-0/")).text();
  assert.match(participant, /<canvas tabindex="1" id="cvs"><\/canvas>/);
  assert.match(participant, /js\//);
  const event = await fetch(`${opsUrl}/api/ops/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "CANARY_STARTED", release: "strict" }) });
  assert.equal(event.status, 202);
  const timeline = await (await fetch(`${opsUrl}/api/timeline`)).json() as { events: Array<{ type: string }> };
  assert.equal(timeline.events[0]?.type, "CANARY_STARTED");
});
