import assert from "node:assert/strict";
import test from "node:test";
import {
    MemoryOperationEventTransport,
    OperationEventPublisher,
  OutboxOperationEventTransport,
  toOpsiaGameOperationEvent,
  type GameOperationEvent,
    type OperationEventTransport,
} from "../../services/room-orchestrator/src/events.js";
import {
  type RoomCandidate,
  RoomCutoverCommittedError,
  type RoomHandoffDriver,
  RoomHandoffCoordinator,
  type RoomHandoffTarget,
} from "../../services/room-orchestrator/src/handoff.js";

const target: RoomHandoffTarget = {
  roomId: "room-1",
  activeEndpoint: "http://active:8001",
  activePod: { kind: "Pod", name: "game-room-1-old", uid: "old-uid", resourceVersion: "11" },
  currentEpoch: 41,
  revision: "safe-revision",
};

const candidate: RoomCandidate = {
  kind: "Pod",
  name: "game-room-1-new",
  uid: "new-uid",
  resourceVersion: "12",
  endpoint: "http://candidate:8001",
  revision: "safe-revision",
};

const driver = (overrides: Partial<RoomHandoffDriver> = {}): RoomHandoffDriver => ({
  async scheduleCandidate() { return candidate; },
  async waitUntilReady() {},
  async freezeGateway() { return { sessions: 4, unackedInputs: 2 }; },
  async abortGatewayPreparation() {},
  async seedSnapshot() { return { checksum: "sha256:matched", snapshotTick: 9_180, payloadBytes: 42_000 }; },
  async catchUpJournal() { return { activeTick: 9_200, candidateTick: 9_200, lagTicks: 0 }; },
  async candidateChecksum() { return "sha256:matched"; },
  async cutoverGateway() { return { sessions: 4, replayedInputs: 2 }; },
  async rollbackGateway() { return { sessions: 4, replayedInputs: 0, roomEpoch: 43 }; },
  async verify() { return { healthy: true, sessionContinuity: true, stateChecksum: "sha256:matched" }; },
  async activateCandidate() { return { checksum: "sha256:matched" }; },
  async finalizeGateway() {},
  async drainOldPod() {},
  async discardCandidate() {},
  ...overrides,
});

test("planned handoff emits one persisted causation chain and drains only after verification", async () => {
  const transport = new MemoryOperationEventTransport();
  const projected: string[] = [];
  const publisher = new OperationEventPublisher(transport);
  publisher.subscribe((event) => projected.push(event.subject));
  const coordinator = new RoomHandoffCoordinator(driver(), publisher);

  const result = await coordinator.handoff(target, "op-handoff-success");

  assert.equal(result.newEpoch, 42);
  assert.equal(result.sessions, 4);
  assert.equal(result.replayedInputs, 2);
  assert.deepEqual(projected, [
    "RolloutWaveStarted",
    "RoomCandidateScheduled",
    "RoomCandidateReady",
    "RoomSnapshotSeeded",
    "RoomJournalCaughtUp",
    "RoomChecksumMatched",
    "RoomEpochFenced",
    "RoomGatewayCutover",
    "RoomInputReplayCompleted",
    "RoomPostVerificationCompleted",
    "RoomOldPodDrained",
    "RolloutWaveCompleted",
  ]);
  assert.deepEqual(transport.events.map((event) => event.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(transport.events[0]?.payload.wave_number, 2);
  assert.equal(transport.events[0]?.payload.total_waves, 5);
  assert.equal(transport.events.at(-1)?.payload.wave_number, 2);
  assert.equal(transport.events.at(-1)?.payload.total_waves, 5);
  for (let index = 1; index < transport.events.length; index++) {
    assert.equal(transport.events[index]?.causation_id, transport.events[index - 1]?.event_id);
  }
  const seededEvent = transport.events.find((event) => event.subject === "RoomSnapshotSeeded");
  assert.ok(seededEvent);
  const opsiaEnvelope = toOpsiaGameOperationEvent(seededEvent);
  assert.equal(opsiaEnvelope.subject, "room.snapshot.seeded");
  assert.equal(opsiaEnvelope.schema_version, 1);
  assert.equal(Object.hasOwn(opsiaEnvelope, "sequence"), false);
  const opsiaPayload = opsiaEnvelope.payload as Record<string, unknown>;
  assert.equal(opsiaPayload.operation_sequence, seededEvent.sequence);
  assert.equal(opsiaPayload.workflow_run_id, "op-handoff-success");
  assert.equal((opsiaPayload.resource_ref as Record<string, unknown>).resource_version, "12");
});

test("authority is fenced before Gateway cutover and the final release checksum is authoritative", async () => {
  const calls: string[] = [];
  const finalChecksum = "sha256:final-release";
  const coordinator = new RoomHandoffCoordinator(driver({
    async activateCandidate() {
      calls.push("authority");
      return { checksum: finalChecksum };
    },
    async cutoverGateway(input) {
      calls.push(`gateway:${input.checksum}`);
      return { sessions: 1, replayedInputs: 0 };
    },
    async verify(_candidate, checksum) {
      calls.push(`verify:${checksum}`);
      return { healthy: true, sessionContinuity: true, stateChecksum: checksum };
    },
  }), new OperationEventPublisher(new MemoryOperationEventTransport()));

  const result = await coordinator.handoff(target, "op-authority-first");

  assert.deepEqual(calls, [
    "authority",
    `gateway:${finalChecksum}`,
    `verify:${finalChecksum}`,
  ]);
  assert.equal(result.checksum, finalChecksum);
});

test("post-cutover verification accepts a live checksum newer than the fenced checkpoint", async () => {
  const fencedChecksum = "sha256:fenced";
  const liveChecksum = "sha256:advanced";
  const transport = new MemoryOperationEventTransport();
  const coordinator = new RoomHandoffCoordinator(driver({
    async activateCandidate() { return { checksum: fencedChecksum }; },
    async verify() {
      return { healthy: true, sessionContinuity: true, stateChecksum: liveChecksum };
    },
  }), new OperationEventPublisher(transport));

  const result = await coordinator.handoff(target, "op-checksum-advanced");

  assert.equal(result.checksum, fencedChecksum);
  const verified = transport.events.find((event) => event.subject === "RoomPostVerificationCompleted");
  assert.equal(verified?.payload.state_checksum, liveChecksum);
});

test("checksum mismatch blocks gateway cutover and preserves the active room", async () => {
  let cutoverCalls = 0;
  let abortCalls = 0;
  let discardedReason = "";
  const transport = new MemoryOperationEventTransport();
  const coordinator = new RoomHandoffCoordinator(driver({
    async candidateChecksum() { return "sha256:different"; },
    async cutoverGateway() { cutoverCalls++; return { sessions: 0, replayedInputs: 0 }; },
    async abortGatewayPreparation() { abortCalls++; },
    async discardCandidate(_candidate, reason) { discardedReason = reason; },
  }), new OperationEventPublisher(transport));

  await assert.rejects(coordinator.handoff(target, "op-handoff-mismatch"), /state_checksum_mismatch/);

  assert.equal(cutoverCalls, 0);
  assert.equal(abortCalls, 1);
  assert.equal(discardedReason, "state_checksum_mismatch");
  assert.ok(transport.events.some((event) => event.subject === "RoomChecksumMismatched"));
  const failed = transport.events.find((event) => event.subject === "RoomHandoffFailed");
  assert.equal(failed?.payload.rollback, "active_resumed");
  assert.equal(transport.events.at(-1)?.subject, "RolloutWaveBlocked");
});

test("candidate build revision mismatch is rejected before readiness or gateway freeze", async () => {
  let readyCalls = 0;
  let freezeCalls = 0;
  let discarded = false;
  const coordinator = new RoomHandoffCoordinator(driver({
    async scheduleCandidate() { return { ...candidate, revision: "unexpected-revision" }; },
    async waitUntilReady() { readyCalls++; },
    async freezeGateway() { freezeCalls++; return { sessions: 0, unackedInputs: 0 }; },
    async discardCandidate() { discarded = true; },
  }), new OperationEventPublisher(new MemoryOperationEventTransport()));

  await assert.rejects(coordinator.handoff(target, "op-revision-mismatch"), /candidate_revision_mismatch/);
  assert.equal(readyCalls, 0);
  assert.equal(freezeCalls, 0);
  assert.equal(discarded, true);
});

test("post-cutover failure fences back before discarding the failed candidate", async () => {
  const calls: string[] = [];
  const transport = new MemoryOperationEventTransport();
  const coordinator = new RoomHandoffCoordinator(driver({
    async cutoverGateway() { calls.push("cutover"); return { sessions: 3, replayedInputs: 1 }; },
    async verify() { calls.push("verify"); return { healthy: false, sessionContinuity: false, stateChecksum: "bad" }; },
    async rollbackGateway(input) {
      calls.push(`rollback:${input.expectedEpoch}->${input.nextEpoch}`);
      return { sessions: 3, replayedInputs: 0, roomEpoch: input.nextEpoch };
    },
    async discardCandidate() { calls.push("discard"); },
  }), new OperationEventPublisher(transport));

  await assert.rejects(coordinator.handoff(target, "op-post-cutover-failure"), /post_cutover_verification_failed/);

  assert.deepEqual(calls, ["cutover", "verify", "rollback:42->43", "discard"]);
  const failed = transport.events.find((event) => event.subject === "RoomHandoffFailed");
  assert.equal(failed?.payload.room_epoch, 43);
  assert.equal(failed?.payload.rollback, "gateway_rolled_back");
});

test("failed post-cutover rollback retains the serving candidate", async () => {
  let discarded = false;
  const transport = new MemoryOperationEventTransport();
  const coordinator = new RoomHandoffCoordinator(driver({
    async verify() { return { healthy: false, sessionContinuity: false, stateChecksum: "bad" }; },
    async rollbackGateway() { throw new Error("rollback_gateway_unavailable"); },
    async discardCandidate() { discarded = true; },
  }), new OperationEventPublisher(transport));

  await assert.rejects(coordinator.handoff(target, "op-rollback-blocked"), /post_cutover_verification_failed/);

  assert.equal(discarded, false);
  const failed = transport.events.find((event) => event.subject === "RoomHandoffFailed");
  assert.equal(failed?.payload.room_epoch, 42);
  assert.equal(failed?.payload.rollback, "rollback_failed_candidate_retained");
});

test("a driver-reported committed cutover is handled as post-cutover and never discarded", async () => {
  let discarded = false;
  let rollbackCalls = 0;
  const transport = new MemoryOperationEventTransport();
  const coordinator = new RoomHandoffCoordinator(driver({
    async cutoverGateway() { throw new RoomCutoverCommittedError("candidate_promote_failed", 42); },
    async rollbackGateway() { rollbackCalls++; throw new Error("rollback_unavailable"); },
    async discardCandidate() { discarded = true; },
  }), new OperationEventPublisher(transport));

  await assert.rejects(coordinator.handoff(target, "op-commit-error"), /candidate_promote_failed/);
  assert.equal(rollbackCalls, 1);
  assert.equal(discarded, false);
  const failed = transport.events.find((event) => event.subject === "RoomHandoffFailed");
  assert.equal(failed?.payload.rollback, "rollback_failed_candidate_retained");
});

test("default wave policy refuses a concurrent second room", async () => {
  let releaseReady!: () => void;
  const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
  const transport = new MemoryOperationEventTransport();
  const coordinator = new RoomHandoffCoordinator(driver({
    async waitUntilReady() { await readyGate; },
  }), new OperationEventPublisher(transport));

  const first = coordinator.handoff(target, "op-wave-first");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(coordinator.handoff({ ...target, roomId: "room-2" }, "op-wave-second"), /handoff_wave_already_running/);
  releaseReady();
  await first;
});

test("durable event authority is not rolled back by a projection or relay outage", async () => {
  const durable = new MemoryOperationEventTransport();
  const unavailableRelay: OperationEventTransport = {
    async persist() { throw new Error("opsia_projection_unavailable"); },
  };
  const transport = new OutboxOperationEventTransport(durable, unavailableRelay);
  const publisher = new OperationEventPublisher(transport);
  publisher.subscribe(() => { throw new Error("local_projection_failed"); });

  const event = await publisher.publish({
    operationId: "op-durable-first",
    workspaceId: "demo-game",
    workflowRunId: "workflow-1",
    applicationId: "game-app",
  }, "CanaryScheduled", {
    workflow_run_id: "workflow-1",
    application_id: "game-app",
    status: "running",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(durable.events.length, 1);
  assert.equal(event.payload.operation_id, "op-durable-first");
  assert.equal(event.payload.operation_sequence, 1);
  assert.equal(event.payload.workspace_id, "demo-game");
  assert.equal(transport.status().relayError, "opsia_projection_unavailable");
});

test("operation event cursor pages never skip an accumulated durable prefix", async () => {
  const durable = new MemoryOperationEventTransport();
  const publisher = new OperationEventPublisher(durable);
  for (let index = 0; index < 5; index++) {
    await publisher.publish({
      operationId: "op-cursor",
      workspaceId: "demo-game",
      workflowRunId: "workflow-cursor",
      applicationId: "game-app",
    }, "CanaryScheduled", {
      workflow_run_id: "workflow-cursor",
      application_id: "game-app",
      status: "running",
    });
  }

  assert.deepEqual(
    (await durable.read({ operationId: "op-cursor", limit: 2 })).map((event) => event.sequence),
    [1, 2],
  );
  assert.deepEqual(
    (await durable.read({ operationId: "op-cursor", afterSequence: 2, limit: 2 })).map((event) => event.sequence),
    [3, 4],
  );
  assert.equal((await durable.readRetained()).length, 5);
});

test("an ambiguous durable ACK never reuses an operation sequence or hides the next cursor page", async () => {
  const durable = new MemoryOperationEventTransport();
  let loseFirstAck = true;
  const appendThenMaybeLoseAck: OperationEventTransport = {
    async persist(event) {
      await durable.persist(event);
      if (loseFirstAck) {
        loseFirstAck = false;
        throw new Error("xtrim_response_lost_after_xadd");
      }
    },
  };
  const publisher = new OperationEventPublisher(appendThenMaybeLoseAck);
  const context = {
    operationId: "op-ambiguous-ack",
    workspaceId: "demo-game",
    workflowRunId: "workflow-ambiguous-ack",
    applicationId: "game-app",
  };
  const payload = {
    workflow_run_id: "workflow-ambiguous-ack",
    application_id: "game-app",
    status: "running",
  };

  await assert.rejects(publisher.publish(context, "CanaryScheduled", payload), /xtrim_response_lost/);
  const second = await publisher.publish(context, "CanaryReady", payload);

  assert.deepEqual(durable.events.map((event) => event.sequence), [1, 2]);
  assert.equal(second.causation_id, durable.events[0]?.event_id);
  assert.deepEqual(
    (await durable.read({ operationId: context.operationId, afterSequence: 1 })).map((event) => event.sequence),
    [2],
  );
});

test("outbox re-kicks when an event arrives after drain observed empty but before finally", async () => {
  const durable = new MemoryOperationEventTransport();
  const relayed: number[] = [];
  let outbox!: OutboxOperationEventTransport;
  const event = (sequence: number): GameOperationEvent => ({
    event_id: `evt-race-${sequence}`,
    subject: "CanaryScheduled",
    source: "test",
    workspace_id: "demo-game",
    correlation_id: "op-relay-race",
    created_at: new Date(0).toISOString(),
    sequence,
    payload: {},
  });
  const second = event(2);
  const relay: OperationEventTransport = {
    async persist(current) {
      relayed.push(current.sequence);
      if (current.sequence === 1) {
        // Queue replay after drain's await continuation has removed event 1,
        // but before its finally callback clears relayRunning.
        queueMicrotask(() => queueMicrotask(() => outbox.replay([second])));
      }
    },
  };
  outbox = new OutboxOperationEventTransport(durable, relay);

  outbox.replay([event(1)]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(relayed, [1, 2]);
  assert.equal(outbox.status().pending, 0);
});
