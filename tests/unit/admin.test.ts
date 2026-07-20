import assert from "node:assert/strict";
import test from "node:test";
import { buildAdminRooms, fetchJson, UpstreamError } from "../../services/ops-console/src/admin.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("admin room projection uses real map dimensions, live player fields, and bot sessions", async (context) => {
  const capturedAt = Date.now();
  const originalFetch = globalThis.fetch;
  const originalUrls = process.env.PUBLIC_ROOM_URLS;
  const originalTemplate = process.env.PUBLIC_ROOM_URL_TEMPLATE;
  delete process.env.PUBLIC_ROOM_URLS;
  delete process.env.PUBLIC_ROOM_URL_TEMPLATE;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrls === undefined) delete process.env.PUBLIC_ROOM_URLS;
    else process.env.PUBLIC_ROOM_URLS = originalUrls;
    if (originalTemplate === undefined) delete process.env.PUBLIC_ROOM_URL_TEMPLATE;
    else process.env.PUBLIC_ROOM_URL_TEMPLATE = originalTemplate;
  });

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "http://orchestrator/rooms") return json({ rooms: [{
      roomId: "room-0",
      ordinal: 0,
      podName: "game-0",
      endpoint: "http://game-0",
      status: "waiting",
      players: 0,
      alive: 0,
      strictMode: false,
      joinLocked: true,
      statusChangedAt: new Date().toISOString(),
      spec: {
        name: "Live Faction",
        description: "real room",
        region: "Seoul / ap-northeast-2",
        map: "Faction Island",
        mode: "Faction 50v50",
        maxPlayers: 100,
        createdAt: new Date().toISOString(),
      },
    }] });
    if (url === "http://bots/bots") return json({ bots: [{
      id: "bot-1",
      sessionId: "session-bot-1",
      roomId: "room-0",
      mode: "normal",
      connected: true,
    }] });
    if (url === "http://game-0/summary") return json({
      roomId: "room-0",
      status: "running",
      players: 1,
      alive: 1,
      podName: "game-0",
      strictMode: false,
      joinLocked: true,
      capturedAt,
      tickP95Ms: 8,
      cpuPercent: 42,
      memoryMb: 256,
      uptimeSeconds: 90,
    });
    if (url === "http://game-0/ops/snapshot") return json({
      roomId: "room-0",
      capturedAt,
      map: {
        name: "faction",
        factionMode: true,
        maxPlayers: 100,
        seed: 4242,
        width: 880,
        height: 500,
        shoreInset: 12,
        grassInset: 18,
        rivers: [{ width: 14, looped: false, points: [{ x: 100, y: 0 }, { x: 120, y: 500 }] }],
        places: [{ name: "Riverside", x: 0.5, y: 0.4 }],
        objects: [{
          id: 7,
          type: "house_red_01",
          kind: "building",
          x: 220,
          y: 125,
          width: 40,
          height: 24,
        }],
      },
      zone: { x: 440, y: 100, radius: 220, nextX: 660, nextY: 125, nextRadius: 110 },
      tickP95Ms: 8,
      tickRate: 100,
      cpuPercent: 42,
      memoryMb: 256,
      uptimeSeconds: 90,
      strictMode: false,
      inputAccepted: 4,
      inputRejected: 0,
      players: [
        {
          sessionId: "session-bot-1",
          nickname: "ProtocolClient",
          teamId: 1,
          team: "red",
          x: 440,
          y: 100,
          vx: 8.8,
          vy: 5,
          alive: true,
          score: 3,
          rotation: 1.25,
          health: 87,
          armor: 33,
          weapon: "ak47",
          ammo: 24,
          isBot: false,
          connected: true,
        },
        {
          sessionId: "disconnected",
          nickname: "Gone",
          teamId: 2,
          team: "blue",
          x: 1,
          y: 1,
          alive: false,
          score: 0,
          connected: false,
        },
      ],
    });
    return json({ error: "unexpected_url", url }, 500);
  }) as typeof fetch;

  const [room] = await buildAdminRooms("http://orchestrator", "http://bots");
  assert.ok(room);
  assert.equal(room.status, "running");
  assert.equal(room.mode, "Faction 50v50");
  assert.equal(room.map, "Faction Island");
  assert.equal(room.maxPlayers, 100);
  assert.equal(room.joinLocked, true);
  assert.equal(room.serviceUrl, "/play/room-0/");
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0]?.x, 50);
  assert.equal(room.players[0]?.y, 80);
  assert.equal(room.players[0]?.vx, 1);
  assert.equal(room.players[0]?.vy, -1);
  assert.ok(Math.abs((room.players[0]?.rotation ?? 0) - (Math.PI / 2 - 1.25)) < 1e-12);
  assert.equal(room.players[0]?.isBot, true);
  assert.equal(room.players[0]?.health, 87);
  assert.equal(room.seed, 4242);
  assert.equal(room.mapLayout.width, 880);
  assert.equal(room.mapLayout.shoreInset, 12);
  assert.equal(room.mapLayout.rivers[0]?.points[0]?.y, 500);
  assert.equal(room.mapLayout.rivers[0]?.points[1]?.y, 0);
  assert.equal(room.mapLayout.places[0]?.name, "Riverside");
  assert.equal(room.mapLayout.places[0]?.x, 440);
  assert.equal(room.mapLayout.places[0]?.y, 200);
  assert.equal(room.mapLayout.objects[0]?.kind, "building");
  assert.equal(room.mapLayout.objects[0]?.x, 220);
  assert.equal(room.mapLayout.objects[0]?.y, 375);
  assert.equal(room.zone.x, 50);
  assert.equal(room.zone.y, 80);
  assert.equal(room.zone.nextX, 75);
  assert.equal(room.zone.nextY, 75);
  assert.equal(room.podHealthy, true);
  assert.equal(room.metrics.websocketCount, 1);
  assert.equal(room.metrics.inputAccepted, 4);
  assert.equal(room.metrics.inputRejected, 0);
});

test("a waiting room becomes degraded after its provisioning grace period", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "http://orchestrator/rooms") return json({ rooms: [{
      roomId: "room-0",
      ordinal: 0,
      podName: "game-0",
      endpoint: "http://game-0",
      status: "waiting",
      players: 0,
      alive: 0,
      strictMode: false,
      statusChangedAt: "1970-01-01T00:00:00.000Z",
    }] });
    if (url === "http://bots/bots") return json({ bots: [] });
    return json({ error: "unavailable" }, 503);
  }) as typeof fetch;

  const [room] = await buildAdminRooms("http://orchestrator", "http://bots");
  assert.equal(room?.status, "degraded");
  assert.equal(room?.podHealthy, false);
});

test("fetchJson preserves an upstream status and JSON error body", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => json({ error: "room_locked" }, 409)) as typeof fetch;
  await assert.rejects(
    fetchJson("http://game/command"),
    (error: unknown) => error instanceof UpstreamError
      && error.status === 409
      && (error.body as { error?: string }).error === "room_locked",
  );
});
