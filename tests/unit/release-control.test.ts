import assert from "node:assert/strict";
import test from "node:test";
import type { GameOperationEvent, GameOperationSubject } from "../../services/room-orchestrator/src/events.js";
import {
  ReleaseOperationGate,
  sealedCanaryApprovalForRevision,
} from "../../services/room-orchestrator/src/release-control.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const digest = `sha256:${"a".repeat(64)}`;

const event = (
  sequence: number,
  subject: GameOperationSubject,
  payload: Record<string, unknown>,
  operationId = "op-canary",
): GameOperationEvent => ({
  event_id: `event-${operationId}-${sequence}`,
  subject,
  source: "room-orchestrator",
  workspace_id: "demo-game",
  correlation_id: operationId,
  created_at: new Date(Date.parse("2026-07-21T00:00:00.000Z") + sequence).toISOString(),
  sequence,
  payload: {
    room_id: "canary-room",
    git_revision: revision,
    ...payload,
  },
});

test("Canary and live handoff reservations atomically exclude simultaneous requests", async () => {
  const gate = new ReleaseOperationGate();
  let releaseExistenceCheck!: () => void;
  const existenceCheckBlocked = new Promise<void>((resolve) => { releaseExistenceCheck = resolve; });
  const first = gate.reserve("canary", "op-canary", async () => {
    await existenceCheckBlocked;
    return false;
  });
  const second = gate.reserve("handoff", "op-handoff", async () => false);

  releaseExistenceCheck();
  const reservation = await first;
  await assert.rejects(second, /canary_validation_already_running:op-canary/);
  reservation.release();
});

test("operation id check and reservation are one serialized transaction", async () => {
  const gate = new ReleaseOperationGate();
  const [first, second] = await Promise.allSettled([
    gate.reserve("canary", "same-operation", async () => false),
    gate.reserve("handoff", "same-operation", async () => false),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  if (first.status === "fulfilled") first.value.release();
  await assert.rejects(
    gate.reserve("handoff", "same-operation", async () => false),
    /operation_id_already_exists/,
  );
});

test("approval requires a terminal complete bundle from the same operation", () => {
  const approved = event(8, "PromotionApproved", {
    status: "completed",
    gate_name: "canary_validation",
    image_digest: digest,
  });
  const sealed = event(9, "EvidenceBundleSealed", {
    status: "completed",
    bundle_id: "bundle_op-canary",
    evidence_count: 1,
    evidence_ids: [approved.event_id],
    image_digest: digest,
    details: { completeness: "complete" },
  });

  assert.equal(sealedCanaryApprovalForRevision([approved], revision), undefined);
  assert.equal(sealedCanaryApprovalForRevision([
    approved,
    event(9, "EvidenceBundleSealed", {
      status: "completed",
      bundle_id: "bundle_other",
      evidence_count: 1,
      evidence_ids: [approved.event_id],
      image_digest: digest,
      details: { completeness: "complete" },
    }, "op-other"),
  ], revision), undefined);
  assert.equal(sealedCanaryApprovalForRevision([approved, {
    ...sealed,
    payload: { ...sealed.payload, evidence_ids: [] },
  }], revision), undefined);
  assert.equal(sealedCanaryApprovalForRevision([
    approved,
    sealed,
    event(10, "CanaryReady", { status: "completed" }),
  ], revision), undefined);
  assert.deepEqual(sealedCanaryApprovalForRevision([approved, sealed], revision), {
    operationId: "op-canary",
    revision,
    imageDigest: digest,
    bundleId: "bundle_op-canary",
    approvalEventId: approved.event_id,
    bundleEventId: sealed.event_id,
  });
});

test("an approval whose evidence bundle publish failed is never recoverable", () => {
  const approved = event(8, "PromotionApproved", {
    status: "completed",
    gate_name: "canary_validation",
    image_digest: digest,
  });
  assert.equal(sealedCanaryApprovalForRevision([approved], revision), undefined);
});
