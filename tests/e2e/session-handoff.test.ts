import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.K8S_HANDOFF_E2E === "1";
const orchestrator = (process.env.E2E_ORCHESTRATOR_URL ?? "http://localhost:8082").replace(/\/$/, "");
const botRunner = (process.env.E2E_BOT_RUNNER_URL ?? "http://localhost:8084").replace(/\/$/, "");
const token = process.env.OPS_CONTROL_TOKEN ?? "";
const revision = process.env.E2E_GAME_REVISION ?? "";
const headers = { authorization: `Bearer ${token}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface BotInventory {
  bots: Array<{ id: string; roomId: string; connected: boolean }>;
}

interface OperationEvent {
  subject: string;
  sequence: number;
  payload: Record<string, unknown>;
}

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json() as T & { error?: string };
  assert.ok(response.ok, `HTTP ${response.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
};

const waitOperation = async <T extends { status: string }>(
  path: string,
  operationId: string,
  terminal: readonly string[],
  onPoll?: () => Promise<void>,
  timeoutMs = 12 * 60_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    await onPoll?.();
    const response = await fetch(`${orchestrator}${path}?operationId=${encodeURIComponent(operationId)}`, { headers });
    if (response.ok) {
      const body = await response.json() as { operation: T };
      last = body.operation;
      if (terminal.includes(last.status)) return last;
    }
    await sleep(250);
  }
  throw new Error(`operation_timeout:${operationId}:${JSON.stringify(last ?? null)}`);
};

test("real five-room rollout keeps every Gateway bot downstream connected and preserves ordered evidence", {
  skip: !enabled,
  timeout: 15 * 60_000,
}, async () => {
  assert.ok(token, "OPS_CONTROL_TOKEN is required for the Kubernetes handoff E2E");
  assert.ok(revision, "E2E_GAME_REVISION is required for the Kubernetes handoff E2E");

  if (process.env.E2E_SKIP_CANARY !== "1") {
    const canaryStart = await json<{ operation: { operationId: string } }>(await fetch(`${orchestrator}/canary/validate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ revision }),
    }));
    const canary = await waitOperation<{ status: string; error?: string }>(
      "/canary/status",
      canaryStart.operation.operationId,
      ["approved", "blocked", "failed"],
    );
    assert.equal(canary.status, "approved", `safe revision did not pass Canary: ${canary.error ?? canary.status}`);
  }

  const baseline = await json<BotInventory>(await fetch(`${botRunner}/bots`, { headers }));
  const baselineByRoom = new Map<string, Set<string>>();
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const roomId = `room-${ordinal}`;
    const ids = new Set(baseline.bots
      .filter((bot) => bot.roomId === roomId && bot.connected)
      .map((bot) => bot.id));
    assert.ok(ids.size > 0, `no live Gateway bots in ${roomId}`);
    baselineByRoom.set(roomId, ids);
  }

  const started = await json<{ operation: { operationId: string } }>(await fetch(`${orchestrator}/rollouts/handoff`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ revision }),
  }));
  const continuityFailures: string[] = [];
  const pollContinuity = async (): Promise<void> => {
    const inventory = await json<BotInventory>(await fetch(`${botRunner}/bots`, { headers }));
    for (const [roomId, ids] of baselineByRoom) {
      for (const id of ids) {
        const bot = inventory.bots.find((candidate) => candidate.id === id);
        if (!bot?.connected || bot.roomId !== roomId) continuityFailures.push(`${roomId}:${id}`);
      }
    }
  };
  const completed = await waitOperation<{
    status: string;
    error?: string;
    completedRooms: string[];
    results: Array<{
      roomId: string;
      oldEpoch: number;
      newEpoch: number;
      checksum: string;
      sessions: number;
    }>;
  }>(
    "/rollouts/handoff/status",
    started.operation.operationId,
    ["completed", "failed"],
    pollContinuity,
  );

  assert.equal(completed.status, "completed", completed.error);
  assert.deepEqual(completed.completedRooms, ["room-0", "room-1", "room-2", "room-3", "room-4"]);
  assert.equal(continuityFailures.length, 0, `Gateway downstream continuity lost: ${continuityFailures.join(",")}`);
  assert.equal(completed.results.length, 5);
  for (const result of completed.results) {
    assert.equal(result.newEpoch, result.oldEpoch + 1);
    assert.match(result.checksum, /^[a-f\d]{64}$/);
    assert.ok(result.sessions > 0, `${result.roomId} cut over without live sessions`);
  }

  const ledger = await json<{ events: OperationEvent[] }>(await fetch(
    `${orchestrator}/rollouts/handoff/events?operationId=${encodeURIComponent(started.operation.operationId)}&limit=500`,
    { headers },
  ));
  assert.deepEqual(ledger.events.map((event) => event.sequence),
    Array.from({ length: ledger.events.length }, (_, index) => index + 1));
  assert.equal(new Set(ledger.events.map((event) => event.sequence)).size, ledger.events.length);
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const roomId = `room-${ordinal}`;
    const roomSubjects = ledger.events
      .filter((event) => event.payload.room_id === roomId)
      .map((event) => event.subject);
    for (const subject of [
      "RoomCandidateReady",
      "RoomSnapshotSeeded",
      "RoomJournalCaughtUp",
      "RoomChecksumMatched",
      "RoomEpochFenced",
      "RoomGatewayCutover",
      "RoomInputReplayCompleted",
      "RoomPostVerificationCompleted",
      "RoomOldPodDrained",
    ]) assert.ok(roomSubjects.includes(subject), `${roomId} missing ${subject}`);
  }
  assert.equal(ledger.events.at(-1)?.subject, "PostVerificationCompleted");
  assert.equal(ledger.events.at(-1)?.payload.passed, true);
});
