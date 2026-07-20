import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.CANARY_OOM_E2E === "1";
const orchestrator = (process.env.E2E_ORCHESTRATOR_URL ?? "http://localhost:8082").replace(/\/$/, "");
const token = process.env.OPS_CONTROL_TOKEN ?? "";
const revision = process.env.E2E_OOM_GAME_REVISION ?? "";
const headers = { authorization: `Bearer ${token}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface OperationEvent {
  subject: string;
  sequence: number;
  payload: Record<string, unknown>;
}

test("isolated unsafe revision is blocked only from observed backlog, memory pressure, and real Kubernetes OOM evidence", {
  skip: !enabled,
  timeout: 15 * 60_000,
}, async () => {
  assert.ok(token, "OPS_CONTROL_TOKEN is required for the Canary OOM E2E");
  assert.ok(revision, "E2E_OOM_GAME_REVISION is required for the Canary OOM E2E");
  const beforeRooms = await (await fetch(`${orchestrator}/rooms`, { headers })).json() as { rooms: unknown[] };
  const startResponse = await fetch(`${orchestrator}/canary/validate`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ revision }),
  });
  const start = await startResponse.json() as { operation?: { operationId: string }; error?: string };
  assert.equal(startResponse.status, 202, start.error);
  assert.ok(start.operation);

  const deadline = Date.now() + 12 * 60_000;
  let status = "";
  while (Date.now() < deadline) {
    const response = await fetch(
      `${orchestrator}/canary/status?operationId=${encodeURIComponent(start.operation.operationId)}`,
      { headers },
    );
    if (response.ok) {
      const body = await response.json() as { operation: { status: string; error?: string } };
      status = body.operation.status;
      if (["approved", "blocked", "failed"].includes(status)) break;
    }
    await sleep(500);
  }
  assert.equal(status, "blocked", "unsafe Canary must be blocked by observed evidence, not approved or synthetically failed");

  const ledgerResponse = await fetch(
    `${orchestrator}/canary/events?operationId=${encodeURIComponent(start.operation.operationId)}&limit=500`,
    { headers },
  );
  assert.equal(ledgerResponse.status, 200);
  const ledger = await ledgerResponse.json() as { events: OperationEvent[] };
  const sequence = (subject: string): number => {
    const event = ledger.events.find((candidate) => candidate.subject === subject);
    assert.ok(event, `missing ${subject}`);
    return event.sequence;
  };
  const backlog = sequence("SnapshotBacklogDetected");
  const memory = sequence("MemoryPressureObserved");
  const oom = sequence("ContainerOOMKilled");
  const blocked = sequence("PromotionBlocked");
  assert.ok(backlog < memory && memory < oom && oom < blocked, "causal evidence order was not preserved");

  const oomEvent = ledger.events.find((event) => event.subject === "ContainerOOMKilled")!;
  const resource = oomEvent.payload.resource_ref as Record<string, unknown>;
  const details = oomEvent.payload.details as Record<string, unknown>;
  assert.equal(resource.kind, "Pod");
  assert.ok(typeof resource.uid === "string" && resource.uid.length > 0);
  assert.ok(typeof details.kubernetes_event_uid === "string" && details.kubernetes_event_uid.length > 0);
  assert.equal(oomEvent.payload.exit_code, 137);
  assert.equal(ledger.events.find((event) => event.subject === "PromotionBlocked")?.payload.reason_code,
    "container_oom_killed");
  const bundle = ledger.events.find((event) => event.subject === "EvidenceBundleSealed");
  assert.ok(bundle);
  assert.equal((bundle.payload.details as Record<string, unknown>).completeness, "complete");

  const afterRooms = await (await fetch(`${orchestrator}/rooms`, { headers })).json() as { rooms: unknown[] };
  assert.deepEqual(afterRooms.rooms, beforeRooms.rooms, "Canary failure mutated the live room fleet");
  assert.equal(ledger.events.some((event) => event.subject === "RoomGatewayCutover"), false);
});
