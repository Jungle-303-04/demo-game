import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const upstream = (...parts: string[]) => join(process.cwd(), "upstream-survev", ...parts);

test("candidate runtime is read-only and exposes bounded handoff IPC", async () => {
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  const candidate = await readFile(upstream("server/src/opsia/candidate.ts"), "utf8");
  const journal = await readFile(upstream("server/src/opsia/journal.ts"), "utf8");
  const processSource = await readFile(upstream("server/src/game/gameProcess.ts"), "utf8");
  const ipc = await readFile(upstream("server/src/game/ipcTypes.ts"), "utf8");

  const candidateStart = runtime.indexOf('if (this.role === "candidate")');
  const leaseAcquire = runtime.indexOf("await this.acquireLease()", candidateStart);
  assert.ok(candidateStart >= 0 && leaseAcquire > candidateStart);
  assert.match(runtime, /if \(this\.role === "candidate"\) throw new Error\("candidate_read_only"\)/);
  const stopStart = runtime.indexOf("async stop(): Promise<void>");
  const stopEnd = runtime.indexOf("async clearSnapshot(): Promise<void>", stopStart);
  const stop = runtime.slice(stopStart, stopEnd);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  assert.match(stop, /if \(this\.role === "active"\) await this\.releaseLeaseOnly\(\)/);
  assert.match(stop, /await this\.client\.quit\(\)/);
  assert.match(processSource, /game\.canSnapshotOpsia\(\) && now - lastOpsiaSaveAt/);
  assert.match(ipc, /OpsiaHandoffStatusResult/);
  assert.match(ipc, /OpsiaHandoffSeedResult/);
  assert.match(candidate, /candidate_epoch_mismatch/);
  assert.match(candidate, /candidate_checksum_mismatch/);
  assert.match(journal, /scannedEntries < maxEntries/);
});

test("handoff status and seed endpoints require the control token", async () => {
  const server = await readFile(upstream("server/src/gameServer.ts"), "utf8");
  for (const route of ['/ops/handoff/status', '/ops/handoff/seed']) {
    const start = server.indexOf(`app.${route.endsWith("status") ? "get" : "post"}("${route}"`);
    assert.ok(start >= 0, `${route} route missing`);
    assert.match(server.slice(start, start + 220), /authorizeOpsRequest\(res, req\)/);
  }
  assert.match(server, /zCandidateSeed/);
  assert.match(server, /if \(!status\.ready\) res\.writeStatus\("409 Conflict"\)/);
  assert.match(server, /OPSIA_ROLE === "candidate".*candidate_not_public/);
});
