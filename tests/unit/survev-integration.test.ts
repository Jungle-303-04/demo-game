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
  const audioManager = await readFile(join(process.cwd(), "upstream-survev/client/src/audioManager.ts"), "utf8");
  const clientCss = await readFile(join(process.cwd(), "upstream-survev/client/css/game.css"), "utf8");
  const gameClient = await readFile(join(process.cwd(), "upstream-survev/client/src/game.ts"), "utf8");
  const serverClient = await readFile(join(process.cwd(), "upstream-survev/server/src/game/client.ts"), "utf8");
  const opsiaRuntime = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/runtime.ts"), "utf8");
  const adminUi = await readFile(join(process.cwd(), "services/ops-console/web/src/GameAdminConsole.tsx"), "utf8");
  const adminCss = await readFile(join(process.cwd(), "services/ops-console/web/src/globals.css"), "utf8");
  const adminHtml = await readFile(join(process.cwd(), "services/ops-console/web/index.html"), "utf8");
  const mapPreviewImages = await Promise.all(["faction", "desert", "snow"].map((name) =>
    readFile(join(process.cwd(), `services/ops-console/web/public/map-previews/${name}.png`))
  ));
  const docker = await readFile(join(process.cwd(), "services/game-server/Dockerfile"), "utf8");
  assert.match(gameServer, /new GameServer\(\)/);
  assert.match(gameServer, /app\.ws<GameSocketData>\("\/play"/);
  assert.match(game, /export class Game/);
  assert.match(client, /pixi\.js-legacy/);
  assert.match(client, /matchArgs\.spectator = true/);
  assert.match(client, /opsia-watch-\$\{this\.opsiaWatchView\}/);
  assert.match(audioManager, /forcedMute = this\.permanentlyMuted/);
  assert.match(audioManager, /this\.forcedMute = this\.permanentlyMuted \|\| mute/);
  assert.match(clientCss, /html\.opsia-watch-player #game-area-wrapper > \*/);
  assert.match(clientCss, /html\.opsia-watch-map #ui-game > :not\(#big-map\)/);
  assert.match(gameClient, /m_opsiaMapView/);
  assert.match(serverClient, /client\.spectatorOnly = true/);
  assert.match(opsiaRuntime, /makeOpsMapSnapshot/);
  assert.match(opsiaRuntime, /game\.map\.riverDescs/);
  assert.match(opsiaRuntime, /game\.map\.buildings/);
  assert.match(adminUi, /function AdminTacticalMap/);
  assert.match(adminUi, /className="admin-map-game-frame"/);
  assert.match(adminUi, /selectedRoom && activeTab === "world" \? "is-world-focused"/);
  assert.match(adminCss, /\.console-shell\.is-world-focused/);
  assert.match(adminUi, /THEME_STORAGE_KEY = "survev-control-theme"/);
  assert.match(adminUi, /aria-label="라이트 모드"/);
  assert.match(adminUi, /aria-pressed=\{colorTheme === "light"\}/);
  assert.match(adminUi, /<strong>라이트<\/strong>/);
  assert.match(adminUi, /document\.documentElement\.dataset\.theme = colorTheme/);
  assert.match(adminUi, /window\.addEventListener\("storage", syncTheme\)/);
  assert.match(adminHtml, /window\.localStorage\.getItem\("survev-control-theme"\)/);
  assert.match(adminHtml, /document\.documentElement\.dataset\.theme = theme/);
  assert.ok(
    adminHtml.indexOf("survev-control-theme") < adminHtml.indexOf('src="/src/main.tsx"'),
    "saved theme must be applied before the React bundle loads",
  );
  assert.match(adminCss, /:root\[data-theme="light"\]/);
  assert.match(adminCss, /\.console-shell\.is-world-focused \{/);
  assert.match(adminUi, /room\.mapLayout/);
  assert.match(adminUi, /className="admin-map-viewport"/);
  assert.match(adminUi, /"--map-width-by-height": `\$\{mapAspect \* 100\}cqh`/);
  assert.match(adminUi, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(adminUi, /function roomWatchUrl/);
  assert.match(adminUi, /url\.searchParams\.set\("target", player\.id\)/);
  assert.match(adminUi, /function PlayerSpectatorView/);
  assert.match(gameClient, /m_opsiaPlayerView/);
  assert.match(gameClient, /this\.m_uiManager\.hideMiniMap\(\)/);
  assert.match(adminUi, /<iframe/);
  assert.match(adminUi, /documentPictureInPicture/);
  assert.match(adminUi, /documentPip\.requestWindow/);
  assert.match(adminUi, /PIP로 관전/);
  assert.match(adminUi, /SURVEV SPECTATOR · LIVE · MUTED/);
  assert.doesNotMatch(adminUi, /allow="autoplay; fullscreen"/);
  assert.match(adminUi, /전체 맵으로 돌아가기/);
  assert.match(adminUi, /상세 화면에서 실시간 전술 맵 확인/);
  assert.match(adminUi, /className="player-marker-core"/);
  assert.match(adminUi, /capabilities\.scalingAvailable && \(/);
  assert.doesNotMatch(adminUi, /방 배포 사용 불가|현재 런타임은 Kubernetes StatefulSet/);
  assert.doesNotMatch(adminUi, /RoomMiniMap|LIVE COORDINATES|mini-map-zone/);
  assert.doesNotMatch(adminUi, /preserveAspectRatio="none"/);
  assert.doesNotMatch(adminUi, /PlayerPerspective|MAP_OBJECTS|MAP_LABELS/);
  const roomCard = adminUi.slice(adminUi.indexOf("function RoomCard"), adminUi.indexOf("function RoomDirectory"));
  assert.match(roomCard, /className="room-choice-preview"/);
  assert.match(roomCard, /<img/);
  assert.doesNotMatch(roomCard, /<iframe/);
  assert.match(adminUi, /\/map-previews\/faction\.png/);
  assert.match(adminUi, /\/map-previews\/desert\.png/);
  assert.match(adminUi, /\/map-previews\/snow\.png/);
  assert.ok(mapPreviewImages.every((image) => image.byteLength > 100_000));
  assert.match(docker, /WORKDIR \/app\/upstream-survev\/server/);
  assert.match(docker, /CMD \["node", "--enable-source-maps", "dist\/gameServer\.js"\]/);
  assert.doesNotMatch(docker, /services\/game-server\/src\/main/);
});

test("the three room pods run distinct validated maps", async () => {
  const gameServer = await readFile(join(process.cwd(), "upstream-survev/server/src/gameServer.ts"), "utf8");
  const roomConfig = await readFile(join(process.cwd(), "services/game-server/survev-config.hjson"), "utf8");
  const compose = await readFile(join(process.cwd(), "docker-compose.yml"), "utf8");
  const statefulSet = await readFile(join(process.cwd(), "deploy/k8s/base/game.yaml"), "utf8");

  assert.match(gameServer, /z\.enum\(\["faction", "desert", "snow"\]\)/);
  assert.match(gameServer, /process\.env\.OPSIA_MAP_NAME \?\? "faction"/);
  assert.match(gameServer, /server\.manager\.newGame\(opsiaMode\)/);
  assert.match(gameServer, /modes: process\.env\.OPSIA_ROOM === "true" \? \[opsiaMode\] : Config\.modes/);
  assert.match(gameServer, /mapName: opsiaMapName/);
  assert.match(gameServer, /mode: opsiaModeLabel/);
  assert.match(gameServer, /maxPlayers: opsiaMaxPlayers/);
  for (const mapName of ["faction", "desert", "snow"]) {
    assert.match(roomConfig, new RegExp(`mapName: "${mapName}"`));
    assert.match(compose, new RegExp(`OPSIA_MAP_NAME: ${mapName}`));
    assert.match(statefulSet, new RegExp(`export OPSIA_MAP_NAME=${mapName}`));
  }
});
