import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GameConfig } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import { v2 } from "../../../shared/utils/v2.ts";

type BotMode = "normal" | "hack";
type FindGameResponse = {
    res?: Array<{ gameId: string; useHttps: boolean; addrs: string[]; data: string }>;
    error?: string;
};

type BotSummary = { id: string; roomId: string; mode: BotMode; connected: boolean };

class SurvevProtocolBot {
    readonly id: string;
    readonly roomId: string;
    readonly mode: BotMode;
    private readonly ws: WebSocket;
    private readonly stream = new net.MsgStream(new ArrayBuffer(1024));
    private timer: NodeJS.Timeout | undefined;
    private connected = false;
    private stopped = false;
    private angle = Math.random() * Math.PI * 2;

    constructor(id: string, roomId: string, mode: BotMode, match: NonNullable<FindGameResponse["res"]>[number]) {
        this.id = id;
        this.roomId = roomId;
        this.mode = mode;
        this.ws = new WebSocket(`ws${match.useHttps ? "s" : ""}://${match.addrs[0]}/play?gameId=${match.gameId}`);
        this.ws.binaryType = "arraybuffer";
        this.ws.addEventListener("open", () => {
            this.connected = true;
            const join = new net.JoinMsg();
            join.bot = true;
            join.name = `OPSIA_${id.slice(-6)}`;
            join.isMobile = false;
            join.protocol = GameConfig.protocolVersion;
            join.matchPriv = match.data;
            join.loadout = {
                outfit: "outfitBase",
                melee: "fists",
                heal: "heal_basic",
                boost: "boost_basic",
                emotes: ["emote_happyface", "emote_sadface", "emote_surviv", "emote_thumbsup", "emote_angryface", "emote_happyface"],
            };
            this.send(net.MsgType.Join, join);
            this.timer = setInterval(() => this.sendInputs(), 30);
        });
        this.ws.addEventListener("close", () => this.stop());
        this.ws.addEventListener("error", () => this.stop());
    }

    summary(): BotSummary {
        return { id: this.id, roomId: this.roomId, mode: this.mode, connected: this.connected };
    }

    stop(): void {
        // Node's WebSocket emits close/error while close() is in progress.
        // Keep the real protocol client teardown idempotent so one rejected
        // socket cannot take down the entire bot-runner process.
        if (this.stopped) return;
        this.stopped = true;
        this.connected = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    }

    private send(type: net.MsgType, message: net.Msg): void {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        this.stream.stream.index = 0;
        this.stream.serializeMsg(type, message);
        this.ws.send(this.stream.getBuffer());
    }

    private sendInputs(): void {
        if (!this.connected) return;
        this.angle += 0.08;
        const sendOne = () => {
            const input = new net.InputMsg();
            input.moveUp = Math.sin(this.angle) > 0;
            input.moveRight = Math.cos(this.angle) > 0;
            input.shootStart = Math.random() < 0.12;
            input.toMouseDir = v2.create(Math.cos(this.angle), Math.sin(this.angle));
            input.toMouseLen = 40;
            this.send(net.MsgType.Input, input);
        };
        // Hack mode is intentionally a protocol-valid input flood. The real
        // ClientBarn validation hook—not this runner—decides enforcement.
        const count = this.mode === "hack" ? 20 : 1;
        for (let index = 0; index < count; index++) sendOne();
    }
}

const rooms = (): Map<string, string> => {
    const configured = process.env.OPSIA_ROOM_ENDPOINTS ?? "room-0=http://game-0:8001,room-1=http://game-1:8001,room-2=http://game-2:8001";
    return new Map(configured.split(",").map((entry) => {
        const [roomId, endpoint] = entry.split("=");
        return [roomId!, endpoint!];
    }));
};

const bots = new Map<string, SurvevProtocolBot>();
let roundRobin = 0;

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};
const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
};

const spawn = async (count: number, requestedRoom: string | undefined, mode: BotMode, requestedSessionId?: string): Promise<BotSummary[]> => {
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("invalid_bot_count");
    const roomMap = rooms();
    const roomIds = [...roomMap.keys()];
    if (!roomIds.length) throw new Error("no_room_endpoint");
    const created: SurvevProtocolBot[] = [];
    for (let index = 0; index < count; index++) {
        const roomId = requestedRoom ?? roomIds[roundRobin++ % roomIds.length]!;
        const endpoint = roomMap.get(roomId);
        if (!endpoint) throw new Error("unknown_room");
        const sessionId = requestedSessionId ?? `opsia-bot-${Date.now()}-${index}`;
        const response = await fetch(`${endpoint}/api/find_game`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ region: "local", zones: ["local"], version: GameConfig.protocolVersion, playerCount: 1, autoFill: true, gameModeIdx: 2, opsiaSessionId: sessionId }),
        });
        const match = await response.json() as FindGameResponse;
        if (!response.ok || !match.res?.[0]) throw new Error(`find_game_failed:${match.error ?? response.status}`);
        const id = `bot-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`;
        const bot = new SurvevProtocolBot(id, roomId, mode, match.res[0]);
        bots.set(id, bot);
        created.push(bot);
    }
    return created.map((bot) => bot.summary());
};

const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
        if (request.method === "GET" && pathname === "/healthz") return reply(response, 200, { status: "ok", protocol: "survev" });
        if (request.method === "GET" && pathname === "/bots") return reply(response, 200, { bots: [...bots.values()].map((bot) => bot.summary()) });
        if (request.method === "POST" && pathname === "/bots/spawn") {
            const body = await readJson(request);
            const mode: BotMode = body.mode === "hack" ? "hack" : "normal";
            return reply(response, 201, { bots: await spawn(Number(body.count), body.room ? String(body.room) : undefined, mode, body.sessionId ? String(body.sessionId) : undefined) });
        }
        if (request.method === "POST" && pathname === "/bots/kill") {
            const body = await readJson(request);
            const id = body.id ? String(body.id) : undefined;
            const selected = id ? [bots.get(id)].filter((bot): bot is SurvevProtocolBot => Boolean(bot)) : [...bots.values()];
            selected.forEach((bot) => { bot.stop(); bots.delete(bot.id); });
            return reply(response, 200, { killed: selected.length });
        }
        return reply(response, 404, { error: "not_found" });
    } catch (error) {
        return reply(response, 400, { error: error instanceof Error ? error.message : "bad_request" });
    }
});

server.listen(Number(process.env.PORT ?? 8084), () => {
    console.log(JSON.stringify({ level: "info", event: "bot_runner_listening", detail: { protocol: "survev", port: Number(process.env.PORT ?? 8084) } }));
});
