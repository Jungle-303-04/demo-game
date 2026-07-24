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

test("matchmaker admits a requested room only when that exact room is available", async () => {
  const first = { ...recordForOrdinal(0), status: "running" as const, players: 1, joinLocked: false };
  const requested = { ...recordForOrdinal(1), status: "running" as const, players: 10, joinLocked: false };
  const directory: RoomDirectory = { list: async () => [first, requested] };
  const selected = await new Matchmaker(directory).findGame("session-room", "Grace", "room-1");
  assert.equal(selected.roomId, "room-1");
});

test("matchmaker rejects a requested room that is locked", async () => {
  const requested = { ...recordForOrdinal(1), status: "running" as const, players: 10, joinLocked: true };
  const directory: RoomDirectory = { list: async () => [requested] };
  await assert.rejects(
    new Matchmaker(directory).findGame("session-room", "Grace", "room-1"),
    /find_game_rejected:room_unavailable/,
  );
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

test("40 RPS fits two 25 RPS lobby replicas but exceeds one replica by 15 requests", async () => {
  const directory: RoomDirectory = {
    list: async () => [{ ...recordForOrdinal(0), status: "running", players: 0 }],
  };
  const twoReplicas = [
    new Matchmaker(directory, 25, () => 1_000),
    new Matchmaker(directory, 25, () => 1_000),
  ];
  let twoReplicaFailures = 0;
  for (let request = 0; request < 40; request += 1) {
    await twoReplicas[request % twoReplicas.length]!
      .findGame(`healthy-${request}`, "Ada")
      .catch(() => { twoReplicaFailures += 1; });
  }
  assert.equal(twoReplicaFailures, 0);

  const oneReplica = new Matchmaker(directory, 25, () => 1_000);
  let oneReplicaFailures = 0;
  for (let request = 0; request < 40; request += 1) {
    await oneReplica
      .findGame(`degraded-${request}`, "Grace")
      .catch(() => { oneReplicaFailures += 1; });
  }
  assert.equal(oneReplicaFailures, 15);
  assert.ok(oneReplicaFailures / 40 > 0.2);
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
  assert.doesNotMatch(metrics, /opsia_sli_failure_ratio/);
  assert.match(
    metrics,
    /opsia_sli_requests_total\{namespace="sandbox",resource_kind="Deployment",resource_name="api-server",service="api-server",sli="admission",symptom="admission_failure",outcome="success"\} 1/,
  );
  assert.match(
    metrics,
    /opsia_sli_requests_total\{namespace="sandbox",resource_kind="Deployment",resource_name="api-server",service="api-server",sli="admission",symptom="admission_failure",outcome="failure"\} 1/,
  );
  assert.doesNotMatch(metrics, /root_category=/);
});

test("standard SLI initializes both outcome series before traffic starts", async () => {
  const matchmaker = new Matchmaker({ list: async () => [] });
  const metrics = await matchmaker.registry.metrics();

  assert.match(metrics, /opsia_sli_requests_total\{[^}]+outcome="success"\} 0/);
  assert.match(metrics, /opsia_sli_requests_total\{[^}]+outcome="failure"\} 0/);
  assert.doesNotMatch(metrics, /opsia_sli_failure_ratio/);
});

test("matchmaker emits generic structured admission facts for Loki correlation", async () => {
  const directory: RoomDirectory = {
    list: async () => [{ ...recordForOrdinal(0), status: "running", players: 0 }],
  };
  const entries: Array<Record<string, unknown>> = [];
  const matchmaker = new Matchmaker(
    directory,
    1,
    () => Date.parse("2026-07-24T00:00:00.000Z"),
    (entry) => entries.push(entry),
  );

  await matchmaker.findGame("session-a", "Ada");
  await assert.rejects(
    matchmaker.findGame("session-b", "Grace"),
    /find_game_rejected:rate_limited/,
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    level: "info",
    event: "find_game_admitted",
    timestamp: "2026-07-24T00:00:00.000Z",
    namespace: "sandbox",
    resource_kind: "Deployment",
    resource_name: "api-server",
    service: "api-server",
    sli: "admission",
    symptom: "admission_failure",
    outcome: "accepted",
    room_id: "room-0",
    capacity_per_second: 1,
    duration_ms: entries[0]!.duration_ms,
  });
  assert.deepEqual(entries[1], {
    level: "warn",
    event: "find_game_rejected",
    timestamp: "2026-07-24T00:00:00.000Z",
    namespace: "sandbox",
    resource_kind: "Deployment",
    resource_name: "api-server",
    service: "api-server",
    sli: "admission",
    symptom: "admission_failure",
    outcome: "rejected",
    reason: "rate_limited",
    capacity_per_second: 1,
    duration_ms: entries[1]!.duration_ms,
  });
  assert.equal(typeof entries[0]!.duration_ms, "number");
  assert.equal(typeof entries[1]!.duration_ms, "number");
  assert.doesNotMatch(JSON.stringify(entries), /replicas|root_cause|cost|deployment.*caused/i);
});

test("scraping clears only the legacy window gauge while standard counters stay monotonic", async () => {
  let now = 1_000;
  const directory: RoomDirectory = {
    list: async () => [{ ...recordForOrdinal(0), status: "running", players: 0 }],
  };
  const matchmaker = new Matchmaker(directory, 1, () => now);
  await matchmaker.findGame("session-a", "Ada");
  await assert.rejects(
    matchmaker.findGame("session-b", "Grace"),
    /find_game_rejected:rate_limited/,
  );

  now += 1_001;
  matchmaker.refreshMetrics();
  const metrics = await matchmaker.registry.metrics();

  assert.match(metrics, /find_game_fail_ratio 0(?:\n|$)/);
  assert.doesNotMatch(metrics, /opsia_sli_failure_ratio/);
  assert.match(metrics, /opsia_sli_requests_total\{[^}]+outcome="success"\} 1/);
  assert.match(metrics, /opsia_sli_requests_total\{[^}]+outcome="failure"\} 1/);
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
