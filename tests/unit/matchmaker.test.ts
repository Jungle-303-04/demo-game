import assert from "node:assert/strict";
import test from "node:test";
import { HttpRoomDirectory, Matchmaker, type RoomDirectory } from "../../services/api-server/src/matchmaker.js";
import { recordForOrdinal } from "../../services/room-orchestrator/src/registry.js";

test("matchmaker never assigns a room whose persistent join lock is enabled", async () => {
  const locked = { ...recordForOrdinal(0), status: "running" as const, players: 0, joinLocked: true };
  const open = { ...recordForOrdinal(1), status: "running" as const, players: 50, joinLocked: false };
  const directory: RoomDirectory = { list: async () => [locked, open] };
  const selected = await new Matchmaker(directory).findGame("session-1", "Ada");
  assert.equal(selected.roomId, "room-1");
});

test("matchmaker rejects when every active room is join locked", async () => {
  const directory: RoomDirectory = {
    list: async () => [{ ...recordForOrdinal(0), status: "running", joinLocked: true }],
  };
  await assert.rejects(
    new Matchmaker(directory).findGame("session-1", "Ada"),
    /find_game_rejected:no_room/,
  );
});

test("matchmaker excludes rooms that report their real player capacity is full", async () => {
  const full = { ...recordForOrdinal(0), status: "running" as const, players: 100, joinLocked: false };
  const open = { ...recordForOrdinal(1), status: "running" as const, players: 79, joinLocked: false };
  const directory: RoomDirectory = { list: async () => [full, open] };
  const selected = await new Matchmaker(directory).findGame("session-2", "Grace");
  assert.equal(selected.roomId, "room-1");
});

test("matchmaker reserves its rate-limit slot before concurrent directory probes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let probes = 0;
  const directory: RoomDirectory = {
    list: async () => {
      probes += 1;
      await gate;
      return [{ ...recordForOrdinal(0), status: "running", players: 0 }];
    },
  };
  const matchmaker = new Matchmaker(directory, 2);
  const first = matchmaker.findGame("session-a", "Ada");
  const second = matchmaker.findGame("session-b", "Linus");
  await assert.rejects(
    matchmaker.findGame("session-c", "Ken"),
    /find_game_rejected:rate_limited/,
  );
  assert.equal(probes, 2);
  release();
  await Promise.all([first, second]);
});

test("matchmaker metrics count every rejected admission and expose capacity", async () => {
  const directory: RoomDirectory = {
    list: async () => [{ ...recordForOrdinal(0), status: "running", players: 0 }],
  };
  const matchmaker = new Matchmaker(directory, 1, () => 1_000);
  await matchmaker.findGame("session-a", "Ada");
  await assert.rejects(
    matchmaker.findGame("session-b", "Grace"),
    /find_game_rejected:rate_limited/,
  );

  const metrics = await matchmaker.registry.metrics();
  assert.match(metrics, /find_game_requests_total\{outcome="accepted"\} 1/);
  assert.match(metrics, /find_game_requests_total\{outcome="rate_limited"\} 1/);
  assert.match(metrics, /find_game_fail_ratio 0\.5/);
  assert.match(metrics, /find_game_inflight 0/);
  assert.match(metrics, /find_game_capacity_per_second 1/);
  assert.match(metrics, /find_game_request_duration_seconds_count\{outcome="rate_limited"\} 1/);
});

test("HTTP room directory authenticates and bounds its orchestrator request", async (context) => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ rooms: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  assert.deepEqual(await new HttpRoomDirectory("http://orchestrator", "service-secret").list(), []);
  assert.equal(new Headers(captured?.headers).get("authorization"), "Bearer service-secret");
  assert.ok(captured?.signal instanceof AbortSignal);
});
