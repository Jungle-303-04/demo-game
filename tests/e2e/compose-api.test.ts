import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.COMPOSE_E2E === "1";
const opsUrl = process.env.OPS_CONSOLE_URL ?? "http://localhost:8085";
const waitFor = async (url: string): Promise<void> => {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; last = String(response.status); }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service_not_ready:${url}:${last}`);
};

test("compose starts three actual survev rooms, distributes 30 protocol bots, and exposes playerBarn snapshots", { skip: !enabled }, async () => {
  await waitFor(`${opsUrl}/healthz`);
  let before: { rooms: Array<{ roomId: string }> } | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = await (await fetch(`${opsUrl}/api/rooms`)).json() as Partial<{ rooms: Array<{ roomId: string }> }>;
    if (candidate.rooms?.length === 3) { before = { rooms: candidate.rooms }; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(before, "room_registry_not_ready");
  assert.equal(before.rooms.length, 3);
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
  const spawned = await fetch(`${opsUrl}/api/bots/spawn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 30, mode: "normal" }) });
  assert.equal(spawned.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const bots = await (await fetch(`${opsUrl}/api/bots`)).json() as { bots: unknown[] };
  assert.equal(bots.bots.length, 30);
  const snapshots = await Promise.all(before.rooms.map(async ({ roomId }) => (await (await fetch(`${opsUrl}/api/ops/snapshot/${roomId}`)).json() as { players: unknown[] }).players));
  assert.equal(snapshots.reduce((total, players) => total + players.length, 0), 30);
  const page = await (await fetch(`${opsUrl}/`)).text();
  assert.match(page, /다음 생존자/);
  assert.match(page, /<svg id="map"/);
  assert.match(page, /opsiaZoomInput/);
  const participant = await (await fetch("http://localhost:8090/play/room-0")).text();
  assert.match(participant, /<canvas tabindex="1" id="cvs"><\/canvas>/);
  assert.match(participant, /js\//);
  const event = await fetch(`${opsUrl}/api/ops/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "CANARY_STARTED", release: "strict" }) });
  assert.equal(event.status, 202);
  const timeline = await (await fetch(`${opsUrl}/api/timeline`)).json() as { events: Array<{ type: string }> };
  assert.equal(timeline.events[0]?.type, "CANARY_STARTED");
});
