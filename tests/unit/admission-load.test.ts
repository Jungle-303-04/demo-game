import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMISSION_METRIC_WINDOW_MS,
  AdmissionLoadController,
} from "../../services/ops-console/src/admission-load.js";

const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition_timeout");
};

test("adaptive admission load holds the first reproducible failure level and carries RCA context", async () => {
  let expandedCapacity = false;
  let requests = 0;
  const sessionIds = new Set<string>();
  const controller = new AdmissionLoadController({
    endpoint: "http://demo-game-gateway",
    initialRps: 10,
    rampStepRps: 10,
    rampIntervalMs: 500,
    maximumRps: 30,
    failureConfirmations: 2,
    minimumSamples: 5,
    metricWindowMs: 1_000,
    safetyTtlMs: 10_000,
    requestTimeoutMs: 500,
    fetchImpl: async (input, init) => {
      requests += 1;
      assert.equal(String(input), "http://demo-game-gateway/api/find-game");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("connection"), "close");
      assert.equal(headers.get("x-opsia-scenario"), "admission-storm");
      assert.equal(headers.get("x-opsia-synthetic-load"), "true");
      assert.match(headers.get("x-opsia-correlation-id") ?? "", /^admission-/);
      const target = JSON.parse(String(init?.body)) as { sessionId?: string; roomId?: string };
      assert.match(target.sessionId ?? "", /^admission-/);
      assert.equal(target.roomId, "room-0");
      assert.equal(sessionIds.has(target.sessionId ?? ""), false);
      sessionIds.add(target.sessionId ?? "");
      if (expandedCapacity || requests % 3 !== 0) {
        return new Response(JSON.stringify({ room: { roomId: "room-0" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "find_game_rejected:rate_limited" }), { status: 429 });
    },
  });

  const started = controller.start("room-0");
  await waitUntil(() => controller.status(started.jobId)?.incidentTriggered === true);
  const saturated = controller.status(started.jobId)!;
  assert.equal(saturated.phase, "saturated");
  assert.ok(saturated.failureRatePercent >= 20);
  assert.ok(saturated.targetRps >= 10);
  assert.ok(saturated.targetRps < saturated.maximumRps);
  const saturationRps = saturated.targetRps;

  expandedCapacity = true;
  await waitUntil(() => Number(controller.status(started.jobId)?.failureRatePercent ?? 100) < 1, 5_000);
  const recoveredMetric = controller.status(started.jobId)!;
  assert.equal(recoveredMetric.phase, "saturated");
  assert.ok(recoveredMetric.successRatePercent >= 99);
  assert.equal(recoveredMetric.targetRps, saturationRps);
  assert.equal(controller.stop(started.jobId).phase, "stopped");
  assert.ok(requests > 10);
  assert.equal(sessionIds.size, requests);
});

test("starting the same room twice is idempotent and stopping aborts in-flight requests", async () => {
  let issued = 0;
  let aborted = 0;
  const controller = new AdmissionLoadController({
    endpoint: "http://demo-game-gateway",
    initialRps: 10,
    rampStepRps: 10,
    rampIntervalMs: 500,
    maximumRps: 30,
    metricWindowMs: 1_000,
    safetyTtlMs: 10_000,
    requestTimeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      issued += 1;
      return new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () => {
          aborted += 1;
          resolve(new Response(null, { status: 499 }));
        }, { once: true });
      });
    },
  });

  const started = controller.start("room-0");
  const duplicate = controller.start("room-0");
  assert.equal(duplicate.jobId, started.jobId);
  await waitUntil(() => issued > 0);
  assert.equal(controller.stop(started.jobId).phase, "stopped");
  await waitUntil(() => aborted === issued);
  const issuedAtStop = issued;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(issued, issuedAtStop);

  const restarted = controller.start("room-0");
  assert.notEqual(restarted.jobId, started.jobId);
  controller.stop(restarted.jobId);
});

test("presentation admission load ramps from 40 to a bounded ceiling and has a 30 minute TTL", () => {
  const now = Date.parse("2026-07-24T09:00:00.000Z");
  const controller = new AdmissionLoadController({
    endpoint: "http://demo-game-gateway",
    now: () => now,
    sleep: async () => new Promise<void>(() => undefined),
  });

  const started = controller.start("room-0");

  assert.equal(started.targetRps, 40);
  assert.equal(started.initialRps, 40);
  assert.equal(started.rampStepRps, 40);
  assert.equal(started.rampIntervalMs, 2_000);
  assert.equal(started.maximumRps, 400);
  assert.equal(started.failureThresholdPercent, 20);
  assert.equal(started.expiresAt, "2026-07-24T09:30:00.000Z");
  assert.equal(controller.stop(started.jobId).phase, "stopped");
});

test("presentation admission status uses the same one-minute window as the Kyro SLI", () => {
  assert.equal(ADMISSION_METRIC_WINDOW_MS, 60_000);
});

test("scheduler drops overdue token debt instead of bursting after an event-loop stall", async () => {
  let now = 0;
  let sleepCalls = 0;
  const issuedAt: number[] = [];
  const controller = new AdmissionLoadController({
    endpoint: "http://demo-game-gateway",
    now: () => now,
    sleep: async () => {
      sleepCalls += 1;
      now += sleepCalls === 3 ? 5_000 : 100;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    fetchImpl: async () => {
      issuedAt.push(now);
      return new Response(JSON.stringify({ room: { roomId: "room-0" } }), { status: 200 });
    },
  });

  const started = controller.start("room-0");
  await waitUntil(() => sleepCalls >= 7);
  controller.stop(started.jobId);

  const callsPerTick = new Map<number, number>();
  for (const at of issuedAt) callsPerTick.set(at, (callsPerTick.get(at) ?? 0) + 1);
  assert.ok((callsPerTick.get(5_200) ?? 0) > 0);
  assert.ok((callsPerTick.get(5_200) ?? 0) <= 4);
});

test("30 minute absolute TTL stops pressure even if no operator cleanup occurs", async () => {
  let now = Date.parse("2026-07-24T09:00:00.000Z");
  let requests = 0;
  const controller = new AdmissionLoadController({
    endpoint: "http://demo-game-gateway",
    now: () => now,
    sleep: async () => {
      now += 30 * 60_000;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    fetchImpl: async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    },
  });

  const started = controller.start("room-0");
  await waitUntil(() => controller.status(started.jobId)?.phase === "safety_timeout");

  assert.equal(controller.status(started.jobId)?.phase, "safety_timeout");
  assert.equal(requests, 0);
});
