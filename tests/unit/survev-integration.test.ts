import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("game server executes upstream Game/gameServer and serves the upstream PixiJS client", async () => {
  const config = await readFile(join(process.cwd(), "upstream-survev/config.ts"), "utf8");
  assert.match(config, /\{ mapName: "faction", teamMode: TeamMode\.Solo, enabled: true \}/);
  assert.match(config, /database:\s*\{\s*enabled: false/s);
  const faction = await readFile(join(process.cwd(), "upstream-survev/shared/defs/maps/factionDefs.ts"), "utf8");
  assert.match(faction, /maxPlayers: 100/);
  assert.match(faction, /factionMode: true/);
  const gameServer = await readFile(join(process.cwd(), "upstream-survev/server/src/gameServer.ts"), "utf8");
  const game = await readFile(join(process.cwd(), "upstream-survev/server/src/game/game.ts"), "utf8");
  const client = await readFile(join(process.cwd(), "upstream-survev/client/src/main.ts"), "utf8");
  const docker = await readFile(join(process.cwd(), "services/game-server/Dockerfile"), "utf8");
  assert.match(gameServer, /new GameServer\(\)/);
  assert.match(gameServer, /app\.ws<GameSocketData>\("\/play"/);
  assert.match(game, /export class Game/);
  assert.match(client, /pixi\.js-legacy/);
  assert.match(docker, /WORKDIR \/app\/upstream-survev\/server/);
  assert.match(docker, /CMD \["node", "--enable-source-maps", "dist\/gameServer\.js"\]/);
  assert.doesNotMatch(docker, /services\/game-server\/src\/main/);
});
