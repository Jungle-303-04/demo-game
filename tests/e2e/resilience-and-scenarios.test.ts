import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recoveryPatch } from "../../services/room-orchestrator/src/recovery.js";

const upstream = (...parts: string[]) => join(process.cwd(), "upstream-survev", ...parts);

test("pod replacement is wired to the actual survev Game process snapshot and reconnect token", async () => {
  const processSource = await readFile(upstream("server/src/game/gameProcess.ts"), "utf8");
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  const client = await readFile(upstream("client/src/main.ts"), "utf8");
  assert.match(processSource, /new ServerGame\(msg\.id, msg\.config\)/);
  assert.match(processSource, /game\.snapshotOpsia/);
  assert.match(runtime, /room:\$\{opsiaRoomId\(\)\}:snapshot/);
  assert.match(runtime, /room:\$\{opsiaRoomId\(\)\}:lease/);
  assert.match(client, /localStorage\.getItem\("opsia-survev-session"\)/);
});

test("scenario 01 speed-hack: real protocol flood emits an input event and strict rollout is image-only", async () => {
  const bot = await readFile(upstream("server/src/opsia/botRunner.ts"), "utf8");
  const runtime = await readFile(upstream("server/src/opsia/runtime.ts"), "utf8");
  assert.match(bot, /count = this\.mode === "hack" \? 20 : 1/);
  assert.match(bot, /net\.MsgType\.Input/);
  assert.match(runtime, /input_rate_exceeded/);
  assert.deepEqual(recoveryPatch({ action: "image_rollforward", image: "ghcr.io/jungle-303-04/demo-game/game-server:strict" }).kind, "StatefulSet");
});

test("scenario 06 join-storm and 08 bad-canary retain supported recovery actions only", () => {
  assert.deepEqual(recoveryPatch({ action: "deployment_scale", replicas: 4 }), { kind: "Deployment", name: "api-server", patch: { spec: { replicas: 4 } } });
  assert.deepEqual(recoveryPatch({ action: "image_rollback", image: "ghcr.io/jungle-303-04/demo-game/game-server:stable" }).kind, "StatefulSet");
});
