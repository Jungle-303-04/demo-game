import assert from "node:assert/strict";
import test from "node:test";
import { CapturingLogSink } from "../../services/game-server/src/logger.js";
import { GameMetrics } from "../../services/game-server/src/metrics.js";
import { GameRuntime } from "../../services/game-server/src/runtime.js";
import { MemorySnapshotStore } from "../../services/game-server/src/snapshot-store.js";
import { Matchmaker, type RoomDirectory } from "../../services/api-server/src/matchmaker.js";
import { recoveryPatch } from "../../services/room-orchestrator/src/recovery.js";
import type { RoomRegistryRecord } from "../../services/room-orchestrator/src/registry.js";

const directory: RoomDirectory = { list: async () => [{ roomId: "room-0", ordinal: 0, podName: "game-0", endpoint: "http://game-0:8080", status: "running", players: 2, alive: 2, strictMode: false }] };

test("pod replacement restores the same character, faction, and score", async () => {
  const store = new MemorySnapshotStore();
  const first = new GameRuntime({ roomId: "room-0", podName: "game-0", store, owner: "before-delete" });
  await first.start();
  const joined = first.join("survivor", "Survivor");
  first.award("survivor", 11);
  const preserved = first.player("survivor");
  await first.stop(); // equivalent to a StatefulSet pod deletion after its 1s snapshot

  const replacement = new GameRuntime({ roomId: "room-0", podName: "game-0", store, owner: "after-delete" });
  await replacement.start();
  const reconnected = replacement.join("survivor", "Survivor");
  assert.equal(reconnected.reconnected, true);
  assert.equal(replacement.player("survivor")?.team, joined.player.team);
  assert.equal(replacement.player("survivor")?.score, preserved?.score);
  await replacement.stop();
});

test("scenario 01: input flood creates evidence and a strict-image rollout removes only the violating session", async () => {
  const store = new MemorySnapshotStore();
  const logs = new CapturingLogSink();
  const metrics = new GameMetrics();
  const lenient = new GameRuntime({ roomId: "room-1", podName: "game-1", store, owner: "lenient", log: logs.emit });
  await lenient.start();
  lenient.join("victim", "Viewer"); lenient.award("victim", 4); lenient.join("hack", "xX_Speed_Xx", true);
  for (let sequence = 1; sequence <= 50; sequence += 1) {
    const result = lenient.input("hack", { sequence, dx: 0.2, dy: 0 });
    metrics.observeInput("room-1", result.accepted, result.reason);
  }
  assert.ok(logs.byEvent("input_rate_exceeded").length > 0);
  assert.match(await metrics.registry.metrics(), /player_input_rate/);
  await lenient.stop();

  const strict = new GameRuntime({ roomId: "room-1", podName: "game-1", strictMode: true, store, owner: "strict", log: logs.emit });
  await strict.start();
  strict.join("victim", "Viewer");
  strict.join("hack", "xX_Speed_Xx", true);
  assert.equal(strict.input("hack", { sequence: 51, dx: 9, dy: 0 }).kick, true);
  assert.equal(strict.player("hack")?.kicked, true);
  assert.equal(strict.player("victim")?.score, 4);
  assert.deepEqual(recoveryPatch({ action: "image_rollforward", image: "ghcr.io/jungle-303-04/demo-game/game-server:strict" }).kind, "StatefulSet");
  await strict.stop();
});

test("scenario 06: join storm produces a rejection signal and deployment scale recovery accepts new joins", async () => {
  const logs = new CapturingLogSink();
  const stormed = new Matchmaker(directory, 2, () => 1_000, logs.emit);
  await stormed.findGame("a", "a"); await stormed.findGame("b", "b");
  await assert.rejects(stormed.findGame("c", "c"), /find_game_rejected:rate_limited/);
  assert.equal(logs.byEvent("find_game_rejected").length, 1);
  assert.match(await stormed.registry.metrics(), /find_game_fail_ratio/);
  assert.deepEqual(recoveryPatch({ action: "deployment_scale", replicas: 4 }), { kind: "Deployment", name: "api-server", patch: { spec: { replicas: 4 } } });
  const recovered = new Matchmaker(directory, 100);
  assert.equal((await recovered.findGame("after-scale", "after-scale")).roomId, "room-0");
});

test("scenario 08: a bad canary event is paired with an image-only rollback plan", () => {
  const logs = new CapturingLogSink();
  logs.emit({ level: "error", event: "image_pull_back_off", roomId: "room-2", server: "game-2", detail: { image: "ghcr.io/jungle-303-04/demo-game/game-server:missing" } });
  assert.equal(logs.byEvent("image_pull_back_off").length, 1);
  assert.deepEqual(recoveryPatch({ action: "image_rollback", image: "ghcr.io/jungle-303-04/demo-game/game-server:stable" }), {
    kind: "StatefulSet", name: "game", patch: { spec: { template: { spec: { containers: [{ name: "game-server", image: "ghcr.io/jungle-303-04/demo-game/game-server:stable" }] } } } },
  });
});
