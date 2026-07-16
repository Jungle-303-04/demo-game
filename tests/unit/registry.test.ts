import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRoomRegistry, RoomReconciler } from "../../services/room-orchestrator/src/registry.js";

test("registry fixes room IDs to StatefulSet ordinals and only deactivates high ordinals", async () => {
  const registry = new MemoryRoomRegistry();
  const reconciler = new RoomReconciler(registry);
  await reconciler.reconcile(3, (ordinal) => `http://game-${ordinal}:8080`);
  assert.deepEqual((await registry.list()).map((room) => [room.roomId, room.podName]), [["room-0", "game-0"], ["room-1", "game-1"], ["room-2", "game-2"]]);
  await reconciler.reconcile(2);
  const rooms = await registry.list();
  assert.equal(rooms[0]?.status, "waiting");
  assert.equal(rooms[1]?.status, "waiting");
  assert.equal(rooms[2]?.status, "inactive");
});
