import fs from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { Config } from "../config.ts";
import { apiPrivateRouter } from "../utils/apiRouter.ts";
import { logErrorToWebhook } from "../utils/logger.ts";
import type { SaveGameBody } from "../utils/types.ts";
import type { Client } from "./client.ts";
import { Game } from "./game.ts";
import { type ProcessMsg, ProcessMsgType } from "./ipcTypes.ts";
import { ClientSocket } from "./socket.ts";
import { makeOpsSnapshot, OpsiaSnapshotStore, opsiaEnabled } from "../opsia/runtime.ts";

let game: ServerGame | undefined;

/**
 * Implements methods only used when the game is actually running on a server
 */
class ServerGame extends Game {
    private opsiaReady = !opsiaEnabled();
    private opsiaStore: OpsiaSnapshotStore | undefined;

    async initializeOpsia(): Promise<void> {
        if (opsiaEnabled()) {
            this.opsiaStore = new OpsiaSnapshotStore();
            await this.opsiaStore.start(this);
        }
        this.opsiaReady = true;
        this.updateData();
    }

    async snapshotOpsia(): Promise<void> {
        await this.opsiaStore?.save(this);
    }

    async stopOpsia(): Promise<void> {
        await this.opsiaStore?.stop();
    }

    async resetOpsia(): Promise<void> {
        await this.opsiaStore?.clearSnapshot();
        await this.stopOpsia();
    }

    override updateData() {
        // Do not admit join tokens until a replacement process has acquired the
        // Redis lease and loaded its real Game projection.
        if (!this.opsiaReady) return;
        sendMsg({
            type: ProcessMsgType.UpdateData,
            id: this.id,
            teamMode: this.teamMode,
            mapName: this.mapName,
            canJoin: this.canJoin,
            aliveCount: this.aliveCount,
            startedTime: this.startedTime,
            stopped: this.stopped,
            timeRunning: this.timeRunning,
        });
        if (this.stopped) {
            game = undefined;
        }
    }

    override async sendQuestProgress(userId: string, progress: Array<{ id: string; delta: number }>) {
        try {
            const req = await apiPrivateRouter.quest_progress.$post({
                json: {
                    userId,
                    progress,
                },
            });
            const res = await req.json();
            if (!req.ok || !(res as { success: boolean }).success) {
                this.logger.error(`Failed to save quest progress`, res);
            }
        } catch (err) {
            this.logger.error(`Failed to save quest progress:`, err);
        }
    }

    override async _saveGameToDatabase() {
        // don't save games that never started
        if (!this.started) return;

        const players = this.modeManager.getPlayersSortedByRank();
        /**
         * teamTotal is for total teams that started the match, i hope?
         *
         * it also seems to be unused by the client so we could also remove it?
         */
        const teamTotal = new Set(players.map(({ player }) => player.teamId)).size;

        const teamKills = players.reduce(
            (acc, curr) => {
                acc[curr.player.teamId] = (acc[curr.player.teamId] ?? 0) + curr.player.kills;
                return acc;
            },
            {} as Record<string, number>,
        );

        const values: SaveGameBody["matchData"] = players.map(({ player, rank }) => {
            return {
                // *NOTE: userId is optional; we save the game stats for non logged users too
                userId: player.userId,
                region: Config.gameServer.thisRegion,
                username: player.name,
                playerId: player.matchDataId,
                teamMode: this.teamMode,
                teamCount: player.group?.players.length ?? 1,
                teamTotal: teamTotal,
                teamId: player.teamId,
                timeAlive: Math.round(player.timeAlive),
                died: player.dead,
                kills: player.kills,
                team_kills: teamKills[player.groupId] ?? 0,
                damageDealt: Math.round(player.damageDealt),
                damageTaken: Math.round(player.damageTaken),
                killerId: player.killedBy?.matchDataId || 0,
                gameId: this.id,
                mapId: this.map.mapId,
                mapSeed: this.map.seed,
                killedIds: player.killedIds,
                rank: rank,
                ip: player.client.ip,
                findGameIp: player.client.findGameIp,
                role: player.role,
            };
        });

        // only save the game if it has more than 2 players lol
        if (values.length < 2) return;

        // FIXME: maybe move this to the parent game server process?
        // to avoid blocking the game from being GC'd until this request is done
        // and opening a database in each process if it fails
        // etc
        let res: Response | undefined = undefined;
        try {
            res = await apiPrivateRouter.save_game.$post({
                json: {
                    matchData: values,
                },
            });
        } catch (err) {
            this.logger.error(`Failed to fetch API save game:`, err);
        }

        if (!res || !res.ok) {
            const region = Config.gameServer.thisRegion.toUpperCase();
            this.logger.error(
                `[${region}] Failed to save game data, saving locally instead`,
            );

            const dir = path.resolve("lost_game_data");
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir);
            }
            fs.writeFileSync(
                path.join(dir, `${this.id}.json`),
                JSON.stringify(values),
                "utf8",
            );
        }
    }
}

function sendMsg(msg: ProcessMsg) {
    process.send!(msg);
}

let stopping = false;
const gracefulExit = async () => {
    if (stopping) return;
    stopping = true;
    try {
        await game?.snapshotOpsia();
        await game?.stopOpsia();
    } finally {
        process.exit();
    }
};
process.on("disconnect", () => { void gracefulExit(); });
process.on("SIGTERM", () => { void gracefulExit(); });
process.on("SIGINT", () => { void gracefulExit(); });

const socketMsgs: Array<{
    socketId: string;
    data: Uint8Array;
    ip: string;
}> = [];

let lastMsgTime = Date.now();

const socketIdToSocket = new Map<string, ProcessSocket<Client | undefined>>();
class ProcessSocket<T> extends ClientSocket<T> {
    private _id: string;
    private _ip: string;
    _closed = false;
    constructor(id: string, ip: string) {
        super();
        this._id = id;
        this._ip = ip;
    }

    ip(): string {
        return this._ip;
    }

    closed(): boolean {
        return this._closed;
    }

    send(data: Uint8Array<ArrayBuffer>): void {
        if (this.closed()) return;

        socketMsgs.push({
            socketId: this._id,
            data,
            ip: "",
        });
    }
    close(): void {
        this._closed = true;
        sendMsg({
            type: ProcessMsgType.SocketClose,
            socketId: this._id,
            reason: undefined,
        });
    }

    closeWithReason(reason: string): void {
        this._closed = true;
        sendMsg({
            type: ProcessMsgType.SocketClose,
            socketId: this._id,
            reason: reason,
        });
    }
}

process.on("message", (msg: ProcessMsg) => {
    if (msg.type) {
        lastMsgTime = Date.now();
    }

    if (msg.type === ProcessMsgType.Create && !game) {
        game = new ServerGame(msg.id, msg.config);
        void game.initializeOpsia().catch((error) => {
            console.error("Opsia game initialization failed", error);
            process.exit(1);
        });
    }

    if (!game) return;

    switch (msg.type) {
        case ProcessMsgType.AddJoinToken:
            game.addJoinTokens(msg.tokens, msg.autoFill);
            break;
        case ProcessMsgType.SocketOpen: {
            const socket = new ProcessSocket<Client | undefined>(msg.socketId, msg.ip);
            socketIdToSocket.set(msg.socketId, socket);
            break;
        }
        case ProcessMsgType.ClientSocketMsg: {
            let socket = socketIdToSocket.get(msg.socketId)!;
            game.clientBarn.handleMsg(msg.data as ArrayBuffer, socket);
            break;
        }
        case ProcessMsgType.SocketClose: {
            const socket = socketIdToSocket.get(msg.socketId);
            // Logical room reset closes and clears every ProcessSocket before
            // the queued close messages reach this handler.
            if (!socket) break;
            socket._closed = true;
            game.clientBarn.handleSocketClose(socket);
            socketIdToSocket.delete(msg.socketId);
            break;
        }
        case ProcessMsgType.OpsiaReset: {
            const previous = game;
            for (const socket of socketIdToSocket.values()) socket.close();
            socketIdToSocket.clear();
            void previous.resetOpsia().finally(() => {
                game = new ServerGame(previous.id, previous.config);
                void game.initializeOpsia().catch((error) => {
                    console.error("Opsia room reset failed", error);
                    process.exit(1);
                });
            });
            break;
        }
    }
});

setInterval(() => {
    if (Date.now() - lastMsgTime > 10000) {
        console.log("Game process has not received a message in 10 seconds, exiting");
        process.exit();
    }

    if (game) {
        game?.updateData();
    } else {
        sendMsg({
            type: ProcessMsgType.KeepAlive,
        });
    }
}, 5000);

let setGameInterval: (cb: () => void, time: number) => void = setInterval;
if (platform() === "win32") {
    const NanoTimer = (await import("nanotimer")).default;
    // setInterval on windows sucks
    // and doesn't give accurate timings
    setGameInterval = (cb: () => void, time: number) => {
        new NanoTimer().setInterval(cb, [], `${time}m`);
    };
}

let lastOpsiaSnapshotAt = 0;
let lastOpsiaSaveAt = 0;
setGameInterval(() => {
    const startedAt = performance.now();
    game?.update();
    if (game && opsiaEnabled()) {
        const now = Date.now();
        const tickMs = performance.now() - startedAt;
        if (now - lastOpsiaSnapshotAt >= 500) {
            lastOpsiaSnapshotAt = now;
            sendMsg({ type: ProcessMsgType.OpsiaSnapshot, snapshot: makeOpsSnapshot(game, tickMs) });
        }
        if (now - lastOpsiaSaveAt >= 1000) {
            lastOpsiaSaveAt = now;
            void game.snapshotOpsia().catch((error) => console.error("Opsia snapshot save failed", error));
        }
    }
}, 1000 / Config.gameTps);

setGameInterval(() => {
    game?.netSync();
    sendMsg({
        type: ProcessMsgType.ServerSocketMsg,
        msgs: socketMsgs,
    });
    socketMsgs.length = 0;
}, 1000 / Config.netSyncTps);

process.on("uncaughtException", async (err) => {
    console.error(err);
    game = undefined;

    await logErrorToWebhook("server", "Game process error", err);

    process.exit(1);
});
