import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GameConfig } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import { type BotBrainSnapshot, createBotBrainState, decideBotIntent } from "./botBrain.ts";
import { createBotInput } from "./botInput.ts";
import { controlTokenMatches, readControlToken } from "./controlPlaneAuth.ts";

type BotMode = "normal" | "hack";
type FindGameResponse = {
    res?: Array<{ gameId: string; useHttps: boolean; addrs: string[]; data: string }>;
    error?: string;
};

type BotSummary = {
    id: string;
    sessionId: string;
    nickname: string;
    roomId: string;
    mode: BotMode;
    connected: boolean;
};
type BotJobState = "running" | "completed" | "cancelled" | "failed";
type BotJob = {
    jobId: string;
    roomId: string;
    total: number;
    completed: number;
    intervalMs: number;
    mode: BotMode;
    state: BotJobState;
    error?: string;
};

const controlToken = readControlToken();
type RoomAwareness = {
    snapshot?: BotBrainSnapshot;
    requestedAt: number;
    pending?: Promise<void>;
};
const roomAwareness = new Map<string, RoomAwareness>();

const requestRoomAwareness = (roomId: string, endpoint: string): void => {
    const awareness = roomAwareness.get(roomId) ?? { requestedAt: 0 };
    roomAwareness.set(roomId, awareness);
    const now = Date.now();
    if (awareness.pending || now - awareness.requestedAt < 250) return;
    awareness.requestedAt = now;
    awareness.pending = (async () => {
        try {
            const response = await fetch(`${endpoint}/ops/snapshot`, {
                headers: controlToken ? { authorization: `Bearer ${controlToken}` } : undefined,
                signal: AbortSignal.timeout(900),
            });
            if (!response.ok) return;
            awareness.snapshot = await response.json() as BotBrainSnapshot;
        } catch {
            // A stale snapshot still produces safe wandering while a room is
            // being replaced. The next shared refresh retries automatically.
        } finally {
            awareness.pending = undefined;
        }
    })();
};

class SurvevProtocolBot {
    readonly id: string;
    readonly sessionId: string;
    readonly nickname: string;
    readonly roomId: string;
    readonly mode: BotMode;
    private readonly ws: WebSocket;
    private readonly stream = new net.MsgStream(new ArrayBuffer(1024));
    private timer: NodeJS.Timeout | undefined;
    private connected = false;
    private stopped = false;
    private readySettled = false;
    private readonly readyPromise: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (error: Error) => void;
    private readonly brain = createBotBrainState();

    constructor(
        id: string,
        sessionId: string,
        roomId: string,
        mode: BotMode,
        match: NonNullable<FindGameResponse["res"]>[number],
        private readonly roomEndpoint: string,
        private readonly onStopped: (id: string) => void,
    ) {
        this.id = id;
        this.sessionId = sessionId;
        this.nickname = `OPSIA_${id.slice(-6)}`;
        this.roomId = roomId;
        this.mode = mode;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.ws = new WebSocket(`ws${match.useHttps ? "s" : ""}://${match.addrs[0]}/play?gameId=${match.gameId}`);
        this.ws.binaryType = "arraybuffer";
        this.ws.addEventListener("open", () => {
            const join = new net.JoinMsg();
            join.bot = true;
            join.name = this.nickname;
            join.isMobile = false;
            join.protocol = GameConfig.protocolVersion;
            join.matchPriv = match.data;
            join.loadout = {
                outfit: "outfitBase",
                melee: "fists",
                heal: "heal_basic",
                boost: "boost_basic",
                emotes: [
                    "emote_happyface",
                    "emote_sadface",
                    "emote_surviv",
                    "emote_thumbsup",
                    "emote_angryface",
                    "emote_happyface",
                ],
            };
            this.send(net.MsgType.Join, join);
        });
        this.ws.addEventListener("message", () => {
            if (this.stopped || this.connected) return;
            this.connected = true;
            this.timer = setInterval(() => this.sendInputs(), 30);
            this.settleReady();
        });
        this.ws.addEventListener("close", () => {
            this.settleReady(new Error("bot_connection_closed"));
            this.stop();
        });
        this.ws.addEventListener("error", () => {
            this.settleReady(new Error("bot_connection_failed"));
            this.stop();
        });
    }

    summary(): BotSummary {
        return {
            id: this.id,
            sessionId: this.sessionId,
            nickname: this.nickname,
            roomId: this.roomId,
            mode: this.mode,
            connected: this.connected,
        };
    }

    async waitUntilConnected(timeoutMs = 5_000): Promise<void> {
        let timeout: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                this.readyPromise,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("bot_connection_timeout")), timeoutMs);
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    stop(): void {
        // Node's WebSocket emits close/error while close() is in progress.
        // Keep the real protocol client teardown idempotent so one rejected
        // socket cannot take down the entire bot-runner process.
        if (this.stopped) return;
        this.stopped = true;
        this.connected = false;
        this.settleReady(new Error("bot_stopped"));
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
        this.onStopped(this.id);
    }

    private settleReady(error?: Error): void {
        if (this.readySettled) return;
        this.readySettled = true;
        if (error) this.rejectReady(error);
        else this.resolveReady();
    }

    private send(type: net.MsgType, message: net.Msg): void {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        this.stream.stream.index = 0;
        this.stream.serializeMsg(type, message);
        this.ws.send(this.stream.getBuffer());
    }

    private sendInputs(): void {
        if (!this.connected) return;
        requestRoomAwareness(this.roomId, this.roomEndpoint);
        const intent = decideBotIntent(
            roomAwareness.get(this.roomId)?.snapshot,
            this.sessionId,
            this.brain,
        );
        const sendOne = () => {
            this.send(net.MsgType.Input, createBotInput(intent));
        };
        // Hack mode is intentionally a protocol-valid input flood. The real
        // ClientBarn validation hook—not this runner—decides enforcement.
        const count = this.mode === "hack" ? 20 : 1;
        for (let index = 0; index < count; index++) sendOne();
    }
}

const rooms = (): Map<string, string> => {
    const configured = process.env.OPSIA_ROOM_ENDPOINTS
        ?? "room-0=http://game-0:8001,room-1=http://game-1:8001,room-2=http://game-2:8001";
    return new Map(
        configured.split(",").map((entry) => {
            const [roomId, endpoint] = entry.split("=");
            return [roomId!, endpoint!];
        }),
    );
};

const bots = new Map<string, SurvevProtocolBot>();
const jobs = new Map<string, BotJob>();
let roundRobin = 0;
const minimumBotsPerRoom = Math.max(
    0,
    Math.min(100, Number.parseInt(process.env.OPSIA_MIN_BOTS_PER_ROOM ?? "0", 10) || 0),
);
const reconcileIntervalMs = Math.max(
    1_000,
    Math.min(30_000, Number.parseInt(process.env.OPSIA_BOT_RECONCILE_INTERVAL_MS ?? "2_000", 10) || 2_000),
);
const reconcileBatchSize = Math.max(
    1,
    Math.min(20, Number.parseInt(process.env.OPSIA_BOT_RECONCILE_BATCH_SIZE ?? "5", 10) || 5),
);
let reconciliationPending = false;

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};
const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
};

const spawn = async (
    count: number,
    requestedRoom: string | undefined,
    mode: BotMode,
    requestedSessionId?: string,
): Promise<BotSummary[]> => {
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("invalid_bot_count");
    const roomMap = rooms();
    const roomIds = [...roomMap.keys()];
    if (!roomIds.length) throw new Error("no_room_endpoint");
    const created: SurvevProtocolBot[] = [];
    for (let index = 0; index < count; index++) {
        const roomId = requestedRoom ?? roomIds[roundRobin++ % roomIds.length]!;
        const endpoint = roomMap.get(roomId);
        if (!endpoint) throw new Error("unknown_room");
        const uniqueSuffix = `${Date.now()}-${index}-${Math.random().toString(16).slice(2, 10)}`;
        const sessionId = requestedSessionId
            ? count === 1 ? requestedSessionId : `${requestedSessionId}-${index}`
            : `opsia-bot-${uniqueSuffix}`;
        const response = await fetch(`${endpoint}/api/find_game`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(2_000),
            body: JSON.stringify({
                region: "local",
                zones: ["local"],
                version: GameConfig.protocolVersion,
                playerCount: 1,
                autoFill: true,
                gameModeIdx: 2,
                opsiaSessionId: sessionId,
            }),
        });
        const match = await response.json() as FindGameResponse;
        if (!response.ok || !match.res?.[0]) throw new Error(`find_game_failed:${match.error ?? response.status}`);
        const id = `bot-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`;
        const bot = new SurvevProtocolBot(
            id,
            sessionId,
            roomId,
            mode,
            match.res[0],
            endpoint,
            (stoppedId) => bots.delete(stoppedId),
        );
        bots.set(id, bot);
        try {
            await bot.waitUntilConnected();
        } catch (error) {
            bot.stop();
            throw error;
        }
        created.push(bot);
    }
    return created.map((bot) => bot.summary());
};

const startJob = async (count: number, roomId: string, mode: BotMode, intervalMs: number): Promise<BotJob> => {
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("invalid_bot_count");
    if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 5_000) throw new Error("invalid_bot_interval");
    const endpoint = rooms().get(roomId);
    if (!endpoint) throw new Error("unknown_room");
    if ([...jobs.values()].some((job) => job.roomId === roomId && job.state === "running")) {
        throw new Error("bot_job_already_running");
    }
    const summaryResponse = await fetch(`${endpoint}/summary`, { signal: AbortSignal.timeout(1_500) });
    if (!summaryResponse.ok) throw new Error(`room_summary_failed:${summaryResponse.status}`);
    if ([...jobs.values()].some((job) => job.roomId === roomId && job.state === "running")) {
        throw new Error("bot_job_already_running");
    }
    const summary = await summaryResponse.json() as { players?: number; maxPlayers?: number };
    const connecting = [...bots.values()].filter((bot) => bot.roomId === roomId && !bot.summary().connected).length;
    const capacity = Number(summary.maxPlayers ?? 100);
    const available = Math.max(0, capacity - Number(summary.players ?? 0) - connecting);
    if (count > available) throw new Error("bot_capacity_exceeded");
    const job: BotJob = {
        jobId: `load-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        roomId,
        total: count,
        completed: 0,
        intervalMs,
        mode,
        state: "running",
    };
    jobs.set(job.jobId, job);
    while (jobs.size > 100) jobs.delete(jobs.keys().next().value!);
    void (async () => {
        try {
            for (let index = 0; index < count; index++) {
                if (job.state !== "running") return;
                const created = await spawn(1, roomId, mode);
                if (job.state !== "running") {
                    for (const bot of created) bots.get(bot.id)?.stop();
                    return;
                }
                job.completed += 1;
                if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
            if (job.state === "running") job.state = "completed";
        } catch (error) {
            if (job.state !== "running") return;
            job.state = "failed";
            job.error = error instanceof Error ? error.message : "bot_job_failed";
        }
    })();
    return job;
};

const connectedBotCount = (roomId: string): number =>
    [...bots.values()].filter((bot) => {
        const summary = bot.summary();
        return summary.roomId === roomId && summary.connected;
    }).length;

const reconcileMinimumBots = async (): Promise<void> => {
    if (minimumBotsPerRoom <= 0 || reconciliationPending) return;
    reconciliationPending = true;
    try {
        await Promise.all([...rooms().keys()].map(async (roomId) => {
            const deficit = minimumBotsPerRoom - connectedBotCount(roomId);
            if (deficit <= 0) return;
            const requested = Math.min(deficit, reconcileBatchSize);
            try {
                const created = await spawn(requested, roomId, "normal");
                console.log(JSON.stringify({
                    level: "info",
                    event: "bot_population_reconciled",
                    detail: {
                        roomId,
                        created: created.length,
                        connected: connectedBotCount(roomId),
                        desiredMinimum: minimumBotsPerRoom,
                    },
                }));
            } catch (error) {
                console.warn(JSON.stringify({
                    level: "warn",
                    event: "bot_population_reconcile_retry",
                    detail: {
                        roomId,
                        error: error instanceof Error ? error.message : "bot_reconcile_failed",
                    },
                }));
            }
        }));
    } finally {
        reconciliationPending = false;
    }
};

const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
        if (request.method === "GET" && pathname === "/healthz") {
            return reply(response, 200, {
                status: "ok",
                protocol: "survev",
                connectedBots: [...bots.values()].filter((bot) => bot.summary().connected).length,
                minimumBotsPerRoom,
                reconciliationPending,
            });
        }
        if (!controlTokenMatches(request.headers.authorization, controlToken)) {
            response.setHeader("www-authenticate", "Bearer realm=\"demo-game-control\"");
            return reply(response, 401, { error: "unauthorized" });
        }
        if (request.method === "GET" && pathname === "/bots") {
            return reply(response, 200, { bots: [...bots.values()].map((bot) => bot.summary()) });
        }
        const jobMatch = pathname.match(/^\/bots\/jobs\/([^/]+)$/);
        const cancelMatch = pathname.match(/^\/bots\/jobs\/([^/]+)\/cancel$/);
        if (request.method === "GET" && jobMatch) {
            const job = jobs.get(jobMatch[1]!);
            return job ? reply(response, 200, job) : reply(response, 404, { error: "bot_job_not_found" });
        }
        if (request.method === "POST" && cancelMatch) {
            const job = jobs.get(cancelMatch[1]!);
            if (!job) return reply(response, 404, { error: "bot_job_not_found" });
            if (job.state === "running") job.state = "cancelled";
            return reply(response, 200, job);
        }
        if (request.method === "POST" && pathname === "/bots/jobs") {
            const body = await readJson(request);
            const mode: BotMode = body.mode === "hack" ? "hack" : "normal";
            const roomId = String(body.room ?? "");
            const job = await startJob(Number(body.count), roomId, mode, Number(body.intervalMs ?? 300));
            return reply(response, 202, job);
        }
        if (request.method === "POST" && pathname === "/bots/spawn") {
            const body = await readJson(request);
            const mode: BotMode = body.mode === "hack" ? "hack" : "normal";
            return reply(response, 201, {
                bots: await spawn(
                    Number(body.count),
                    body.room ? String(body.room) : undefined,
                    mode,
                    body.sessionId ? String(body.sessionId) : undefined,
                ),
            });
        }
        if (request.method === "POST" && pathname === "/bots/kill") {
            const body = await readJson(request);
            const id = body.id ? String(body.id) : undefined;
            const roomId = body.room ? String(body.room) : undefined;
            if (!id) {
                for (const job of jobs.values()) {
                    if (job.state === "running" && (!roomId || job.roomId === roomId)) job.state = "cancelled";
                }
            }
            const selected = id
                ? [bots.get(id)].filter((bot): bot is SurvevProtocolBot => Boolean(bot))
                : [...bots.values()].filter((bot) => !roomId || bot.roomId === roomId);
            selected.forEach((bot) => {
                bot.stop();
                bots.delete(bot.id);
            });
            return reply(response, 200, { killed: selected.length });
        }
        return reply(response, 404, { error: "not_found" });
    } catch (error) {
        return reply(response, 400, { error: error instanceof Error ? error.message : "bad_request" });
    }
});

server.listen(Number(process.env.PORT ?? 8084), () => {
    console.log(
        JSON.stringify({
            level: "info",
            event: "bot_runner_listening",
            detail: {
                protocol: "survev",
                port: Number(process.env.PORT ?? 8084),
                minimumBotsPerRoom,
                reconcileIntervalMs,
            },
        }),
    );
    if (minimumBotsPerRoom > 0) {
        setTimeout(() => void reconcileMinimumBots(), 500);
        setInterval(() => void reconcileMinimumBots(), reconcileIntervalMs);
    }
});
