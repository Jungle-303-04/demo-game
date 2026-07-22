import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRoomRegistry, RoomReconciler } from "../../services/room-orchestrator/src/registry.js";

test("registry fixes room IDs to room Deployment names and only deactivates high ordinals", async () => {
  const registry = new MemoryRoomRegistry();
  const reconciler = new RoomReconciler(registry);
  await reconciler.reconcile(3);
  assert.deepEqual((await registry.list()).map((room) => [room.roomId, room.podName]), [["room-0", "game-room-0"], ["room-1", "game-room-1"], ["room-2", "game-room-2"]]);
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

test("registry assigns the fixed map profile for each room Deployment ordinal", async () => {
  const registry = new MemoryRoomRegistry();
  const reconciler = new RoomReconciler(registry);
  await reconciler.reconcile(5);
  const rooms = await registry.list();

  assert.deepEqual(rooms.map((room) => [room.spec?.map, room.spec?.mode, room.spec?.maxPlayers]), [
    ["Faction Island", "Faction 50v50", 100],
    ["Desert", "Solo FFA", 80],
    ["Snow", "Solo FFA", 80],
    ["Main Island", "Solo FFA", 80],
    ["Woods", "Solo FFA", 80],
  ]);
});

test("registry adds a room discovered from a labeled Kubernetes workload and preserves its stable roomId", async () => {
  const registry = new MemoryRoomRegistry();
  const reconciler = new RoomReconciler(registry);
  await reconciler.reconcileWorkloads([{
    roomId: "room-6",
    ordinal: 6,
    deploymentName: "suroi-room-demo-6-7f8c9d",
    serviceName: "game-room-6",
    endpoint: "http://game-room-6:8001",
    replicas: 1,
  }]);
  const room = await registry.get("room-6");
  assert.equal(room?.roomId, "room-6");
  assert.equal(room?.podName, "suroi-room-demo-6-7f8c9d");
  assert.equal(room?.endpoint, "http://game-room-6:8001");
  assert.equal(room?.status, "waiting");
  assert.equal(room?.spec?.name, "Desert Run 2");

  await reconciler.reconcileWorkloads([]);
  assert.equal((await registry.get("room-6"))?.status, "inactive");
});
