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

test("compose starts three rooms, distributes 30 bots, and exposes minimap snapshots and timeline", { skip: !enabled }, async () => {
  await waitFor(`${opsUrl}/healthz`);
  const before = await (await fetch(`${opsUrl}/api/rooms`)).json() as { rooms: Array<{ roomId: string }> };
  assert.equal(before.rooms.length, 3);
  const spawned = await fetch(`${opsUrl}/api/bots/spawn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 30, mode: "normal" }) });
  assert.equal(spawned.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const snapshot = await (await fetch(`${opsUrl}/api/ops/snapshot/room-0`)).json() as { players: unknown[] };
  assert.ok(snapshot.players.length > 0);
  const event = await fetch(`${opsUrl}/api/ops/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "CANARY_STARTED", release: "strict" }) });
  assert.equal(event.status, 202);
  const timeline = await (await fetch(`${opsUrl}/api/timeline`)).json() as { events: Array<{ type: string }> };
  assert.equal(timeline.events[0]?.type, "CANARY_STARTED");
});
