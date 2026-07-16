import assert from "node:assert/strict";
import test from "node:test";
import { CapturingLogSink } from "../../services/game-server/src/logger.js";
import { DemoRoom } from "../../services/game-server/src/room.js";
import { GameRuntime } from "../../services/game-server/src/runtime.js";
import { MemorySnapshotStore } from "../../services/game-server/src/snapshot-store.js";

test("snapshot serializes and restores a player round-trip", async () => {
  const store = new MemorySnapshotStore();
  const logs = new CapturingLogSink();
  const first = new GameRuntime({ roomId: "room-0", podName: "game-0", store, owner: "old", log: logs.emit });
  await first.start();
  first.join("session-a", "Ada");
  first.award("session-a", 7);
  first.input("session-a", { sequence: 1, dx: 0.5, dy: -0.25 });
  const before = first.player("session-a");
  await first.stop();

  const replacement = new GameRuntime({ roomId: "room-0", podName: "game-0", store, owner: "new", log: logs.emit });
  await replacement.start();
  const resumed = replacement.join("session-a", "Ada");
  assert.equal(resumed.reconnected, true);
  assert.deepEqual(replacement.player("session-a"), { ...before, connected: true });
  assert.ok(logs.byEvent("snapshot_restored").length > 0);
  await replacement.stop();
});

test("input validation accepts normal input, drops floods, and strict mode kicks violations", () => {
  let now = 10_000;
  const lenientLogs = new CapturingLogSink();
  const lenient = new DemoRoom({ roomId: "room-1", podName: "game-1", now: () => now, log: lenientLogs.emit });
  lenient.start();
  lenient.join("normal", "Normal");
  assert.equal(lenient.applyInput("normal", { sequence: 1, dx: 0.2, dy: 0.2 }).accepted, true);
  for (let sequence = 2; sequence <= 42; sequence += 1) lenient.applyInput("normal", { sequence, dx: 0.1, dy: 0 });
  assert.ok(lenientLogs.byEvent("input_rate_exceeded").length > 0);
  assert.equal(lenient.getPlayer("normal")?.kicked, false);

  const strict = new DemoRoom({ roomId: "room-2", podName: "game-2", strictMode: true, now: () => now });
  strict.start();
  strict.join("cheater", "xX_Speed_Xx");
  const violation = strict.applyInput("cheater", { sequence: 1, dx: 99, dy: 0 });
  assert.deepEqual(violation, { accepted: false, reason: "movement", kick: true });
  assert.equal(strict.getPlayer("cheater")?.kicked, true);
  now += 1_001;
});

test("infinite match respawns dead players and retains score without a win state", () => {
  let now = 5_000;
  const room = new DemoRoom({ roomId: "room-3", podName: "game-3", now: () => now });
  room.start();
  room.join("player", "Player");
  room.award("player", 3);
  room.eliminate("player");
  assert.equal(room.getPlayer("player")?.alive, false);
  now += 1_000;
  room.tick();
  const player = room.getPlayer("player");
  assert.equal(player?.alive, true);
  assert.equal(player?.score, 3);
  assert.equal(room.snapshot().status, "running");
});
