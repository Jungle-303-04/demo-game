import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { App, SSLApp, type WebSocket } from "uWebSockets.js";
import { z } from "zod";
import pkgJson from "../../package.json" with { type: "json" };
import { GameConfig } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { Config } from "./config.ts";
import { GameProcessManager, type GameSocketData, ProcState } from "./game/gameProcessManager.ts";
import type { OpsiaSnapshotData } from "./game/ipcTypes.ts";
import { apiPrivateRouter } from "./utils/apiRouter.ts";
import { GIT_VERSION } from "./utils/gitRevision.ts";
import { logErrorToWebhook, ServerLogger } from "./utils/logger.ts";
import { HTTPRateLimit, WebSocketRateLimit } from "./utils/rateLimit.ts";
import {
    type FindGamePrivateBody,
    type FindGamePrivateRes,
    type SaveGameBody,
    zFindGamePrivateBody,
} from "./utils/types.ts";
import { uwsHelpers } from "./utils/uwsHelpers.ts";

const zOpsiaFindGame = z.object({
    region: z.string(),
    zones: z.array(z.string()),
    version: z.number(),
    playerCount: z.number(),
    autoFill: z.boolean(),
    gameModeIdx: z.number(),
    opsiaSessionId: z.string().min(16).max(128).optional(),
}).passthrough();

class OpsiaMetrics {
    readonly registry = new Registry();
    private readonly tick = new Histogram({ name: "tick_duration_ms", help: "survev Game.update duration", labelNames: ["room"] as const, registers: [this.registry], buckets: [1, 5, 10, 20, 40, 80, 160] });
    private readonly online = new Gauge({ name: "players_online", help: "players in the real survev playerBarn", labelNames: ["room"] as const, registers: [this.registry] });
    private readonly alive = new Gauge({ name: "players_alive", help: "living players in the real survev playerBarn", labelNames: ["room"] as const, registers: [this.registry] });
    private readonly inputs = new Counter({ name: "player_input_rate_total", help: "decoded survev input outcomes", labelNames: ["room", "outcome"] as const, registers: [this.registry] });

    observe(snapshot: OpsiaSnapshotData): void {
        this.tick.labels(snapshot.roomId).observe(snapshot.tickMs);
        this.online.labels(snapshot.roomId).set(snapshot.players.length);
        this.alive.labels(snapshot.roomId).set(snapshot.players.filter((player) => player.alive).length);
        if (snapshot.inputAccepted) this.inputs.labels(snapshot.roomId, "accepted").inc(snapshot.inputAccepted);
        if (snapshot.inputRejected) this.inputs.labels(snapshot.roomId, "rejected").inc(snapshot.inputRejected);
    }
}

process.on("uncaughtException", async (err) => {
    console.error(err);

    await logErrorToWebhook("server", "Game server error:", err);

    process.exit(1);
});

class GameServer {
    readonly logger = new ServerLogger("GameServer");

    readonly region = Config.regions[Config.gameServer.thisRegion] ?? {
        https: false,
        address: `127.0.0.1:${Config.gameServer.port}`,
        l10n: "index-local",
    };
    readonly regionId = Config.gameServer.thisRegion;

    readonly manager = new GameProcessManager();
    readonly metrics = new OpsiaMetrics();

    constructor() {
        this.manager.onOpsiaSnapshot((snapshot) => this.metrics.observe(snapshot));
    }

    async findGame(body: FindGamePrivateBody): Promise<FindGamePrivateRes> {
        if (body.version !== GameConfig.protocolVersion) {
            return { error: "invalid_protocol" };
        }

        if (body.region !== this.regionId) {
            return { error: "invalid_region" };
        }

        const game = await this.manager.findGame({
            region: body.region,
            version: body.version,
            autoFill: body.autoFill,
            mapName: body.mapName,
            teamMode: body.teamMode,
            playerData: body.playerData,
        });

        return {
            gameId: game.gameData.id,
            useHttps: this.region.https,
            hosts: [this.region.address],
            addrs: [this.region.address],
        };
    }

    async findOpsiaGame(body: z.infer<typeof zOpsiaFindGame>, host: string, ip: string) {
        // A room-pod is always the live 50v50 faction game. The client still
        // renders upstream's mode menu, but no request can create another map.
        const mode = Config.modes.find((candidate) => candidate.mapName === "faction") ?? Config.modes[body.gameModeIdx] ?? Config.modes[0];
        if (!mode) return { error: "mode_disabled" };
        const token = randomUUID();
        const result = await this.findGame({
            region: this.regionId,
            version: body.version,
            autoFill: body.autoFill,
            mapName: mode.mapName,
            teamMode: mode.teamMode,
            playerData: [{
                token,
                userId: null,
                ip,
                opsiaSessionId: body.opsiaSessionId,
            }],
        });
        if ("error" in result) return result;
        return {
            res: [{
                zone: this.regionId,
                gameId: result.gameId,
                useHttps: this.region.https,
                hosts: [host],
                addrs: [host],
                data: token,
            }],
        };
    }

    async sendData() {
        if (process.env.OPSIA_ROOM === "true") return;
        try {
            await apiPrivateRouter.update_region.$post({
                json: {
                    data: {
                        playerCount: this.manager.getPlayerCount(),
                    },
                    regionId: Config.gameServer.thisRegion,
                },
            });
        } catch (err) {
            this.logger.error(`Failed to update region: `, err);
        }
    }

    async checkIp(ip: string) {
        if (process.env.OPSIA_ROOM === "true") return undefined;
        try {
            const apiRes = await apiPrivateRouter.check_ip.$post({
                json: {
                    ip,
                },
            });

            if (apiRes.ok) {
                const body = await apiRes.json();
                return body;
            }
        } catch (err) {
            this.logger.error(`Failed request API fetch_ip: `, err);
        }

        return undefined;
    }

    async tryToSaveLostGames() {
        const games: SaveGameBody["matchData"] = [];

        const dir = path.resolve("lost_game_data");

        if (!existsSync(dir)) return;

        const files = await fs.readdir(dir);

        for (const fileName of files) {
            const filePath = path.resolve(dir, fileName);
            const data = JSON.parse(await fs.readFile(filePath, "utf8"));
            games.push(...data);
        }

        if (games.length < 2) return;

        this.logger.info(`${games.length} lost games found, trying to save...`);

        let res: Response | undefined = undefined;
        try {
            res = await apiPrivateRouter.save_game.$post({
                json: {
                    matchData: games,
                },
            });
        } catch (err) {
            this.logger.error(`Failed to fetch API save game:`, err);
        }

        if (res?.ok) {
            this.logger.info(`successfully saved lost games!`);
            // if we successfully saved the games we can remove them
            for (const fileName of files) {
                const filePath = path.resolve(dir, fileName);
                await fs.rm(filePath);
            }
        }
    }
}

const server = new GameServer();

if (process.env.OPSIA_ROOM === "true") {
    server.manager.newGame(Config.modes.find((mode) => mode.mapName === "faction") ?? Config.modes[0]!);
} else if (process.env.NODE_ENV !== "production") {
    server.manager.newGame(Config.modes[0]!);
}

const app = Config.gameServer.ssl
    ? SSLApp({
        key_file_name: Config.gameServer.ssl.keyFile,
        cert_file_name: Config.gameServer.ssl.certFile,
    })
    : App();

app.get("/health", (res) => {
    res.writeStatus("200 OK");
    res.write("OK");
    res.end();
});

app.get("/healthz", (res) => {
    if (process.env.OPSIA_ROOM === "true" && !server.manager.isOpsiaReady()) {
        res.writeStatus("503 Service Unavailable");
        uwsHelpers.returnJson(res, { status: "initializing", roomId: process.env.ROOM_ID ?? "room-0", runtime: "survev-gameServer" });
        return;
    }
    uwsHelpers.returnJson(res, { status: "ok", roomId: process.env.ROOM_ID ?? "room-0", runtime: "survev-gameServer" });
});

app.get("/metrics", async (res) => {
    res.onAborted(() => { res.aborted = true; });
    const text = await server.metrics.registry.metrics();
    if (!res.aborted) res.cork(() => res.writeHeader("Content-Type", server.metrics.registry.contentType).end(text));
});

const returnSiteInfo = (res: Parameters<typeof uwsHelpers.returnJson>[0]) => {
    uwsHelpers.returnJson(res, {
        country: "local",
        gitRevision: GIT_VERSION,
        captchaEnabled: false,
        modes: Config.modes,
        clientTheme: Config.clientTheme,
        pops: { [server.regionId]: { playerCount: server.manager.getPlayerCount(), l10n: server.region.l10n } },
        youtube: { name: "", link: "" },
        twitch: [],
    });
};

app.get("/api/site_info", (res) => {
    returnSiteInfo(res);
});

app.get("/summary", (res) => {
    const snapshot = server.manager.getOpsiaSnapshot();
    uwsHelpers.returnJson(res, {
        roomId: process.env.ROOM_ID ?? "room-0",
        status: server.manager.isOpsiaReady() ? "running" : "initializing",
        players: snapshot?.players.length ?? 0,
        alive: snapshot?.players.filter((player) => player.alive).length ?? 0,
        podName: process.env.POD_NAME ?? "game-0",
        strictMode: process.env.STRICT_MODE === "true",
        qrUrl: `${process.env.PUBLIC_BASE_URL ?? "http://localhost:8090"}/play/${process.env.ROOM_ID ?? "room-0"}`,
    });
});

app.get("/ops/snapshot", (res) => {
    const snapshot = server.manager.getOpsiaSnapshot();
    if (!snapshot) {
        res.writeStatus("503 Service Unavailable").end(JSON.stringify({ error: "ops_snapshot_pending" }));
        return;
    }
    uwsHelpers.returnJson(res, snapshot as unknown as Record<string, unknown>);
});

app.post("/ops/end", (res) => {
    if (!server.manager.resetOpsiaRoom()) {
        res.writeStatus("409 Conflict").end(JSON.stringify({ error: "room_not_ready" }));
        return;
    }
    uwsHelpers.returnJson(res, { status: "reset", roomId: process.env.ROOM_ID ?? "room-0" });
});

app.get("/private/status", (res, req) => {
    if (req.getHeader("survev-api-key") !== Config.secrets.SURVEV_API_KEY) {
        uwsHelpers.forbidden(res);
        return;
    }

    uwsHelpers.returnJson(res, {
        socketCount: server.manager.sockets.size,
        gameCount: server.manager.processes.length,
        games: server.manager.processes.map(p => {
            return {
                state: ProcState[p.state],
                reusedCount: p.reusedCount,
                avaliableSlots: p.avaliableSlots,
                gameData: p.gameData,
            };
        }),
    });
});

const handleFindGame = async (res: Parameters<typeof uwsHelpers.getJsonBody>[0], req: Parameters<typeof uwsHelpers.getIp>[1]) => {
    res.onAborted(() => {
        res.aborted = true;
    });

    try {
        if (process.env.OPSIA_ROOM === "true" && req.getHeader("survev-api-key") !== Config.secrets.SURVEV_API_KEY) {
            // uWS request headers are only valid before awaiting body parsing.
            const host = req.getHeader("host") || server.region.address;
            const ip = uwsHelpers.getIp(res, req, Config.gameServer.proxyIPHeader) ?? "127.0.0.1";
            const body = await uwsHelpers.getJsonBody(res, zOpsiaFindGame);
            uwsHelpers.returnJson(res, await server.findOpsiaGame(body, host, ip));
            return;
        }
        if (req.getHeader("survev-api-key") !== Config.secrets.SURVEV_API_KEY) {
            uwsHelpers.forbidden(res);
            return;
        }
        const body = await uwsHelpers.getJsonBody(res, zFindGamePrivateBody);

        uwsHelpers.returnJson(res, await server.findGame(body));
    } catch (error) {
        server.logger.warn("/api/find_game error: ", error);
    }
};

app.post("/api/find_game", (res, req) => {
    void handleFindGame(res, req);
});

// When ingress routes /play/room-N to that StatefulSet pod, keep the browser
// API calls in the same room namespace. These aliases still execute the exact
// upstream GameServer matchmaking path above; they are not a replacement API.
app.post("/*", (res, req) => {
    if (/^\/(?:play|watch)\/room-\d+\/api\/find_game$/.test(req.getUrl())) {
        void handleFindGame(res, req);
        return;
    }
    res.writeStatus("404 Not Found").end("not found");
});

// The normal upstream rate stays conservative. A single controlled
// bot-runner is intentionally allowed to bring 30 real protocol clients into
// the three room-pods for the local live demo; input abuse is still caught in
// the decoded InputMsg hook below.
const opsiaRoom = process.env.OPSIA_ROOM === "true";
const gameHTTPRateLimit = new HTTPRateLimit(opsiaRoom ? 100 : 5, 1000);
const gameWsRateLimit = new WebSocketRateLimit(500, 1000, opsiaRoom ? 100 : 5);

const gameWsBehavior: import("uWebSockets.js").WebSocketBehavior<GameSocketData> = {
    idleTimeout: 30,
    maxPayloadLength: 1024,

    async upgrade(res, req, context): Promise<void> {
        res.onAborted((): void => {
            res.aborted = true;
        });
        const wskey = req.getHeader("sec-websocket-key");
        const wsProtocol = req.getHeader("sec-websocket-protocol");
        const wsExtensions = req.getHeader("sec-websocket-extensions");

        const ip = uwsHelpers.getIp(res, req, Config.gameServer.proxyIPHeader);

        if (!ip) {
            server.logger.warn(`Invalid IP Found`);
            res.end();
            return;
        }

        if (gameHTTPRateLimit.isRateLimited(ip) || gameWsRateLimit.isIpRateLimited(ip)) {
            res.cork(() => {
                server.logger.warn("Websocket upgrade closed: Rate limited");
                res.writeStatus("429 Too Many Requests");
                res.write("429 Too Many Requests");
                res.end();
            });
            return;
        }

        const searchParams = new URLSearchParams(req.getQuery());
        const gameId = searchParams.get("gameId");

        if (!gameId) {
            server.logger.warn("Websocket upgrade closed: no game ID");
            uwsHelpers.forbidden(res);
            return;
        }
        const proc = server.manager.getById(gameId);

        if (!proc) {
            server.logger.warn("Websocket upgrade closed: invalid game ID");
            uwsHelpers.forbidden(res);
            return;
        }

        if (!proc.gameData.canJoin) {
            server.logger.warn("Websocket upgrade closed: game already started");
            uwsHelpers.forbidden(res);
            return;
        }

        gameWsRateLimit.ipConnected(ip);

        const socketId = randomUUID();
        let disconnectReason = "";

        const ipData = await server.checkIp(ip);

        if (ipData?.banned) {
            disconnectReason = "ip_banned";
        } else if (ipData?.behindProxy) {
            disconnectReason = "behind_proxy";
        }

        if (res.aborted) return;
        res.cork(() => {
            if (res.aborted) return;
            res.upgrade(
                {
                    gameId,
                    id: socketId,
                    closed: false,
                    rateLimit: {},
                    ip,
                    disconnectReason,
                },
                wskey,
                wsProtocol,
                wsExtensions,
                context,
            );
        });
    },

    open(socket: WebSocket<GameSocketData>) {
        const data = socket.getUserData();

        if (data.disconnectReason) {
            const disconnectMsg = new net.DisconnectMsg();
            disconnectMsg.reason = data.disconnectReason;
            const stream = new net.MsgStream(new ArrayBuffer(128));
            stream.serializeMsg(net.MsgType.Disconnect, disconnectMsg);
            socket.send(stream.getBuffer(), true, false);
            socket.end();
            return;
        }

        server.manager.onOpen(data.id, socket);
    },

    message(socket: WebSocket<GameSocketData>, message) {
        if (gameWsRateLimit.isRateLimited(socket.getUserData().rateLimit)) {
            server.logger.warn("Game websocket rate limited, closing socket.");
            socket.close();
            return;
        }
        server.manager.onMsg(socket.getUserData().id, message);
    },

    close(socket: WebSocket<GameSocketData>) {
        const data = socket.getUserData();
        data.closed = true;
        server.manager.onClose(data.id);
        gameWsRateLimit.ipDisconnected(data.ip);
    },
};
app.ws<GameSocketData>("/play", gameWsBehavior);
app.ws<GameSocketData>("/play/*", gameWsBehavior);

const pingHTTPRateLimit = new HTTPRateLimit(1, 3000);
const pingWsRateLimit = new WebSocketRateLimit(50, 1000, 10);

interface pingSocketData {
    rateLimit: Record<symbol, number>;
    ip: string;
}

// ping test
app.ws<pingSocketData>("/ptc", {
    idleTimeout: 10,
    maxPayloadLength: 2,

    upgrade(res, req, context) {
        res.onAborted((): void => {});

        const ip = uwsHelpers.getIp(res, req, Config.gameServer.proxyIPHeader);

        if (!ip) {
            server.logger.warn(`Invalid IP Found`);
            res.end();
            return;
        }

        if (pingHTTPRateLimit.isRateLimited(ip) || pingWsRateLimit.isIpRateLimited(ip)) {
            res.writeStatus("429 Too Many Requests");
            res.write("429 Too Many Requests");
            res.end();
            return;
        }
        pingWsRateLimit.ipConnected(ip);

        res.upgrade(
            {
                rateLimit: {},
                ip,
            },
            req.getHeader("sec-websocket-key"),
            req.getHeader("sec-websocket-protocol"),
            req.getHeader("sec-websocket-extensions"),
            context,
        );
    },

    message(socket: WebSocket<pingSocketData>, message) {
        if (pingWsRateLimit.isRateLimited(socket.getUserData().rateLimit)) {
            server.logger.warn("Ping websocket rate limited, closing socket.");
            socket.close();
            return;
        }
        socket.send(message, true, false);
    },

    close(ws) {
        pingWsRateLimit.ipDisconnected(ws.getUserData().ip);
    },
});

// Serve the Vite/PixiJS client built from upstream-survev/client. This is a
// static shell only; all game state and websocket traffic stay in GameServer.
const clientDist = process.env.SURVEV_CLIENT_DIR;
const contentTypeFor = (file: string): string => {
    if (file.endsWith(".js")) return "application/javascript";
    if (file.endsWith(".css")) return "text/css";
    if (file.endsWith(".json")) return "application/json";
    if (file.endsWith(".svg")) return "image/svg+xml";
    if (file.endsWith(".png")) return "image/png";
    if (file.endsWith(".woff2")) return "font/woff2";
    return "text/html; charset=utf-8";
};
app.get("/*", (res, req) => {
    if (!clientDist) {
        res.writeStatus("404 Not Found").end("survev client build is not configured");
        return;
    }
    const requestPath = decodeURIComponent(req.getUrl());
    if (/^\/(?:play|watch)\/room-\d+\/api\/site_info$/.test(requestPath)) {
        returnSiteInfo(res);
        return;
    }
    // index.html references ./js and ./css. For /play/room-N, browsers resolve
    // those to /play/js (not /play/room-N/js), so support both forms.
    const roomAsset = requestPath.match(/^\/(?:play|watch)\/(?:(?:room-\d+)\/)?(.+)$/)?.[1];
    const candidate = requestPath === "/" || /^\/(play|watch)\/room-\d+$/.test(requestPath)
        ? "index.html"
        // Vite emits relative ./js and ./css URLs. Strip only the room route
        // prefix so the actual upstream bundle is served, not an HTML fallback.
        : roomAsset ?? requestPath.replace(/^\/+/, "");
    const resolved = path.resolve(clientDist, candidate);
    if (!resolved.startsWith(path.resolve(clientDist))) {
        res.writeStatus("403 Forbidden").end("forbidden");
        return;
    }
    try {
        const file = existsSync(resolved) ? resolved : path.resolve(clientDist, "index.html");
        res.cork(() => res.writeHeader("Content-Type", contentTypeFor(file)).end(readFileSync(file)));
    } catch {
        res.writeStatus("404 Not Found").end("not found");
    }
});

server.sendData();
setInterval(() => {
    server.sendData();
}, 20 * 1000);

app.listen(Config.gameServer.host, Config.gameServer.port, 1, (socket) => {
    if (!socket) {
        throw new Error(`Port ${Config.gameServer.port} is already in use`);
    }
    server.logger.info(`Survev Game Server v${pkgJson.version} - GIT ${GIT_VERSION}`);
    server.logger.info(
        `Listening on ${Config.gameServer.host}:${Config.gameServer.port}`,
    );
    server.logger.info("Press Ctrl+C to exit.");
});

// try to save lost games every hour
new Cron("0 * * * *", async () => {
    try {
        await server.tryToSaveLostGames();
    } catch (err) {
        server.logger.error("Failed to save lost games", err);
    }
});
