import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Counter, Gauge, Registry } from "prom-client";
import { createClient, type RedisClientType } from "redis";
import { App, type HttpRequest, type HttpResponse, SSLApp, type WebSocket } from "uWebSockets.js";
import { z } from "zod";
import pkgJson from "../../package.json" with { type: "json" };
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameConfig } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { Config } from "./config.ts";
import { GameProcessManager, type GameSocketData, ProcState } from "./game/gameProcessManager.ts";
import type { OpsiaSnapshotData } from "./game/ipcTypes.ts";
import { controlTokenMatches, readControlToken } from "./opsia/controlPlaneAuth.ts";
import { decodeGatewayFrame, encodeGatewayOutput } from "./opsia/gatewayWire.ts";
import {
    assertGatewaySharedSecret,
    type GatewayConnectionIdentity,
    readGatewayJoin,
    verifyGatewayConnection,
} from "./opsia/sessionGatewayProtocol.ts";
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
    spectator: z.boolean().optional(),
    spectateSessionId: z.string().min(16).max(128).optional(),
}).passthrough();
const zCandidateSeed = z.object({
    expectedEpoch: z.number().int().nonnegative(),
    targetTick: z.number().int().nonnegative(),
    expectedChecksum: z.string().regex(/^[a-f\d]{64}$/).optional(),
    maxEntries: z.number().int().min(1).max(512).optional(),
}).strict();
const zAuthorityRelease = z.object({
    expectedEpoch: z.number().int().nonnegative(),
    expectedChecksum: z.string().regex(/^[a-f\d]{64}$/),
}).strict();
const zCandidatePromote = z.object({
    expectedEpoch: z.number().int().nonnegative(),
    nextEpoch: z.number().int().positive(),
    expectedChecksum: z.string().regex(/^[a-f\d]{64}$/),
}).strict();

const opsiaMapName = z.enum(["faction", "desert", "snow", "main", "woods"]).parse(
    process.env.OPSIA_MAP_NAME ?? "faction",
);
const getOpsiaMode = () => {
    const mode = Config.modes.find((candidate) => candidate.enabled && candidate.mapName === opsiaMapName);
    if (!mode) throw new Error(`OPSIA_MAP_NAME=${opsiaMapName} must be enabled in Config.modes`);
    return mode;
};
const opsiaMode = getOpsiaMode();
const opsiaModeLabel = opsiaMapName === "faction" ? "Faction 50v50" : "Solo FFA";
const opsiaMaxPlayers = MapDefs[opsiaMapName].gameMode.maxPlayers;

const controlToken = readControlToken();
const requireSessionGateway = process.env.OPSIA_ROOM === "true"
    && process.env.REQUIRE_SESSION_GATEWAY === "true";
const sessionGatewaySharedSecret = process.env.SESSION_GATEWAY_SHARED_SECRET?.trim() ?? "";
if (requireSessionGateway) assertGatewaySharedSecret(sessionGatewaySharedSecret);
const consumedGatewayNonces = new Map<string, number>();
const consumeGatewayNonce = (nonce: string, now = Date.now()): boolean => {
    for (const [candidate, expiresAt] of consumedGatewayNonces) {
        if (expiresAt <= now) consumedGatewayNonces.delete(candidate);
    }
    if (consumedGatewayNonces.has(nonce)) return false;
    consumedGatewayNonces.set(nonce, now + 60_000);
    return true;
};
const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

class OpsiaMetrics {
    readonly registry = new Registry();
    private readonly snapshotCounterBaselines = new Map<
        string,
        { coalescedTotal: number; failuresTotal: number; timeoutsTotal: number }
    >();
    private readonly tickP95 = new Gauge({
        name: "tick_p95_ms",
        help: "500ms-window p95 of survev Game.update duration",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly online = new Gauge({
        name: "players_online",
        help: "players in the real survev playerBarn",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly processResidentMemory = new Gauge({
        name: "process_resident_memory_bytes",
        help: "resident memory of the authoritative survev game process",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly alive = new Gauge({
        name: "players_alive",
        help: "living players in the real survev playerBarn",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly inputs = new Counter({
        name: "player_input_rate_total",
        help: "decoded survev input outcomes",
        labelNames: ["room", "outcome"] as const,
        registers: [this.registry],
    });
    private readonly snapshotInflight = new Gauge({
        name: "game_snapshot_inflight",
        help: "whether a room snapshot write is currently in flight",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotPending = new Gauge({
        name: "game_snapshot_pending",
        help: "bounded latest snapshot request waiting behind the active write",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotPayloadBytes = new Gauge({
        name: "game_snapshot_payload_bytes",
        help: "serialized snapshot envelope size",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotWriteDuration = new Gauge({
        name: "game_snapshot_write_duration_seconds",
        help: "duration of the latest snapshot write",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotCoalesced = new Counter({
        name: "game_snapshot_coalesced_total",
        help: "snapshot requests coalesced into the bounded latest request",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotFailures = new Counter({
        name: "game_snapshot_failures_total",
        help: "snapshot serialization, write, journal, and timeout failures",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotTimeouts = new Counter({
        name: "game_snapshot_timeouts_total",
        help: "snapshot writes that crossed the bounded write deadline",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotCircuitOpen = new Gauge({
        name: "game_snapshot_circuit_open",
        help: "whether repeated snapshot failures have disabled handoff",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly snapshotHandoffEnabled = new Gauge({
        name: "game_snapshot_handoff_enabled",
        help: "whether the latest snapshot state is eligible for room handoff",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly roomEpoch = new Gauge({
        name: "game_room_epoch",
        help: "fencing epoch attached to the latest snapshot",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });
    private readonly serverTick = new Gauge({
        name: "game_server_tick",
        help: "authoritative server tick attached to the latest snapshot",
        labelNames: ["room"] as const,
        registers: [this.registry],
    });

    observe(snapshot: OpsiaSnapshotData): void {
        this.tickP95.labels(snapshot.roomId).set(snapshot.tickP95Ms);
        this.online.labels(snapshot.roomId).set(snapshot.players.filter((player) => player.connected).length);
        this.processResidentMemory.labels(snapshot.roomId).set(Math.round(snapshot.memoryMb * 1024 * 1024));
        this.alive.labels(snapshot.roomId).set(
            snapshot.players.filter((player) => player.connected && player.alive).length,
        );
        if (snapshot.inputAccepted) this.inputs.labels(snapshot.roomId, "accepted").inc(snapshot.inputAccepted);
        if (snapshot.inputRejected) this.inputs.labels(snapshot.roomId, "rejected").inc(snapshot.inputRejected);
        const writer = snapshot.snapshot;
        this.snapshotInflight.labels(snapshot.roomId).set(writer.inflight);
        this.snapshotPending.labels(snapshot.roomId).set(writer.pending);
        this.snapshotPayloadBytes.labels(snapshot.roomId).set(writer.payloadBytes);
        this.snapshotWriteDuration.labels(snapshot.roomId).set(writer.writeDurationMs / 1_000);
        this.snapshotCircuitOpen.labels(snapshot.roomId).set(writer.circuitOpen ? 1 : 0);
        this.snapshotHandoffEnabled.labels(snapshot.roomId).set(writer.handoffEnabled ? 1 : 0);
        this.roomEpoch.labels(snapshot.roomId).set(writer.roomEpoch);
        this.serverTick.labels(snapshot.roomId).set(writer.serverTick);
        const previous = this.snapshotCounterBaselines.get(snapshot.roomId) ?? {
            coalescedTotal: 0,
            failuresTotal: 0,
            timeoutsTotal: 0,
        };
        const coalescedDelta = Math.max(0, writer.coalescedTotal - previous.coalescedTotal);
        const failureDelta = Math.max(0, writer.failuresTotal - previous.failuresTotal);
        const timeoutDelta = Math.max(0, writer.timeoutsTotal - previous.timeoutsTotal);
        if (coalescedDelta) this.snapshotCoalesced.labels(snapshot.roomId).inc(coalescedDelta);
        if (failureDelta) this.snapshotFailures.labels(snapshot.roomId).inc(failureDelta);
        if (timeoutDelta) this.snapshotTimeouts.labels(snapshot.roomId).inc(timeoutDelta);
        this.snapshotCounterBaselines.set(snapshot.roomId, {
            coalescedTotal: writer.coalescedTotal,
            failuresTotal: writer.failuresTotal,
            timeoutsTotal: writer.timeoutsTotal,
        });
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
    private joinLocked = false;
    private joinLockClient: RedisClientType | undefined;
    private readonly joinLockKey = `room:${process.env.ROOM_ID ?? "room-0"}:join-lock`;

    constructor() {
        this.manager.onOpsiaSnapshot((snapshot) => this.metrics.observe(snapshot));
    }

    async initializeOpsiaControls(): Promise<void> {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) return;
        this.joinLockClient = createClient({ url: redisUrl });
        this.joinLockClient.on("error", (error) => this.logger.error("Join-lock Redis error", error));
        await this.joinLockClient.connect();
        await this.refreshJoinLock();
        const refreshTimer = setInterval(() => {
            void this.refreshJoinLock().catch((error) => this.logger.error("Join-lock refresh failed", error));
        }, 1_000);
        refreshTimer.unref();
    }

    private async refreshJoinLock(): Promise<void> {
        if (!this.joinLockClient) return;
        if (!this.joinLockClient.isOpen) throw new Error("join_lock_store_unavailable");
        this.joinLocked = await this.joinLockClient.get(this.joinLockKey) === "1";
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

    async findOpsiaGame(body: z.infer<typeof zOpsiaFindGame>, host: string, ip: string, useHttps = this.region.https) {
        if (process.env.OPSIA_ROLE === "candidate") return { error: "candidate_not_public" };
        // Fail closed and, critically, finish the HTTP response if Redis is
        // unavailable. A join-lock lookup must never leave admission hanging.
        await withTimeout(this.refreshJoinLock(), 1_500, "join_lock_unavailable");
        if (this.joinLocked) return { error: "room_join_locked" };
        // Each room pod owns one configured map. The client still renders the
        // upstream mode menu, but admission can never switch this pod's map.
        const mode = opsiaMode;
        const token = randomUUID();
        let result: FindGamePrivateRes;
        try {
            result = await this.findGame({
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
                    spectator: body.spectator === true,
                    spectateSessionId: body.spectator === true ? body.spectateSessionId : undefined,
                }],
            });
        } catch (error) {
            if (error instanceof Error && error.message === "full") return { error: "full" };
            throw error;
        }
        if ("error" in result) return result;
        return {
            res: [{
                zone: this.regionId,
                gameId: result.gameId,
                useHttps,
                hosts: [host],
                addrs: [host],
                data: token,
            }],
        };
    }

    async setJoinLocked(locked: boolean): Promise<void> {
        await this.joinLockClient?.set(this.joinLockKey, locked ? "1" : "0");
        this.joinLocked = locked;
    }

    isJoinLocked(): boolean {
        return this.joinLocked;
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
await server.initializeOpsiaControls();

if (process.env.OPSIA_ROOM === "true") {
    server.manager.newGame(opsiaMode);
} else if (process.env.NODE_ENV !== "production") {
    server.manager.newGame(Config.modes[0]!);
}

const app = Config.gameServer.ssl
    ? SSLApp({
        key_file_name: Config.gameServer.ssl.keyFile,
        cert_file_name: Config.gameServer.ssl.certFile,
    })
    : App();

const authorizeOpsRequest = (res: HttpResponse, req: HttpRequest): boolean => {
    if (controlTokenMatches(req.getHeader("authorization"), controlToken)) return true;
    res.writeStatus("401 Unauthorized")
        .writeHeader("Content-Type", "application/json")
        .writeHeader("WWW-Authenticate", "Bearer realm=\"demo-game-control\"")
        .end(JSON.stringify({ error: "unauthorized" }));
    return false;
};

app.get("/health", (res) => {
    res.writeStatus("200 OK");
    res.write("OK");
    res.end();
});

app.get("/healthz", (res) => {
    if (process.env.OPSIA_ROOM === "true" && ["auto", "candidate"].includes(process.env.OPSIA_ROLE ?? "")) {
        res.onAborted(() => {
            res.aborted = true;
        });
        void server.manager.getOpsiaHandoffStatus().then((handoff) => {
            if (res.aborted) return;
            const healthy = handoff.role === "active" && handoff.ready && server.manager.isOpsiaReady();
            res.cork(() => {
                if (!healthy) res.writeStatus("503 Service Unavailable");
                uwsHelpers.returnJson(res, {
                    status: healthy ? "ok" : "handoff-waiting",
                    roomId: process.env.ROOM_ID ?? "room-0",
                    runtime: "survev-gameServer",
                    role: handoff.role,
                    phase: handoff.phase,
                });
            });
        }).catch(() => {
            if (!res.aborted) {
                res.cork(() => res.writeStatus("503 Service Unavailable").end("handoff status unavailable"));
            }
        });
        return;
    }
    if (process.env.OPSIA_ROOM === "true" && !server.manager.isOpsiaReady()) {
        res.writeStatus("503 Service Unavailable");
        uwsHelpers.returnJson(res, {
            status: "initializing",
            roomId: process.env.ROOM_ID ?? "room-0",
            runtime: "survev-gameServer",
        });
        return;
    }
    uwsHelpers.returnJson(res, { status: "ok", roomId: process.env.ROOM_ID ?? "room-0", runtime: "survev-gameServer" });
});

app.get("/metrics", async (res) => {
    res.onAborted(() => {
        res.aborted = true;
    });
    const text = await server.metrics.registry.metrics();
    if (!res.aborted) res.cork(() => res.writeHeader("Content-Type", server.metrics.registry.contentType).end(text));
});

const returnSiteInfo = (res: Parameters<typeof uwsHelpers.returnJson>[0]) => {
    uwsHelpers.returnJson(res, {
        country: "local",
        gitRevision: GIT_VERSION,
        captchaEnabled: false,
        modes: process.env.OPSIA_ROOM === "true" ? [opsiaMode] : Config.modes,
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
        mapName: opsiaMapName,
        mode: opsiaModeLabel,
        maxPlayers: opsiaMaxPlayers,
        status: server.manager.isOpsiaReady() ? "running" : "initializing",
        players: snapshot?.players.filter((player) => player.connected).length ?? 0,
        alive: snapshot?.players.filter((player) => player.connected && player.alive).length ?? 0,
        podName: process.env.POD_NAME ?? "game-0",
        strictMode: process.env.STRICT_MODE === "true",
        joinLocked: server.isJoinLocked(),
        capturedAt: snapshot?.capturedAt,
        tickP95Ms: snapshot?.tickP95Ms,
        cpuPercent: snapshot?.cpuPercent,
        memoryMb: snapshot?.memoryMb,
        uptimeSeconds: snapshot?.uptimeSeconds,
        inputAccepted: snapshot?.inputAccepted,
        inputRejected: snapshot?.inputRejected,
        opsiaRole: process.env.OPSIA_ROLE ?? "active",
        qrUrl: `${process.env.PUBLIC_BASE_URL ?? "http://localhost:8090"}/play/${process.env.ROOM_ID ?? "room-0"}/`,
    });
});

app.get("/ops/snapshot", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    const snapshot = server.manager.getOpsiaSnapshot();
    if (!snapshot) {
        res.writeStatus("503 Service Unavailable").end(JSON.stringify({ error: "ops_snapshot_pending" }));
        return;
    }
    const responseSnapshot = req.getQuery("brain") === "1"
        ? {
            ...snapshot,
            map: {
                ...snapshot.map,
                objects: snapshot.map.objects.filter(
                    (object) => object.kind === "building" || object.kind === "structure",
                ),
            },
        }
        : snapshot;
    uwsHelpers.returnJson(res, responseSnapshot as unknown as Record<string, unknown>);
});

app.post("/ops/end", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void server.manager.resetOpsiaRoom().then((resetAt) => {
        if (!res.aborted) {
            res.cork(() =>
                uwsHelpers.returnJson(res, { status: "reset", roomId: process.env.ROOM_ID ?? "room-0", resetAt })
            );
        }
    }).catch((error) => {
        if (!res.aborted) {
            res.cork(() =>
                res.writeStatus("503 Service Unavailable").end(
                    JSON.stringify({ error: error instanceof Error ? error.message : "room_reset_failed" }),
                )
            );
        }
    });
});

app.post("/ops/snapshot/save", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void server.manager.saveOpsiaRoom().then((savedAt) => {
        if (!res.aborted) {
            res.cork(() =>
                uwsHelpers.returnJson(res, { status: "saved", roomId: process.env.ROOM_ID ?? "room-0", savedAt })
            );
        }
    }).catch((error) => {
        if (!res.aborted) {
            res.cork(() =>
                res.writeStatus("503 Service Unavailable").end(
                    JSON.stringify({ error: error instanceof Error ? error.message : "snapshot_save_failed" }),
                )
            );
        }
    });
});

app.get("/ops/handoff/status", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void server.manager.getOpsiaHandoffStatus().then((status) => {
        if (!res.aborted) res.cork(() => uwsHelpers.returnJson(res, status as unknown as Record<string, unknown>));
    }).catch((error) => {
        if (!res.aborted) {
            res.cork(() =>
                res.writeStatus("503 Service Unavailable")
                    .writeHeader("Content-Type", "application/json")
                    .end(JSON.stringify({ error: error instanceof Error ? error.message : "handoff_status_failed" }))
            );
        }
    });
});

app.post("/ops/handoff/seed", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void (async () => {
        let request: z.infer<typeof zCandidateSeed>;
        try {
            request = await uwsHelpers.getJsonBody(res, zCandidateSeed);
        } catch (error) {
            server.logger.warn("/ops/handoff/seed invalid body: ", error);
            return;
        }
        try {
            const status = await server.manager.seedOpsiaCandidate(request);
            if (res.aborted) return;
            res.cork(() => {
                if (!status.ready) res.writeStatus("409 Conflict");
                uwsHelpers.returnJson(res, status as unknown as Record<string, unknown>);
            });
        } catch (error) {
            if (!res.aborted) {
                const message = error instanceof Error ? error.message : "candidate_seed_failed";
                const responseStatus = message === "candidate_role_required"
                    ? "409 Conflict"
                    : "503 Service Unavailable";
                res.cork(() =>
                    res.writeStatus(responseStatus)
                        .writeHeader("Content-Type", "application/json")
                        .end(JSON.stringify({ error: message }))
                );
            }
        }
    })();
});

app.post("/ops/handoff/release", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void (async () => {
        let request: z.infer<typeof zAuthorityRelease>;
        try {
            request = await uwsHelpers.getJsonBody(res, zAuthorityRelease);
        } catch (error) {
            server.logger.warn("/ops/handoff/release invalid body: ", error);
            return;
        }
        try {
            const status = await server.manager.releaseOpsiaAuthority(request);
            if (!res.aborted) res.cork(() => uwsHelpers.returnJson(res, status as unknown as Record<string, unknown>));
        } catch (error) {
            if (!res.aborted) {
                res.cork(() =>
                    res.writeStatus("409 Conflict")
                        .writeHeader("Content-Type", "application/json")
                        .end(
                            JSON.stringify({
                                error: error instanceof Error ? error.message : "authority_release_failed",
                            }),
                        )
                );
            }
        }
    })();
});

app.post("/ops/handoff/promote", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void (async () => {
        let request: z.infer<typeof zCandidatePromote>;
        try {
            request = await uwsHelpers.getJsonBody(res, zCandidatePromote);
        } catch (error) {
            server.logger.warn("/ops/handoff/promote invalid body: ", error);
            return;
        }
        try {
            const status = await server.manager.promoteOpsiaCandidate(request);
            if (!res.aborted) res.cork(() => uwsHelpers.returnJson(res, status as unknown as Record<string, unknown>));
        } catch (error) {
            if (!res.aborted) {
                res.cork(() =>
                    res.writeStatus("409 Conflict")
                        .writeHeader("Content-Type", "application/json")
                        .end(
                            JSON.stringify({
                                error: error instanceof Error ? error.message : "candidate_promote_failed",
                            }),
                        )
                );
            }
        }
    })();
});

app.post("/ops/failure/process-crash", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.onAborted(() => {
        res.aborted = true;
    });
    void server.manager.saveOpsiaRoom().then((savedAt) => {
        if (res.aborted) return;
        let pid: number;
        try {
            pid = server.manager.crashOpsiaRoom();
        } catch (error) {
            const message = error instanceof Error ? error.message : "room_crash_failed";
            const status = message === "room_recovery_in_progress"
                ? "409 Conflict"
                : "503 Service Unavailable";
            res.cork(() => res.writeStatus(status).end(JSON.stringify({ error: message })));
            return;
        }
        res.cork(() =>
            uwsHelpers.returnJson(res, {
                status: "recovery_requested",
                roomId: process.env.ROOM_ID ?? "room-0",
                savedAt,
                pid,
            })
        );
    }).catch((error) => {
        if (!res.aborted) {
            res.cork(() =>
                res.writeStatus("503 Service Unavailable").end(
                    JSON.stringify({ error: error instanceof Error ? error.message : "snapshot_save_failed" }),
                )
            );
        }
    });
});

app.get("/ops/join-lock", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    uwsHelpers.returnJson(res, { roomId: process.env.ROOM_ID ?? "room-0", locked: server.isJoinLocked() });
});

app.post("/ops/join-lock/:state", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    const state = req.getParameter(0);
    if (state !== "true" && state !== "false") {
        res.writeStatus("400 Bad Request").end(JSON.stringify({ error: "invalid_join_lock" }));
        return;
    }
    res.onAborted(() => {
        res.aborted = true;
    });
    void server.setJoinLocked(state === "true").then(() => {
        if (!res.aborted) {
            res.cork(() =>
                uwsHelpers.returnJson(res, { roomId: process.env.ROOM_ID ?? "room-0", locked: server.isJoinLocked() })
            );
        }
    }).catch((error) => {
        if (!res.aborted) {
            res.cork(() =>
                res.writeStatus("503 Service Unavailable").end(
                    JSON.stringify({ error: error instanceof Error ? error.message : "join_lock_store_failed" }),
                )
            );
        }
    });
});

app.any("/ops/*", (res, req) => {
    if (!authorizeOpsRequest(res, req)) return;
    res.writeStatus("404 Not Found").end(JSON.stringify({ error: "not_found" }));
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

const handleFindGame = async (
    res: Parameters<typeof uwsHelpers.getJsonBody>[0],
    req: Parameters<typeof uwsHelpers.getIp>[1],
) => {
    res.onAborted(() => {
        res.aborted = true;
    });

    // OPSIA exposes only the public admission contract. The demo config is
    // intentionally repository-visible, so its upstream private API key must
    // never select a less-restricted branch in a room Pod.
    if (process.env.OPSIA_ROOM === "true") {
        // uWS request headers are only valid before awaiting body parsing.
        const host = req.getHeader("host") || server.region.address;
        const useHttps = server.region.https
            || req.getHeader("x-forwarded-proto").split(",")[0]?.trim() === "https";
        const ip = uwsHelpers.getIp(res, req, Config.gameServer.proxyIPHeader);
        if (!ip) {
            res.writeStatus("400 Bad Request").end(JSON.stringify({ error: "invalid_client_ip" }));
            return;
        }
        // Reserve rate-limit capacity before parsing or creating a 15-second
        // game token. WebSocket upgrades use the same per-IP window below.
        if (gameHTTPRateLimit.isRateLimited(ip)) {
            res.writeStatus("429 Too Many Requests").end(JSON.stringify({ error: "find_game_rate_limited" }));
            return;
        }
        let body: z.infer<typeof zOpsiaFindGame>;
        try {
            body = await uwsHelpers.getJsonBody(res, zOpsiaFindGame);
        } catch (error) {
            // getJsonBody has already ended the response with 400 or 413.
            server.logger.warn("/api/find_game invalid body: ", error);
            return;
        }
        try {
            uwsHelpers.returnJson(res, await server.findOpsiaGame(body, host, ip, useHttps));
        } catch (error) {
            server.logger.warn("/api/find_game unavailable: ", error);
            if (!res.aborted) {
                res.cork(() =>
                    res.writeStatus("503 Service Unavailable")
                        .writeHeader("Content-Type", "application/json")
                        .end(JSON.stringify({ error: "find_game_unavailable" }))
                );
            }
        }
        return;
    }
    if (req.getHeader("survev-api-key") !== Config.secrets.SURVEV_API_KEY) {
        uwsHelpers.forbidden(res);
        return;
    }
    let body: z.infer<typeof zFindGamePrivateBody>;
    try {
        body = await uwsHelpers.getJsonBody(res, zFindGamePrivateBody);
    } catch (error) {
        server.logger.warn("/api/find_game invalid private body: ", error);
        return;
    }
    try {
        uwsHelpers.returnJson(res, await server.findGame(body));
    } catch (error) {
        server.logger.warn("/api/find_game private service unavailable: ", error);
        if (!res.aborted) {
            res.cork(() =>
                res.writeStatus("503 Service Unavailable")
                    .writeHeader("Content-Type", "application/json")
                    .end(JSON.stringify({ error: "find_game_unavailable" }))
            );
        }
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
const gameHTTPRateLimit = new HTTPRateLimit(opsiaRoom ? 40 : 5, 1000);
const gameWsRateLimit = new WebSocketRateLimit(500, 1000, opsiaRoom ? 100 : 5);

const gameWsBehavior: import("uWebSockets.js").WebSocketBehavior<GameSocketData> = {
    idleTimeout: 30,
    maxPayloadLength: 2 * 1024,

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
        const gatewayRequested = searchParams.get("opsiaGateway") === "1";
        const gatewaySessionId = gatewayRequested ? searchParams.get("gatewaySessionId") ?? "" : undefined;
        const roomEpoch = gatewayRequested ? Number(searchParams.get("roomEpoch")) : undefined;
        const gatewayIssuedAt = gatewayRequested ? Number(searchParams.get("gatewayIssuedAt")) : undefined;
        const gatewayNonce = gatewayRequested ? searchParams.get("gatewayNonce") ?? "" : undefined;
        const gatewaySignature = gatewayRequested ? searchParams.get("gatewaySignature") ?? "" : undefined;

        if (!gameId) {
            server.logger.warn("Websocket upgrade closed: no game ID");
            uwsHelpers.forbidden(res);
            return;
        }
        if (requireSessionGateway && !gatewayRequested) {
            res.writeStatus("403 Forbidden").end("session_gateway_required");
            return;
        }
        if (gatewayRequested) {
            const identity: GatewayConnectionIdentity = {
                roomId: process.env.ROOM_ID ?? "",
                gameId,
                sessionId: gatewaySessionId ?? "",
                roomEpoch: roomEpoch ?? Number.NaN,
                issuedAt: gatewayIssuedAt ?? Number.NaN,
                nonce: gatewayNonce ?? "",
            };
            if (
                !verifyGatewayConnection(
                    sessionGatewaySharedSecret,
                    identity,
                    gatewaySignature ?? "",
                )
                || !consumeGatewayNonce(identity.nonce)
            ) {
                res.writeStatus("403 Forbidden").end("invalid_gateway_signature");
                return;
            }
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
                    gatewaySessionId,
                    roomEpoch,
                    gatewayJoinConsumed: false,
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
            const output = data.gatewaySessionId && Number.isSafeInteger(data.roomEpoch)
                ? encodeGatewayOutput({
                    roomEpoch: data.roomEpoch!,
                    serverTick: 0,
                    payload: stream.getBuffer(),
                })
                : stream.getBuffer();
            socket.send(output, true, false);
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
        const data = socket.getUserData();
        if (data.gatewaySessionId) {
            let frame: ReturnType<typeof decodeGatewayFrame>;
            try {
                frame = decodeGatewayFrame(message);
            } catch {
                socket.end(1002, "invalid_gateway_wire_frame");
                return;
            }
            if (frame?.kind !== "input" || frame.roomEpoch !== data.roomEpoch) {
                socket.end(1002, "gateway_epoch_or_frame_invalid");
                return;
            }
            if (frame.inputSequence === 0) {
                if (data.gatewayJoinConsumed || !readGatewayJoin(frame.payload)) {
                    socket.end(1002, "gateway_join_frame_invalid");
                    return;
                }
                data.gatewayJoinConsumed = true;
                server.manager.onMsg(data.id, Uint8Array.from(frame.payload).buffer);
                return;
            }
            if (!data.gatewayJoinConsumed) {
                socket.end(1002, "gateway_join_required");
                return;
            }
            server.manager.onMsg(
                data.id,
                Uint8Array.from(frame.payload).buffer,
                {
                    sessionId: data.gatewaySessionId,
                    inputSequence: frame.inputSequence,
                    clientTick: frame.clientTick,
                    roomEpoch: frame.roomEpoch,
                },
            );
            return;
        }
        server.manager.onMsg(data.id, message);
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
    const candidate = requestPath === "/" || /^\/(play|watch)\/room-\d+\/?$/.test(requestPath)
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
