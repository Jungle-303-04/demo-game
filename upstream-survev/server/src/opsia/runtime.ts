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
    schemaVersion: 3;
    roomId: string;
    mapName: string;
    savedAt: number;
    gasPhase: number;
    destroyedObstacleIds: number[];
    players: LoosePlayerState[];
}

export interface OpsiaPlayerSnapshot {
    sessionId: string;
    nickname: string;
    teamId: number;
    team: "red" | "blue";
    x: number;
    y: number;
    vx: number;
    vy: number;
    alive: boolean;
    score: number;
    rotation: number;
    health: number;
    armor: number;
    weapon: string;
    ammo: number;
    bandages?: number;
    healthkits?: number;
    isBot: boolean;
    connected: boolean;
}

export type OpsiaMapObjectKind = "building" | "structure" | "tree" | "rock" | "wall" | "obstacle";

export interface OpsiaMapSnapshot {
    name: string;
    factionMode: boolean;
    maxPlayers: number;
    seed: number;
    width: number;
    height: number;
    shoreInset: number;
    grassInset: number;
    rivers: Array<{
        width: number;
        looped: boolean;
        points: Array<{ x: number; y: number }>;
    }>;
    places: Array<{
        name: string;
        x: number;
        y: number;
    }>;
    objects: Array<{
        id: number;
        type: string;
        kind: OpsiaMapObjectKind;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}

export interface OpsiaSnapshot {
    roomId: string;
    capturedAt: number;
    map: OpsiaMapSnapshot;
    zone: { x: number; y: number; radius: number; nextX: number; nextY: number; nextRadius: number };
    players: OpsiaPlayerSnapshot[];
    tickP95Ms: number;
    tickRate: number;
    cpuPercent: number;
    memoryMb: number;
    uptimeSeconds: number;
    strictMode: boolean;
    inputAccepted: number;
    inputRejected: number;
}

const restoredPlayers = new WeakMap<Game, Map<string, LoosePlayerState>>();
const inputWindows = new WeakMap<Game, Map<string, number[]>>();
const inputCounters = new WeakMap<Game, { accepted: number; rejected: number }>();
const mapSnapshots = new WeakMap<Game, OpsiaMapSnapshot>();
const memorySnapshots = new Map<string, LooseGameSnapshot>();
const memoryLeases = new Map<string, { owner: string; expiresAt: number }>();
let previousCpuUsage = process.cpuUsage();
let previousCpuAt = performance.now();
// A dead pod leaves no graceful owner release. Keep the hand-off short enough
// for the reconnect overlay, while refreshing well inside the ownership window.
const leaseTtlSeconds = 10;
const leaseRefreshMs = 2_000;
const refreshLeaseScript =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0";
const saveSnapshotScript =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[2], ARGV[2]); return 1 end return 0";
const releaseLeaseScript =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";
const clearSnapshotScript =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[2]); return 1 end return 0";

export const opsiaEnabled = (): boolean => process.env.OPSIA_ROOM === "true";
export const opsiaStrict = (): boolean => process.env.STRICT_MODE === "true";
export const opsiaRoomId = (): string => process.env.ROOM_ID ?? "room-0";

const jsonLog = (level: "info" | "warn" | "error", event: string, detail: Record<string, unknown> = {}) => {
    console.log(
        JSON.stringify({ level, event, roomId: opsiaRoomId(), server: process.env.POD_NAME ?? "game-0", detail }),
    );
};

const playerSessionId = (player: Player): string => player.opsiaSessionId || player.client.findGameIp;

const mapObjectSize = (bounds: { min: { x: number; y: number }; max: { x: number; y: number } }) => ({
    width: Math.max(1, bounds.max.x - bounds.min.x),
    height: Math.max(1, bounds.max.y - bounds.min.y),
});

const makeOpsMapSnapshot = (game: Game): OpsiaMapSnapshot => {
    const cached = mapSnapshots.get(game);
    if (cached?.seed === game.map.seed) return cached;

    const buildings: OpsiaMapSnapshot["objects"] = game.map.buildings
        .filter((building) => building.layer === 0 && !building.parentBuilding && !building.parentStructure)
        .map((building) => ({
            id: building.__id,
            type: building.type,
            kind: "building",
            x: building.pos.x,
            y: building.pos.y,
            ...mapObjectSize(building.bounds),
        }));
    const structures: OpsiaMapSnapshot["objects"] = game.map.structures
        .filter((structure) => structure.layer === 0)
        .map((structure) => ({
            id: structure.__id,
            type: structure.type,
            kind: "structure",
            x: structure.pos.x,
            y: structure.pos.y,
            ...mapObjectSize(structure.bounds),
        }));
    const snapshot: OpsiaMapSnapshot = {
        name: game.mapName,
        factionMode: game.map.factionMode,
        maxPlayers: game.map.mapDef.gameMode.maxPlayers,
        seed: game.map.seed,
        width: game.map.width,
        height: game.map.height,
        shoreInset: game.map.shoreInset,
        grassInset: game.map.grassInset,
        rivers: game.map.riverDescs.map((river) => ({
            width: river.width,
            looped: river.looped,
            points: river.points.map((point) => ({ x: point.x, y: point.y })),
        })),
        places: game.map.msg.places.map((place) => ({
            name: place.name,
            x: place.pos.x,
            y: place.pos.y,
        })),
        // The admin tactical LOD keeps real navigational geometry while
        // omitting thousands of tiny decorative props from every 1s poll.
        objects: [...structures, ...buildings],
    };
    mapSnapshots.set(game, snapshot);
    return snapshot;
};

export const serializeGame = (game: Game): LooseGameSnapshot => ({
    schemaVersion: 3,
    roomId: opsiaRoomId(),
    mapName: game.mapName,
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
    if (
        snapshot.schemaVersion !== 3
        || snapshot.roomId !== opsiaRoomId()
        || snapshot.mapName !== game.mapName
    ) {
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
    player.name = state.name;
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
    // A reconnect projection is a one-shot hand-off. Keeping it would let a
    // later connection with the same session roll a live player back to stale
    // coordinates, health and inventory.
    const pending = restoredPlayers.get(game);
    pending?.delete(sessionId);
    if (pending?.size === 0) restoredPlayers.delete(game);
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
        jsonLog("warn", "input_rate_exceeded", {
            nickname: player.name,
            rate: timestamps.length,
            strictMode: opsiaStrict(),
        });
        if (opsiaStrict()) {
            jsonLog("warn", "session_kicked", {
                nickname: player.name,
                reason: "input_rate_exceeded",
                enforcement: "strict_mode",
            });
            player.client.disconnect("input_rate_exceeded");
            return false;
        }
        return false;
    }
    counters.accepted++;
    return true;
};

export const makeOpsSnapshot = (game: Game, tickP95Ms: number, tickRate: number): OpsiaSnapshot => {
    const counters = inputCounters.get(game) ?? { accepted: 0, rejected: 0 };
    inputCounters.set(game, { accepted: 0, rejected: 0 });
    const now = performance.now();
    const elapsedMs = Math.max(1, now - previousCpuAt);
    const cpuDelta = process.cpuUsage(previousCpuUsage);
    previousCpuUsage = process.cpuUsage();
    previousCpuAt = now;
    const cpuPercent = Math.max(0, Math.min(100, ((cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs) * 100));
    return {
        roomId: opsiaRoomId(),
        capturedAt: Date.now(),
        map: makeOpsMapSnapshot(game),
        zone: {
            x: game.gas.currentPos.x,
            y: game.gas.currentPos.y,
            radius: game.gas.currentRad,
            nextX: game.gas.posNew.x,
            nextY: game.gas.posNew.y,
            nextRadius: game.gas.radNew,
        },
        tickP95Ms,
        tickRate,
        cpuPercent,
        memoryMb: process.memoryUsage().rss / 1024 / 1024,
        uptimeSeconds: process.uptime(),
        strictMode: opsiaStrict(),
        inputAccepted: counters.accepted,
        inputRejected: counters.rejected,
        players: game.playerBarn.players.map((player) => ({
            sessionId: playerSessionId(player),
            nickname: player.name,
            teamId: player.teamId,
            team: player.teamId === 1 ? "red" : "blue",
            x: player.pos.x,
            y: player.pos.y,
            vx: player.vel.x,
            vy: player.vel.y,
            alive: !player.dead,
            score: player.kills,
            rotation: Math.atan2(player.dir.y, player.dir.x),
            health: player.health,
            armor: Math.round(
                Math.max(player.getGearLevel(player.helmet), player.getGearLevel(player.chest)) / 3 * 100,
            ),
            weapon: player.activeWeapon || "fists",
            ammo: player.weapons[player.curWeapIdx]?.ammo ?? 0,
            bandages: player.invManager.get("bandage"),
            healthkits: player.invManager.get("healthkit"),
            isBot: player.bot,
            connected: !player.disconnected,
        })),
    };
};

export class OpsiaSnapshotStore {
    private readonly owner = process.env.OPSIA_LEASE_OWNER ?? `${process.env.POD_NAME ?? "game-0"}-${randomUUID()}`;
    private readonly snapshotKey = `room:${opsiaRoomId()}:snapshot`;
    private readonly leaseKey = `room:${opsiaRoomId()}:lease`;
    private client: RedisClientType | undefined;
    private leaseTimer: NodeJS.Timeout | undefined;
    private ready = false;
    private pendingPlayers: LoosePlayerState[] = [];
    private pendingRestoreUntil = 0;

    async start(game: Game): Promise<void> {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
            this.client = createClient({ url: redisUrl });
            this.client.on("error", (error) => jsonLog("error", "redis_error", { message: String(error) }));
            await this.client.connect();
        }
        // A replacement pod can begin before its predecessor's lease
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
            const compatible = snapshot.schemaVersion === 3
                && snapshot.roomId === opsiaRoomId()
                && snapshot.mapName === game.mapName;
            if (compatible) {
                restoreGame(game, snapshot);
                // `PlayerBarn` materializes a restored player only once its session
                // reconnects. Preserve these projections while the public gateway
                // keeps retrying, instead of a newly-empty Game overwriting Redis.
                this.pendingPlayers = snapshot.players;
                this.pendingRestoreUntil = Date.now() + 2 * 60_000;
                jsonLog("info", "snapshot_restored", { savedAt: snapshot.savedAt, players: snapshot.players.length });
            } else {
                // A rollout can change the room's map while Redis still holds a
                // legacy or differently-sized projection. Starting fresh avoids
                // restoring invalid teams and out-of-bounds coordinates.
                jsonLog("warn", "snapshot_skipped_incompatible_map", {
                    schemaVersion: snapshot.schemaVersion,
                    savedMapName: snapshot.mapName,
                    currentMapName: game.mapName,
                });
            }
        }
        this.ready = true;
        this.leaseTimer = setInterval(() => {
            void this.refreshLease().catch((error) => {
                // Do not keep serving after a failed ownership refresh. The
                // parent manager will create a replacement Game which restores
                // the last snapshot after it acquires the lease.
                jsonLog("error", "room_lease_refresh_failed", { message: String(error) });
                process.exit(1);
            });
        }, leaseRefreshMs);
    }

    async save(game: Game): Promise<void> {
        // A child Game begins ticking before `start()` has acquired its lease.
        // It must never publish that unowned empty state over the previous owner.
        if (!this.ready) return;
        const snapshot = serializeGame(game);
        const liveSessions = new Set(snapshot.players.map((player) => player.sessionId));
        if (Date.now() < this.pendingRestoreUntil) {
            this.pendingPlayers = this.pendingPlayers.filter((player) => !liveSessions.has(player.sessionId));
            snapshot.players.push(...this.pendingPlayers);
        } else {
            this.pendingPlayers = [];
        }
        if (this.client) {
            // A stopped StatefulSet ordinal can remain offline for longer than a
            // minute. Keep the latest acknowledged projection until an explicit
            // room reset/delete clears it.
            const saved = await this.client.eval(saveSnapshotScript, {
                keys: [this.leaseKey, this.snapshotKey],
                arguments: [this.owner, JSON.stringify(snapshot)],
            });
            if (Number(saved) !== 1) throw new Error("room_lease_lost");
        } else {
            const lease = memoryLeases.get(this.leaseKey);
            if (!lease || lease.owner !== this.owner || lease.expiresAt <= Date.now()) {
                throw new Error("room_lease_lost");
            }
            memorySnapshots.set(this.snapshotKey, snapshot);
        }
        jsonLog("info", "snapshot_saved", { players: snapshot.players.length });
    }

    async stop(): Promise<void> {
        this.ready = false;
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.leaseTimer = undefined;
        if (this.client?.isOpen) {
            // Compare-and-delete in one Redis operation. A GET/DEL pair could
            // erase a replacement owner's lease if this lease expired between
            // the two commands.
            await this.client.eval(releaseLeaseScript, {
                keys: [this.leaseKey],
                arguments: [this.owner],
            });
            await this.client.quit();
            return;
        }
        const current = memoryLeases.get(this.leaseKey);
        if (current?.owner === this.owner) memoryLeases.delete(this.leaseKey);
    }

    /** A console-requested logical room reset discards only this room's game
     * projection. Pod replacement never calls this method. */
    async clearSnapshot(): Promise<void> {
        this.pendingPlayers = [];
        this.pendingRestoreUntil = 0;
        if (this.client?.isOpen) {
            const cleared = await this.client.eval(clearSnapshotScript, {
                keys: [this.leaseKey, this.snapshotKey],
                arguments: [this.owner],
            });
            if (Number(cleared) !== 1) throw new Error("room_lease_lost");
        } else if (this.client) {
            throw new Error("room_lease_lost");
        } else {
            const lease = memoryLeases.get(this.leaseKey);
            if (!lease || lease.owner !== this.owner || lease.expiresAt <= Date.now()) {
                throw new Error("room_lease_lost");
            }
            memorySnapshots.delete(this.snapshotKey);
        }
        jsonLog("info", "snapshot_cleared", {});
    }

    private async acquireLease(): Promise<void> {
        if (this.client) {
            const result = await this.client.set(this.leaseKey, this.owner, { NX: true, EX: leaseTtlSeconds });
            if (result !== "OK") throw new Error("room_lease_not_acquired");
            return;
        }
        const existing = memoryLeases.get(this.leaseKey);
        if (existing && existing.expiresAt > Date.now() && existing.owner !== this.owner) {
            throw new Error("room_lease_not_acquired");
        }
        memoryLeases.set(this.leaseKey, { owner: this.owner, expiresAt: Date.now() + leaseTtlSeconds * 1000 });
    }

    private async refreshLease(): Promise<void> {
        if (this.client) {
            const refreshed = await this.client.eval(refreshLeaseScript, {
                keys: [this.leaseKey],
                arguments: [this.owner, String(leaseTtlSeconds)],
            });
            if (Number(refreshed) !== 1) throw new Error("room_lease_lost");
            return;
        }
        const current = memoryLeases.get(this.leaseKey);
        if (!current || current.owner !== this.owner) throw new Error("room_lease_lost");
        current.expiresAt = Date.now() + leaseTtlSeconds * 1000;
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
