import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("survev subtree enables the 100-player faction map and disables the account database", async () => {
  const config = await readFile(join(process.cwd(), "upstream-survev/config.ts"), "utf8");
  assert.match(config, /\{ mapName: "faction", teamMode: TeamMode\.Solo, enabled: true \}/);
  assert.match(config, /database:\s*\{\s*enabled: false/s);
  const faction = await readFile(join(process.cwd(), "upstream-survev/shared/defs/maps/factionDefs.ts"), "utf8");
  assert.match(faction, /maxPlayers: 100/);
  assert.match(faction, /factionMode: true/);
});
