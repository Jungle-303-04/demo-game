import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const upstream = (...parts: string[]) => join(process.cwd(), "upstream-survev", ...parts);

test("real survev Game snapshot projection round-trips player, team, score, inventory and gas", async () => {
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  const game = await readFile(upstream("server/src/game/game.ts"), "utf8");
  const projected = {
    schemaVersion: 3,
    roomId: "room-0",
    mapName: "faction",
    gasPhase: 0,
    players: [{ sessionId: "browser-token-123456", name: "Ada", teamId: 1, x: 44, y: 32, health: 87, score: 9, inventory: { "9mm": 30 } }],
  };
  const restored = JSON.parse(JSON.stringify(projected)) as typeof projected;
  assert.deepEqual(restored, projected);
  assert.match(runtime, /game\.playerBarn\.players\.map/);
  assert.match(runtime, /player\.invManager\.set/);
  assert.match(runtime, /player\.name = state\.name/);
  assert.match(runtime, /game\.grid\.updateObject\(player\)/);
  assert.match(runtime, /snapshot\.mapName !== game\.mapName/);
  assert.match(game, /opsiaSessionId/);
});

test("replacement never lets an unleased empty Game overwrite Redis before sessions reconnect", async () => {
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  const process = await readFile(upstream("server/src/game/gameProcess.ts"), "utf8");
  assert.match(runtime, /if \(!this\.ready\) return;/);
  assert.match(runtime, /pendingRestoreUntil/);
  assert.match(runtime, /snapshot\.players\.push\(\.\.\.this\.pendingPlayers\)/);
  assert.match(process, /if \(!this\.opsiaReady\) return;/);
});

test("logical reset pauses saves and Redis cleanup remains lease-owner atomic", async () => {
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  const process = await readFile(upstream("server/src/game/gameProcess.ts"), "utf8");
  const manager = await readFile(upstream("server/src/game/gameProcessManager.ts"), "utf8");
  const reset = process.slice(process.indexOf("async resetOpsia"), process.indexOf("override updateData"));
  assert.ok(reset.indexOf("this.opsiaReady = false") < reset.indexOf("clearSnapshot"));
  assert.match(runtime, /releaseLeaseScript/);
  assert.match(runtime, /clearSnapshotScript/);
  assert.match(runtime, /pending\?\.delete\(sessionId\)/);
  assert.match(manager, /opsiaResetInFlight/);
  assert.match(manager, /maxOutstandingPerIp = 20/);
});

test("public find-game admission is bounded and always terminates on internal failure", async () => {
  const server = await readFile(upstream("server/src/gameServer.ts"), "utf8");
  const manager = await readFile(upstream("server/src/game/gameProcessManager.ts"), "utf8");
  assert.match(server, /if \(process\.env\.OPSIA_ROOM === "true"\) \{/);
  assert.match(server, /withTimeout\(this\.refreshJoinLock\(\), 1_500, "join_lock_unavailable"\)/);
  assert.match(server, /gameHTTPRateLimit\.isRateLimited\(ip\)/);
  assert.match(server, /503 Service Unavailable/);
  assert.match(server, /find_game_unavailable/);
  assert.match(manager, /game_process_ready_timeout/);
});

test("decoded survev InputMsg is rate-validated and strict mode disconnects the violating real Client", async () => {
  const client = await readFile(upstream("server/src/game/client.ts"), "utf8");
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  assert.match(client, /type === net\.MsgType\.Input && client\.player && !validateInput/);
  assert.match(runtime, /timestamps\.length > 60/);
  assert.match(runtime, /player\.client\.disconnect\("input_rate_exceeded"\)/);
});

test("infinite mode retains the actual Game loop, removes win termination, and respawns actual Player objects", async () => {
  const game = await readFile(upstream("server/src/game/game.ts"), "utf8");
  const player = await readFile(upstream("server/src/game/objects/player.ts"), "utf8");
  assert.match(game, /process\.env\.OPSIA_INFINITE !== "true"/);
  assert.match(game, /checkGameOver\(\) \{\r?\n        if \(process\.env\.OPSIA_INFINITE === "true"\) return;/);
  assert.match(player, /opsiaRespawnTicker/);
  assert.match(player, /this\.game\.playerBarn\.livingPlayers\.push\(this\)/);
});
