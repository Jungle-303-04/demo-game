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
  const clientUi = await readFile(join(process.cwd(), "upstream-survev/client/src/ui/ui.ts"), "utf8");
  const audioManager = await readFile(join(process.cwd(), "upstream-survev/client/src/audioManager.ts"), "utf8");
  const clientCss = await readFile(join(process.cwd(), "upstream-survev/client/css/game.css"), "utf8");
  const clientHtml = await readFile(join(process.cwd(), "upstream-survev/client/index.html"), "utf8");
  const gameClient = await readFile(join(process.cwd(), "upstream-survev/client/src/game.ts"), "utf8");
  const serverClient = await readFile(join(process.cwd(), "upstream-survev/server/src/game/client.ts"), "utf8");
  const opsiaRuntime = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/runtime.ts"), "utf8");
  const deadBodies = await readFile(join(process.cwd(), "upstream-survev/server/src/game/objects/deadBody.ts"), "utf8");
  const loot = await readFile(join(process.cwd(), "upstream-survev/server/src/game/objects/loot.ts"), "utf8");
  const player = await readFile(join(process.cwd(), "upstream-survev/server/src/game/objects/player.ts"), "utf8");
  const adminUi = await readFile(join(process.cwd(), "services/ops-console/web/src/GameAdminConsole.tsx"), "utf8");
  const failureScenarioUi = await readFile(join(process.cwd(), "services/ops-console/web/src/FailureScenarioPage.tsx"), "utf8");
  const roomDisplay = await readFile(join(process.cwd(), "services/ops-console/web/src/room-display.ts"), "utf8");
  const controlPlaneClient = await readFile(join(process.cwd(), "services/ops-console/web/src/control-plane-client.ts"), "utf8");
  const opsConsoleServer = await readFile(join(process.cwd(), "services/ops-console/src/main.ts"), "utf8");
  const opsConsoleAdmin = await readFile(join(process.cwd(), "services/ops-console/src/admin.ts"), "utf8");
  const roomOrchestrator = await readFile(
    join(process.cwd(), "services/room-orchestrator/src/main.ts"),
    "utf8",
  );
  const failureScenarios = await readFile(join(process.cwd(), "services/ops-console/src/failure-scenarios.ts"), "utf8");
  const botRunner = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/botRunner.ts"), "utf8");
  const botStarterWeapon = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/botStarterWeapon.ts"), "utf8");
  const botRouting = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/botRouting.ts"), "utf8");
  const sessionGatewaySource = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/sessionGateway.ts"), "utf8");
  const gameProcessManager = await readFile(join(process.cwd(), "upstream-survev/server/src/game/gameProcessManager.ts"), "utf8");
  const adminCss = await readFile(join(process.cwd(), "services/ops-console/web/src/globals.css"), "utf8");
  const adminHtml = await readFile(join(process.cwd(), "services/ops-console/web/index.html"), "utf8");
  const docker = await readFile(join(process.cwd(), "services/game-server/Dockerfile"), "utf8");
  const compose = await readFile(join(process.cwd(), "docker-compose.yml"), "utf8");
  assert.match(gameServer, /new GameServer\(\)/);
  assert.match(gameServer, /app\.ws<GameSocketData>\("\/play"/);
  assert.match(game, /export class Game/);
  assert.match(client, /pixi\.js-legacy/);
  assert.match(client, /matchArgs\.spectator = true/);
  assert.match(client, /opsia-watch-\$\{this\.opsiaWatchView\}/);
  assert.match(client, /this\.opsiaPlay \|\| this\.opsiaWatch/);
  assert.match(client, /type: "opsia-spectator-key"/);
  assert.match(client, /event\.stopImmediatePropagation\(\)/);
  assert.match(client, /this\.pixi\.ticker\.maxFPS = 5/);
  assert.match(client, /this\.pixi\.ticker\.maxFPS = this\.opsiaWallFps/);
  assert.match(client, /__opsiaDriveSpectatorFrame/);
  assert.match(client, /this\.pixi\?\.ticker\.stop\(\)/);
  assert.match(client, /this\.pixi\?\.ticker\.update\(frameAt\)/);
  assert.match(client, /this\.game\.updateOpsiaWall\(dt\)/);
  assert.match(gameClient, /updateOpsiaWall\(dt: number\)[\s\S]*this\.m_render\(dt, debug, false\)/);
  assert.ok(clientHtml.includes("else if (/^\\/watch\\/room-\\d+\\/?$/.test(opsiaPath))"));
  assert.match(clientHtml, /`opsia-watch-\$\{opsiaWatchView\}`/);
  assert.ok(clientHtml.indexOf("opsia-watch-${opsiaWatchView}") < clientHtml.indexOf("css/app.css"));
  assert.match(audioManager, /forcedMute = this\.permanentlyMuted/);
  assert.match(audioManager, /this\.forcedMute = this\.permanentlyMuted \|\| mute/);
  assert.match(audioManager, /if \(this\.permanentlyMuted\) \{\s*this\.preloadedSounds = true;\s*return;/s);
  assert.match(client, /const rendererRes = this\.opsiaWatch\s*\? this\.opsiaWallFps > 0/s);
  assert.match(client, /this\.opsiaWallFps <= 45 \? 1 : 0\.9/);
  assert.match(client, /__opsiaWallLightFrames/);
  assert.match(client, /opsiaControllerOrigin/);
  assert.match(client, /data\.type !== "opsia-spectator-control"/);
  assert.match(client, /data\.type === "opsia-spectator-stats-request"/);
  assert.match(client, /type: "opsia-spectator-status"/);
  assert.match(client, /event\.source !== window\.parent/);
  assert.match(client, /event\.origin !== this\.opsiaControllerOrigin/);
  assert.match(clientUi, /window\.parent !== window && window\.__opsiaSpectatorControllerOrigin/);
  assert.doesNotMatch(clientUi, /opsia-spectator-target[\s\S]{0,160}, "\*"/);
  assert.match(clientCss, /html\.opsia-watch-player #game-area-wrapper > \*/);
  assert.match(clientCss, /html\.opsia-watch-map #ui-game > :not\(#big-map\)/);
  assert.match(clientCss, /html\.opsia-watch:not\(\.opsia-in-game\) #cvs/);
  assert.match(gameClient, /m_opsiaMapView/);
  assert.match(serverClient, /client\.spectatorOnly = true/);
  assert.match(serverClient, /this\.spectatorOnly \|\| this\.shouldSpectateTeam\(\) \? 0\.1 : 1/);
  assert.match(serverClient, /client\.opsiaBot = process\.env\.OPSIA_ROOM === "true" && joinMsg\.bot/);
  assert.match(serverClient, /process\.env\.OPSIA_ROOM === "true" && player\.bot[\s\S]*removePlayer\(player\)/);
  assert.match(serverClient, /if \(client\.opsiaBot\)/);
  assert.match(serverClient, /client\.sendInstantMsg\(net\.MsgType\.AliveCounts, ready\)/);
  assert.match(serverClient, /client\.msgsToSend\.length = 0/);
  assert.match(opsiaRuntime, /makeOpsMapSnapshot/);
  assert.match(opsiaRuntime, /game\.map\.riverDescs/);
  assert.match(opsiaRuntime, /game\.map\.buildings/);
  assert.match(opsiaRuntime, /game\.lootBarn\.loots/);
  assert.match(opsiaRuntime, /primaryReserve: weaponReserve/);
  assert.match(opsiaRuntime, /throwableCount: player\.weapons\[3\]/);
  assert.match(adminUi, /function TacticalMap/);
  assert.match(adminUi, /function ActualGameMap/);
  assert.doesNotMatch(adminUi, /function roomMapUrl/);
  assert.match(adminUi, /function drawLiveMap/);
  assert.match(adminUi, /LiveMapCanvas/);
  assert.match(adminUi, /ResizeObserver/);
  assert.match(adminUi, /room\.mapLayout/);
  assert.match(adminUi, /className="actual-game-map"/);
  assert.match(adminUi, /"--player-x": player\.x/);
  assert.match(adminUi, /"--player-y": player\.y/);
  assert.match(adminCss, /transition: transform 360ms linear/);
  assert.match(adminCss, /will-change: transform/);
  assert.match(adminUi, /function roomWatchUrl/);
  assert.match(adminUi, /wallFps/);
  assert.match(adminUi, /url\.searchParams\.set\("target", player\.id\)/);
  assert.match(adminUi, /function PlayerSpectatorView/);
  assert.match(adminUi, /function SpectatorWall/);
  assert.match(adminUi, /type SpectatorViewCount = 1 \| 2 \| 4/);
  assert.match(adminUi, /useState<SpectatorViewCount>\(1\)/);
  assert.match(adminUi, /\(\[1, 2, 4\] as const\)/);
  assert.doesNotMatch(adminUi, /\[1, 4, 16\]|layout: 4 \| 16/);
  assert.match(adminUi, /direction \* stride/);
  assert.match(adminUi, /Math\.min\(spectatorViewCount, alivePlayers\.length\)/);
  assert.match(adminUi, /\(unwrappedIndex % alivePlayers\.length\) \+ alivePlayers\.length/);
  assert.doesNotMatch(adminCss, /\.spectator-wall\[data-layout="16"\]/);
  assert.match(adminCss, /\.spectator-wall\[data-layout="2"\][^}]*grid-template-columns: repeat\(2,/s);
  assert.match(adminUi, /type: "opsia-spectator-control"/);
  assert.match(adminUi, /drawNow: false/);
  assert.match(adminUi, /url\.searchParams\.set\("controllerOrigin", window\.location\.origin\)/);
  assert.match(adminUi, /data\.version === 1[\s\S]*data\.playing === true/);
  assert.match(adminUi, /frame\.contentWindow === event\.source/);
  assert.match(adminUi, /get\("spectatorDebug"\) === "1"/);
  assert.match(adminUi, /tile\.dataset\.wallFrames/);
  assert.match(adminUi, /visiblePlayers\.map\(\(player, index\) =>/);
  assert.match(adminUi, /loadDelayMs=\{index \* 200\}/);
  assert.doesNotMatch(adminUi, /targetFps=\{60\}/);
  assert.match(adminUi, /wallFps=\{layout === 4 \? 45 : 60\}/);
  assert.match(adminUi, /loadAttempt >= 3/);
  assert.match(adminUi, /}, 6_000\)/);
  assert.match(adminUi, /className="spectator-loading"/);
  assert.doesNotMatch(adminUi, /selectedOutsideBase|prewarm budget|is-hidden/);
  assert.doesNotMatch(adminUi, /__opsiaDriveSpectatorFrame|driveSpectatorFrame|selfDriven|registerFrame/);
  assert.match(gameClient, /m_opsiaPlayerView/);
  assert.match(gameClient, /this\.m_uiManager\.hideMiniMap\(\)/);
  assert.match(adminUi, /<iframe/);
  assert.doesNotMatch(adminUi, /allow="autoplay; fullscreen"/);
  assert.match(adminUi, /event\.key === "Tab"/);
  assert.match(adminUi, /selectAdjacentPlayer/);
  assert.match(adminUi, /data\.type !== "opsia-spectator-key"/);
  assert.match(adminUi, /event\.origin !== expectedOrigin/);
  assert.match(adminUi, /localeCompare\(right\.name, "ko"\)/);
  assert.match(adminUi, /event\.key\.toLowerCase\(\) === "m"/);
  assert.match(adminUi, /requestFullscreen\(\)/);
  assert.match(adminUi, /documentPictureInPicture/);
  assert.match(adminUi, /controller\.requestWindow/);
  assert.match(adminUi, /createPortal\(liveStage, pipSession\.container\)/);
  assert.match(adminUi, /world-stage\$\{isInlinePip \? " is-inline-pip" : ""\}/);
  assert.match(adminUi, /function firstAlivePlayer\(room\?: GameRoom\)/);
  assert.match(adminUi, /function openRoomForSpectating\(roomId: string\)[\s\S]*setPlayerSpectating\(true\)[\s\S]*setSelectedPlayerId\(firstAlivePlayer\(room\)\?\.id \?\? ""\)/);
  assert.match(adminUi, /onOpenRoom=\{openRoomForSpectating\}/);
  assert.match(adminUi, /if \(playerSpectating\) \{[\s\S]*setSelectedPlayerId\(firstAlivePlayer\(selectedRoom\)\?\.id \?\? ""\)/);
  assert.match(adminCss, /\.server-grid \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s);
  assert.doesNotMatch(adminCss, /\.server-grid\[data-room-count="5"\][^}]*grid-column: span 3/s);
  assert.match(adminCss, /\.server-block \{[^}]*linear-gradient\(#080a0d, #080a0d\) padding-box,/s);
  assert.match(adminCss, /\.server-block-name \{[^}]*color: #fff;/s);
  assert.match(adminCss, /\.server-block-menu-popover/);
  assert.match(adminCss, /\.world-stage\.is-inline-pip \{[^}]*aspect-ratio: 1;/s);
  assert.match(adminUi, /controlPlaneClient\.addBots/);
  assert.match(adminUi, /controlPlaneClient\.removeBots/);
  assert.match(adminUi, /className="remove-bots-button"/);
  assert.match(adminUi, /controlPlaneClient\.startFailureScenario\(roomId, "admission-storm"\)/);
  assert.match(adminUi, /onRunAdmissionStorm=\{\(roomId\) => void startAdmissionStorm\(roomId\)\}/);
  assert.match(adminUi, /입장 서버 장애/);
  assert.match(adminUi, /onRecoverAdmissionStorm=\{\(roomId\) => void recoverAdmissionStorm\(roomId\)\}/);
  assert.match(adminUi, /className="is-recovery"/);
  assert.match(adminUi, /복구 검증/);
  assert.match(compose, /api-server:\s+[\s\S]*?restart: on-failure/);
  assert.match(adminUi, /snapshotCapturedAt > 0/);
  assert.doesNotMatch(adminUi, /ROOM_FORM_DEFAULTS|ManagementTab/);
  assert.doesNotMatch(adminUi, /import \{ FailureScenarioPage \}/);
  assert.match(adminUi, /window\.addEventListener\("popstate", handlePopState\)/);
  assert.doesNotMatch(adminUi, /href="\/scenarios"/);
  assert.doesNotMatch(adminUi, /<FailureScenarioPage/);
  assert.match(adminUi, /className="border-metric-tabs"/);
  assert.match(adminUi, /role="tablist"/);
  for (const scenarioId of [
    "admission-lock",
    "bot-surge",
    "malicious-input",
    "admission-storm",
    "process-crash",
    "pod-failure",
  ]) {
    assert.match(failureScenarioUi, new RegExp(`id: "${scenarioId}"`));
    assert.match(failureScenarios, new RegExp(`"${scenarioId}"`));
  }
  assert.match(failureScenarioUi, /window\.setInterval\([\s\S]*1_000/);
  assert.match(failureScenarioUi, /className="scenario-confirmation"/);
  assert.match(failureScenarioUi, /setConfirmation\(\{ roomId: selectedRoom\.id, scenarioId: scenario\.id \}\)/);
  assert.match(failureScenarioUi, /controlPlaneClient\.startFailureScenario/);
  assert.match(failureScenarioUi, /controlPlaneClient\.recoverFailureScenario/);
  assert.match(failureScenarioUi, /scenario\.requiresPodFailure && !podFailureAvailable/);
  assert.match(failureScenarioUi, /selectedScenarioRoom\?\.lastResults\[scenario\.id\]/);
  assert.match(failureScenarioUi, /events\.filter\(\(event\) => event\.roomId === selectedRoomId\)/);
  assert.match(failureScenarioUi, /inputRejected/);
  assert.match(failureScenarioUi, /function roomPressureProfile/);
  assert.match(failureScenarioUi, /scenarioRoom\.active\.scenarioId !== "admission-storm"/);
  assert.match(failureScenarioUi, /로비 입장 실패율/);
  assert.match(failureScenarioUi, /className="scenario-room-carousel"/);
  assert.match(failureScenarioUi, /className="scenario-load-score"/);
  assert.match(failureScenarioUi, /className="scenario-graph-line"/);
  assert.match(failureScenarioUi, /selectAdjacentRoom/);
  const scenarioRoomCarousel = failureScenarioUi.slice(
    failureScenarioUi.indexOf('className="scenario-room-carousel"'),
    failureScenarioUi.indexOf("{!selectedRoom"),
  );
  assert.match(scenarioRoomCarousel, /profile\.latency/);
  assert.match(scenarioRoomCarousel, /profile\.drop/);
  assert.doesNotMatch(scenarioRoomCarousel, /room\.map/);
  assert.match(controlPlaneClient, /getFailureScenarios\(\)/);
  assert.match(controlPlaneClient, /\/api\/admin\/scenarios/);
  assert.match(controlPlaneClient, /normalizeLobbyAdmissionStatus/);
  assert.match(controlPlaneClient, /admission\?: unknown/);
  assert.doesNotMatch(controlPlaneClient, /survev-admin-token|window\.prompt|authorization: `Bearer/);
  assert.doesNotMatch(adminUi, /withControlPlaneAdminTokenRetry|관리자 토큰/);
  assert.doesNotMatch(failureScenarioUi, /withControlPlaneAdminTokenRetry|관리자 토큰/);
  assert.doesNotMatch(opsConsoleServer, /OPS_ADMIN_TOKEN|REQUIRE_ADMIN_TOKEN|admin_token_required|timingSafeEqual/);
  assert.match(failureScenarios, /new AdmissionLoadController/);
  assert.match(failureScenarios, /process\.env\.ADMISSION_GATEWAY_URL/);
  assert.doesNotMatch(failureScenarios, /admission-overload\/(?:arm|recover|disarm)/);
  assert.match(failureScenarios, /failureMode: "capacity-regression"/);
  assert.match(failureScenarios, /admission_capacity_recovery_not_verified/);
  assert.doesNotMatch(failureScenarios, /api-server\/scale/);
  assert.match(failureScenarioUi, /function AdmissionCapacityPanel/);
  assert.match(failureScenarioUi, /failureRatePercent/);
  assert.match(roomOrchestrator, /const existingRoomIds = new Set/);
  assert.ok(
    roomOrchestrator.indexOf("`${gatewayEndpoint}/internal/rooms`")
      < roomOrchestrator.indexOf("`${gatewayEndpoint}/internal/rooms/${encodeURIComponent(workload.roomId)}/register`"),
  );
  assert.match(failureScenarios, /pod_failure_requires_kubernetes/);
  assert.match(failureScenarios, /\/bots\/jobs\/\$\{encodeURIComponent\(run\.jobId\)\}\/cleanup/);
  assert.match(botRunner, /OPSIA_MIN_BOTS_PER_ROOM/);
  assert.match(botRunner, /for \(const id of job\.createdBotIds\)/);
  assert.match(botRunner, /const NORMAL_BOT_INPUT_INTERVAL_MS = 100/);
  assert.match(botRunner, /const BOT_AWARENESS_INTERVAL_MS = 750/);
  assert.match(botRunner, /const BOT_DECISION_INTERVAL_MS = 650/);
  assert.match(botStarterWeapon, /DEFAULT_OPSIA_BOT_STARTER_GUNS/);
  assert.match(botStarterWeapon, /selectOpsiaBotStarterGun/);
  assert.match(compose, /OPSIA_BOT_STARTER_GUNS: "\$\{OPSIA_BOT_STARTER_GUNS:-mp5,mac10,vector,hk416,ak47,scar,mosin,m870,mp220,saiga,spas12,m9\}"/);
  assert.match(botRunner, /OPSIA_BOT_TACTICAL_BRAIN === "true"/);
  assert.match(compose, /OPSIA_BOT_TACTICAL_BRAIN: "\$\{OPSIA_BOT_TACTICAL_BRAIN:-false\}"/);
  assert.match(botRunner, /OPSIA_BOT_LIGHTWEIGHT_COMBAT !== "false"/);
  assert.match(compose, /OPSIA_BOT_LIGHTWEIGHT_COMBAT: "\$\{OPSIA_BOT_LIGHTWEIGHT_COMBAT:-true\}"/);
  assert.match(gameServer, /brainMode === "lite"/);
  assert.match(gameServer, /obstacle\.destructible && obstacle\.containsLoot && obstacle\.health > 0/);
  assert.match(botRunner, /summaryResponse = await fetch\([\s\S]*AbortSignal\.timeout\(8_000\)/);
  assert.match(opsConsoleServer, /botRunner\}\/bots\/jobs[\s\S]*10_000\)/);
  assert.match(botRunner, /roomBrainEnabled \? roomAwareness\.get\(this\.roomId\)\?\.snapshot : undefined/);
  assert.match(botRunner, /decideLightweightCombatIntent\(snapshot, this\.sessionId, this\.brain\)/);
  assert.match(botRunner, /if \(!this\.cachedIntent \|\| now >= this\.nextDecisionAt\)/);
  assert.match(botRunner, /}, \{ once: true \}\);/);
  assert.doesNotMatch(botRunner, /BOT_JOIN_READY_GRACE_MS/);
  assert.match(botRunner, /const SURGE_BOT_INPUT_INTERVAL_MS = 60/);
  assert.match(botRunner, /const SURGE_BOT_INPUTS_PER_INTERVAL = 3/);
  assert.match(botRunner, /const HACK_BOT_INPUT_INTERVAL_MS = 30/);
  assert.match(botRunner, /this\.mode === "hack"/);
  assert.match(botRunner, /OPSIA_BOT_RECONCILE_INTERVAL_MS \?\? "2000"/);
  assert.match(botRunner, /await Promise\.all\(Array\.from\(\{ length: count \}, \(\) => spawnOne\(\)\)\)/);
  assert.match(botRunner, /await spawnOne\(\)/);
  assert.match(botRunner, /const reconcileRetryAt = new Map<string, number>\(\)/);
  assert.match(botRunner, /if \(available < 1\) throw new Error\("bot_capacity_exceeded"\)/);
  assert.match(botRunner, /const removableCount = requestedCount === undefined/);
  assert.match(botRunner, /selected\.length - \(roomId \? minimumBotsPerRoom : 0\)/);
  assert.match(botRunner, /selected\.slice\(Math\.max\(0, selected\.length - removableCount\)\)/);
  assert.match(opsConsoleServer, /\{ room: roomId, \.\.\.\(count === undefined \? \{\} : \{ count \}\) \}/);
  assert.match(botRunner, /SESSION_GATEWAY_INTERNAL_URL/);
  assert.match(botRunner, /botFindGameUrl\(roomId, endpoint, sessionGatewayUrl\)/);
  assert.match(botRunner, /botWebsocketUrl\(roomId, match\.res\[0\], sessionId, sessionGatewayUrl\)/);
  const gatewayWebsocketRoute = sessionGatewaySource.slice(
    sessionGatewaySource.indexOf('app.ws<GatewaySocketData>("/play/*"'),
    sessionGatewaySource.indexOf("// uWebSockets routes are registered in order"),
  );
  assert.match(gatewayWebsocketRoute, /if \(!data\.closed\) \{[\s\S]*try \{[\s\S]*socket\.end\(1013, "gateway_upstream_unavailable"\)/);
  assert.match(gatewayWebsocketRoute, /if \(sessions\.delete\(data\.id\)\) \{[\s\S]*metrics\.connections = Math\.max/);
  assert.match(sessionGatewaySource, /const LATENCY_MEDIAN_WINDOW = 5/);
  assert.match(sessionGatewaySource, /socket\.ping\("opsia-latency"\)/);
  assert.match(sessionGatewaySource, /pong\(socket\)/);
  assert.match(sessionGatewaySource, /app\.get\("\/internal\/latencies"/);
  assert.match(opsConsoleAdmin, /SESSION_GATEWAY_INTERNAL_URL/);
  assert.match(opsConsoleAdmin, /latencyBySession\.get\(`\$\{record\.roomId\}:\$\{player\.sessionId\}`\) \?\? -1/);
  assert.match(opsConsoleAdmin, /const RESOURCE_MEDIAN_WINDOW = 9/);
  assert.match(opsConsoleAdmin, /const RESOURCE_SMOOTHING_ALPHA = 0\.2/);
  assert.match(opsConsoleAdmin, /const stabilizedResourceMetrics =/);
  assert.match(opsConsoleAdmin, /capturedAt !== history\.capturedAt/);
  assert.match(opsConsoleAdmin, /medianCpu - history\.smoothedCpuPercent/);
  assert.match(opsConsoleAdmin, /medianMemory - history\.smoothedMemoryMb/);
  assert.match(opsConsoleAdmin, /cpuPercent: resources\.cpuPercent/);
  assert.match(opsConsoleAdmin, /memoryMb: resources\.memoryMb/);
  assert.match(compose, /ops-console:[\s\S]*SESSION_GATEWAY_INTERNAL_URL: http:\/\/session-gateway:8083/);
  assert.match(botRouting, /roomId === "canary-room"/);
  assert.match(botRouting, /session_gateway_url_required_for_live_bots/);
  assert.match(gameServer, /verifyGatewayConnection/);
  assert.match(gameServer, /consumeGatewayNonce/);
  assert.match(gameServer, /session_gateway_required/);
  assert.match(gameServer, /this\.snapshotFailures\.labels\(snapshot\.roomId\)\.inc\(failureDelta\)/);
  assert.match(gameServer, /this\.snapshotTimeouts\.labels\(snapshot\.roomId\)\.inc\(timeoutDelta\)/);
  assert.doesNotMatch(gameServer, /if \(failureDelta\) this\.snapshotFailures/);
  assert.doesNotMatch(gameServer, /if \(timeoutDelta\) this\.snapshotTimeouts/);
  assert.match(gameServer, /gateway_join_frame_invalid/);
  assert.match(gameServer, /gateway_join_required/);
  assert.match(serverClient, /session_already_connected/);
  assert.match(serverClient, /session_reattach_expired/);
  assert.match(gameServer, /app\.post\("\/ops\/failure\/process-crash"/);
  assert.match(gameProcessManager, /crashOpsiaRoom\(\): number/);
  assert.match(gameProcessManager, /this\.killProcess\(proc, "SIGKILL"\)/);
  assert.doesNotMatch(adminUi, /map-previews|<img/);
  assert.doesNotMatch(adminHtml, /survev-control-theme|prefers-color-scheme/);
  assert.match(adminHtml, /name="color-scheme" content="light"/);
  assert.match(adminCss, /--bg: #fafafc/);
  assert.match(adminCss, /--blue: #0a84ff/);
  assert.match(adminCss, /\.border-metric-tabs button\[aria-selected="true"\]/);
  assert.match(adminCss, /\.scenario-grid/);
  assert.match(adminCss, /\.scenario-card\.is-active/);
  const serverBlock = adminUi.slice(adminUi.indexOf("function ServerBlock"), adminUi.indexOf("function JoinRoomDialog"));
  const roomDirectory = adminUi.slice(adminUi.indexOf("function RoomDirectory"), adminUi.indexOf("function roomWatchUrl"));
  assert.match(adminUi, /function roomBorderProfile/);
  assert.match(adminUi, /function roomDisplayName/);
  assert.match(adminUi, /function roomStableId/);
  assert.match(adminUi, /function roomCurrentPodName/);
  assert.match(adminUi, /room\.roomName \|\| room\.name/);
  assert.match(adminUi, /room\.roomId \|\| room\.id/);
  assert.match(adminUi, /room\.currentPodName \|\| room\.podName/);
  assert.match(roomDisplay, /\/-\[a-z0-9\]\{8,10\}-\[a-z0-9\]\{5\}\$\//);
  assert.match(adminUi, /compactPodName\(roomCurrentPodName\(room\)\)/);
  assert.match(failureScenarioUi, /compactPodName\(roomCurrentPodName\(room\)\)/);
  assert.match(adminUi, /className="server-block-meta"/);
  assert.match(adminUi, /className="room-view-overlay"/);
  assert.match(adminUi, /<strong title=\{currentPodName\}>\{podDisplayName\}<\/strong>/);
  assert.doesNotMatch(adminUi, /className="room-toolbar-identity"/);
  assert.match(failureScenarioUi, /className="scenario-room-identity"/);
  assert.match(adminCss, /\.room-identity/);
  assert.match(adminCss, /\.room-view-overlay/);
  assert.doesNotMatch(adminCss, /\.room-toolbar-identity/);
  assert.match(adminCss, /\.scenario-room-identity/);
  assert.match(adminUi, /function ServerBlock/);
  assert.doesNotMatch(adminUi, /function RoomMapPreviewStrip/);
  assert.match(adminUi, /const TICK_WARNING_MS = 8/);
  assert.match(adminUi, /const CPU_WARNING_PERCENT = 70/);
  assert.match(adminUi, /const MEMORY_WARNING_PERCENT = 75/);
  assert.match(adminUi, /const RESOURCE_STABLE_SAMPLE_COUNT = 9/);
  assert.match(adminUi, /const LATENCY_WARNING_MS = 100/);
  assert.match(adminUi, /const LATENCY_INCIDENT_MS = 200/);
  assert.match(adminUi, /function smoothStep/);
  assert.match(adminUi, /function healthTone/);
  assert.match(adminUi, /function healthHue/);
  assert.match(adminUi, /type BorderMetricKey = "tick" \| "resources" \| "latency"/);
  assert.doesNotMatch(adminUi, /key: "admission", label: "입장 실패율"/);
  assert.match(adminUi, /key: "tick", label: "틱 P95"/);
  assert.match(adminUi, /key: "resources", label: "CPU \/ 메모리"/);
  assert.match(adminUi, /key: "latency", label: "지연 P95"/);
  assert.match(adminUi, /className=\{`lobby-admission-status is-\$\{lobbyAdmission\.tone\}`\}/);
  assert.match(adminUi, /로비 입장/);
  assert.match(adminUi, /lobbyAdmission\.failureRatePercent\.toFixed\(1\)/);
  assert.doesNotMatch(opsConsoleServer, /withAdmissionFailureRates/);
  assert.match(opsConsoleServer, /admission: failureScenarios\.admissionStatus\(\)/);
  assert.match(adminUi, /room\.metrics\.resourceSampleCount \?\? RESOURCE_STABLE_SAMPLE_COUNT/);
  assert.match(adminUi, /stateLabel: "수집 중"/);
  assert.match(adminUi, /function percentile95/);
  assert.match(adminUi, /filter\(\(player\) => Number\.isFinite\(player\.ping\) && player\.ping >= 0\)/);
  assert.match(adminUi, /const latencyLabel = "전체 접속 지연 P95"/);
  assert.match(adminUi, /unknownMetricSample\(latencyLabel, "ms"\)/);
  assert.match(roomDirectory, /borderMetric=\{borderMetric\}/);
  assert.match(roomDirectory, /className="server-grid"/);
  assert.match(roomDirectory, /data-room-count=\{Math\.min\(rooms\.length, 6\)\}/);
  assert.match(roomDirectory, /rooms\.map\(\(room\) =>/);
  assert.match(roomDirectory, /<ServerBlock/);
  assert.match(roomDirectory, /onSpectate=\{\(\) => onOpenRoom\(room\.id\)\}/);
  assert.doesNotMatch(roomDirectory, /room-carousel|RoomMapPreviewStrip|selectAdjacentRoom|cyclicOffset|LiveMapCanvas/);
  assert.match(serverBlock, /className=\{`server-block is-\$\{profile\.tone\}`\}/);
  assert.match(serverBlock, /statusSurfaceStyleVars\(profile\)/);
  assert.match(serverBlock, /className="server-block-tick"/);
  assert.match(serverBlock, /profile\.stateLabel/);
  assert.match(serverBlock, /profile\.primary\.valueText/);
  assert.match(serverBlock, /profile\.secondary\.valueText/);
  assert.match(serverBlock, /className="server-block-name"/);
  assert.match(serverBlock, /server-block-tick-value\$\{profile\.secondary \? " is-paired" : ""\}/);
  assert.match(serverBlock, /\{podDisplayName\}/);
  assert.match(serverBlock, /className="server-block-meta"/);
  assert.match(serverBlock, /className="server-block-connections"/);
  assert.match(serverBlock, /\{displayName\}/);
  assert.match(serverBlock, /\{stableRoomId\}/);
  assert.match(serverBlock, /aria-haspopup="menu"/);
  assert.match(serverBlock, /className="server-block-menu-popover"/);
  assert.match(serverBlock, /role="menu"/);
  assert.match(serverBlock, /document\.addEventListener\("pointerdown", closeOnOutsidePointer\)/);
  assert.match(serverBlock, /event\.key === "Escape"/);
  assert.match(serverBlock, /관전하기/);
  assert.match(serverBlock, /참가하기/);
  assert.match(serverBlock, /onScenarioStart/);
  assert.match(serverBlock, /onScenarioRecover/);
  assert.match(serverBlock, /scenarioActive/);
  assert.doesNotMatch(serverBlock, /room-graph-stack|room-signal-graph|LiveRoomMiniMap|ActualGameMap|<iframe/);
  assert.match(adminCss, /\.server-block \{[^}]*--server-border-size: clamp\(50px, 4\.8vw, 80px\);[^}]*--status-left-color:[^}]*--status-right-color:[^}]*border: var\(--server-border-size\) solid transparent;[^}]*linear-gradient\([^}]*var\(--status-left-color\) 50%[^}]*var\(--status-right-color\) 50%/s);
  assert.doesNotMatch(adminUi, /<h1>게임 서버<\/h1>/);
  assert.match(adminUi, /<span className="server-chip"[\s\S]*<strong>\{rooms\.length\} ROOMS<\/strong>/);
  assert.doesNotMatch(adminUi, /className="directory-heading"/);
  assert.match(adminCss, /\.server-block-tick-value \{[^}]*color: var\(--tick-status-color\);/s);
  assert.match(adminCss, /\.server-block-tick-value\.is-paired > span:first-child \{[^}]*color: var\(--status-left-color\);/s);
  assert.match(adminCss, /\.server-block-tick-value\.is-paired > span:last-child \{[^}]*color: var\(--status-right-color\);/s);
  assert.match(adminCss, /\.server-block-name \{[^}]*overflow-wrap: anywhere;[^}]*text-align: center;/s);
  assert.match(adminCss, /\.server-block\.is-danger \{[^}]*animation: server-border-alert/s);
  assert.match(adminCss, /\.server-block-menu-toggle/);
  assert.match(adminCss, /\.server-block-menu-popover/);
  assert.doesNotMatch(adminCss, /\.server-block:hover \{[^}]*transform:/s);
  assert.match(adminUi, /selectedRoom \? "is-room-open" : "is-room-directory"/);
  assert.match(adminCss, /\.console-shell\.is-room-directory \.console-topbar \{[^}]*height: 46px;/s);
  assert.match(adminCss, /\.room-directory \{[^}]*height: calc\(100dvh - 46px\);/s);
  assert.match(adminUi, /const stateLabel = tone === "danger"/);
  assert.match(adminUi, /\? "장애"[\s\S]*\? "주의"[\s\S]*\? "데이터 없음"[\s\S]*: "정상"/);
  const roomServiceUrl = adminUi.slice(adminUi.indexOf("function roomServiceUrl"), adminUi.indexOf("function ActualGameMap"));
  assert.match(roomServiceUrl, /isPrivateIpv4/);
  assert.match(roomServiceUrl, /\^172\\\.\(1\[6-9\]\|2\\d\|3\[0-1\]\)\\\./);
  assert.match(roomServiceUrl, /url\.hostname = window\.location\.hostname/);
  const roomQrServiceUrl = adminUi.slice(adminUi.indexOf("function roomQrServiceUrl"), adminUi.indexOf("function ActualGameMap"));
  assert.match(roomQrServiceUrl, /new URL\(room\.serviceUrl/);
  assert.match(roomQrServiceUrl, /loopbackHosts\.has\(url\.hostname\)/);
  assert.doesNotMatch(roomQrServiceUrl, /isPrivateIpv4/);
  const joinDialog = adminUi.slice(adminUi.indexOf("function JoinRoomDialog"), adminUi.indexOf("function RoomDirectory"));
  assert.match(joinDialog, /<dialog/);
  assert.match(joinDialog, /dialog\.showModal\(\)/);
  assert.match(joinDialog, /aria-labelledby=\{titleId\}/);
  assert.match(joinDialog, /<QRCodeSVG/);
  assert.match(joinDialog, /size=\{1024\}/);
  assert.match(joinDialog, /data-join-url=\{qrJoinUrl\}/);
  assert.match(joinDialog, /value=\{qrJoinUrl\}/);
  assert.match(joinDialog, /className="join-dialog-back"/);
  assert.match(joinDialog, /←/);
  assert.match(joinDialog, /새 탭에서 접속/);
  assert.match(joinDialog, /href=\{directJoinUrl\}/);
  assert.match(joinDialog, /target="_blank"/);
  assert.doesNotMatch(joinDialog, /if \(dialog\.open\) dialog\.close\(\)/);
  assert.match(adminCss, /\.join-room-dialog \{[^}]*width: 100vw;[^}]*height: 100dvh;[^}]*max-height: none;/s);
  assert.match(adminCss, /\.join-dialog-back \{[^}]*top: max\(7px, env\(safe-area-inset-top\)\);[^}]*left: max\(7px, env\(safe-area-inset-left\)\);/s);
  assert.match(adminCss, /\.join-dialog-qr \{[^}]*width: min\(calc\(100vw - 8px\), calc\(100dvh - 24px\)\);/s);
  assert.match(compose, /PUBLIC_GAME_HOST:-localhost/);
  assert.match(compose, /"8083:8083"/);
  assert.match(compose, /SESSION_ROOM_ENDPOINTS:[^\n]*room-4=http:\/\/game-4:8001/);
  assert.doesNotMatch(compose, /"8190:8001"/);
  assert.match(deadBodies, /DEAD_BODY_TTL_SECONDS = 18/);
  assert.match(deadBodies, /this\.ageSeconds >= DEAD_BODY_TTL_SECONDS/);
  assert.match(loot, /cleanupAfterSeconds/);
  assert.match(player, /markForCleanupSince\(deathLootStartIndex, 30\)/);
  assert.match(player, /Config\.debug\.allowBots \|\| process\.env\.OPSIA_ROOM === "true"/);
  assert.match(docker, /WORKDIR \/app\/upstream-survev\/server/);
  assert.match(docker, /CMD \["node", "--enable-source-maps", "dist\/gameServer\.js"\]/);
  assert.doesNotMatch(docker, /services\/game-server\/src\/main/);
});

test("five room Deployments, isolated canary, and registry discovery match the fleet contract", async () => {
  const gameServer = await readFile(join(process.cwd(), "upstream-survev/server/src/gameServer.ts"), "utf8");
  const roomConfig = await readFile(join(process.cwd(), "services/game-server/survev-config.hjson"), "utf8");
  const compose = await readFile(join(process.cwd(), "docker-compose.yml"), "utf8");
  const liveDeployments = await readFile(join(process.cwd(), "deploy/k8s/base/game.yaml"), "utf8");
  const roomServices = await readFile(join(process.cwd(), "deploy/k8s/base/services.yaml"), "utf8");
  const rbac = await readFile(join(process.cwd(), "deploy/k8s/base/rbac.yaml"), "utf8");
  const canary = await readFile(join(process.cwd(), "deploy/k8s/base/canary.yaml"), "utf8");
  const gateway = await readFile(join(process.cwd(), "deploy/k8s/base/gateway.yaml"), "utf8");
  const policy = await readFile(join(process.cwd(), "deploy/k8s/base/configmap.yaml"), "utf8");
  const management = await readFile(join(process.cwd(), "deploy/k8s/base/management-server.yaml"), "utf8");
  const apiServer = await readFile(join(process.cwd(), "deploy/k8s/base/api-server.yaml"), "utf8");
  const baseKustomization = await readFile(join(process.cwd(), "deploy/k8s/base/kustomization.yaml"), "utf8");
  const monitoring = await readFile(join(process.cwd(), "deploy/k8s/base/monitoring.yaml"), "utf8");
  const sessionGateway = await readFile(join(process.cwd(), "deploy/k8s/base/session-gateway.yaml"), "utf8");
  const sessionGatewayImplementation = await readFile(
    join(process.cwd(), "upstream-survev/server/src/opsia/sessionGateway.ts"),
    "utf8",
  );
  const sandboxOverlay = await readFile(join(process.cwd(), "deploy/k8s/overlays/sandbox/kustomization.yaml"), "utf8");
  const gameServerOverlay = await readFile(join(process.cwd(), "deploy/k8s/overlays/game-server/kustomization.yaml"), "utf8");
  const bootstrapSecrets = await readFile(join(process.cwd(), "deploy/k8s/overlays/game-server/bootstrap-secrets.yaml"), "utf8");
  const publishImagesWorkflow = await readFile(join(process.cwd(), ".github/workflows/publish-images.yml"), "utf8");
  const botRunner = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/botRunner.ts"), "utf8");
  const botRouting = await readFile(join(process.cwd(), "upstream-survev/server/src/opsia/botRouting.ts"), "utf8");
  const admissionProbe = await readFile(
    join(process.cwd(), "scripts/check-admission-capacity.mjs"),
    "utf8",
  );
  const admissionSmoke = await readFile(
    join(process.cwd(), "scripts/k8s-admission-capacity-smoke.sh"),
    "utf8",
  );

  assert.match(gameServer, /z\.enum\(\["faction", "desert", "snow", "main", "woods"\]\)/);
  assert.match(gameServer, /process\.env\.OPSIA_MAP_NAME \?\? "faction"/);
  assert.match(gameServer, /server\.manager\.newGame\(opsiaMode\)/);
  assert.match(gameServer, /modes: process\.env\.OPSIA_ROOM === "true" \? \[opsiaMode\] : Config\.modes/);
  assert.match(gameServer, /mapName: opsiaMapName/);
  assert.match(gameServer, /mode: opsiaModeLabel/);
  assert.match(gameServer, /maxPlayers: opsiaMaxPlayers/);
  for (const mapName of ["faction", "desert", "snow", "main", "woods"]) {
    assert.match(roomConfig, new RegExp(`mapName: "${mapName}"`));
    assert.match(compose, new RegExp(`OPSIA_MAP_NAME: ${mapName}`));
    assert.match(liveDeployments, new RegExp(`OPSIA_MAP_NAME, value: ${mapName}`));
  }
  assert.equal((liveDeployments.match(/name: game-room-[0-4]\r?\n/g) ?? []).length, 5);
  assert.equal((liveDeployments.match(/replicas: 1/g) ?? []).length, 5);
  assert.equal((liveDeployments.match(/maxSurge: 1/g) ?? []).length, 5);
  assert.equal((liveDeployments.match(/maxUnavailable: 0/g) ?? []).length, 5);
  assert.equal((liveDeployments.match(/opsia\.dev\/rollout-role: active-candidate/g) ?? []).length, 10);
  assert.equal(
    (liveDeployments.match(/opsia\.dev\/recovery-continuity: protected/g) ?? []).length,
    10,
  );
  const protectedRoomDeployments = liveDeployments
    .split(/^---\s*$/m)
    .filter((document) => /kind: Deployment/.test(document))
    .filter((document) => /opsia\.dev\/recovery-continuity: protected/.test(document));
  assert.ok(protectedRoomDeployments.length > 0);
  for (const deployment of protectedRoomDeployments) {
    const podTemplate = deployment.slice(deployment.indexOf("  template:"));
    assert.match(podTemplate, /opsia\.dev\/recovery-continuity: protected/);
    assert.match(podTemplate, /prometheus\.io\/scrape: "true"/);
    assert.match(podTemplate, /prometheus\.io\/path: "\/metrics"/);
    assert.match(podTemplate, /prometheus\.io\/port: "8001"/);
    assert.match(podTemplate, /name: POD_NAMESPACE[\s\S]*fieldPath: metadata\.namespace/);
    assert.match(podTemplate, /name: POD_UID[\s\S]*fieldPath: metadata\.uid/);
    assert.match(podTemplate, /name: OPSIA_RESOURCE_KIND, value: Deployment/);
    assert.doesNotMatch(podTemplate, /name: OPSIA_CONTINUITY_ID/);
  }
  // Each stable room ID labels both its Deployment and the Pod template, so
  // reconciliation can follow a replacement Pod without using its name.
  assert.equal((liveDeployments.match(/game\.opsia\.dev\/room-id: room-[0-4]/g) ?? []).length, 10);
  assert.doesNotMatch(liveDeployments, /kind: StatefulSet/);
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    assert.match(roomServices, new RegExp(`name: game-room-${ordinal}`));
    assert.match(roomServices, new RegExp(`game\\.opsia\\.dev/room-id: room-${ordinal}`));
  }
  assert.match(gateway, /room-\\d\+/);
  assert.match(gateway, /proxy_pass http:\/\/session-gateway\.sandbox\.svc\.cluster\.local:8083/);
  assert.match(gateway, /proxy_pass http:\/\/login-gateway-api\.sandbox\.svc\.cluster\.local:8081/);
  assert.match(policy, /desiredRooms: "5"/);
  assert.match(policy, /maxRooms: "20"/);
  assert.match(policy, /roomProfiles: "room-0,room-1,room-2,room-3,room-4"/);
  assert.match(policy, /kind: GameFleet/);
  assert.match(policy, /maxConcurrentRooms: 1/);
  assert.match(management, /OPSIA_ROOM_DIRECTORY_URL/);
  assert.match(management, /OPSIA_MIN_BOTS_PER_ROOM, value: "60"/);
  assert.match(management, /API_SERVER_URL, value: http:\/\/login-gateway-api:8081/);
  assert.match(management, /ADMISSION_GATEWAY_URL, value: http:\/\/login-gateway/);
  assert.doesNotMatch(management, /- name: api-server\r?\n/);
  assert.match(baseKustomization, /- api-server\.yaml/);
  assert.doesNotMatch(baseKustomization, /monitoring\.yaml|alertmanager\.yaml/);
  assert.match(apiServer, /name: api-server[\s\S]*replicas: [1-9]\d*/);
  assert.match(apiServer, /MAX_FIND_GAME_PER_SECOND, value: "25"/);
  assert.match(apiServer, /prometheus\.io\/scrape: "true"/);
  assert.match(apiServer, /prometheus\.io\/path: "\/metrics"/);
  assert.match(apiServer, /prometheus\.io\/port: "8081"/);
  assert.match(apiServer, /opsia\.dev\/service: api-server/);
  assert.match(apiServer, /opsia\.dev\/sli: admission/);
  assert.match(apiServer, /opsia\.dev\/symptom: admission_failure/);
  assert.match(
    apiServer,
    /name: OPSIA_WORKLOAD_NAME[\s\S]*fieldPath: "metadata\.labels\['app'\]"/,
  );
  assert.match(
    apiServer,
    /name: OPSIA_SERVICE_NAME[\s\S]*fieldPath: "metadata\.labels\['opsia\.dev\/service'\]"/,
  );
  assert.match(
    apiServer,
    /name: OPSIA_SLI_NAME[\s\S]*fieldPath: "metadata\.labels\['opsia\.dev\/sli'\]"/,
  );
  assert.match(
    apiServer,
    /name: OPSIA_SLI_SYMPTOM[\s\S]*fieldPath: "metadata\.labels\['opsia\.dev\/symptom'\]"/,
  );
  assert.doesNotMatch(
    apiServer,
    /ADMISSION_OVERLOAD_|ADMISSION_FAILURE_STATE_FILE|admission-failure-state/,
  );
  assert.doesNotMatch(
    compose,
    /ADMISSION_OVERLOAD_|ADMISSION_FAILURE_STATE_FILE|opsia-admission-overload/,
  );
  assert.match(apiServer, /publishNotReadyAddresses: true/);
  assert.match(apiServer, /kind: Service[\s\S]*name: login-gateway-api/);
  assert.match(rbac, /resources: \["deployments", "replicasets"\][\s\S]*verbs: \["get", "list", "patch"\]/);
  assert.match(monitoring, /OPTIONAL LEGACY MONITORING/);
  assert.doesNotMatch(monitoring, /DemoGameJoinStorm|opsia_sli_failure_ratio|root_category/);
  assert.match(admissionProbe, /const TARGET_RPS = 40/);
  assert.match(admissionProbe, /durationSeconds < 21/);
  assert.match(admissionProbe, /failureRatio < 0\.2/);
  assert.match(admissionProbe, /failureRatio > 0\.2/);
  assert.match(admissionSmoke, /--replicas=2/);
  assert.match(admissionSmoke, /scale_and_wait 2[\s\S]*scale_and_wait 1[\s\S]*scale_and_wait 2/);
  assert.match(admissionSmoke, /--expect healthy/);
  assert.match(admissionSmoke, /--expect degraded/);
  assert.match(management, /key: maxRooms/);
  assert.match(rbac, /resources: \["services"\][\s\S]*verbs: \["get", "list"\]/);
  assert.match(management, /GAME_DEPLOYMENT_PREFIX, value: game-room/);
  assert.doesNotMatch(management, /OPS_ADMIN_TOKEN|REQUIRE_ADMIN_TOKEN|demo-game-admin/);
  assert.doesNotMatch(bootstrapSecrets, /demo-game-admin/);
  assert.match(sessionGateway, /room-4=http:\/\/game-room-4:8001/);
  assert.match(sessionGateway, /SESSION_GATEWAY_SHARED_SECRET/);
  assert.match(sessionGateway, /ADMISSION_GATEWAY_URL, value: "http:\/\/login-gateway-api:8081"/);
  assert.match(sessionGateway, /REQUIRE_ADMISSION_GATEWAY, value: "true"/);
  assert.match(sessionGatewayImplementation, /admission_gateway_url_required/);
  assert.match(sessionGatewayImplementation, /admission_gateway_unavailable/);
  assert.match(sessionGatewayImplementation, /spectator = parsed\.spectator === true/);
  assert.match(sessionGatewayImplementation, /roomId: details\.roomId/);
  assert.equal((liveDeployments.match(/REQUIRE_SESSION_GATEWAY, value: "true"/g) ?? []).length, 5);
  assert.equal((liveDeployments.match(/name: SESSION_GATEWAY_SHARED_SECRET/g) ?? []).length, 5);
  assert.match(management, /SESSION_GATEWAY_INTERNAL_URL, value: http:\/\/session-gateway:8083/);
  assert.doesNotMatch(sessionGateway, /canary-room=http/);
  assert.doesNotMatch(gateway, /canary-room/);
  assert.match(canary, /name: canary-room/);
  assert.match(canary, /OPSIA_REDIS_KEY_PREFIX, value: "room:canary-room:"/);
  assert.match(canary, /REDIS_URL, value: redis:\/\/cache:6379\/1/);
  assert.match(canary, /OPSIA_ROOM_ENDPOINTS, value: "canary-room=http:\/\/game-room-canary:8001"/);
  assert.match(canary, /OPSIA_MIN_BOTS_PER_ROOM, value: "0"/);
  assert.match(canary, /limits: \{ cpu: "3", memory: 4Gi \}/);
  assert.match(canary, /opsia\.dev\/public: disabled/);
  assert.match(canary, /game\.opsia\.dev\/room-id: canary-room/);
  assert.match(canary, /opsia\.dev\/matchmaking: disabled/);
  assert.match(canary, /REQUIRE_SESSION_GATEWAY, value: "false"/);
  assert.match(botRunner, /fetch\(`\$\{roomDirectoryUrl\}\/rooms`/);
  assert.match(botRouting, /session_gateway_url_required_for_live_bots/);
  assert.match(botRunner, /room\.status === "inactive"/);
  assert.doesNotMatch(botRunner, /room-0=http:\/\/game-0/);
  for (const image of ["game-server", "api-server", "bot-runner", "ops-console", "room-orchestrator", "session-gateway"]) {
    assert.match(publishImagesWorkflow, new RegExp(`image: ${image}`));
    assert.match(sandboxOverlay, new RegExp(`name: ghcr\\.io/jungle-303-04/demo-game/${image}`));
    assert.match(gameServerOverlay, new RegExp(`name: ghcr\\.io/jungle-303-04/demo-game/${image}`));
  }
  assert.match(publishImagesWorkflow, /ghcr\.io\/jungle-303-04\/demo-game\/\$\{\{ matrix\.image \}\}:\$\{\{ inputs\.tag \}\}/);
  assert.doesNotMatch(gameServerOverlay, /v20260720-/);
  const pinnedImages = [
    ...gameServerOverlay.matchAll(
      /- name: ghcr\.io\/jungle-303-04\/demo-game\/([a-z-]+)\s+newTag: ([0-9a-f]{40})/g,
    ),
  ];
  assert.equal(pinnedImages.length, 6);
  const continuityImageTags = pinnedImages
    .filter((match) => match[1] !== "api-server")
    .map((match) => match[2]);
  assert.equal(new Set(continuityImageTags).size, 1);
  assert.doesNotMatch(gameServerOverlay, /newTag: stable/);
  assert.match(gameServerOverlay, /kyro\.io\/workload-role: game/);
  assert.match(gameServerOverlay, /value: game\s+effect: NoSchedule/);
  assert.match(gameServerOverlay, /name: management-server[\s\S]*kyro\.io\/workload-role: infra/);
});
