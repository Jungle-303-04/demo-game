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

test("registry preserves room metadata and does not expose mutable spec references", async () => {
  const registry = new MemoryRoomRegistry();
  const reconciler = new RoomReconciler(registry);
  await reconciler.reconcile(1);
  const original = await registry.get("room-0");
  assert.ok(original?.spec);
  original.spec.name = "mutated outside registry";
  assert.equal((await registry.get("room-0"))?.spec?.name, "Faction Front");

  const stored = await registry.get("room-0");
  assert.ok(stored?.spec);
  stored.spec.name = "Production Faction";
  stored.joinLocked = true;
  await registry.put(stored);
  await reconciler.reconcile(1);
  const reconciled = await registry.get("room-0");
  assert.equal(reconciled?.spec?.name, "Production Faction");
  assert.equal(reconciled?.joinLocked, true);
  assert.equal(reconciled?.spec?.mode, "Faction 50v50");
});

test("registry assigns the fixed map profile for each StatefulSet ordinal", async () => {
  const registry = new MemoryRoomRegistry();
  const reconciler = new RoomReconciler(registry);
  await reconciler.reconcile(3);
  const rooms = await registry.list();

  assert.deepEqual(rooms.map((room) => [room.spec?.map, room.spec?.mode, room.spec?.maxPlayers]), [
    ["Faction Island", "Faction 50v50", 100],
    ["Desert", "Solo FFA", 80],
    ["Snow", "Solo FFA", 80],
  ]);
});
