import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("active room deletion snapshots, scales, then removes Redis state", async () => {
  const source = await readFile("services/room-orchestrator/src/main.ts", "utf8");
  const start = source.indexOf('request.method === "DELETE"');
  const end = source.indexOf('request.method === "POST" && room && path === `/rooms/${room.roomId}/failure`');
  assert.ok(start >= 0 && end > start);
  const deletion = source.slice(start, end);
  const snapshotAt = deletion.indexOf('/ops/snapshot/save');
  const scaleAt = deletion.indexOf("scaleAndReconcile");
  const removeAt = deletion.indexOf("await registry.remove");
  assert.ok(snapshotAt >= 0 && snapshotAt < scaleAt && scaleAt < removeAt);
  assert.doesNotMatch(deletion, /\/ops\/end/);
});
