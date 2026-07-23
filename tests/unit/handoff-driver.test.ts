import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesRoomHandoffDriver } from "../../services/room-orchestrator/src/handoff-driver.js";

const checksum = "a".repeat(64);
const retainedOldChecksum = "b".repeat(64);
const latestCandidateChecksum = "c".repeat(64);

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

interface Harness {
  driver: KubernetesRoomHandoffDriver;
  calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
}

const harness = (options: {
  candidateNeverAppears?: boolean;
  candidateTimeoutMs?: number;
  candidateImage?: string;
  candidateImageId?: string;
  gatewayContinuous?: boolean;
  gatewayContinuousAfterReads?: number;
  cutoverResponseLost?: boolean;
  originalAnnotations?: Record<string, string>;
  candidateChecksumMismatchOnce?: boolean;
  requestTimeoutMs?: number;
} = {}): Harness => {
  const calls: Harness["calls"] = [];
  let rolloutPatched = false;
  let gatewayEndpoint = "http://10.0.0.11:8001";
  let gatewayEpoch = 41;
  let gatewayOperationId = "op-rollout";
  let gatewayReadCount = 0;
  let oldActive = true;
  let candidateActive = false;
  let oldEpoch = 41;
  let candidateEpoch = 41;
  let candidateChecksum = checksum;
  let oldChecksum = retainedOldChecksum;
  let oldTick = 100;
  let candidateTick = 100;
  let candidateSeedAttempts = 0;
  const oldPod = {
    metadata: {
      name: "game-room-1-old",
      uid: "old-uid",
      resourceVersion: "11",
      creationTimestamp: "2026-07-20T00:00:00Z",
      labels: { "opsia.dev/fleet": "live", "opsia.dev/room-id": "room-1" },
    },
    spec: { containers: [{ name: "game-server", image: "repo/game-server:old" }] },
    status: { phase: "Running", podIP: "10.0.0.11" },
  };
  const candidatePod = {
    metadata: {
      name: "game-room-1-new",
      uid: "new-uid",
      resourceVersion: "12",
      creationTimestamp: "2026-07-20T00:01:00Z",
      labels: { "opsia.dev/fleet": "live", "opsia.dev/room-id": "room-1" },
      annotations: { "opsia.dev/handoff-operation": "op-rollout" },
    },
    spec: { containers: [{ name: "game-server", image: options.candidateImage ?? "repo/game-server:new" }] },
    status: {
      phase: "Running",
      podIP: "10.0.0.12",
      containerStatuses: [{ name: "game-server", imageID: options.candidateImageId }],
    },
  };

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });

    if (url.includes("/api/v1/namespaces/sandbox/pods?")) {
      return json({
        items: rolloutPatched && !options.candidateNeverAppears ? [oldPod, candidatePod] : [oldPod],
      });
    }
    if (url.endsWith("/apis/apps/v1/namespaces/sandbox/deployments/game-room-1") && method === "GET") {
      return json({
        spec: {
          template: {
            metadata: { annotations: options.originalAnnotations },
            spec: {
              containers: [{
                name: "game-server",
                image: "repo/game-server:old",
                env: [{ name: "OPSIA_GAME_BUILD_REVISION", value: "old" }],
              }],
            },
          },
        },
      });
    }
    if (url.endsWith("/apis/apps/v1/namespaces/sandbox/deployments/game-room-1") && method === "PATCH") {
      rolloutPatched = true;
      return json({ status: "Success" });
    }
    if (url.includes("/api/v1/namespaces/sandbox/pods/") && method === "PATCH") {
      return json({ status: "Success" });
    }
    if (url === "http://10.0.0.11:8001/ops/handoff/status") {
      return json({
        role: oldActive ? "active" : "candidate",
        roomId: "room-1",
        ready: true,
        phase: oldActive ? "active" : "seeded",
        roomEpoch: oldEpoch,
        serverTick: oldTick,
        checksum: oldActive ? checksum : oldChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.12:8001/ops/handoff/status") {
      return json({
        role: candidateActive ? "active" : "candidate",
        roomId: "room-1",
        ready: true,
        phase: candidateActive ? "active" : "seeded",
        roomEpoch: candidateEpoch,
        serverTick: candidateTick,
        checksum: candidateChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.11:8001/ops/handoff/release") {
      oldActive = false;
      return json({
        role: "candidate",
        roomId: "room-1",
        ready: true,
        phase: "seeded",
        roomEpoch: 41,
        serverTick: 100,
        checksum: oldChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.11:8001/ops/handoff/promote") {
      oldActive = true;
      oldEpoch = Number(body?.nextEpoch);
      return json({
        role: "active",
        roomId: "room-1",
        ready: true,
        phase: "active",
        roomEpoch: oldEpoch,
        checksum: oldChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.12:8001/ops/handoff/seed") {
      candidateSeedAttempts++;
      if (options.candidateChecksumMismatchOnce && candidateSeedAttempts === 2) {
        return json({
          role: "candidate",
          roomId: "room-1",
          ready: false,
          phase: "blocked",
          roomEpoch: 41,
          serverTick: candidateTick,
          checksum: candidateChecksum,
          caughtUp: false,
          reason: "candidate_checksum_mismatch",
        });
      }
      candidateChecksum = String(body?.expectedChecksum);
      candidateTick = Number(body?.targetTick);
      return json({
        role: "candidate",
        roomId: "room-1",
        ready: true,
        phase: "seeded",
        roomEpoch: 41,
        serverTick: candidateTick,
        checksum: candidateChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.11:8001/ops/snapshot/save") {
      return json({ status: "saved" });
    }
    if (url === "http://10.0.0.12:8001/ops/handoff/promote") {
      candidateActive = true;
      candidateEpoch = Number(body?.nextEpoch);
      return json({
        role: "active",
        roomId: "room-1",
        ready: true,
        phase: "active",
        roomEpoch: candidateEpoch,
        serverTick: 100,
        checksum: candidateChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.12:8001/ops/handoff/release") {
      candidateActive = false;
      return json({
        role: "candidate",
        roomId: "room-1",
        ready: true,
        phase: "seeded",
        roomEpoch: candidateEpoch,
        serverTick: candidateTick,
        checksum: candidateChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://10.0.0.12:8001/ops/snapshot/save") {
      candidateChecksum = latestCandidateChecksum;
      candidateTick = 120;
      return json({ status: "saved" });
    }
    if (url === "http://10.0.0.11:8001/ops/handoff/seed") {
      oldChecksum = String(body?.expectedChecksum);
      oldTick = Number(body?.targetTick);
      return json({
        role: "candidate",
        roomId: "room-1",
        ready: true,
        phase: "seeded",
        roomEpoch: Number(body?.expectedEpoch),
        serverTick: oldTick,
        checksum: oldChecksum,
        caughtUp: true,
      });
    }
    if (url === "http://gateway:8083/internal/rooms/room-1/freeze") {
      return json({ sessions: 3, unackedInputs: 2 });
    }
    if (url === "http://gateway:8083/internal/rooms") {
      gatewayReadCount++;
      return json({
        rooms: [{ roomId: "room-1", endpoint: gatewayEndpoint, epoch: gatewayEpoch }],
        preparations: [],
        verifications: gatewayEpoch > 41 ? [{
          operationId: gatewayOperationId,
          roomId: "room-1",
          epoch: gatewayEpoch,
          expectedSessions: 3,
          liveSessions: 3,
          upstreamSessions: 3,
          continuous: options.gatewayContinuousAfterReads === undefined
            ? options.gatewayContinuous ?? true
            : gatewayReadCount >= options.gatewayContinuousAfterReads,
        }] : [],
        operations: gatewayEpoch > 41 ? [{
          operationId: gatewayOperationId,
          roomId: "room-1",
          nextEpoch: gatewayEpoch,
          endpoint: gatewayEndpoint,
          status: "committed",
          sessions: 3,
          replayedInputs: 2,
        }] : [],
      });
    }
    if (url === "http://gateway:8083/internal/rooms/room-1/cutover") {
      gatewayEndpoint = String(body?.endpoint);
      gatewayEpoch = Number(body?.nextEpoch);
      gatewayOperationId = String(body?.operationId);
      if (options.cutoverResponseLost) return json({ error: "response_lost_after_commit" }, 503);
      return json({ sessions: 3, replayedInputs: 2 });
    }
    if (url === "http://gateway:8083/internal/rooms/room-1/operations/op-rollout") {
      return json({
        operationId: "op-rollout",
        roomId: "room-1",
        nextEpoch: gatewayEpoch,
        endpoint: gatewayEndpoint,
        status: "committed",
        sessions: 3,
        replayedInputs: 2,
      });
    }
    if (url === "http://gateway:8083/internal/rooms/room-1/finalize") {
      return json({ status: "verified", sessions: 3 });
    }
    throw new Error(`unexpected_fetch:${method}:${url}`);
  }) as typeof fetch;

  return {
    calls,
    driver: new KubernetesRoomHandoffDriver({
      apiServer: "https://kubernetes",
      namespace: "sandbox",
      deploymentPrefix: "game-room",
      roomCount: 5,
      token: "service-account-token",
      controlToken: "control-token",
      gatewayEndpoint: "http://gateway:8083",
      gameImageRepository: "repo/game-server",
      fetchImpl,
      sleep: async () => undefined,
      requestTimeoutMs: options.requestTimeoutMs,
      candidateTimeoutMs: options.candidateTimeoutMs ?? 1_000,
      pollIntervalMs: 1,
    }),
  };
};

test("rolling handoff creates an auto-role Candidate addressed by Pod IP", async () => {
  const { driver, calls } = harness();
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");
  await driver.waitUntilReady(candidate);

  assert.equal(target.activeEndpoint, "http://10.0.0.11:8001");
  assert.equal(candidate.endpoint, "http://10.0.0.12:8001");
  const patch = calls.find((call) => call.method === "PATCH");
  const container = (((patch?.body?.spec as Record<string, unknown>).template as Record<string, unknown>).spec as {
    containers: Array<{ image: string; env: Array<{ name: string; value: string }> }>;
  }).containers[0];
  assert.equal(container?.image, "repo/game-server:new");
  assert.ok(container?.env.some((entry) => entry.name === "OPSIA_ROLE" && entry.value === "auto"));
  assert.ok(calls.some((call) => call.url === "http://10.0.0.12:8001/ops/handoff/status"));
  const podRolePatches = calls.filter((call) => call.method === "PATCH" && call.url.includes("/pods/"));
  assert.equal(podRolePatches.length, 2);
  assert.deepEqual(
    ((podRolePatches[1]?.body?.metadata as Record<string, unknown>).labels as Record<string, string>),
    { "opsia.dev/game-role": "candidate" },
  );
});

test("candidate schedule timeout restores the original Deployment template", async () => {
  const { driver, calls } = harness({ candidateNeverAppears: true, candidateTimeoutMs: 0 });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });

  await assert.rejects(driver.scheduleCandidate(target, "op-rollout"), /candidate_pod_schedule_timeout/);

  const deploymentPatches = calls.filter((call) => call.method === "PATCH"
    && call.url.endsWith("/deployments/game-room-1"));
  assert.equal(deploymentPatches.length, 2);
  const rollbackTemplate = ((deploymentPatches[1]?.body?.spec as Record<string, unknown>)
    .template as Record<string, unknown>);
  const rollbackContainer = ((rollbackTemplate.spec as Record<string, unknown>)
    .containers as Array<{ image: string }>)[0];
  assert.equal(rollbackContainer?.image, "repo/game-server:old");
  assert.equal(
    (rollbackTemplate.metadata as { annotations: Record<string, unknown> })
      .annotations["opsia.dev/handoff-operation"],
    null,
  );
  assert.equal(
    (rollbackTemplate.metadata as { annotations: Record<string, unknown> })
      .annotations["opsia.dev/handoff-rollback"],
    null,
  );
});

test("candidate identity is derived from the observed Pod image", async () => {
  const { driver } = harness({ candidateImage: "repo/game-server:unexpected" });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });

  await assert.rejects(driver.scheduleCandidate(target, "op-rollout"), /candidate_pod_image_mismatch/);
});

test("journal catch-up retries a snapshot checksum race", async () => {
  const { driver, calls } = harness({ candidateChecksumMismatchOnce: true });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");
  const seeded = await driver.seedSnapshot(target, candidate);
  const caughtUp = await driver.catchUpJournal(target, candidate, seeded.snapshotTick);

  assert.deepEqual(caughtUp, {
    activeTick: 100,
    candidateTick: 100,
    lagTicks: 0,
    checksum,
  });
  assert.equal(calls.filter((call) => call.url === "http://10.0.0.12:8001/ops/handoff/seed").length, 3);
});

test("live handoff schedules and verifies the exact Canary-approved runtime digest", async () => {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const image = `repo/game-server@${imageDigest}`;
  const { driver, calls } = harness({
    candidateImage: image,
    candidateImageId: `docker-pullable://${image}`,
  });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new", imageDigest });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");

  assert.equal(candidate.revision, "new");
  assert.equal(candidate.imageDigest, imageDigest);
  const deploymentPatch = calls.find((call) => call.method === "PATCH"
    && call.url.endsWith("/deployments/game-room-1"));
  const container = ((((deploymentPatch?.body?.spec as Record<string, unknown>)
    .template as Record<string, unknown>).spec as Record<string, unknown>)
    .containers as Array<{ image: string }>)[0];
  assert.equal(container?.image, image);
});

test("live handoff rejects a runtime imageID that differs from the approved digest", async () => {
  const approvedDigest = `sha256:${"a".repeat(64)}`;
  const { driver } = harness({
    candidateImage: `repo/game-server@${approvedDigest}`,
    candidateImageId: `containerd://sha256:${"b".repeat(64)}`,
  });
  const target = await driver.resolveTarget({
    roomId: "room-1",
    revision: "new",
    imageDigest: approvedDigest,
  });

  await assert.rejects(driver.scheduleCandidate(target, "op-rollout"), /candidate_pod_image_digest_mismatch/);
});

test("rollback restores the exact prior handoff annotations instead of creating a unique ReplicaSet", async () => {
  const originalAnnotations = {
    "opsia.dev/handoff-operation": "op-previous",
    "opsia.dev/handoff-revision": "old",
  };
  const { driver, calls } = harness({
    candidateNeverAppears: true,
    candidateTimeoutMs: 0,
    originalAnnotations,
  });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });

  await assert.rejects(driver.scheduleCandidate(target, "op-rollout"), /candidate_pod_schedule_timeout/);

  const patches = calls.filter((call) => call.method === "PATCH"
    && call.url.endsWith("/deployments/game-room-1"));
  const restored = (((patches[1]?.body?.spec as Record<string, unknown>).template as Record<string, unknown>)
    .metadata as { annotations: Record<string, string | null> }).annotations;
  assert.equal(restored["opsia.dev/handoff-operation"], "op-previous");
  assert.equal(restored["opsia.dev/handoff-revision"], "old");
  assert.equal(restored["opsia.dev/handoff-rollback"], null);
});

test("post-cutover rollback re-fences authority before gateway shadow replay", async () => {
  const { driver, calls } = harness();
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");
  const authority = await driver.activateCandidate({ target, candidate, roomEpoch: 42, checksum });
  await driver.cutoverGateway({
    operationId: "op-rollout",
    roomId: "room-1",
    endpoint: candidate.endpoint,
    expectedEpoch: 41,
    nextEpoch: 42,
    revision: "new",
    checksum: authority.checksum,
  });
  calls.splice(0);

  const result = await driver.rollbackGateway({
    operationId: "op-rollout",
    roomId: "room-1",
    endpoint: target.activeEndpoint,
    expectedEpoch: 42,
    nextEpoch: 43,
    revision: "new",
  });

  const controlCalls = calls.filter((call) => !call.url.startsWith("https://kubernetes"));
  assert.deepEqual(controlCalls.map((call) => `${call.method}:${call.url}`), [
    "GET:http://10.0.0.11:8001/ops/handoff/status",
    "GET:http://10.0.0.12:8001/ops/handoff/status",
    "GET:http://gateway:8083/internal/rooms",
    "POST:http://10.0.0.12:8001/ops/snapshot/save",
    "GET:http://10.0.0.12:8001/ops/handoff/status",
    "POST:http://10.0.0.12:8001/ops/handoff/release",
    "POST:http://10.0.0.11:8001/ops/handoff/seed",
    "POST:http://10.0.0.11:8001/ops/handoff/promote",
    "POST:http://gateway:8083/internal/rooms/room-1/freeze",
    "POST:http://gateway:8083/internal/rooms/room-1/cutover",
    "GET:http://gateway:8083/internal/rooms",
    "POST:http://gateway:8083/internal/rooms/room-1/finalize",
  ]);
  assert.deepEqual(controlCalls[5]?.body, { expectedEpoch: 42, expectedChecksum: latestCandidateChecksum });
  assert.deepEqual(controlCalls[6]?.body, {
    expectedEpoch: 42,
    targetTick: 120,
    expectedChecksum: latestCandidateChecksum,
    maxEntries: 512,
  });
  assert.deepEqual(controlCalls[7]?.body, {
    expectedEpoch: 42,
    nextEpoch: 43,
    expectedChecksum: latestCandidateChecksum,
  });
  assert.equal((controlCalls[9]?.body as Record<string, unknown>).endpoint, target.activeEndpoint);
  assert.equal((controlCalls[9]?.body as Record<string, unknown>).checksum, latestCandidateChecksum);
  assert.equal((controlCalls[9]?.body as Record<string, unknown>).checksumMatched, true);
  assert.equal((controlCalls[9]?.body as Record<string, unknown>).caughtUp, true);
  const activeRolePatch = calls.find((call) => call.method === "PATCH"
    && call.url.endsWith("/pods/game-room-1-old")
    && ((call.body?.metadata as Record<string, unknown>)?.annotations as Record<string, string>)?.["opsia.dev/room-epoch"] === "43");
  assert.ok(activeRolePatch);
  assert.equal(result.replayedInputs, 2);
  assert.equal(result.roomEpoch, 43);
});

test("a lost cutover response is reconciled from the Gateway operation record", async () => {
  const { driver, calls } = harness({ cutoverResponseLost: true });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");
  const authority = await driver.activateCandidate({ target, candidate, roomEpoch: 42, checksum });

  const cutover = await driver.cutoverGateway({
    operationId: "op-rollout",
    roomId: "room-1",
    endpoint: candidate.endpoint,
    expectedEpoch: 41,
    nextEpoch: 42,
    revision: "new",
    checksum: authority.checksum,
  });

  assert.deepEqual(cutover, { sessions: 3, replayedInputs: 2 });
  assert.ok(calls.some((call) => call.method === "GET"
    && call.url.endsWith("/internal/rooms/room-1/operations/op-rollout")));
});

test("post-cutover verification rejects a cached route when live session continuity is false", async () => {
  const { driver } = harness({ gatewayContinuous: false, requestTimeoutMs: 5 });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");
  await driver.freezeGateway({ operationId: "op-rollout", roomId: "room-1", expectedEpoch: 41 });
  const authority = await driver.activateCandidate({
    target,
    candidate,
    roomEpoch: 42,
    checksum,
  });
  await driver.cutoverGateway({
    operationId: "op-rollout",
    roomId: "room-1",
    endpoint: candidate.endpoint,
    expectedEpoch: 41,
    nextEpoch: 42,
    revision: "new",
    checksum: authority.checksum,
  });

  const verification = await driver.verify(candidate, authority.checksum);

  assert.equal(verification.healthy, true);
  assert.equal(verification.sessionContinuity, false);
});

test("post-cutover verification waits for live session continuity to settle", async () => {
  const { driver, calls } = harness({ gatewayContinuousAfterReads: 2 });
  const target = await driver.resolveTarget({ roomId: "room-1", revision: "new" });
  const candidate = await driver.scheduleCandidate(target, "op-rollout");
  await driver.freezeGateway({ operationId: "op-rollout", roomId: "room-1", expectedEpoch: 41 });
  const authority = await driver.activateCandidate({
    target,
    candidate,
    roomEpoch: 42,
    checksum,
  });
  await driver.cutoverGateway({
    operationId: "op-rollout",
    roomId: "room-1",
    endpoint: candidate.endpoint,
    expectedEpoch: 41,
    nextEpoch: 42,
    revision: "new",
    checksum: authority.checksum,
  });

  const verification = await driver.verify(candidate, authority.checksum);

  assert.equal(verification.healthy, true);
  assert.equal(verification.sessionContinuity, true);
  assert.equal(
    calls.filter((call) => call.url === "http://gateway:8083/internal/rooms").length,
    2,
  );
});
