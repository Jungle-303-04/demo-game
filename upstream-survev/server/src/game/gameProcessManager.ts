import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "uWebSockets.js";
import { type MapDefKey, MapDefs } from "../../../shared/defs/mapDefs.ts";
import type { TeamMode } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import { util } from "../../../shared/utils/util.ts";
import { ServerLogger } from "../utils/logger.ts";
import { type FindGamePrivateBody, type ServerGameConfig } from "../utils/types.ts";
import { type GameData, type OpsiaSnapshotData, type ProcessMsg, ProcessMsgType } from "./ipcTypes.ts";

let procFile: string;
if (process.env.NODE_ENV === "production") {
    procFile = "dist/gameProcess.js";
} else {
    procFile = "src/game/gameProcess.ts";
}

export enum ProcState {
    Idle,
    CreatingGame,
    Running,
}

class GameProcess {
    process: ChildProcess;
    config: ServerGameConfig;

    gameData: GameData = {
        id: "",
        teamMode: 0 as TeamMode,
        mapName: "",
        canJoin: false,
        aliveCount: 0,
        startedTime: 0,
        stopped: false,
        timeRunning: 0,
    };

    state = ProcState.Idle;

    createdTime = Date.now();

    stoppedTime = Date.now();
    lastMsgTime = Date.now();

    manager: GameProcessManager;

    onCreatedCbs: Array<(_proc: typeof this) => void> = [];

    avaliableSlots = 0;

    reusedCount = 0;

    opsiaSnapshot: OpsiaSnapshotData | undefined;
    private readonly opsiaReservations = new Map<string, { expiresAt: number; sessionId?: string; ip: string }>();
    private readonly pendingOpsiaResets = new Map<string, {
        resolve: (resetAt: number) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }>();
    private readonly pendingOpsiaSaves = new Map<string, {
        resolve: (savedAt: number) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }>();
    private opsiaResetInFlight = false;

    constructor(manager: GameProcessManager, id: string, config: ServerGameConfig) {
        this.manager = manager;
        this.config = config;
        this.process = fork(procFile, [], {
            serialization: "advanced",
        });

        this.process.on("message", (msg: ProcessMsg) => {
            this._onProcessMsg(msg);
        });

        this.create(id, config);
    }

    private _onProcessMsg(msg: ProcessMsg) {
        if (msg.type) {
            this.lastMsgTime = Date.now();
        }

        switch (msg.type) {
            case ProcessMsgType.UpdateData:
                if (
                    this.state === ProcState.CreatingGame
                    && (msg.canJoin || (process.env.OPSIA_ROOM === "true" && !msg.stopped))
                ) {
                    this.state = ProcState.Running;
                    for (const cb of this.onCreatedCbs) {
                        cb(this);
                    }
                    this.onCreatedCbs.length = 0;
                    if (this.reusedCount === 1) {
                        this.manager.logger.info(
                            `Process ${this.process.pid} created in ${Date.now() - this.createdTime}ms`,
                        );
                    }
                }

                if (this.gameData.id !== msg.id) {
                    this.manager.processById.delete(this.gameData.id);
                    this.gameData.id = msg.id;
                    this.manager.processById.set(this.gameData.id, this);
                }
                this.gameData = msg;
                if (this.gameData.stopped) {
                    this.stoppedTime = Date.now();
                    this.state = ProcState.Idle;
                }
                break;
            case ProcessMsgType.ServerSocketMsg:
                for (let i = 0; i < msg.msgs.length; i++) {
                    const socketMsg = msg.msgs[i];
                    const socket = this.manager.sockets.get(socketMsg.socketId);

                    if (!socket) continue;
                    if (socket.getUserData().closed) continue;
                    socket.send(socketMsg.data, true, false);
                }
                break;
            case ProcessMsgType.SocketClose:
                const socket = this.manager.sockets.get(msg.socketId);
                if (socket && !socket.getUserData().closed) {
                    if (msg.reason) {
                        const disconnectMsg = new net.DisconnectMsg();
                        disconnectMsg.reason = msg.reason;
                        const stream = new net.MsgStream(new ArrayBuffer(128));
                        stream.serializeMsg(net.MsgType.Disconnect, disconnectMsg);
                        socket.send(stream.getBuffer(), true, false);
                    }
                    socket.end();
                }
                break;
            case ProcessMsgType.OpsiaSnapshot:
                this.opsiaSnapshot = msg.snapshot;
                if (process.env.OPSIA_ROOM === "true") this.refreshOpsiaCapacity();
                this.manager.emitOpsiaSnapshot(msg.snapshot);
                break;
            case ProcessMsgType.OpsiaResetResult: {
                const pending = this.pendingOpsiaResets.get(msg.requestId);
                if (!pending) break;
                clearTimeout(pending.timeout);
                this.pendingOpsiaResets.delete(msg.requestId);
                this.opsiaResetInFlight = false;
                if (msg.ok && msg.resetAt) pending.resolve(msg.resetAt);
                else pending.reject(new Error(msg.error ?? "opsia_reset_failed"));
                break;
            }
            case ProcessMsgType.OpsiaSaveResult: {
                const pending = this.pendingOpsiaSaves.get(msg.requestId);
                if (!pending) break;
                clearTimeout(pending.timeout);
                this.pendingOpsiaSaves.delete(msg.requestId);
                if (msg.ok && msg.savedAt) pending.resolve(msg.savedAt);
                else pending.reject(new Error(msg.error ?? "opsia_snapshot_failed"));
                break;
            }
        }
    }

    send(msg: ProcessMsg) {
        if (this.process.killed || !this.process.channel) return;
        this.process.send(msg);
    }

    create(id: string, config: ServerGameConfig) {
        this.config = config;
        this.send({
            type: ProcessMsgType.Create,
            id,
            config,
        });
        this.gameData.id = id;
        this.gameData.teamMode = config.teamMode;
        this.gameData.mapName = config.mapName;
        this.gameData.stopped = false;
        this.state = ProcState.CreatingGame;

        const mapDef = MapDefs[this.gameData.mapName as MapDefKey];
        this.avaliableSlots = mapDef.gameMode.maxPlayers;

        this.reusedCount++;
    }

    addJoinTokens(tokens: FindGamePrivateBody["playerData"], autoFill: boolean) {
        if (process.env.OPSIA_ROOM === "true") {
            if (!this.canAcceptOpsia(tokens)) throw new Error("full");
            const expiresAt = Date.now() + 15_000;
            for (const token of tokens) {
                this.opsiaReservations.set(token.token, {
                    expiresAt,
                    sessionId: token.opsiaSessionId,
                    ip: token.ip,
                });
            }
            this.refreshOpsiaCapacity();
        }
        this.send({
            type: ProcessMsgType.AddJoinToken,
            autoFill,
            tokens,
        });
        if (process.env.OPSIA_ROOM !== "true") this.avaliableSlots--;
    }

    canAcceptOpsia(tokens: FindGamePrivateBody["playerData"]): boolean {
        this.refreshOpsiaCapacity();
        const requestedSessions = tokens
            .map((token) => token.opsiaSessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId));
        if (new Set(requestedSessions).size !== requestedSessions.length) return false;
        const connectedSessions = new Set(
            (this.opsiaSnapshot?.players ?? [])
                .filter((player) => player.connected)
                .map((player) => player.sessionId),
        );
        const reservedSessions = new Set(
            [...this.opsiaReservations.values()]
                .map((reservation) => reservation.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        if (
            requestedSessions.some((sessionId) => connectedSessions.has(sessionId) || reservedSessions.has(sessionId))
        ) return false;
        // A public find-game response reserves a slot before the WebSocket is
        // established. Bound outstanding reservations per source IP so a
        // request-only client cannot consume the room's entire capacity.
        const maxOutstandingPerIp = 20;
        const requestedByIp = new Map<string, number>();
        for (const token of tokens) requestedByIp.set(token.ip, (requestedByIp.get(token.ip) ?? 0) + 1);
        const reservedByIp = new Map<string, number>();
        for (const reservation of this.opsiaReservations.values()) {
            reservedByIp.set(reservation.ip, (reservedByIp.get(reservation.ip) ?? 0) + 1);
        }
        if (
            [...requestedByIp].some(([ip, requested]) => (reservedByIp.get(ip) ?? 0) + requested > maxOutstandingPerIp)
        ) return false;
        return tokens.length > 0 && this.avaliableSlots >= tokens.length;
    }

    private refreshOpsiaCapacity(): void {
        const now = Date.now();
        const connected = (this.opsiaSnapshot?.players ?? []).filter((player) => player.connected);
        const connectedPlayers = connected.length;
        const connectedSessions = new Set(connected.map((player) => player.sessionId));
        for (const [token, reservation] of this.opsiaReservations) {
            if (
                reservation.expiresAt <= now || (reservation.sessionId && connectedSessions.has(reservation.sessionId))
            ) {
                this.opsiaReservations.delete(token);
            }
        }
        const mapDef = MapDefs[this.gameData.mapName as MapDefKey];
        const maxPlayers = mapDef?.gameMode.maxPlayers ?? 0;
        this.avaliableSlots = Math.max(0, maxPlayers - connectedPlayers - this.opsiaReservations.size);
    }

    handleSocketOpen(socketId: string, ip: string) {
        this.send({
            type: ProcessMsgType.SocketOpen,
            socketId,
            ip,
        });
    }

    handleMsg(data: ArrayBuffer, socketId: string) {
        this.send({
            type: ProcessMsgType.ClientSocketMsg,
            socketId,
            data,
        });
    }

    handleSocketClose(socketId: string) {
        this.send({
            type: ProcessMsgType.SocketClose,
            socketId,
        });
    }

    reset(): Promise<number> {
        if (this.process.killed || !this.process.channel) return Promise.reject(new Error("room_process_unavailable"));
        if (this.opsiaResetInFlight) return Promise.reject(new Error("opsia_reset_in_progress"));
        this.opsiaResetInFlight = true;
        // Stop admission immediately; the replacement Game's first UpdateData
        // transitions this process back to Running after lease acquisition.
        this.state = ProcState.CreatingGame;
        this.opsiaSnapshot = undefined;
        this.opsiaReservations.clear();
        this.avaliableSlots = 0;
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingOpsiaResets.delete(requestId);
                this.opsiaResetInFlight = false;
                reject(new Error("opsia_reset_timeout"));
            }, 7_000);
            this.pendingOpsiaResets.set(requestId, { resolve, reject, timeout });
            this.send({ type: ProcessMsgType.OpsiaReset, requestId });
        });
    }

    saveOpsiaSnapshot(): Promise<number> {
        if (this.process.killed || !this.process.channel) return Promise.reject(new Error("room_process_unavailable"));
        if (this.opsiaResetInFlight || this.state !== ProcState.Running) {
            return Promise.reject(new Error("opsia_not_ready"));
        }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingOpsiaSaves.delete(requestId);
                reject(new Error("opsia_snapshot_timeout"));
            }, 5_000);
            this.pendingOpsiaSaves.set(requestId, { resolve, reject, timeout });
            this.send({ type: ProcessMsgType.OpsiaSave, requestId });
        });
    }
}

export interface GameSocketData {
    gameId: string;
    id: string;
    closed: boolean;
    rateLimit: Record<symbol, number>;
    ip: string;
    disconnectReason: string;
}

export class GameProcessManager {
    readonly sockets = new Map<string, WebSocket<GameSocketData>>();

    readonly processById = new Map<string, GameProcess>();
    readonly processes: GameProcess[] = [];

    readonly logger = new ServerLogger("Game Process Manager");

    private readonly opsiaSnapshotListeners = new Set<(snapshot: OpsiaSnapshotData) => void>();

    constructor() {
        process.on("beforeExit", () => {
            for (const gameProc of this.processes) {
                gameProc.process.kill();
            }
        });

        // always keep some processes running even if theres no active games on them
        // creating a new proc is more expensive than reusing one
        const minIdleProcs = 3;

        setInterval(() => {
            for (const proc of this.processes) {
                proc.send({
                    type: ProcessMsgType.KeepAlive,
                });

                // kill processes that didn't send a keep alive msg in 10 seconds
                // because this usually means they are frozen in an infinite loop
                const watchdogMs = process.env.OPSIA_ROOM === "true" ? 30000 : 10000;
                if (Date.now() - proc.lastMsgTime > watchdogMs) {
                    const id = proc.gameData.id.substring(0, 4);
                    this.logger.warn(
                        `Process ${proc.process.pid} - #${id} did not send a message in more 10 seconds, killing`,
                    );
                    // sigquit can dump a core of the process
                    // useful for debugging infinite loops
                    this.killProcess(proc, "SIGQUIT");
                    continue;
                }
            }

            const idleProcs = this.processes.filter(p => {
                return p.gameData.stopped && (Date.now() - p.stoppedTime) > 60000;
            });

            // kill stale processes if there's too many
            if (idleProcs.length > minIdleProcs) {
                idleProcs.sort((a, b) => a.createdTime - b.createdTime);

                const procsToKill = Math.abs(minIdleProcs - idleProcs.length);
                for (let i = 0; i < procsToKill; i++) {
                    const proc = idleProcs[i];
                    this.logger.info(`Killing ${proc.process.pid} because we have too many stale processes`);
                    this.killProcess(proc);
                }
            }
        }, 5000);
    }

    onOpsiaSnapshot(listener: (snapshot: OpsiaSnapshotData) => void): () => void {
        this.opsiaSnapshotListeners.add(listener);
        return () => this.opsiaSnapshotListeners.delete(listener);
    }

    emitOpsiaSnapshot(snapshot: OpsiaSnapshotData): void {
        for (const listener of this.opsiaSnapshotListeners) listener(snapshot);
    }

    getPlayerCount(): number {
        return this.processes.reduce((a, b) => {
            return a + b.gameData.aliveCount;
        }, 0);
    }

    newGame(config: ServerGameConfig): GameProcess {
        let gameProc: GameProcess | undefined;

        if (process.env.OPSIA_ROOM === "true") {
            const existing = this.processes.find((proc) => !proc.gameData.stopped);
            if (existing) return existing;
        }
        for (let i = 0; i < this.processes.length; i++) {
            const p = this.processes[i];
            if (p.gameData.stopped) {
                gameProc = p;
                break;
            }
        }

        const id = randomUUID();
        if (!gameProc) {
            gameProc = new GameProcess(this, id, config);

            this.processes.push(gameProc);

            gameProc.process.once("exit", () => {
                const shouldRecover = process.env.OPSIA_ROOM === "true" && !gameProc!.gameData.stopped;
                const config = gameProc!.config;
                this.killProcess(gameProc!);
                if (shouldRecover) {
                    setTimeout(() => {
                        if (!this.processes.some((candidate) => !candidate.gameData.stopped)) this.newGame(config);
                    }, 1000);
                }
            });
            this.logger.info("Created new process with PID", gameProc.process.pid);
        } else {
            this.processById.delete(gameProc.gameData.id);
            gameProc.create(id, config);
        }

        this.processById.set(id, gameProc);

        return gameProc;
    }

    killProcess(gameProc: GameProcess, signal: NodeJS.Signals = "SIGTERM"): void {
        if (!this.processes.includes(gameProc)) return;
        for (const [, socket] of this.sockets) {
            const data = socket.getUserData();
            if (data.closed) continue;
            if (data.gameId !== gameProc.gameData.id) continue;
            socket.end();
        }

        // send SIGTERM, if still hasn't terminated after 5 seconds, send SIGKILL >:3
        if (!gameProc.process.killed) gameProc.process.kill(signal);
        setTimeout(() => {
            if (!gameProc.process.killed) {
                gameProc.process.kill("SIGKILL");
            }
        }, 5000);

        util.removeFrom(this.processes, gameProc);
        this.processById.delete(gameProc.gameData.id);
    }

    getById(id: string): GameProcess | undefined {
        return this.processById.get(id);
    }

    async findGame(body: FindGamePrivateBody): Promise<GameProcess> {
        let proc = process.env.OPSIA_ROOM === "true"
            ? this.processes.find((candidate) =>
                !candidate.gameData.stopped && candidate.canAcceptOpsia(body.playerData)
            )
            : this.processes
                .filter((proc) => {
                    const game = proc.gameData;
                    return (
                        (game.canJoin || proc.state === ProcState.CreatingGame)
                        && proc.avaliableSlots > 0
                        && game.teamMode === body.teamMode
                        && game.mapName === body.mapName
                    );
                })
                .sort((a, b) => {
                    return a.gameData.startedTime - b.gameData.startedTime;
                })[0];

        if (!proc) {
            if (process.env.OPSIA_ROOM === "true") throw new Error("full");
            proc = this.newGame({
                teamMode: body.teamMode,
                mapName: body.mapName as MapDefKey,
            });
        }

        // if the game has not finished creating
        // wait for it to be created to send the find game response
        if (proc.state !== ProcState.Running) {
            return await new Promise((resolve, reject) => {
                const onCreated = (created: GameProcess) => {
                    clearTimeout(timeout);
                    try {
                        created.addJoinTokens(body.playerData, body.autoFill);
                        resolve(created);
                    } catch (error) {
                        // A concurrent admission filled the room while its
                        // child process was becoming ready.
                        reject(error);
                    }
                };
                const timeout = setTimeout(() => {
                    const index = proc.onCreatedCbs.indexOf(onCreated);
                    if (index >= 0) proc.onCreatedCbs.splice(index, 1);
                    reject(new Error("game_process_ready_timeout"));
                }, 5_000);
                proc.onCreatedCbs.push(onCreated);
            });
        }

        proc.addJoinTokens(body.playerData, body.autoFill);

        return proc;
    }

    onOpen(socketId: string, socket: WebSocket<GameSocketData>): void {
        const data = socket.getUserData();
        const proc = this.processById.get(data.gameId);
        if (proc === undefined) {
            this.logger.warn("process not found, closing socket.");
            socket.close();
            return;
        }
        this.sockets.set(socketId, socket);
        this.processById.get(data.gameId)?.handleSocketOpen(socketId, data.ip);
    }

    onMsg(socketId: string, msg: ArrayBuffer): void {
        const data = this.sockets.get(socketId)?.getUserData();
        if (!data) return;
        this.processById.get(data.gameId)?.handleMsg(msg, socketId);
    }

    onClose(socketId: string) {
        const data = this.sockets.get(socketId)?.getUserData();
        this.sockets.delete(socketId);
        if (!data) return;
        this.processById.get(data.gameId)?.handleSocketClose(socketId);
    }

    getOpsiaSnapshot(): OpsiaSnapshotData | undefined {
        return this.processes.find((proc) => !proc.gameData.stopped)?.opsiaSnapshot;
    }

    isOpsiaReady(): boolean {
        return this.processes.some((proc) => proc.state === ProcState.Running && !proc.gameData.stopped);
    }

    resetOpsiaRoom(): Promise<number> {
        const proc = this.processes.find((candidate) => !candidate.gameData.stopped);
        if (!proc) return Promise.reject(new Error("room_not_ready"));
        return proc.reset();
    }

    saveOpsiaRoom(): Promise<number> {
        const proc = this.processes.find((candidate) => !candidate.gameData.stopped);
        if (!proc) return Promise.reject(new Error("room_not_ready"));
        return proc.saveOpsiaSnapshot();
    }
}
