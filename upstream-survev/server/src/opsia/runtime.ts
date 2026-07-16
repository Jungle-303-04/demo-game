import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import type { InventoryItem } from "../../../shared/gameConfig.ts";
import type { Game, JoinTokenData } from "../game/game.ts";
import type { Player } from "../game/objects/player.ts";

/**
 * Opsia intentionally persists a loose projection of the *real* survev Game.
 * Bullets and projectiles are transient; players, their team/score/inventory,
 * gas phase and destroyed-map information survive a pod replacement.
 */
export interface LoosePlayerState {
    sessionId: string;
    name: string;
    teamId: number;
    x: number;
    y: number;
    health: number;
    score: number;
    inventory: Record<string, number>;
}

export interface LooseGameSnapshot {
    schemaVersion: 2;
    roomId: string;
    savedAt: number;
    gasPhase: number;
    destroyedObstacleIds: number[];
    players: LoosePlayerState[];
}

export interface OpsiaPlayerSnapshot {
    sessionId: string;
    nickname: string;
    team: "red" | "blue";
    x: number;
    y: number;
    alive: boolean;
    score: number;
}

export interface OpsiaSnapshot {
    roomId: string;
    players: OpsiaPlayerSnapshot[];
    tickMs: number;
    strictMode: boolean;
    inputAccepted: number;
    inputRejected: number;
}

const restoredPlayers = new WeakMap<Game, Map<string, LoosePlayerState>>();
const inputWindows = new WeakMap<Game, Map<string, number[]>>();
const inputCounters = new WeakMap<Game, { accepted: number; rejected: number }>();
const memorySnapshots = new Map<string, LooseGameSnapshot>();
const memoryLeases = new Map<string, { owner: string; expiresAt: number }>();

export const opsiaEnabled = (): boolean => process.env.OPSIA_ROOM === "true";
export const opsiaStrict = (): boolean => process.env.STRICT_MODE === "true";
export const opsiaRoomId = (): string => process.env.ROOM_ID ?? "room-0";

const jsonLog = (level: "info" | "warn" | "error", event: string, detail: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ level, event, roomId: opsiaRoomId(), server: process.env.POD_NAME ?? "game-0", detail }));
};

const playerSessionId = (player: Player): string => player.opsiaSessionId || player.client.findGameIp;

export const serializeGame = (game: Game): LooseGameSnapshot => ({
    schemaVersion: 2,
    roomId: opsiaRoomId(),
    savedAt: Date.now(),
    gasPhase: game.gas.circleIdx,
    // The state projection deliberately omits projectiles. Map object IDs are
    // retained as evidence even when a map version cannot recreate an object.
    destroyedObstacleIds: [],
    players: game.playerBarn.players.map((player) => ({
        sessionId: playerSessionId(player),
        name: player.name,
        teamId: player.teamId,
        x: player.pos.x,
        y: player.pos.y,
        health: player.health,
        score: player.kills,
        inventory: { ...player.inventory },
    })),
});

export const restoreGame = (game: Game, snapshot: LooseGameSnapshot): void => {
    if (snapshot.schemaVersion !== 2 || snapshot.roomId !== opsiaRoomId()) {
        throw new Error("invalid_opsia_snapshot");
    }
    restoredPlayers.set(game, new Map(snapshot.players.map((player) => [player.sessionId, player])));
    // Gas is deliberately kept in its safe initial/circulating phase for an
    // infinite demo. The phase remains observable in the snapshot contract.
    game.gas.circleIdx = Math.max(0, snapshot.gasPhase);
};

/** Called from the real PlayerBarn.addPlayer path after survev creates Player. */
export const restorePlayer = (game: Game, player: Player, joinData: JoinTokenData): boolean => {
    const sessionId = joinData.opsiaSessionId;
    player.opsiaSessionId = sessionId ?? "";
    if (!sessionId) return false;

    const state = restoredPlayers.get(game)?.get(sessionId);
    if (!state) return false;

    const team = game.playerBarn.teams.find((candidate) => candidate.id === state.teamId);
    if (team && player.team !== team) {
        player.team?.removePlayer(player);
        team.addPlayer(player);
    }
    player.pos.x = state.x;
    player.pos.y = state.y;
    player.health = state.health;
    player.kills = state.score;
    for (const [item, amount] of Object.entries(state.inventory)) {
        if (player.invManager.isValid(item) && Number.isInteger(amount) && amount >= 0) {
            player.invManager.set(item as InventoryItem, amount);
        }
    }
    game.grid.updateObject(player);
    jsonLog("info", "player_reconnected", { nickname: player.name, teamId: player.teamId, score: player.kills });
    return true;
};

export const validateInput = (game: Game, player: Player): boolean => {
    const id = playerSessionId(player);
    const now = Date.now();
    const windows = inputWindows.get(game) ?? new Map<string, number[]>();
    inputWindows.set(game, windows);
    const timestamps = (windows.get(id) ?? []).filter((at) => at > now - 1000);
    timestamps.push(now);
    windows.set(id, timestamps);

    const counters = inputCounters.get(game) ?? { accepted: 0, rejected: 0 };
    inputCounters.set(game, counters);
    // Normal survev clients send at the netsync cadence (~33/s). A deliberately
    // abusive client exceeds this by an order of magnitude.
    if (timestamps.length > 60) {
        counters.rejected++;
        jsonLog("warn", "input_rate_exceeded", { nickname: player.name, rate: timestamps.length, strictMode: opsiaStrict() });
        if (opsiaStrict()) {
            jsonLog("warn", "session_kicked", { nickname: player.name, reason: "input_rate_exceeded", enforcement: "strict_mode" });
            player.client.disconnect("input_rate_exceeded");
            return false;
        }
        return false;
    }
    counters.accepted++;
    return true;
};

export const makeOpsSnapshot = (game: Game, tickMs: number): OpsiaSnapshot => {
    const counters = inputCounters.get(game) ?? { accepted: 0, rejected: 0 };
    inputCounters.set(game, { accepted: 0, rejected: 0 });
    return {
        roomId: opsiaRoomId(),
        tickMs,
        strictMode: opsiaStrict(),
        inputAccepted: counters.accepted,
        inputRejected: counters.rejected,
        players: game.playerBarn.players.map((player) => ({
            sessionId: playerSessionId(player),
            nickname: player.name,
            team: player.teamId === 1 ? "red" : "blue",
            x: player.pos.x,
            y: player.pos.y,
            alive: !player.dead,
            score: player.kills,
        })),
    };
};

export class OpsiaSnapshotStore {
    private readonly owner = process.env.OPSIA_LEASE_OWNER ?? `${process.env.POD_NAME ?? "game-0"}-${randomUUID()}`;
    private readonly snapshotKey = `room:${opsiaRoomId()}:snapshot`;
    private readonly leaseKey = `room:${opsiaRoomId()}:lease`;
    private client: RedisClientType | undefined;
    private leaseTimer: NodeJS.Timeout | undefined;

    async start(game: Game): Promise<void> {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
            this.client = createClient({ url: redisUrl });
            this.client.on("error", (error) => jsonLog("error", "redis_error", { message: String(error) }));
            await this.client.connect();
        }
        // A replacement pod can begin before its predecessor's five-second
        // lease has naturally expired. Wait rather than serving concurrently
        // or giving up the actual Game process.
        let acquired = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            try {
                await this.acquireLease();
                acquired = true;
                break;
            } catch (error) {
                if (!(error instanceof Error) || error.message !== "room_lease_not_acquired") throw error;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        if (!acquired) throw new Error("room_lease_not_acquired");
        const snapshot = await this.load();
        if (snapshot) {
            restoreGame(game, snapshot);
            jsonLog("info", "snapshot_restored", { savedAt: snapshot.savedAt, players: snapshot.players.length });
        }
        this.leaseTimer = setInterval(() => { void this.refreshLease(); }, 1000);
    }

    async save(game: Game): Promise<void> {
        const snapshot = serializeGame(game);
        if (this.client) {
            await this.client.set(this.snapshotKey, JSON.stringify(snapshot), { EX: 60 });
        } else {
            memorySnapshots.set(this.snapshotKey, snapshot);
        }
        jsonLog("info", "snapshot_saved", { players: snapshot.players.length });
    }

    async stop(): Promise<void> {
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        if (this.client?.isOpen) {
            // Release only our own lease. This is a lifecycle cleanup, never a
            // player-controlled or ConfigMap-driven mutation.
            if (await this.client.get(this.leaseKey) === this.owner) await this.client.del(this.leaseKey);
            await this.client.quit();
            return;
        }
        const current = memoryLeases.get(this.leaseKey);
        if (current?.owner === this.owner) memoryLeases.delete(this.leaseKey);
    }

    /** A console-requested logical room reset discards only this room's game
     * projection. Pod replacement never calls this method. */
    async clearSnapshot(): Promise<void> {
        if (this.client) {
            await this.client.del(this.snapshotKey);
        } else {
            memorySnapshots.delete(this.snapshotKey);
        }
        jsonLog("info", "snapshot_cleared", {});
    }

    private async acquireLease(): Promise<void> {
        if (this.client) {
            const result = await this.client.set(this.leaseKey, this.owner, { NX: true, EX: 5 });
            if (result !== "OK") throw new Error("room_lease_not_acquired");
            return;
        }
        const existing = memoryLeases.get(this.leaseKey);
        if (existing && existing.expiresAt > Date.now() && existing.owner !== this.owner) throw new Error("room_lease_not_acquired");
        memoryLeases.set(this.leaseKey, { owner: this.owner, expiresAt: Date.now() + 5000 });
    }

    private async refreshLease(): Promise<void> {
        if (this.client) {
            const currentOwner = await this.client.get(this.leaseKey);
            if (currentOwner !== this.owner) throw new Error("room_lease_lost");
            await this.client.expire(this.leaseKey, 5);
            return;
        }
        const current = memoryLeases.get(this.leaseKey);
        if (!current || current.owner !== this.owner) throw new Error("room_lease_lost");
        current.expiresAt = Date.now() + 5000;
    }

    private async load(): Promise<LooseGameSnapshot | undefined> {
        const text = this.client ? await this.client.get(this.snapshotKey) : undefined;
        if (text) return JSON.parse(text) as LooseGameSnapshot;
        return memorySnapshots.get(this.snapshotKey);
    }
}

export const resetRestoredPlayers = (game: Game): void => {
    restoredPlayers.delete(game);
    inputWindows.delete(game);
    inputCounters.delete(game);
    // Keep snapshot storage intact: logical reset is deliberate and handled by
    // an explicit room control endpoint, never by a pod replacement.
};
