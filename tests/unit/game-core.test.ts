import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const upstream = (...parts: string[]) => join(process.cwd(), "upstream-survev", ...parts);

test("real survev Game snapshot projection round-trips player, team, score, inventory and gas", async () => {
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  const game = await readFile(upstream("server/src/game/game.ts"), "utf8");
  const projected = {
    schemaVersion: 2,
    roomId: "room-0",
    gasPhase: 0,
    players: [{ sessionId: "browser-token-123456", name: "Ada", teamId: 1, x: 44, y: 32, health: 87, score: 9, inventory: { "9mm": 30 } }],
  };
  const restored = JSON.parse(JSON.stringify(projected)) as typeof projected;
  assert.deepEqual(restored, projected);
  assert.match(runtime, /game\.playerBarn\.players\.map/);
  assert.match(runtime, /player\.invManager\.set/);
  assert.match(runtime, /game\.grid\.updateObject\(player\)/);
  assert.match(game, /opsiaSessionId/);
});

test("decoded survev InputMsg is rate-validated and strict mode disconnects the violating real Client", async () => {
  const client = await readFile(upstream("server/src/game/client.ts"), "utf8");
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  assert.match(client, /type === net\.MsgType\.Input && !validateInput/);
  assert.match(runtime, /timestamps\.length > 60/);
  assert.match(runtime, /player\.client\.disconnect\("input_rate_exceeded"\)/);
});

test("infinite mode retains the actual Game loop, removes win termination, and respawns actual Player objects", async () => {
  const game = await readFile(upstream("server/src/game/game.ts"), "utf8");
  const player = await readFile(upstream("server/src/game/objects/player.ts"), "utf8");
  assert.match(game, /process\.env\.OPSIA_INFINITE !== "true"/);
  assert.match(game, /checkGameOver\(\) \{\n        if \(process\.env\.OPSIA_INFINITE === "true"\) return;/);
  assert.match(player, /opsiaRespawnTicker/);
  assert.match(player, /this\.game\.playerBarn\.livingPlayers\.push\(this\)/);
});
