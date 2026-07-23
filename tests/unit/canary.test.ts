import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  type BotValidationStarter,
  type CanaryMetricsSource,
  type CanaryPodObservation,
  type CanaryValidationTarget,
  CanaryValidationCoordinator,
  HttpBotValidationStarter,
  HttpCanaryMetricsSource,
  type KubernetesCanaryObservationSource,
} from "../../services/room-orchestrator/src/canary.js";
import {
  MemoryOperationEventTransport,
  OperationEventPublisher,
  toOpsiaGameOperationEvent,
} from "../../services/room-orchestrator/src/events.js";
import {
  KubernetesApiCanaryObservationSource,
} from "../../services/room-orchestrator/src/kubernetes-canary.js";
import { KubernetesCanaryRollout } from "../../services/room-orchestrator/src/canary-rollout.js";
import { sealedCanaryApprovalForRevision } from "../../services/room-orchestrator/src/release-control.js";

const target: CanaryValidationTarget = {
  canaryId: "canary-safe-revision",
  roomId: "canary-room",
  endpoint: "http://game-room-canary:8001",
  revision: "safe-revision",
  redisKeyPrefix: "room:canary-room:",
  redisDatabase: 1,
};

const readyPod = (overrides: Partial<CanaryPodObservation> = {}): CanaryPodObservation => ({
  observedAt: "2026-07-20T10:00:00.000Z",
  pod: {
    kind: "Pod",
    name: "canary-room-abc123",
    uid: "canary-pod-uid",
    resourceVersion: "19",
    phase: "Running",
    canaryId: "canary-safe-revision",
    revision: "safe-revision",
    imageDigest: `sha256:${"a".repeat(64)}`,
  },
  readyReplicas: 1,
  desiredReplicas: 1,
  containers: [{ name: "game-server", ready: true, restartCount: 0 }],
  events: [],
  isolation: {
    roomId: "canary-room",
    fleet: "canary",
    publicEnabled: false,
    matchmakingEnabled: false,
    redisKeyPrefix: "room:canary-room:",
    redisDatabase: 1,
  },
  memoryLimitBytes: 4_000,
  ...overrides,
});

const metricsBody = (overrides: Partial<Record<
  | "inflight"
  | "pending"
  | "duration"
  | "failures"
  | "timeouts"
  | "circuit"
  | "handoff"
  | "tickRate"
  | "memory",
  number
>> = {}): string => {
  const values = {
    inflight: 0,
    pending: 0,
    duration: 0.08,
    failures: 0,
    timeouts: 0,
    circuit: 0,
    handoff: 1,
    tickRate: 100,
    memory: 1_000,
    ...overrides,
  };
  return [
    `game_snapshot_inflight{room="canary-room"} ${values.inflight}`,
    `game_snapshot_pending{room="canary-room"} ${values.pending}`,
    `game_snapshot_write_duration_seconds{room="canary-room"} ${values.duration}`,
    `game_snapshot_failures_total{room="canary-room"} ${values.failures}`,
    `game_snapshot_timeouts_total{room="canary-room"} ${values.timeouts}`,
    `game_snapshot_circuit_open{room="canary-room"} ${values.circuit}`,
    `game_snapshot_handoff_enabled{room="canary-room"} ${values.handoff}`,
    `game_tick_rate{room="canary-room"} ${values.tickRate}`,
    `process_resident_memory_bytes ${values.memory}`,
  ].join("\n");
};

const sources = (input: {
  pods?: readonly CanaryPodObservation[];
  metrics?: string;
}) => {
  const pods = input.pods ?? [readyPod()];
  let podIndex = 0;
  let metricsCalls = 0;
  let botStarts = 0;
  let botStops = 0;
  const kubernetes: KubernetesCanaryObservationSource = {
    async observe() {
      const value = pods[Math.min(podIndex, pods.length - 1)];
      podIndex += 1;
      if (!value) throw new Error("test_pod_observation_missing");
      return structuredClone(value);
    },
  };
  const metrics: CanaryMetricsSource = {
    async scrape() {
      metricsCalls += 1;
      return {
        observedAt: new Date(Date.parse("2026-07-20T10:00:00.000Z") + metricsCalls * 1_000).toISOString(),
        url: "http://game-room-canary:8001/metrics",
        body: input.metrics ?? metricsBody(),
      };
    },
  };
  const bots: BotValidationStarter = {
    async start(request) {
      botStarts += 1;
      assert.equal(request.roomId, "canary-room");
      return {
        jobId: "validation-job-1",
        botCount: request.botCount,
        sessionCount: request.botCount,
        evidenceIds: ["bot-job:validation-job-1"],
        async stop() { botStops += 1; },
      };
    },
  };
  return {
    kubernetes,
    metrics,
    bots,
    calls: {
      get podObservations() { return podIndex; },
      get metricScrapes() { return metricsCalls; },
      get validationStarts() { return botStarts; },
      get validationStops() { return botStops; },
    },
  };
};

const coordinator = (
  fixture: ReturnType<typeof sources>,
  transport: MemoryOperationEventTransport,
): CanaryValidationCoordinator => new CanaryValidationCoordinator({
  events: new OperationEventPublisher(transport),
  metrics: fixture.metrics,
  kubernetes: fixture.kubernetes,
  bots: fixture.bots,
  sleep: async () => undefined,
  now: () => Date.parse("2026-07-20T10:00:00.000Z"),
}, {
  readinessTimeoutMs: 1_000,
  readinessPollIntervalMs: 0,
  maxReadinessPolls: 2,
  validationPollIntervalMs: 0,
  validationPolls: 2,
  requestTimeoutMs: 1_000,
  botCount: 10,
});

test("healthy isolated canary is approved from real metric samples", async () => {
  const fixture = sources({ metrics: metricsBody() });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-canary-approved");

  assert.equal(result.approved, true);
  assert.equal(result.reasonCode, undefined);
  assert.equal(fixture.calls.metricScrapes, 2);
  assert.equal(fixture.calls.validationStarts, 1);
  assert.equal(fixture.calls.validationStops, 1);
  assert.deepEqual(transport.events.map((event) => event.subject), [
    "CanaryScheduled",
    "CanaryReady",
    "ValidationLoadStarted",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "MetricGateEvaluated",
    "PromotionApproved",
    "EvidenceBundleSealed",
  ]);
  assert.deepEqual(
    transport.events.map((event) => event.sequence),
    Array.from({ length: transport.events.length }, (_, index) => index + 1),
  );
  for (let index = 1; index < transport.events.length; index++) {
    assert.equal(transport.events[index]?.causation_id, transport.events[index - 1]?.event_id);
  }
  const bundle = transport.events.at(-1);
  assert.equal(bundle?.payload.evidence_count, result.evidenceIds.length);
  assert.equal((bundle?.payload.details as Record<string, unknown>).completeness, "complete");
});

test("failed evidence bundle persistence cannot leave a reusable approval", async () => {
  class BundleFailingTransport extends MemoryOperationEventTransport {
    override async persist(operationEvent: Parameters<MemoryOperationEventTransport["persist"]>[0]): Promise<void> {
      if (operationEvent.subject === "EvidenceBundleSealed") throw new Error("bundle_persist_failed");
      await super.persist(operationEvent);
    }
  }
  const fixture = sources({ metrics: metricsBody() });
  const transport = new BundleFailingTransport();

  await assert.rejects(
    coordinator(fixture, transport).validate(target, "op-canary-bundle-failed"),
    /bundle_persist_failed/,
  );

  assert.ok(transport.events.some((operationEvent) => operationEvent.subject === "PromotionApproved"));
  assert.ok(!transport.events.some((operationEvent) => operationEvent.subject === "EvidenceBundleSealed"));
  assert.equal(sealedCanaryApprovalForRevision(transport.events, target.revision), undefined);
});

test("Canary blocks if the runtime digest changes while evidence is being collected", async () => {
  const replacement = readyPod({
    pod: { ...readyPod().pod, imageDigest: `sha256:${"b".repeat(64)}` },
  });
  const fixture = sources({ pods: [readyPod(), replacement], metrics: metricsBody() });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-canary-digest-changed");

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "canary_isolation_mismatch");
  assert.ok(!transport.events.some((operationEvent) => operationEvent.subject === "PromotionApproved"));
  assert.equal(
    transport.events.find((operationEvent) => operationEvent.subject === "MetricGateEvaluated")
      ?.payload.reason,
    undefined,
  );
  const gate = transport.events.find((operationEvent) => operationEvent.subject === "MetricGateEvaluated");
  assert.equal((gate?.payload.details as Record<string, unknown>).reason, "observed_canary_image_digest_changed");
});

test("observed snapshot backlog and memory pressure block promotion", async () => {
  const fixture = sources({
    metrics: metricsBody({ inflight: 2, pending: 1, memory: 3_600 }),
  });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-canary-backlog");

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "metric_gate_failed:game_snapshot_inflight");
  const backlog = transport.events.find((event) => event.subject === "SnapshotBacklogDetected");
  assert.ok(backlog);
  assert.equal(backlog.payload.inflight_saves, 2);
  assert.equal(backlog.payload.pending_saves, 1);
  assert.equal(backlog.payload.oldest_age_ms, 1_000);
  const memory = transport.events.find((event) => event.subject === "MemoryPressureObserved");
  assert.ok(memory);
  assert.equal(memory.payload.working_set_bytes, 3_600);
  assert.equal(memory.payload.memory_limit_bytes, 4_000);
  assert.ok(
    transport.events.findIndex((event) => event.subject === "SnapshotBacklogDetected") <
      transport.events.findIndex((event) => event.subject === "MemoryPressureObserved"),
  );
  const pendingGate = transport.events.find((event) =>
    event.subject === "MetricGateEvaluated" && event.payload.metric_name === "game_snapshot_pending"
  );
  assert.equal(pendingGate?.payload.passed, false);
  assert.equal(transport.events.at(-2)?.subject, "PromotionBlocked");
  assert.equal(transport.events.at(-1)?.subject, "EvidenceBundleSealed");
  assert.ok(!transport.events.some((event) => event.subject === "PromotionApproved"));
});

test("observed game tick rate below 60 blocks promotion", async () => {
  const fixture = sources({ metrics: metricsBody({ tickRate: 59.9 }) });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-canary-low-tick-rate");

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "metric_gate_failed:game_tick_rate");
  const tickRateGate = transport.events.find((event) =>
    event.subject === "MetricGateEvaluated" && event.payload.metric_name === "game_tick_rate"
  );
  assert.equal(tickRateGate?.payload.observed_value, 59.9);
  assert.equal(tickRateGate?.payload.threshold_value, 60);
  assert.equal(tickRateGate?.payload.passed, false);
});

test("actual Kubernetes OOMKilled container status blocks without scraping or fabricated failure", async () => {
  const oomPod = readyPod({
    observedAt: "2026-07-20T10:00:02.000Z",
    readyReplicas: 0,
    containers: [{
      name: "game-server",
      ready: false,
      restartCount: 1,
      lastTerminated: {
        reason: "OOMKilled",
        exitCode: 137,
        finishedAt: "2026-07-20T10:00:01.900Z",
      },
    }],
    events: [{
      uid: "k8s-event-oom-1",
      reason: "OOMKilled",
      type: "Warning",
      observedAt: "2026-07-20T10:00:01.950Z",
      involvedObjectUid: "canary-pod-uid",
    }],
  });
  const fixture = sources({ pods: [readyPod(), oomPod], metrics: metricsBody() });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-canary-oom");

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "container_oom_killed");
  assert.equal(fixture.calls.metricScrapes, 0);
  assert.equal(fixture.calls.validationStops, 1);
  const oom = transport.events.find((event) => event.subject === "ContainerOOMKilled");
  assert.ok(oom);
  assert.equal(oom.payload.pod_uid, "canary-pod-uid");
  assert.equal(oom.payload.container_name, "game-server");
  assert.equal(oom.payload.exit_code, 137);
  assert.equal(oom.payload.restart_count, 1);
  assert.deepEqual(oom.payload.evidence_ids, ["k8s-event-oom-1"]);
  assert.deepEqual(transport.events.map((event) => event.subject), [
    "CanaryScheduled",
    "CanaryReady",
    "ValidationLoadStarted",
    "ContainerOOMKilled",
    "MetricGateEvaluated",
    "PromotionBlocked",
    "EvidenceBundleSealed",
  ]);
});

test("live room endpoint is rejected before any event or side effect", async () => {
  const fixture = sources({ metrics: metricsBody() });
  const transport = new MemoryOperationEventTransport();
  const controller = coordinator(fixture, transport);

  await assert.rejects(
    controller.validate({ ...target, endpoint: "http://game-room-0:8001" }, "op-live-forbidden"),
    /canary_live_endpoint_forbidden/,
  );

  assert.equal(transport.events.length, 0);
  assert.equal(fixture.calls.podObservations, 0);
  assert.equal(fixture.calls.metricScrapes, 0);
  assert.equal(fixture.calls.validationStarts, 0);
});

test("stale observed Pod revision blocks before validation load", async () => {
  const fixture = sources({
    pods: [readyPod({ pod: { ...readyPod().pod, revision: "stale-revision" } })],
    metrics: metricsBody(),
  });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-stale-canary");

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "canary_isolation_mismatch");
  assert.equal(fixture.calls.validationStarts, 0);
  assert.equal(fixture.calls.metricScrapes, 0);
  assert.ok(!transport.events.some((event) => event.subject === "CanaryReady"));
});

test("missing real observation blocks with unavailable_reason instead of a made-up value", async () => {
  const bodyWithoutMemory = metricsBody().split("\n")
    .filter((line) => !line.startsWith("process_resident_memory_bytes"))
    .join("\n");
  const fixture = sources({ metrics: bodyWithoutMemory });
  const transport = new MemoryOperationEventTransport();

  const result = await coordinator(fixture, transport).validate(target, "op-canary-unavailable");

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "metric_observation_unavailable");
  assert.match(result.unavailableReason ?? "", /metric_missing:container_memory_working_set_bytes/);
  const gate = transport.events.find((event) => event.subject === "MetricGateEvaluated");
  assert.equal(Object.hasOwn(gate?.payload ?? {}, "observed_value"), false);
  assert.equal(Object.hasOwn(gate?.payload ?? {}, "threshold_value"), false);
  assert.match(String(gate?.payload.unavailable_reason), /metric_missing/);
  assert.ok(gate);
  const opsiaPayload = toOpsiaGameOperationEvent(gate).payload as Record<string, unknown>;
  assert.equal(Object.hasOwn(opsiaPayload, "observed_value"), false);
  assert.match(String(opsiaPayload.unavailable_reason), /metric_missing/);
  assert.ok(!transport.events.some((event) => event.subject === "PromotionApproved"));
});

test("HTTP metric source always reads the isolated server /metrics endpoint", async () => {
  let requestedUrl = "";
  const source = new HttpCanaryMetricsSource(async (input) => {
    requestedUrl = String(input);
    return new Response(metricsBody(), {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });

  const scrape = await source.scrape({
    endpoint: target.endpoint,
    roomId: "canary-room",
    signal: new AbortController().signal,
  });

  assert.equal(requestedUrl, "http://game-room-canary:8001/metrics");
  assert.match(scrape.body, /game_snapshot_inflight/);
});

test("HTTP bot starter waits for the accepted job and real connected sessions", async () => {
  const requests: string[] = [];
  const starter = new HttpBotValidationStarter(
    "http://game-room-canary-bot:8084",
    "control-token",
    async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (init?.method === "POST" && url.pathname === "/bots/jobs") {
        return new Response(JSON.stringify({
          jobId: "job-real-load",
          roomId: "canary-room",
          total: 2,
          completed: 0,
          createdBotIds: [],
          state: "running",
        }), { status: 202 });
      }
      if (init?.method === "GET" && url.pathname === "/bots/jobs/job-real-load") {
        return Response.json({
          jobId: "job-real-load",
          roomId: "canary-room",
          total: 2,
          completed: 2,
          createdBotIds: ["bot-1", "bot-2"],
          state: "completed",
        });
      }
      if (init?.method === "GET" && url.pathname === "/bots") {
        return Response.json({
          bots: [
            { id: "bot-1", roomId: "canary-room", connected: true },
            { id: "bot-2", roomId: "canary-room", connected: true },
          ],
        });
      }
      if (init?.method === "POST" && url.pathname === "/bots/jobs/job-real-load/cleanup") {
        return Response.json({ cleaned: true, remaining: 0 });
      }
      return new Response("not found", { status: 404 });
    },
    { pollIntervalMs: 0, maxPolls: 3, sleep: async () => undefined },
  );

  const run = await starter.start({
    roomId: "canary-room",
    botCount: 2,
    intervalMs: 50,
    signal: new AbortController().signal,
  });

  assert.equal(run.botCount, 2);
  assert.equal(run.sessionCount, 2);
  assert.deepEqual(requests.slice(0, 3), [
    "POST /bots/jobs",
    "GET /bots/jobs/job-real-load",
    "GET /bots",
  ]);
  await run.stop(new AbortController().signal);
  assert.equal(requests.at(-1), "POST /bots/jobs/job-real-load/cleanup");
});

test("HTTP bot starter cleans an accepted job when bounded readiness fails", async () => {
  let cleanupCalls = 0;
  const starter = new HttpBotValidationStarter(
    "http://game-room-canary-bot:8084",
    "control-token",
    async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === "/bots/jobs") {
        return new Response(JSON.stringify({
          jobId: "job-never-ready",
          roomId: "canary-room",
          total: 2,
          completed: 0,
          createdBotIds: [],
          state: "running",
        }), { status: 202 });
      }
      if (init?.method === "POST" && url.pathname.endsWith("/cleanup")) {
        cleanupCalls += 1;
        return Response.json({ cleaned: true, remaining: 0 });
      }
      return new Response("not found", { status: 404 });
    },
    { pollIntervalMs: 0, maxPolls: 1, sleep: async () => undefined },
  );

  await assert.rejects(starter.start({
    roomId: "canary-room",
    botCount: 2,
    intervalMs: 50,
    signal: new AbortController().signal,
  }), /bot_validation_load_not_ready/);
  assert.equal(cleanupCalls, 1);
});

test("game metrics expose actual authoritative process RSS for the memory gate", async () => {
  const gameServer = await readFile(
    join(process.cwd(), "upstream-survev/server/src/gameServer.ts"),
    "utf8",
  );
  assert.match(gameServer, /name: "process_resident_memory_bytes"/);
  assert.match(gameServer, /Math\.round\(snapshot\.memoryMb \* 1024 \* 1024\)/);
  assert.match(gameServer, /name: "game_tick_rate"/);
  assert.match(gameServer, /this\.tickRate\.labels\(snapshot\.roomId\)\.set\(snapshot\.tickRate\)/);
});

test("Kubernetes adapter correlates deployment and Pod labels and preserves OOM Event UID", async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  const labels = {
    "opsia.dev/fleet": "canary",
    "opsia.dev/room-id": "canary-room",
    "opsia.dev/canary-id": "canary-safe-revision",
    "opsia.dev/revision": "safe-revision",
    "opsia.dev/public": "disabled",
    "opsia.dev/matchmaking": "disabled",
  };
  const source = new KubernetesApiCanaryObservationSource(
    "https://kubernetes.default.svc",
    async () => "service-account-token",
    {
      now: () => Date.parse("2026-07-20T10:00:03.000Z"),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}?${url.searchParams.toString()}`);
        assert.equal(init?.signal, controller.signal);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-account-token");
        assert.equal(init?.redirect, "error");
        if (url.pathname.endsWith("/deployments")) {
          return Response.json({ items: [{
            metadata: { name: "canary-room", uid: "deployment-uid", labels },
            spec: { replicas: 1 },
            status: { readyReplicas: 0 },
          }] });
        }
        if (url.pathname.endsWith("/replicasets")) {
          return Response.json({ items: [{
            metadata: {
              name: "canary-room-7cf",
              uid: "replicaset-uid",
              labels,
              ownerReferences: [{ uid: "deployment-uid", controller: true }],
            },
          }] });
        }
        if (url.pathname.endsWith("/pods")) {
          return Response.json({ items: [{
            metadata: {
              name: "canary-room-7cf",
              uid: "pod-uid",
              resourceVersion: "42",
              labels,
              ownerReferences: [{ uid: "replicaset-uid", controller: true }],
            },
            spec: { containers: [{
              name: "game-server",
              env: [
                { name: "OPSIA_REDIS_KEY_PREFIX", value: "room:canary-room:" },
                { name: "REDIS_URL", value: "redis://redis:6379/1" },
              ],
              resources: { limits: { memory: "4Gi" } },
            }] },
            status: {
              phase: "Running",
              containerStatuses: [{
                name: "game-server",
                imageID: `docker-pullable://repo/game-server@sha256:${"a".repeat(64)}`,
                ready: false,
                restartCount: 1,
                lastState: { terminated: {
                  reason: "OOMKilled",
                  exitCode: 137,
                  finishedAt: "2026-07-20T10:00:02.000Z",
                } },
              }],
            },
          }] });
        }
        if (url.pathname.endsWith("/events")) {
          return Response.json({ items: [{
            metadata: { uid: "event-oom-uid", creationTimestamp: "2026-07-20T10:00:02.100Z" },
            reason: "Killing",
            type: "Warning",
            message: "Container game-server was OOMKilled",
            involvedObject: { uid: "pod-uid" },
          }] });
        }
        return new Response("not found", { status: 404 });
      },
    },
  );

  const observation = await source.observe({
    namespace: "sandbox",
    canaryId: "canary-safe-revision",
    roomId: "canary-room",
    signal: controller.signal,
  });

  assert.equal(requests.length, 4);
  assert.equal(observation.pod.canaryId, "canary-safe-revision");
  assert.equal(observation.pod.revision, "safe-revision");
  assert.equal(observation.pod.imageDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(observation.memoryLimitBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(observation.isolation.redisDatabase, 1);
  assert.equal(observation.containers[0]?.lastTerminated?.reason, "OOMKilled");
  assert.equal(observation.events[0]?.uid, "event-oom-uid");
  assert.equal(observation.events[0]?.reason, "OOMKilled");
  assert.equal(observation.events[0]?.involvedObjectUid, "pod-uid");
});

test("Canary rollout patches only the fixed isolated Deployment with immutable identity", async () => {
  const immutableRevision = "0123456789abcdef0123456789abcdef01234567";
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const rollout = new KubernetesCanaryRollout({
    apiServer: "https://kubernetes.default.svc",
    namespace: "sandbox",
    token: async () => "service-account-token",
    fetchImpl: async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return Response.json({ metadata: { name: "canary-room" } });
    },
  });

  const scheduled = await rollout.schedule({
    canaryId: "canary-01234567",
    revision: immutableRevision,
    workflowRunId: "workflow-1",
    applicationId: "demo-game",
  });

  assert.equal(
    observedUrl,
    "https://kubernetes.default.svc/apis/apps/v1/namespaces/sandbox/deployments/canary-room",
  );
  assert.equal(observedInit?.method, "PATCH");
  assert.equal(new Headers(observedInit?.headers).get("authorization"), "Bearer service-account-token");
  const patch = JSON.parse(String(observedInit?.body)) as {
    metadata: { labels: Record<string, string> };
    spec: { template: { metadata: { labels: Record<string, string> }; spec: { containers: Array<{ image: string }> } } };
  };
  assert.equal(patch.metadata.labels["opsia.dev/canary-id"], "canary-01234567");
  assert.equal(patch.spec.template.metadata.labels["opsia.dev/revision"], immutableRevision);
  assert.equal(
    patch.spec.template.spec.containers[0]?.image,
    `ghcr.io/jungle-303-04/demo-game/game-server:${immutableRevision}`,
  );
  assert.deepEqual(scheduled, {
    canaryId: "canary-01234567",
    roomId: "canary-room",
    endpoint: "http://game-room-canary:8001",
    revision: immutableRevision,
    redisKeyPrefix: "room:canary-room:",
    redisDatabase: 1,
    workflowRunId: "workflow-1",
    applicationId: "demo-game",
  });
});

test("Canary rollout rejects caller-controlled or non-label-safe revisions", async () => {
  const rollout = new KubernetesCanaryRollout({
    apiServer: "https://kubernetes.default.svc",
    namespace: "sandbox",
    token: "token",
    fetchImpl: async () => assert.fail("invalid revision must not reach Kubernetes"),
  });
  await assert.rejects(
    rollout.schedule({ canaryId: "canary-safe", revision: "owner/image:tag" }),
    /invalid_canary_revision/,
  );
  await assert.rejects(
    rollout.schedule({ canaryId: "invalid:value", revision: "safe" }),
    /invalid_canary_id/,
  );
});
