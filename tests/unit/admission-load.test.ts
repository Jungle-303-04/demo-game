import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionLoadController } from "../../services/ops-console/src/admission-load.js";

const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition_timeout");
};

test("adaptive admission load keeps the same load while the live failure metric recovers", async () => {
  let expandedCapacity = false;
  let requests = 0;
  const sessionIds = new Set<string>();
  const controller = new AdmissionLoadController({
    endpoint: "http://api-server:8081",
    initialRps: 10,
    rampStepRps: 10,
    rampIntervalMs: 500,
    maximumRps: 30,
    metricWindowMs: 1_000,
    safetyTtlMs: 10_000,
    requestTimeoutMs: 500,
    fetchImpl: async (input, init) => {
      requests += 1;
      assert.equal(String(input), "http://api-server:8081/api/find-game");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("connection"), "close");
      const target = JSON.parse(String(init?.body)) as { sessionId?: string };
      assert.match(target.sessionId ?? "", /^admission-/);
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

  expandedCapacity = true;
  await waitUntil(() => Number(controller.status(started.jobId)?.failureRatePercent ?? 100) < 1, 5_000);
  const recoveredMetric = controller.status(started.jobId)!;
  assert.equal(recoveredMetric.phase, "saturated");
  assert.ok(recoveredMetric.successRatePercent >= 99);
  assert.equal(controller.stop(started.jobId).phase, "stopped");
  assert.ok(requests > 10);
  assert.equal(sessionIds.size, requests);
});
