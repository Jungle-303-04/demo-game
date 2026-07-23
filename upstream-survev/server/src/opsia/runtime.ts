import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { GameObjectDefs, MapObjectDefs } from "../../../shared/defs/register.ts";
import { DamageType, type InventoryItem } from "../../../shared/gameConfig.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import type { Game, JoinTokenData } from "../game/game.ts";
import type { Bullet } from "../game/objects/bullet.ts";
import type { Loot } from "../game/objects/loot.ts";
import type { Player } from "../game/objects/player.ts";
import type { Projectile } from "../game/objects/projectile.ts";
import {
    type ActiveReleaseRequest,
    type CandidatePromoteRequest,
    type CandidateSeedRequest,
    CandidateStateLoader,
    createSnapshotEnvelopeDelta,
    type OpsiaConfiguredRole,
    type OpsiaHandoffStatusData,
    type OpsiaRuntimeRole,
} from "./candidate.ts";
import { RoomStateJournal } from "./journal.ts";
import {
    BoundedSnapshotWriter,
    checksumValue,
    type GameSnapshotEnvelope,
    parseSnapshotEnvelope,
    readSnapshotRuntimeConfig,
    type SnapshotRuntimeConfig,
    type SnapshotWriterMetrics,
} from "./snapshot.ts";

/**
 * Version 4 is an authoritative world checkpoint rather than an admin
 * telemetry projection. Every field in `world` is either materialized on the
 * Candidate and covered by `stateChecksum`, or makes checkpoint creation fail
 * with a named unsupported-state reason.
 */
export interface LooseWeaponState {
    type: string;
    ammo: number;
    cooldown: number;
    recoilTime: number | null;
}

export interface LoosePlayerState {
    sessionId: string;
    name: string;
    teamId: number;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    directionX?: number;
    directionY?: number;
    health: number;
    score: number;
    boost?: number;
    downed?: boolean;
    activeSlot?: number;
    lastInputSequence?: number;
    inventory: Record<string, number>;
    layer?: number;
    dead?: boolean;
    timeAlive?: number;
    outfit?: string;
    backpack?: string;
    helmet?: string;
    chest?: string;
    scope?: string;
    role?: string;
    isKillLeader?: boolean;
    downedCount?: number;
    downedDamageTicker?: number;
    bleedTicker?: number;
    frozen?: boolean;
    frozenTicker?: number;
    frozenOri?: number;
    frozenType?: string;
    action?: {
        type: number;
        seq: number;
        time: number;
        duration: number;
        targetId: number;
        targetSessionId?: string;
        item: string;
    };
    weapons?: LooseWeaponState[];
    perks?: Array<{ type: string; droppable: boolean; replaceOnDeath?: string; isFromRole?: boolean }>;
}

interface LooseGasState {
    mode: number;
    stage: number;
    circleIdx: number;
    damage: number;
    duration: number;
    radOld: number;
    radNew: number;
    currentRad: number;
    posOld: { x: number; y: number };
    posNew: { x: number; y: number };
    currentPos: { x: number; y: number };
    gasT: number;
    gasTicker: number;
    damageTicker: number;
    running: boolean;
    doDamage: boolean;
}

interface LooseObstacleState {
    index: number;
    type: string;
    x: number;
    y: number;
    layer: number;
    originalLayer: number;
    ori: number;
    scale: number;
    health: number;
    healthT: number;
    dead: boolean;
    parentBuildingId?: number;
    puzzlePiece?: string;
    delayedDoorTicker: number;
    killTicker: number;
    regrowTicker: number;
    interactCooldown: number;
    useExpirationTicker: number;
    interactedBySessionId?: string;
    skinPlayerSessionId?: string;
    ownerSessionId?: string;
    shouldApplyLootOwner: boolean;
    delayedDoorInteraction: {
        type: "toggle" | "open" | "close";
        lock?: "lock" | "unlock";
        direction?: { x: number; y: number };
        playerSessionId?: string;
    };
    memorizedDoorState?: {
        open: boolean;
        canUse: boolean;
        useDirection: { x: number; y: number };
    };
    door?: {
        open: boolean;
        canUse: boolean;
        locked: boolean;
        seq: number;
        closedOri: number;
        closedX: number;
        closedY: number;
    };
    button?: { onOff: boolean; canUse: boolean; seq: number };
}

interface LooseBuildingState {
    index: number;
    type: string;
    ceilingDead: boolean;
    ceilingDamaged: boolean;
    wallsToDestroy: number | null;
    occupiedDisabled: boolean;
    occupied: boolean;
    puzzleSolved: boolean;
    puzzleErrSeq: number;
    puzzleOrder: string[];
}

interface LooseLootState {
    type: string;
    x: number;
    y: number;
    layer: number;
    count: number;
    vx: number;
    vy: number;
    isPreloadedGun: boolean;
    ownerSessionId?: string;
    removeOwnerTicker: number;
    cleanupAgeSeconds: number;
    cleanupAfterSeconds: number | null;
}

interface LooseProjectileState {
    type: string;
    x: number;
    y: number;
    layer: number;
    posZ: number;
    vx: number;
    vy: number;
    velZ: number;
    directionX: number;
    directionY: number;
    throwDirectionX: number;
    throwDirectionY: number;
    fuseTime: number;
    damageType: number;
    sourceSessionId?: string;
    weaponSourceType: string;
    obstacleBellowId: number;
    obstacleBellowHeight: number;
    strobe?: {
        timeToPing: number;
        airstrikesTotal: number;
        airstrikesLeft: number;
        airstrikeTicker: number;
        airstrikeDelay: number;
        airstrikeOffset: number;
        rotAngle: number;
    };
}

interface LooseBulletState {
    bulletType: string;
    sourceSessionId?: string;
    pos: { x: number; y: number };
    startPos: { x: number; y: number };
    endPos: { x: number; y: number };
    clientEndPos: { x: number; y: number };
    dir: { x: number; y: number };
    layer: number;
    alive: boolean;
    active: boolean;
    collided: boolean;
    distanceTraveled: number;
    sentToClient: boolean;
    varianceT: number;
    distAdjIdx: number;
    clipDistance: boolean;
    distance: number;
    maxDistance: number;
    shotFx: boolean;
    shotSourceType: string;
    mapSourceType: string;
    shotOffhand: boolean;
    lastShot: boolean;
    reflectCount: number;
    reflectObjectId: number;
    reflectPlayerSessionId?: string;
    hasSpecialFx: boolean;
    shotAlt: boolean;
    splinter: boolean;
    apRounds: boolean;
    highVelocity: boolean;
    combatStims: boolean;
    trailSaturated: boolean;
    trailSmall: boolean;
    trailThick: boolean;
    speed: number;
    damageSelf: boolean;
    damage: number;
    damageMult: number;
    obstacleDamageMult: number;
    falloff: number;
    hasModifier: boolean;
    speedMult: number;
    distanceMult: number;
    onHitFx?: string;
    hasOnHitFx: boolean;
    damageType: number;
    isShrapnel: boolean;
    skipCollision: boolean;
    reflected: boolean;
    canReflect: boolean;
    damagedObjectIds: number[];
    damagedPlayerSessionIds: string[];
}

interface LooseSmokeEmitterState {
    x: number;
    y: number;
    layer: number;
    interior: number;
    active: boolean;
    smokesSpawned: number;
    spawnTicker: number;
    activeTicker: number;
}

interface LooseSmokeState {
    emitterIndex: number;
    x: number;
    y: number;
    layer: number;
    interior: number;
    radius: number;
    maxSize: number;
    vx: number;
    vy: number;
    growTime: number;
    drag: number;
}

interface LooseWorldState {
    game: {
        started: boolean;
        over: boolean;
        startedTime: number;
        timeRunning: number;
        noPlayersTicker: number;
    };
    gas: LooseGasState;
    obstacles: LooseObstacleState[];
    buildings: LooseBuildingState[];
    loot: LooseLootState[];
    projectiles: LooseProjectileState[];
    bullets: LooseBulletState[];
    explosions: Array<{
        type: string;
        x: number;
        y: number;
        layer: number;
        sourceSessionId?: string;
        damageType: number;
        gameSourceType?: string;
        mapSourceType?: string;
        weaponSourceType?: string;
    }>;
    smokeEmitters: LooseSmokeEmitterState[];
    smokes: LooseSmokeState[];
    airdrops: Array<{
        x: number;
        y: number;
        obstacleType: string;
        fallTime: number;
        fallT: number;
        landed: boolean;
        sentLandedToClients: boolean;
    }>;
    deadBodies: Array<{
        x: number;
        y: number;
        layer: number;
        sourceSessionId?: string;
        vx: number;
        vy: number;
        oldX: number;
        oldY: number;
        ageSeconds: number;
    }>;
    decals: Array<{
        type: string;
        x: number;
        y: number;
        layer: number;
        ori: number;
        scale: number;
        goreKills: number;
        lifeTime: number | null;
    }>;
    scheduledPlanes: Array<{ time: number; options: unknown }>;
    airstrikeZones: Array<{
        x: number;
        y: number;
        radius: number;
        durationTicker: number;
        startTicker: number;
        airstrikeTicker: number;
        planesLeft: number;
        directionX: number;
        directionY: number;
        airstrikeInterval: number;
    }>;
    mapUnlocks: Array<{ type: string; stagger: number; time: number }>;
    rng: {
        source: "Math.random";
        serializable: false;
        /** Future entropy is not material until it creates an object/event. */
        requiredForMaterializedRestore: false;
    };
}

export interface LooseGameSnapshot {
    schemaVersion: 4;
    roomId: string;
    mapName: string;
    savedAt: number;
    mapSeed: number;
    stateChecksum: string;
    handoffSafe: true;
    unsupportedState: [];
    world: LooseWorldState;
    /** Kept for the admin/read compatibility projection. */
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
    sodas?: number;
    painkillers?: number;
    boost: number;
    downed: boolean;
    activeSlot: number;
    primaryWeapon: string;
    primaryAmmo: number;
    primaryReserve: number;
    secondaryWeapon: string;
    secondaryAmmo: number;
    secondaryReserve: number;
    throwableWeapon: string;
    throwableCount: number;
    isBot: boolean;
    indoors: boolean;
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
    navigation: Array<{
        id: number;
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
    loot: Array<{
        id: number;
        type: string;
        kind: string;
        x: number;
        y: number;
        count: number;
    }>;
    /**
     * Live, collidable ground-layer obstacles used by protocol bots. Unlike
     * map.navigation this projection is refreshed after crates, windows, and
     * other destructible cover disappear.
     */
    obstacles: Array<{
        id: number;
        type: string;
        kind: "tree" | "rock" | "wall" | "obstacle";
        x: number;
        y: number;
        width: number;
        height: number;
        destructible: boolean;
        containsLoot: boolean;
        health: number;
    }>;
    tickP95Ms: number;
    tickRate: number;
    cpuPercent: number;
    memoryMb: number;
    uptimeSeconds: number;
    strictMode: boolean;
    inputAccepted: number;
    inputRejected: number;
    snapshot: SnapshotWriterMetrics;
}

const restoredPlayers = new WeakMap<Game, Map<string, LoosePlayerState>>();
interface RestoredObstaclePlayerRefs {
    interactedBySessionId?: string;
    delayedPlayerSessionId?: string;
    ownerSessionId?: string;
    skinPlayerSessionId?: string;
}
const restoredObstaclePlayerRefs = new WeakMap<
    Game,
    Map<Game["map"]["obstacles"][number], RestoredObstaclePlayerRefs>
>();
const restoredLootOwners = new WeakMap<Game, Map<Loot, string>>();
const restoredProjectileSources = new WeakMap<Game, Map<Projectile, string>>();
const restoredBulletSources = new WeakMap<Game, Map<Bullet, string>>();
const restoredBulletDamagedPlayers = new WeakMap<Game, Map<Bullet, Set<string>>>();
const restoredBulletReflectPlayers = new WeakMap<Game, Map<Bullet, string>>();
const restoredExplosionSources = new WeakMap<Game, Map<object, string>>();
const restoredDeadBodySources = new WeakMap<Game, Map<object, string>>();
const restoredActionTargets = new WeakMap<Game, Map<Player, string>>();
const processedInputSequences = new WeakMap<Game, Map<string, number>>();
const inputWindows = new WeakMap<Game, Map<string, number[]>>();
const inputCounters = new WeakMap<Game, { accepted: number; rejected: number }>();
const mapSnapshots = new WeakMap<Game, OpsiaMapSnapshot>();
const memorySnapshots = new Map<string, string>();
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
export const opsiaRole = (): OpsiaConfiguredRole => {
    const role = process.env.OPSIA_ROLE ?? "active";
    if (role !== "active" && role !== "candidate" && role !== "auto") throw new Error("invalid_opsia_role");
    return role;
};
export const opsiaRoomEpoch = (): number => {
    const value = Number(process.env.ROOM_EPOCH ?? "0");
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_room_epoch");
    return value;
};
const opsiaSourceEpoch = (): number | undefined => {
    if (process.env.OPSIA_SOURCE_EPOCH === undefined) return undefined;
    const value = Number(process.env.OPSIA_SOURCE_EPOCH);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_opsia_source_epoch");
    return value;
};

const jsonLog = (level: "info" | "warn" | "error", event: string, detail: Record<string, unknown> = {}) => {
    console.log(
        JSON.stringify({ level, event, roomId: opsiaRoomId(), server: process.env.POD_NAME ?? "game-0", detail }),
    );
};

const playerSessionId = (player: Player): string => player.opsiaSessionId || player.client.findGameIp;

const weaponReserve = (player: Player, weapon: string): number => {
    const definition = GameObjectDefs.typeToDefSafe(weapon);
    return definition?.type === "gun"
        ? player.invManager.get(definition.ammo as InventoryItem)
        : 0;
};

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
    const mapObstacles: OpsiaMapSnapshot["objects"] = game.map.obstacles
        .filter((obstacle) => {
            if (obstacle.layer !== 0 || obstacle.dead || obstacle.isDoor) return false;
            const size = mapObjectSize(obstacle.bounds);
            return obstacle.isWall || obstacle.isTree || size.width >= 2.5 || size.height >= 2.5;
        })
        .map((obstacle) => {
            const kind: OpsiaMapObjectKind = obstacle.isWall
                ? "wall"
                : obstacle.isTree
                ? "tree"
                : /rock|stone|boulder/i.test(obstacle.type)
                ? "rock"
                : "obstacle";
            return {
                id: obstacle.__id,
                type: obstacle.type,
                kind,
                x: obstacle.pos.x + (obstacle.bounds.min.x + obstacle.bounds.max.x) / 2,
                y: obstacle.pos.y + (obstacle.bounds.min.y + obstacle.bounds.max.y) / 2,
                ...mapObjectSize(obstacle.bounds),
            };
        });
    const navigation: OpsiaMapSnapshot["navigation"] = mapObstacles
        .filter((obstacle) => obstacle.kind === "wall")
        .map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
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
        // This immutable layout is sent in full only for the first admin
        // render. Subsequent telemetry and bot-brain polls use the compact
        // projection in gameServer.ts.
        objects: [...mapObstacles, ...structures, ...buildings],
        navigation,
    };
    mapSnapshots.set(game, snapshot);
    return snapshot;
};

const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null;
const numberOr = (value: number | undefined, fallback = 0): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
const point = (value: { x: number; y: number } | undefined, fallback = { x: 0, y: 0 }) => ({
    x: numberOr(value?.x, fallback.x),
    y: numberOr(value?.y, fallback.y),
});

const sessionForObjectId = (game: Game, id: number | undefined): string | undefined => {
    if (!id) return undefined;
    const object = game.objectRegister?.getById(id);
    return object?.__type === ObjectType.Player ? playerSessionId(object as Player) : undefined;
};

const capturePlayer = (game: Game, player: Player): LoosePlayerState => {
    const sessionId = playerSessionId(player);
    return {
        sessionId,
        name: player.name,
        teamId: player.teamId,
        x: player.pos.x,
        y: player.pos.y,
        vx: player.vel?.x ?? 0,
        vy: player.vel?.y ?? 0,
        directionX: player.dir?.x ?? 1,
        directionY: player.dir?.y ?? 0,
        health: player.health,
        score: player.kills,
        boost: player.boost ?? 0,
        downed: player.downed ?? false,
        activeSlot: player.curWeapIdx ?? 2,
        lastInputSequence: processedInputSequences.get(game)?.get(sessionId) ?? 0,
        inventory: { ...player.inventory },
        layer: player.layer ?? 0,
        dead: player.dead ?? false,
        timeAlive: player.timeAlive ?? 0,
        outfit: player.outfit ?? "outfitBase",
        backpack: player.backpack ?? "",
        helmet: player.helmet ?? "",
        chest: player.chest ?? "",
        scope: player.scope ?? "1xscope",
        role: player.role ?? "",
        isKillLeader: player.isKillLeader ?? false,
        downedCount: player.downedCount ?? 0,
        downedDamageTicker: player.downedDamageTicker ?? 0,
        bleedTicker: player.bleedTicker ?? 0,
        frozen: player.frozen ?? false,
        frozenTicker: player.frozenTicker ?? 0,
        frozenOri: player.frozenOri ?? 0,
        frozenType: player.frozenType ?? "",
        action: {
            type: player.actionType ?? 0,
            seq: player.actionSeq ?? 0,
            time: player.action?.time ?? 0,
            duration: player.action?.duration ?? 0,
            targetId: player.action?.targetId ?? 0,
            targetSessionId: sessionForObjectId(game, player.action?.targetId),
            item: player.actionItem ?? "",
        },
        weapons: (player.weapons ?? []).map((weapon) => ({
            type: weapon.type,
            ammo: weapon.ammo,
            cooldown: weapon.cooldown,
            recoilTime: finiteOrNull(weapon.recoilTime),
        })),
        perks: (player.perks ?? []).map((perk) => ({ ...perk })),
    };
};

type GasRuntimeView = {
    mode: number;
    stage: number;
    circleIdx: number;
    damage: number;
    duration: number;
    radOld: number;
    radNew: number;
    currentRad: number;
    posOld: { x: number; y: number };
    posNew: { x: number; y: number };
    currentPos: { x: number; y: number };
    gasT: number;
    _gasTicker: number;
    _damageTicker: number;
    _running: boolean;
    doDamage: boolean;
    dirty: boolean;
    timeDirty: boolean;
};

const captureGas = (game: Game): LooseGasState => {
    const gas = game.gas as unknown as GasRuntimeView;
    return {
        mode: numberOr(gas?.mode),
        stage: numberOr(gas?.stage),
        circleIdx: numberOr(gas?.circleIdx),
        damage: numberOr(gas?.damage),
        duration: numberOr(gas?.duration),
        radOld: numberOr(gas?.radOld, numberOr(gas?.currentRad)),
        radNew: numberOr(gas?.radNew, numberOr(gas?.currentRad)),
        currentRad: numberOr(gas?.currentRad),
        posOld: point(gas?.posOld, point(gas?.currentPos)),
        posNew: point(gas?.posNew, point(gas?.currentPos)),
        currentPos: point(gas?.currentPos),
        gasT: numberOr(gas?.gasT),
        gasTicker: numberOr(gas?._gasTicker),
        damageTicker: numberOr(gas?._damageTicker),
        running: gas?._running === true,
        doDamage: gas?.doDamage === true,
    };
};

const captureBullet = (game: Game, bullet: Bullet): LooseBulletState => {
    const damagedPlayerSessionIds = new Set(restoredBulletDamagedPlayers.get(game)?.get(bullet) ?? []);
    const damagedObjectIds: number[] = [];
    for (const id of bullet.damagedObjIds) {
        const sessionId = sessionForObjectId(game, id);
        if (sessionId) damagedPlayerSessionIds.add(sessionId);
        else damagedObjectIds.push(id);
    }
    const reflectedSessionId = restoredBulletReflectPlayers.get(game)?.get(bullet)
        ?? sessionForObjectId(game, bullet.reflectObjId);
    return {
        bulletType: bullet.bulletType,
        sourceSessionId: restoredBulletSources.get(game)?.get(bullet) ?? sessionForObjectId(game, bullet.playerId),
        pos: point(bullet.pos),
        startPos: point(bullet.startPos),
        endPos: point(bullet.endPos),
        clientEndPos: point(bullet.clientEndPos),
        dir: point(bullet.dir, { x: 1, y: 0 }),
        layer: bullet.layer,
        alive: bullet.alive,
        active: bullet.active,
        collided: bullet.collided,
        distanceTraveled: bullet.distanceTraveled,
        sentToClient: bullet.sentToClient,
        varianceT: bullet.varianceT,
        distAdjIdx: bullet.distAdjIdx,
        clipDistance: bullet.clipDistance,
        distance: bullet.distance,
        maxDistance: bullet.maxDistance,
        shotFx: bullet.shotFx,
        shotSourceType: bullet.shotSourceType,
        mapSourceType: bullet.mapSourceType,
        shotOffhand: bullet.shotOffhand,
        lastShot: bullet.lastShot,
        reflectCount: bullet.reflectCount,
        reflectObjectId: reflectedSessionId ? 0 : bullet.reflectObjId,
        reflectPlayerSessionId: reflectedSessionId,
        hasSpecialFx: bullet.hasSpecialFx,
        shotAlt: bullet.shotAlt,
        splinter: bullet.splinter,
        apRounds: bullet.apRounds,
        highVelocity: bullet.highVelocity,
        combatStims: bullet.combatStims,
        trailSaturated: bullet.trailSaturated,
        trailSmall: bullet.trailSmall,
        trailThick: bullet.trailThick,
        speed: bullet.speed,
        damageSelf: bullet.damageSelf,
        damage: bullet.damage,
        damageMult: bullet.damageMult,
        obstacleDamageMult: bullet.obstacleDamageMult,
        falloff: bullet.falloff,
        hasModifier: bullet.hasModifier,
        speedMult: bullet.speedMult,
        distanceMult: bullet.distanceMult,
        onHitFx: bullet.onHitFx,
        hasOnHitFx: bullet.hasOnHitFx,
        damageType: bullet.damageType,
        isShrapnel: bullet.isShrapnel,
        skipCollision: bullet.skipCollision,
        reflected: bullet.reflected,
        canReflect: bullet.canReflect,
        damagedObjectIds: damagedObjectIds.sort((a, b) => a - b),
        damagedPlayerSessionIds: [...damagedPlayerSessionIds].sort(),
    };
};

const collectUnsupportedWorldState = (game: Game): string[] => {
    const unsupported: string[] = [];
    if ((game.bulletBarn?.damages.length ?? 0) > 0) unsupported.push("pending_bullet_damage");
    if ((game.planeBarn?.planes.length ?? 0) > 0) unsupported.push("active_plane");
    if ((game.map?.unlocks?.length ?? 0) > 0) unsupported.push("active_map_unlock_batch");
    if (game.map?.obstacles?.some((obstacle) => obstacle.destroyed)) {
        unsupported.push("destroyed_map_object_pending_replacement");
    }
    if (game.map?.buildings?.some((building) => building.destroyed)) {
        unsupported.push("destroyed_building_pending_replacement");
    }
    if (game.map?.buildings?.some((building) => building.pendingPuzzleTimeouts.size > 0)) {
        unsupported.push("building_puzzle_timeout");
    }
    return unsupported.sort();
};

const captureObstacle = (
    game: Game,
    obstacle: Game["map"]["obstacles"][number],
    index: number,
): LooseObstacleState => {
    const restoredRefs = restoredObstaclePlayerRefs.get(game)?.get(obstacle);
    return {
        index,
        type: obstacle.type,
        x: obstacle.pos.x,
        y: obstacle.pos.y,
        layer: obstacle.layer,
        originalLayer: obstacle.originalLayer,
        ori: obstacle.ori,
        scale: obstacle.scale,
        health: obstacle.health,
        healthT: obstacle.healthT,
        dead: obstacle.dead,
        parentBuildingId: obstacle.parentBuildingId,
        puzzlePiece: obstacle.puzzlePiece,
        delayedDoorTicker: obstacle.delayedDoorTicker,
        killTicker: obstacle.killTicker,
        regrowTicker: obstacle.regrowTicker,
        interactCooldown: obstacle.interactCooldown,
        useExpirationTicker: obstacle.useExpirationTicker,
        interactedBySessionId: obstacle.interactedBy
            ? playerSessionId(obstacle.interactedBy)
            : restoredRefs?.interactedBySessionId,
        skinPlayerSessionId: sessionForObjectId(game, obstacle.skinPlayerId)
            ?? restoredRefs?.skinPlayerSessionId,
        ownerSessionId: sessionForObjectId(game, obstacle.ownerId) ?? restoredRefs?.ownerSessionId,
        shouldApplyLootOwner: obstacle.shouldApplyLootOwner,
        delayedDoorInteraction: {
            type: obstacle.delayedDoorInteraction.type,
            lock: obstacle.delayedDoorInteraction.lock,
            direction: obstacle.delayedDoorInteraction.dir
                ? point(obstacle.delayedDoorInteraction.dir)
                : undefined,
            playerSessionId: obstacle.delayedDoorInteraction.player
                ? playerSessionId(obstacle.delayedDoorInteraction.player)
                : restoredRefs?.delayedPlayerSessionId,
        },
        memorizedDoorState: obstacle.memorizedDoorState
            ? {
                open: obstacle.memorizedDoorState.open,
                canUse: obstacle.memorizedDoorState.canUse,
                useDirection: point(obstacle.memorizedDoorState.useDir),
            }
            : undefined,
        door: obstacle.door
            ? {
                open: obstacle.door.open,
                canUse: obstacle.door.canUse,
                locked: obstacle.door.locked,
                seq: obstacle.door.seq,
                closedOri: obstacle.door.closedOri,
                closedX: obstacle.door.closedPos.x,
                closedY: obstacle.door.closedPos.y,
            }
            : undefined,
        button: obstacle.isButton
            ? { onOff: obstacle.button.onOff, canUse: obstacle.button.canUse, seq: obstacle.button.seq }
            : undefined,
    };
};

const captureWorld = (game: Game): LooseWorldState => {
    const explosionSources = restoredExplosionSources.get(game);
    const deadBodySources = restoredDeadBodySources.get(game);
    const emitters = game.smokeBarn?.emitters ?? [];
    return {
        game: {
            started: game.started === true,
            over: game.over === true,
            startedTime: numberOr(game.startedTime),
            timeRunning: numberOr(game.timeRunning),
            noPlayersTicker: numberOr(game.noPlayersTicker),
        },
        gas: captureGas(game),
        obstacles: (game.map?.obstacles ?? []).filter((obstacle) => !obstacle.destroyed).map(
            (obstacle, index) => captureObstacle(game, obstacle, index),
        ),
        buildings: (game.map?.buildings ?? []).filter((building) => !building.destroyed).map((building, index) => ({
            index,
            type: building.type,
            ceilingDead: building.ceilingDead,
            ceilingDamaged: building.ceilingDamaged,
            wallsToDestroy: finiteOrNull(building.wallsToDestroy),
            occupiedDisabled: building.occupiedDisabled,
            occupied: building.occupied,
            puzzleSolved: building.puzzleSolved,
            puzzleErrSeq: building.puzzleErrSeq,
            puzzleOrder: [...building.puzzleOrder],
        })),
        loot: (game.lootBarn?.loots ?? []).filter((loot) => !loot.destroyed).map((loot) => ({
            type: loot.type,
            x: loot.pos.x,
            y: loot.pos.y,
            layer: loot.layer,
            count: loot.count,
            vx: loot.vel.x,
            vy: loot.vel.y,
            isPreloadedGun: loot.isPreloadedGun,
            ownerSessionId: restoredLootOwners.get(game)?.get(loot) ?? sessionForObjectId(game, loot.ownerId),
            removeOwnerTicker: loot.removeOwnerTicker,
            cleanupAgeSeconds: loot.cleanupAgeSeconds,
            cleanupAfterSeconds: finiteOrNull(loot.cleanupAfterSeconds),
        })),
        projectiles: (game.projectileBarn?.projectiles ?? []).filter((projectile) => !projectile.destroyed).map(
            (projectile) => ({
                type: projectile.type,
                x: projectile.pos.x,
                y: projectile.pos.y,
                layer: projectile.layer,
                posZ: projectile.posZ,
                vx: projectile.vel.x,
                vy: projectile.vel.y,
                velZ: projectile.velZ,
                directionX: projectile.dir.x,
                directionY: projectile.dir.y,
                throwDirectionX: projectile.throwDir.x,
                throwDirectionY: projectile.throwDir.y,
                fuseTime: projectile.fuseTime,
                damageType: projectile.damageType,
                sourceSessionId: restoredProjectileSources.get(game)?.get(projectile)
                    ?? sessionForObjectId(game, projectile.playerId),
                weaponSourceType: projectile.weaponSourceType,
                obstacleBellowId: projectile.obstacleBellowId,
                obstacleBellowHeight: projectile.obstacleBellowHeight,
                strobe: projectile.strobe ? { ...projectile.strobe } : undefined,
            }),
        ),
        bullets: (game.bulletBarn?.bullets ?? []).filter((bullet) => bullet.active).map((bullet) =>
            captureBullet(game, bullet)
        ),
        explosions: (game.explosionBarn?.explosions ?? []).map((explosion) => ({
            type: explosion.type,
            x: explosion.pos.x,
            y: explosion.pos.y,
            layer: explosion.layer,
            sourceSessionId: explosionSources?.get(explosion as object)
                ?? (explosion.damageParams.source?.__type === ObjectType.Player
                    ? playerSessionId(explosion.damageParams.source as Player)
                    : undefined),
            damageType: explosion.damageParams.damageType,
            gameSourceType: explosion.damageParams.gameSourceType,
            mapSourceType: explosion.damageParams.mapSourceType,
            weaponSourceType: explosion.damageParams.weaponSourceType,
        })),
        smokeEmitters: emitters.map((emitter) => ({
            x: emitter.pos.x,
            y: emitter.pos.y,
            layer: emitter.layer,
            interior: emitter.interior,
            active: emitter.active,
            smokesSpawned: emitter.smokesSpawned,
            spawnTicker: emitter.spawnTicker,
            activeTicker: emitter.activeTicker,
        })),
        smokes: (game.smokeBarn?.smokes ?? []).filter((smoke) => !smoke.destroyed).map((smoke) => ({
            emitterIndex: Math.max(0, emitters.indexOf(smoke.emitter)),
            x: smoke.pos.x,
            y: smoke.pos.y,
            layer: smoke.layer,
            interior: smoke.interior,
            radius: smoke.rad,
            maxSize: smoke.maxSize,
            vx: smoke.vel.x,
            vy: smoke.vel.y,
            growTime: smoke.growTime,
            drag: smoke.drag,
        })),
        airdrops: (game.airdropBarn?.airdrops ?? []).filter((airdrop) => !airdrop.destroyed).map((airdrop) => ({
            x: airdrop.pos.x,
            y: airdrop.pos.y,
            obstacleType: airdrop.obstacleType,
            fallTime: airdrop.fallTime,
            fallT: airdrop.fallT,
            landed: airdrop.landed,
            sentLandedToClients: airdrop.sentLandedToClients,
        })),
        deadBodies: (game.deadBodyBarn?.deadBodies ?? []).filter((body) => !body.destroyed).map((body) => ({
            x: body.pos.x,
            y: body.pos.y,
            layer: body.layer,
            sourceSessionId: deadBodySources?.get(body as object) ?? sessionForObjectId(game, body.playerId),
            vx: body.vel.x,
            vy: body.vel.y,
            oldX: body.oldPos.x,
            oldY: body.oldPos.y,
            ageSeconds: body.ageSeconds,
        })),
        decals: (game.decalBarn?.decals ?? []).filter((decal) => !decal.destroyed).map((decal) => ({
            type: decal.type,
            x: decal.pos.x,
            y: decal.pos.y,
            layer: decal.layer,
            ori: decal.ori,
            scale: decal.scale,
            goreKills: decal.goreKills,
            lifeTime: finiteOrNull(decal.lifeTime),
        })),
        scheduledPlanes: (game.planeBarn?.scheduledPlanes ?? []).map((scheduled) => ({
            time: scheduled.time,
            options: structuredClone(scheduled.options),
        })),
        airstrikeZones: (game.planeBarn?.airstrikeZones ?? []).map((zone) => ({
            x: zone.pos.x,
            y: zone.pos.y,
            radius: zone.rad,
            durationTicker: zone.durationTicker,
            startTicker: zone.startTicker,
            airstrikeTicker: zone.airstrikeTicker,
            planesLeft: zone.planesLeft,
            directionX: zone.planeDir.x,
            directionY: zone.planeDir.y,
            airstrikeInterval: zone.airstrikeInterval,
        })),
        mapUnlocks: (game.map?.scheduledUnlocks ?? []).map((unlock) => ({ ...unlock })),
        rng: {
            source: "Math.random",
            serializable: false,
            requiredForMaterializedRestore: false,
        },
    };
};

const materialStateChecksum = (
    roomId: string,
    mapName: string,
    mapSeed: number,
    world: LooseWorldState,
    players: LoosePlayerState[],
): string =>
    checksumValue({
        schemaVersion: 4,
        roomId,
        mapName,
        mapSeed,
        world,
        players: [...players].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    });

const firstMaterialMismatch = (expected: unknown, actual: unknown, path = "world"): string | undefined => {
    if (Object.is(expected, actual)) return undefined;
    if (Array.isArray(expected) && Array.isArray(actual)) {
        if (expected.length !== actual.length) return `${path}.length`;
        for (let index = 0; index < expected.length; index++) {
            const mismatch = firstMaterialMismatch(expected[index], actual[index], `${path}[${index}]`);
            if (mismatch) return mismatch;
        }
        return undefined;
    }
    if (typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null) {
        const expectedRecord = expected as Record<string, unknown>;
        const actualRecord = actual as Record<string, unknown>;
        const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
        for (const key of keys) {
            const mismatch = firstMaterialMismatch(expectedRecord[key], actualRecord[key], `${path}.${key}`);
            if (mismatch) return mismatch;
        }
        return undefined;
    }
    return path;
};

export const serializeGame = (game: Game): LooseGameSnapshot => {
    const unsupportedState = collectUnsupportedWorldState(game);
    if (unsupportedState.length > 0) {
        throw new Error(`snapshot_world_state_unsupported:${unsupportedState.join(",")}`);
    }
    const roomId = opsiaRoomId();
    const mapSeed = game.map?.seed ?? 0;
    const players = (game.playerBarn?.players ?? []).map((player) => capturePlayer(game, player))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const world = captureWorld(game);
    return {
        schemaVersion: 4,
        roomId,
        mapName: game.mapName,
        savedAt: Date.now(),
        mapSeed,
        stateChecksum: materialStateChecksum(roomId, game.mapName, mapSeed, world, players),
        handoffSafe: true,
        unsupportedState: [],
        world,
        gasPhase: world.gas.circleIdx,
        destroyedObstacleIds: world.obstacles.filter((obstacle) => obstacle.dead).map((obstacle) => obstacle.index),
        players,
    };
};

const restoreGas = (game: Game, state: LooseGasState): void => {
    const gas = game.gas as unknown as GasRuntimeView;
    if (!gas) throw new Error("snapshot_gas_restore_unsupported");
    gas.mode = state.mode;
    gas.stage = state.stage;
    gas.circleIdx = state.circleIdx;
    gas.damage = state.damage;
    gas.duration = state.duration;
    gas.radOld = state.radOld;
    gas.radNew = state.radNew;
    gas.currentRad = state.currentRad;
    gas.posOld = point(state.posOld);
    gas.posNew = point(state.posNew);
    gas.currentPos = point(state.currentPos);
    gas.gasT = state.gasT;
    gas._gasTicker = state.gasTicker;
    gas._damageTicker = state.damageTicker;
    gas._running = state.running;
    gas.doDamage = state.doDamage;
    gas.dirty = true;
    gas.timeDirty = true;
};

const restoreObstaclesAndBuildings = (game: Game, world: LooseWorldState): void => {
    if (!game.map?.obstacles || !game.map?.buildings) {
        if (world.obstacles.length || world.buildings.length) throw new Error("snapshot_map_restore_unsupported");
        return;
    }
    const obstaclePlayerRefs = new Map<Game["map"]["obstacles"][number], RestoredObstaclePlayerRefs>();
    for (const state of world.obstacles) {
        let obstacle = game.map.obstacles[state.index];
        if (!obstacle) {
            obstacle = game.map.genObstacle(
                state.type,
                { x: state.x, y: state.y },
                state.layer,
                state.ori,
                state.scale,
                state.parentBuildingId,
                state.puzzlePiece,
            );
        }
        if (!obstacle || obstacle.type !== state.type) throw new Error("snapshot_obstacle_layout_mismatch");
        obstacle.pos.x = state.x;
        obstacle.pos.y = state.y;
        obstacle.layer = state.layer;
        obstacle.originalLayer = state.originalLayer;
        obstacle.ori = state.ori;
        obstacle.rot = state.ori * Math.PI / 2;
        obstacle.scale = state.scale;
        obstacle.health = state.health;
        obstacle.healthT = state.healthT;
        obstacle.dead = state.dead;
        obstacle.delayedDoorTicker = state.delayedDoorTicker;
        obstacle.killTicker = state.killTicker;
        obstacle.regrowTicker = state.regrowTicker;
        obstacle.interactCooldown = state.interactCooldown;
        obstacle.useExpirationTicker = state.useExpirationTicker;
        obstacle.interactedBy = undefined;
        obstacle.skinPlayerId = undefined;
        obstacle.ownerId = 0;
        obstacle.shouldApplyLootOwner = state.shouldApplyLootOwner;
        obstacle.delayedDoorInteraction = {
            type: state.delayedDoorInteraction.type,
            lock: state.delayedDoorInteraction.lock,
            dir: state.delayedDoorInteraction.direction
                ? point(state.delayedDoorInteraction.direction)
                : undefined,
            player: undefined,
        };
        obstacle.memorizedDoorState = state.memorizedDoorState
            ? {
                open: state.memorizedDoorState.open,
                canUse: state.memorizedDoorState.canUse,
                useDir: point(state.memorizedDoorState.useDirection),
            }
            : undefined;
        if (
            state.interactedBySessionId
            || state.delayedDoorInteraction.playerSessionId
            || state.ownerSessionId
            || state.skinPlayerSessionId
        ) {
            obstaclePlayerRefs.set(obstacle, {
                interactedBySessionId: state.interactedBySessionId,
                delayedPlayerSessionId: state.delayedDoorInteraction.playerSessionId,
                ownerSessionId: state.ownerSessionId,
                skinPlayerSessionId: state.skinPlayerSessionId,
            });
        }
        if (state.door) {
            if (!obstacle.door) throw new Error("snapshot_obstacle_door_mismatch");
            obstacle.door.open = state.door.open;
            obstacle.door.canUse = state.door.canUse;
            obstacle.door.locked = state.door.locked;
            obstacle.door.seq = state.door.seq;
            obstacle.door.closedOri = state.door.closedOri;
            obstacle.door.closedPos.x = state.door.closedX;
            obstacle.door.closedPos.y = state.door.closedY;
        }
        if (state.button) {
            if (!obstacle.isButton) throw new Error("snapshot_obstacle_button_mismatch");
            obstacle.button.onOff = state.button.onOff;
            obstacle.button.canUse = state.button.canUse;
            obstacle.button.seq = state.button.seq;
        }
        obstacle.updateCollider();
        obstacle.setDirty();
    }
    restoredObstaclePlayerRefs.set(game, obstaclePlayerRefs);
    if (game.map.obstacles.filter((obstacle) => !obstacle.destroyed).length !== world.obstacles.length) {
        throw new Error("snapshot_obstacle_count_mismatch");
    }
    for (const state of world.buildings) {
        const building = game.map.buildings[state.index];
        if (!building || building.type !== state.type || building.destroyed) {
            throw new Error("snapshot_building_layout_mismatch");
        }
        building.ceilingDead = state.ceilingDead;
        building.ceilingDamaged = state.ceilingDamaged;
        building.wallsToDestroy = state.wallsToDestroy ?? Infinity;
        building.occupiedDisabled = state.occupiedDisabled;
        building.occupied = state.occupied;
        building.puzzleSolved = state.puzzleSolved;
        building.puzzleErrSeq = state.puzzleErrSeq;
        building.puzzleOrder = [...state.puzzleOrder];
        building.setDirty();
    }
    if (game.map.buildings.filter((building) => !building.destroyed).length !== world.buildings.length) {
        throw new Error("snapshot_building_count_mismatch");
    }
};

const destroyRegistered = (objects: Array<{ destroyed: boolean; destroy(): void }>): void => {
    for (const object of objects) if (!object.destroyed) object.destroy();
};

const restoreWorldObjects = (game: Game, world: LooseWorldState): void => {
    const required = [
        game.objectRegister,
        game.lootBarn,
        game.projectileBarn,
        game.bulletBarn,
        game.explosionBarn,
        game.smokeBarn,
        game.airdropBarn,
        game.deadBodyBarn,
        game.decalBarn,
        game.planeBarn,
    ];
    if (required.some((value) => !value)) {
        const hasObjects = world.loot.length || world.projectiles.length || world.bullets.length
            || world.explosions.length || world.smokes.length || world.smokeEmitters.length
            || world.airdrops.length || world.deadBodies.length || world.decals.length
            || world.scheduledPlanes.length || world.airstrikeZones.length;
        if (hasObjects) throw new Error("snapshot_world_restore_unsupported");
        return;
    }

    destroyRegistered(game.lootBarn.loots);
    destroyRegistered(game.projectileBarn.projectiles);
    destroyRegistered(game.smokeBarn.smokes);
    destroyRegistered(game.airdropBarn.airdrops);
    destroyRegistered(game.deadBodyBarn.deadBodies);
    destroyRegistered(game.decalBarn.decals);
    game.objectRegister.flush();
    game.lootBarn.loots = [];
    game.lootBarn.newLoots = [];
    game.projectileBarn.projectiles = [];
    game.bulletBarn.bullets = [];
    game.bulletBarn.newBullets = [];
    game.bulletBarn.damages = [];
    game.explosionBarn.explosions = [];
    game.explosionBarn.newExplosions = [];
    game.smokeBarn.smokes = [];
    game.smokeBarn.emitters = [];
    game.airdropBarn.airdrops = [];
    game.deadBodyBarn.deadBodies = [];
    game.decalBarn.decals = [];

    const lootOwners = new Map<Loot, string>();
    for (const state of world.loot) {
        const before = game.lootBarn.loots.length;
        game.lootBarn.addLoot(state.type, { x: state.x, y: state.y }, state.layer, state.count, {
            noSideAmmo: true,
            pushSpeed: 0,
            dir: { x: 1, y: 0 },
        });
        const loot = game.lootBarn.loots[before];
        if (!loot) throw new Error("snapshot_loot_restore_failed");
        loot.pos.x = state.x;
        loot.pos.y = state.y;
        loot.vel.x = state.vx;
        loot.vel.y = state.vy;
        loot.isPreloadedGun = state.isPreloadedGun;
        loot.ownerId = 0;
        loot.removeOwnerTicker = state.removeOwnerTicker;
        loot.cleanupAgeSeconds = state.cleanupAgeSeconds;
        loot.cleanupAfterSeconds = state.cleanupAfterSeconds ?? Infinity;
        loot.refresh();
        if (state.ownerSessionId) lootOwners.set(loot, state.ownerSessionId);
    }
    restoredLootOwners.set(game, lootOwners);

    const projectileSources = new Map<Projectile, string>();
    for (const state of world.projectiles) {
        const projectile = game.projectileBarn.addProjectile(
            0,
            state.type,
            { x: state.x, y: state.y },
            state.posZ,
            state.layer,
            { x: state.vx, y: state.vy },
            state.fuseTime,
            state.damageType as DamageType,
            { x: state.throwDirectionX, y: state.throwDirectionY },
            state.weaponSourceType,
        );
        projectile.pos.x = state.x;
        projectile.pos.y = state.y;
        projectile.vel.x = state.vx;
        projectile.vel.y = state.vy;
        projectile.velZ = state.velZ;
        projectile.dir.x = state.directionX;
        projectile.dir.y = state.directionY;
        projectile.throwDir.x = state.throwDirectionX;
        projectile.throwDir.y = state.throwDirectionY;
        projectile.fuseTime = state.fuseTime;
        projectile.obstacleBellowId = state.obstacleBellowId;
        projectile.obstacleBellowHeight = state.obstacleBellowHeight;
        projectile.strobe = state.strobe ? { ...state.strobe } : undefined;
        game.grid.updateObject(projectile);
        if (state.sourceSessionId) projectileSources.set(projectile, state.sourceSessionId);
    }
    restoredProjectileSources.set(game, projectileSources);

    const bulletSources = new Map<Bullet, string>();
    const bulletDamagedPlayers = new Map<Bullet, Set<string>>();
    const bulletReflectPlayers = new Map<Bullet, string>();
    for (const state of world.bullets) {
        const bullet = game.bulletBarn.fireBullet({
            bulletType: state.bulletType,
            gameSourceType: state.shotSourceType,
            mapSourceType: state.mapSourceType,
            pos: state.startPos,
            dir: state.dir,
            layer: state.layer,
            damageMult: state.damageMult,
            damageType: state.damageType as DamageType,
            playerId: 0,
            varianceT: state.varianceT,
            shotFx: state.shotFx,
            shotOffhand: state.shotOffhand,
            lastShot: state.lastShot,
            splinter: state.splinter,
            apRounds: state.apRounds,
            highVelocity: state.highVelocity,
            combatStims: state.combatStims,
            shotAlt: state.shotAlt,
            trailSaturated: state.trailSaturated,
            trailSmall: state.trailSmall,
            trailThick: state.trailThick,
            reflectCount: state.reflectCount,
            reflectObjId: state.reflectObjectId,
            onHitFx: state.onHitFx,
            clipDistance: state.clipDistance,
            distance: state.distance,
            speedMult: state.speedMult,
            distanceMult: state.distanceMult,
        });
        Object.assign(bullet, {
            alive: state.alive,
            active: state.active,
            collided: state.collided,
            distanceTraveled: state.distanceTraveled,
            sentToClient: state.sentToClient,
            playerId: 0,
            pos: point(state.pos),
            startPos: point(state.startPos),
            endPos: point(state.endPos),
            clientEndPos: point(state.clientEndPos),
            dir: point(state.dir),
            varianceT: state.varianceT,
            distAdjIdx: state.distAdjIdx,
            distance: state.distance,
            maxDistance: state.maxDistance,
            hasSpecialFx: state.hasSpecialFx,
            speed: state.speed,
            damageSelf: state.damageSelf,
            damage: state.damage,
            obstacleDamageMult: state.obstacleDamageMult,
            falloff: state.falloff,
            hasModifier: state.hasModifier,
            hasOnHitFx: state.hasOnHitFx,
            isShrapnel: state.isShrapnel,
            skipCollision: state.skipCollision,
            reflected: state.reflected,
            canReflect: state.canReflect,
            damagedObjIds: new Set(state.damagedObjectIds),
        });
        if (state.sourceSessionId) bulletSources.set(bullet, state.sourceSessionId);
        if (state.damagedPlayerSessionIds.length) {
            bulletDamagedPlayers.set(bullet, new Set(state.damagedPlayerSessionIds));
        }
        if (state.reflectPlayerSessionId) bulletReflectPlayers.set(bullet, state.reflectPlayerSessionId);
    }
    game.bulletBarn.newBullets = game.bulletBarn.bullets.filter((bullet) => !bullet.sentToClient);
    restoredBulletSources.set(game, bulletSources);
    restoredBulletDamagedPlayers.set(game, bulletDamagedPlayers);
    restoredBulletReflectPlayers.set(game, bulletReflectPlayers);

    const explosionSources = new Map<object, string>();
    for (const state of world.explosions) {
        game.explosionBarn.addExplosion(state.type, { x: state.x, y: state.y }, state.layer, {
            damageType: state.damageType as DamageType,
            gameSourceType: state.gameSourceType,
            mapSourceType: state.mapSourceType,
            weaponSourceType: state.weaponSourceType,
        });
        const explosion = game.explosionBarn.explosions.at(-1);
        if (!explosion) throw new Error("snapshot_explosion_restore_failed");
        if (state.sourceSessionId) explosionSources.set(explosion as object, state.sourceSessionId);
    }
    restoredExplosionSources.set(game, explosionSources);

    for (const emitterState of world.smokeEmitters) {
        game.smokeBarn.addEmitter({ x: emitterState.x, y: emitterState.y }, emitterState.layer);
        const emitter = game.smokeBarn.emitters.at(-1);
        if (!emitter) throw new Error("snapshot_smoke_emitter_restore_failed");
        emitter.pos.x = emitterState.x;
        emitter.pos.y = emitterState.y;
        emitter.interior = emitterState.interior;
        emitter.active = emitterState.active;
        emitter.smokesSpawned = emitterState.smokesSpawned;
        emitter.spawnTicker = emitterState.spawnTicker;
        emitter.activeTicker = emitterState.activeTicker;
    }
    destroyRegistered(game.smokeBarn.smokes);
    game.objectRegister.flush();
    game.smokeBarn.smokes = [];
    for (const state of world.smokes) {
        const emitter = game.smokeBarn.emitters[state.emitterIndex];
        if (!emitter) throw new Error("snapshot_smoke_emitter_reference_invalid");
        game.smokeBarn.addSmoke({ x: state.x, y: state.y }, state.layer, state.interior, emitter, false);
        const smoke = game.smokeBarn.smokes.at(-1)!;
        smoke.pos.x = state.x;
        smoke.pos.y = state.y;
        smoke.rad = state.radius;
        smoke.maxSize = state.maxSize;
        smoke.vel.x = state.vx;
        smoke.vel.y = state.vy;
        smoke.growTime = state.growTime;
        smoke.drag = state.drag;
        game.grid.updateObject(smoke);
    }

    for (const state of world.airdrops) {
        game.airdropBarn.addAirdrop({ x: state.x, y: state.y }, state.obstacleType);
        const airdrop = game.airdropBarn.airdrops.at(-1)!;
        airdrop.fallTime = state.fallTime;
        airdrop.fallT = state.fallT;
        airdrop.landed = state.landed;
        airdrop.sentLandedToClients = state.sentLandedToClients;
    }

    const bodySources = new Map<object, string>();
    for (const state of world.deadBodies) {
        game.deadBodyBarn.addDeadBody({ x: state.x, y: state.y }, 0, state.layer, { x: 0, y: 0 });
        const body = game.deadBodyBarn.deadBodies.at(-1)!;
        body.vel.x = state.vx;
        body.vel.y = state.vy;
        body.oldPos.x = state.oldX;
        body.oldPos.y = state.oldY;
        body.ageSeconds = state.ageSeconds;
        if (state.sourceSessionId) bodySources.set(body as object, state.sourceSessionId);
    }
    restoredDeadBodySources.set(game, bodySources);

    for (const state of world.decals) {
        const decal = game.decalBarn.addDecal(
            state.type,
            { x: state.x, y: state.y },
            state.layer,
            state.ori,
            state.scale,
        );
        decal.goreKills = state.goreKills;
        decal.lifeTime = state.lifeTime ?? Infinity;
    }

    game.planeBarn.scheduledPlanes = world.scheduledPlanes.map((scheduled) => ({
        time: scheduled.time,
        options: structuredClone(scheduled.options) as typeof game.planeBarn.scheduledPlanes[number]["options"],
    }));
    game.planeBarn.airstrikeZones = [];
    game.planeBarn.newAirstrikeZones = [];
    for (const state of world.airstrikeZones) {
        game.planeBarn.addAirstrikeZone(
            { x: state.x, y: state.y },
            state.radius,
            state.planesLeft,
            state.startTicker,
            state.airstrikeInterval,
        );
        const zone = game.planeBarn.airstrikeZones.at(-1)!;
        zone.durationTicker = state.durationTicker;
        zone.startTicker = state.startTicker;
        zone.airstrikeTicker = state.airstrikeTicker;
        zone.planesLeft = state.planesLeft;
        zone.planeDir.x = state.directionX;
        zone.planeDir.y = state.directionY;
    }
    game.planeBarn.newAirstrikeZones = [];
    game.map.scheduledUnlocks = world.mapUnlocks.map((unlock) => ({ ...unlock }));
};

export const restoreGame = (game: Game, snapshot: LooseGameSnapshot): string => {
    if (
        snapshot.schemaVersion !== 4
        || snapshot.roomId !== opsiaRoomId()
        || snapshot.mapName !== game.mapName
        || snapshot.handoffSafe !== true
        || !Array.isArray(snapshot.unsupportedState)
        || snapshot.unsupportedState.length !== 0
        || !/^[a-f\d]{64}$/.test(snapshot.stateChecksum)
        || !snapshot.world
    ) {
        throw new Error("invalid_opsia_snapshot");
    }
    if ((game.map?.seed ?? 0) !== snapshot.mapSeed) throw new Error("snapshot_map_seed_mismatch");

    game.started = snapshot.world.game.started;
    game.over = snapshot.world.game.over;
    game.startedTime = snapshot.world.game.startedTime;
    game.timeRunning = snapshot.world.game.timeRunning;
    game.noPlayersTicker = snapshot.world.game.noPlayersTicker;
    restoreGas(game, snapshot.world.gas);
    restoreObstaclesAndBuildings(game, snapshot.world);
    restoreWorldObjects(game, snapshot.world);

    restoredPlayers.set(game, new Map(snapshot.players.map((player) => [player.sessionId, player])));
    processedInputSequences.set(
        game,
        new Map(snapshot.players.map((player) => {
            const sequence = Number(player.lastInputSequence ?? 0);
            return [player.sessionId, Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0] as const;
        })),
    );

    const materializedWorld = captureWorld(game);
    const materializedChecksum = materialStateChecksum(
        snapshot.roomId,
        snapshot.mapName,
        snapshot.mapSeed,
        materializedWorld,
        snapshot.players,
    );
    if (materializedChecksum !== snapshot.stateChecksum) {
        const mismatch = firstMaterialMismatch(snapshot.world, materializedWorld);
        throw new Error(`snapshot_materialized_checksum_mismatch:${mismatch ?? "players_or_metadata"}`);
    }
    return materializedChecksum;
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
    if (player.vel) {
        player.vel.x = typeof state.vx === "number" && Number.isFinite(state.vx) ? state.vx : 0;
        player.vel.y = typeof state.vy === "number" && Number.isFinite(state.vy) ? state.vy : 0;
    }
    if (player.dir) {
        player.dir.x = typeof state.directionX === "number" && Number.isFinite(state.directionX) ? state.directionX : 1;
        player.dir.y = typeof state.directionY === "number" && Number.isFinite(state.directionY) ? state.directionY : 0;
    }
    player.health = state.health;
    player.kills = state.score;
    if (state.boost !== undefined) {
        player.boost = typeof state.boost === "number" && Number.isFinite(state.boost) ? state.boost : 0;
    }
    if (state.downed !== undefined) player.downed = state.downed === true;
    if (
        typeof state.activeSlot === "number"
        && Number.isSafeInteger(state.activeSlot)
        && state.activeSlot >= 0
        && state.activeSlot < (player.weapons?.length ?? 0)
    ) {
        player.weaponManager?.setCurWeapIndex(state.activeSlot, true);
    }
    for (const [item, amount] of Object.entries(state.inventory)) {
        if (player.invManager.isValid(item) && Number.isInteger(amount) && amount >= 0) {
            player.invManager.set(item as InventoryItem, amount);
        }
    }
    player.layer = state.layer ?? player.layer;
    player.dead = state.dead === true;
    player.timeAlive = state.timeAlive ?? player.timeAlive;
    player.outfit = state.outfit ?? player.outfit;
    player.backpack = state.backpack ?? player.backpack;
    player.helmet = state.helmet ?? player.helmet;
    player.chest = state.chest ?? player.chest;
    player.scope = state.scope ?? player.scope;
    player.role = state.role ?? player.role;
    player.isKillLeader = state.isKillLeader ?? player.isKillLeader;
    player.downedCount = state.downedCount ?? player.downedCount;
    player.downedDamageTicker = state.downedDamageTicker ?? player.downedDamageTicker;
    player.bleedTicker = state.bleedTicker ?? player.bleedTicker;
    player.frozen = state.frozen ?? player.frozen;
    player.frozenTicker = state.frozenTicker ?? player.frozenTicker;
    player.frozenOri = state.frozenOri ?? player.frozenOri;
    player.frozenType = state.frozenType ?? player.frozenType;
    if (
        state.perks
        && player.perks
        && typeof player.removePerk === "function"
        && typeof player.addPerk === "function"
    ) {
        for (const perk of [...player.perks]) player.removePerk(perk.type);
        for (const perk of state.perks) {
            player.addPerk(perk.type, perk.droppable, perk.replaceOnDeath, perk.isFromRole);
        }
    }
    // Perk application can replace weapons; apply the checkpointed slots last
    // so the materialized player is byte-for-byte equivalent to the Active.
    if (state.weapons && player.weapons && state.weapons.length === player.weapons.length) {
        for (let index = 0; index < state.weapons.length; index++) {
            const weapon = state.weapons[index]!;
            player.weaponManager.setWeapon(index, weapon.type, weapon.ammo);
            player.weapons[index]!.cooldown = weapon.cooldown;
            player.weapons[index]!.recoilTime = weapon.recoilTime ?? Infinity;
        }
        if (state.activeSlot !== undefined) player.weaponManager.setCurWeapIndex(state.activeSlot, true);
    }
    if (state.action) {
        player.actionType = state.action.type as Player["actionType"];
        player.actionSeq = state.action.seq;
        player.action = {
            time: state.action.time,
            duration: state.action.duration,
            targetId: state.action.targetSessionId === sessionId ? player.__id : state.action.targetId,
        };
        player.actionItem = state.action.item;
        if (state.action.targetSessionId && state.action.targetSessionId !== sessionId) {
            const targets = restoredActionTargets.get(game) ?? new Map<Player, string>();
            targets.set(player, state.action.targetSessionId);
            restoredActionTargets.set(game, targets);
        }
    }

    for (const [obstacle, refs] of restoredObstaclePlayerRefs.get(game) ?? []) {
        if (obstacle.destroyed) {
            restoredObstaclePlayerRefs.get(game)?.delete(obstacle);
            continue;
        }
        if (refs.interactedBySessionId === sessionId) {
            obstacle.interactedBy = player;
            refs.interactedBySessionId = undefined;
        }
        if (refs.delayedPlayerSessionId === sessionId) {
            obstacle.delayedDoorInteraction.player = player;
            refs.delayedPlayerSessionId = undefined;
        }
        if (refs.ownerSessionId === sessionId) {
            obstacle.ownerId = player.__id;
            refs.ownerSessionId = undefined;
        }
        if (refs.skinPlayerSessionId === sessionId) {
            obstacle.skinPlayerId = player.__id;
            refs.skinPlayerSessionId = undefined;
        }
        if (!Object.values(refs).some(Boolean)) restoredObstaclePlayerRefs.get(game)?.delete(obstacle);
    }
    for (const [loot, ownerSessionId] of restoredLootOwners.get(game) ?? []) {
        if (ownerSessionId !== sessionId || loot.destroyed) continue;
        loot.ownerId = player.__id;
        restoredLootOwners.get(game)?.delete(loot);
    }
    for (const [projectile, sourceSessionId] of restoredProjectileSources.get(game) ?? []) {
        if (sourceSessionId !== sessionId || projectile.destroyed) continue;
        projectile.playerId = player.__id;
        restoredProjectileSources.get(game)?.delete(projectile);
    }
    for (const [bullet, sourceSessionId] of restoredBulletSources.get(game) ?? []) {
        if (sourceSessionId !== sessionId || !bullet.active) continue;
        bullet.playerId = player.__id;
        bullet.player = player;
        restoredBulletSources.get(game)?.delete(bullet);
    }
    for (const [bullet, sessionIds] of restoredBulletDamagedPlayers.get(game) ?? []) {
        if (!bullet.active) {
            restoredBulletDamagedPlayers.get(game)?.delete(bullet);
            continue;
        }
        if (!sessionIds.delete(sessionId)) continue;
        bullet.damagedObjIds.add(player.__id);
        if (sessionIds.size === 0) restoredBulletDamagedPlayers.get(game)?.delete(bullet);
    }
    for (const [bullet, reflectedSessionId] of restoredBulletReflectPlayers.get(game) ?? []) {
        if (reflectedSessionId !== sessionId || !bullet.active) continue;
        bullet.reflectObjId = player.__id;
        restoredBulletReflectPlayers.get(game)?.delete(bullet);
    }
    for (const [explosion, sourceSessionId] of restoredExplosionSources.get(game) ?? []) {
        if (sourceSessionId !== sessionId) continue;
        const runtimeExplosion = explosion as Game["explosionBarn"]["explosions"][number];
        runtimeExplosion.damageParams.source = player;
        restoredExplosionSources.get(game)?.delete(explosion);
    }
    for (const [body, sourceSessionId] of restoredDeadBodySources.get(game) ?? []) {
        if (sourceSessionId !== sessionId) continue;
        (body as Game["deadBodyBarn"]["deadBodies"][number]).playerId = player.__id;
        restoredDeadBodySources.get(game)?.delete(body);
    }
    for (const [source, targetSessionId] of restoredActionTargets.get(game) ?? []) {
        if (targetSessionId !== sessionId) continue;
        source.action.targetId = player.__id;
        restoredActionTargets.get(game)?.delete(source);
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

export const lastProcessedGatewayInput = (game: Game, sessionId: string): number =>
    processedInputSequences.get(game)?.get(sessionId) ?? 0;

export const recordProcessedGatewayInput = (game: Game, sessionId: string, sequence: number): void => {
    if (!sessionId || !Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("gateway_input_sequence_invalid");
    }
    const sequences = processedInputSequences.get(game) ?? new Map<string, number>();
    processedInputSequences.set(game, sequences);
    const previous = sequences.get(sessionId) ?? 0;
    if (sequence > previous) sequences.set(sessionId, sequence);
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

export const makeOpsSnapshot = (
    game: Game,
    tickP95Ms: number,
    tickRate: number,
    snapshot: SnapshotWriterMetrics = {
        roomEpoch: 0,
        serverTick: 0,
        inflight: 0,
        pending: 0,
        payloadBytes: 0,
        writeDurationMs: 0,
        coalescedTotal: 0,
        failuresTotal: 0,
        timeoutsTotal: 0,
        consecutiveFailures: 0,
        circuitOpen: false,
        handoffEnabled: true,
        oldestPendingAgeMs: 0,
    },
): OpsiaSnapshot => {
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
        snapshot,
        loot: game.lootBarn.loots
            .filter((loot) => !loot.destroyed && loot.layer === 0)
            .map((loot) => ({
                id: loot.__id,
                type: loot.type,
                kind: GameObjectDefs.typeToDefSafe(loot.type)?.type ?? "other",
                x: loot.pos.x,
                y: loot.pos.y,
                count: loot.count,
            })),
        obstacles: game.map.obstacles
            .filter((obstacle) =>
                obstacle.layer === 0
                && !obstacle.dead
                && obstacle.collidable
                && !obstacle.isDoor
            )
            .map((obstacle) => {
                const definition = MapObjectDefs.typeToDefSafe(obstacle.type);
                const obstacleDefinition = definition?.type === "obstacle" ? definition : undefined;
                const kind = obstacle.isWall
                    ? "wall" as const
                    : obstacle.isTree
                    ? "tree" as const
                    : /rock|stone|boulder/i.test(obstacle.type)
                    ? "rock" as const
                    : "obstacle" as const;
                return {
                    id: obstacle.__id,
                    type: obstacle.type,
                    kind,
                    x: obstacle.pos.x + (obstacle.bounds.min.x + obstacle.bounds.max.x) / 2,
                    y: obstacle.pos.y + (obstacle.bounds.min.y + obstacle.bounds.max.y) / 2,
                    ...mapObjectSize(obstacle.bounds),
                    destructible: obstacle.destructible,
                    containsLoot: Boolean(
                        obstacleDefinition
                            && (
                                obstacleDefinition.loot.length > 0
                                || obstacleDefinition.smartLoot
                                || obstacleDefinition.obstacleType === "crate"
                            ),
                    ),
                    health: obstacle.health,
                };
            }),
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
            sodas: player.invManager.get("soda"),
            painkillers: player.invManager.get("painkiller"),
            boost: player.boost,
            downed: player.downed,
            activeSlot: player.curWeapIdx,
            primaryWeapon: player.weapons[0]?.type ?? "",
            primaryAmmo: player.weapons[0]?.ammo ?? 0,
            primaryReserve: weaponReserve(player, player.weapons[0]?.type ?? ""),
            secondaryWeapon: player.weapons[1]?.type ?? "",
            secondaryAmmo: player.weapons[1]?.ammo ?? 0,
            secondaryReserve: weaponReserve(player, player.weapons[1]?.type ?? ""),
            throwableWeapon: player.weapons[3]?.type ?? "",
            throwableCount: player.weapons[3]?.type
                ? player.invManager.get(player.weapons[3].type as InventoryItem)
                : 0,
            isBot: player.bot,
            indoors: player.indoors,
            connected: !player.disconnected,
        })),
    };
};

export class OpsiaSnapshotStore {
    private readonly configuredRole = opsiaRole();
    private role: OpsiaRuntimeRole = this.configuredRole === "active" ? "active" : "candidate";
    private roomEpoch = opsiaRoomEpoch();
    private readonly owner = process.env.OPSIA_LEASE_OWNER ?? `${process.env.POD_NAME ?? "game-0"}-${randomUUID()}`;
    private readonly snapshotKey = `room:${opsiaRoomId()}:snapshot`;
    private readonly leaseKey = `room:${opsiaRoomId()}:lease`;
    private client: RedisClientType | undefined;
    private journal: RoomStateJournal | undefined;
    private leaseTimer: NodeJS.Timeout | undefined;
    private ready = false;
    private pendingPlayers: LoosePlayerState[] = [];
    private pendingRestoreUntil = 0;
    private snapshotTick = 0;
    private loadedMapSeed: number | undefined;
    private lastJournalEnvelope: GameSnapshotEnvelope<LooseGameSnapshot> | undefined;
    private candidateLoader: CandidateStateLoader<LooseGameSnapshot> | undefined;
    private gameMapName: string | undefined;
    private candidateSeedInFlight: Promise<OpsiaHandoffStatusData> | undefined;
    private candidateStatus: OpsiaHandoffStatusData | undefined;
    private authorityChecksum: string | undefined;
    private readonly snapshotConfig: SnapshotRuntimeConfig;
    private readonly writer: BoundedSnapshotWriter<LooseGameSnapshot>;

    constructor() {
        this.snapshotConfig = readSnapshotRuntimeConfig();
        this.writer = new BoundedSnapshotWriter<LooseGameSnapshot>({
            config: this.snapshotConfig,
            write: (serialized, envelope) => this.persistEnvelope(serialized, envelope),
            onEvent: (subject, payload) => {
                const level = subject === "SnapshotSaveFailed" || subject === "SnapshotCircuitOpened"
                    ? "error"
                    : subject === "SnapshotBacklogDetected" || subject === "SnapshotSaveCoalesced"
                    ? "warn"
                    : "info";
                jsonLog(level, subject, payload);
            },
        });
    }

    async start(game: Game): Promise<boolean> {
        this.gameMapName = game.mapName;
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
            this.client = createClient({ url: redisUrl });
            this.client.on("error", (error) => jsonLog("error", "redis_error", { message: String(error) }));
            await this.client.connect();
        }
        let acquired = false;
        if (this.configuredRole === "auto") {
            try {
                await this.acquireLease();
                this.role = "active";
                acquired = true;
            } catch (error) {
                if (!(error instanceof Error) || error.message !== "room_lease_not_acquired") throw error;
                this.role = "candidate";
            }
        }
        if (this.role === "candidate") {
            this.journal = new RoomStateJournal({
                roomId: opsiaRoomId(),
                client: this.client,
                maxEntryBytes: Math.min(64 * 1024 * 1024, this.snapshotConfig.maxPayloadBytes + 64 * 1024),
            });
            this.candidateLoader = new CandidateStateLoader<LooseGameSnapshot>({
                roomId: opsiaRoomId(),
                mapName: game.mapName,
                maxPayloadBytes: this.snapshotConfig.maxPayloadBytes,
                readSnapshot: () => this.readSerializedSnapshot(),
                journal: this.journal,
            });
            const outcome = await this.candidateLoader.loadLatest(opsiaSourceEpoch());
            this.candidateStatus = outcome.status;
            this.authorityChecksum = outcome.status.checksum;
            if (outcome.envelope) {
                const stateChecksum = this.applyCandidateEnvelope(game, outcome.envelope);
                this.candidateStatus = { ...this.candidateStatus, stateChecksum };
            }
            this.ready = true;
            jsonLog(this.candidateStatus.ready ? "info" : "warn", "candidate_snapshot_loaded", {
                ...this.candidateStatus,
            });
            return this.candidateStatus.ready;
        }
        // A replacement pod can begin before its predecessor's lease
        // lease has naturally expired. Wait rather than serving concurrently
        // or giving up the actual Game process.
        for (let attempt = 0; attempt < 15; attempt++) {
            if (acquired) break;
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
        this.journal = new RoomStateJournal({
            roomId: opsiaRoomId(),
            client: this.client,
            lease: this.client ? { key: this.leaseKey, owner: this.owner } : undefined,
            maxEntryBytes: Math.min(64 * 1024 * 1024, this.snapshotConfig.maxPayloadBytes + 64 * 1024),
            memoryFence: () => this.hasMemoryLease(),
        });
        const snapshot = await this.load();
        if (snapshot) {
            const compatible = snapshot.schemaVersion === 4
                && snapshot.roomId === opsiaRoomId()
                && snapshot.mapName === game.mapName;
            if (compatible) {
                this.alignMapSeed(game, this.loadedMapSeed);
                restoreGame(game, snapshot);
                // `PlayerBarn` materializes a restored player only once its session
                // reconnects. Preserve these projections while the public gateway
                // keeps retrying, instead of a newly-empty Game overwriting Redis.
                this.pendingPlayers = snapshot.players;
                this.pendingRestoreUntil = Date.now() + 2 * 60_000;
                jsonLog("info", "snapshot_restored", { savedAt: snapshot.savedAt, players: snapshot.players.length });
            } else {
                this.lastJournalEnvelope = undefined;
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
        this.startLeaseRefresh();
        return true;
    }

    async save(game: Game, serverTick = 0): Promise<void> {
        if (this.role === "candidate") throw new Error("candidate_read_only");
        // A child Game begins ticking before `start()` has acquired its lease.
        // It must never publish that unowned empty state over the previous owner.
        if (!this.ready) return;
        const normalizedServerTick = Math.max(0, Math.trunc(serverTick));
        const result = await this.writer.request(() => {
            const snapshot = serializeGame(game);
            const liveSessions = new Set(snapshot.players.map((player) => player.sessionId));
            if (Date.now() < this.pendingRestoreUntil) {
                this.pendingPlayers = this.pendingPlayers.filter((player) => !liveSessions.has(player.sessionId));
                snapshot.players.push(...this.pendingPlayers);
            } else {
                this.pendingPlayers = [];
            }
            if (this.pendingPlayers.length > 0) {
                snapshot.players.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
                snapshot.stateChecksum = materialStateChecksum(
                    snapshot.roomId,
                    snapshot.mapName,
                    snapshot.mapSeed,
                    snapshot.world,
                    snapshot.players,
                );
            }
            this.snapshotTick = Math.max(this.snapshotTick + 1, normalizedServerTick);
            return {
                context: {
                    roomId: opsiaRoomId(),
                    roomEpoch: this.roomEpoch,
                    serverTick: normalizedServerTick,
                    snapshotTick: this.snapshotTick,
                    gameBuildRevision: process.env.OPSIA_GAME_BUILD_REVISION
                        ?? process.env.GIT_REVISION
                        ?? "unavailable",
                    // Lightweight recovery tests and future non-world control
                    // games may not materialize a GameMap. Zero is the explicit
                    // unavailable seed and remains covered by the checksum.
                    mapSeed: game.map?.seed ?? 0,
                },
                payload: snapshot,
            };
        });
        if (result.status !== "saved") throw new Error(result.error ?? `snapshot_${result.status}`);
        jsonLog("info", "snapshot_saved", {
            players: game.playerBarn.players.length,
            checksum: result.checksum,
            payloadBytes: result.payloadBytes,
        });
    }

    snapshotMetrics(): SnapshotWriterMetrics {
        const metrics = this.writer.metrics();
        if (this.role !== "candidate") return metrics;
        const status = this.candidateStatus;
        return {
            ...metrics,
            roomEpoch: status?.roomEpoch ?? 0,
            serverTick: status?.serverTick ?? 0,
            circuitOpen: false,
            handoffEnabled: status?.ready === true,
            lastChecksum: status?.checksum,
            lastError: status?.reason,
        };
    }

    canWriteSnapshots(): boolean {
        return this.role === "active";
    }

    /**
     * Gameplay input is authoritative only for the epoch currently owned by
     * this runtime. The Gateway's signed upgrade metadata is necessary, but
     * never sufficient: a previously valid socket becomes stale immediately
     * when this process releases its lease or another epoch is promoted.
     */
    acceptsGatewayInput(roomEpoch: number): boolean {
        return Number.isSafeInteger(roomEpoch)
            && this.ready
            && this.role === "active"
            && this.roomEpoch === roomEpoch
            && (this.client ? this.client.isOpen : this.hasMemoryLease());
    }

    handoffStatus(): OpsiaHandoffStatusData {
        if (this.role === "candidate") {
            return this.candidateStatus ?? {
                role: "candidate",
                roomId: opsiaRoomId(),
                ready: false,
                phase: "waiting_snapshot",
                reason: "candidate_not_started",
                observedAt: Date.now(),
            };
        }
        const metrics = this.writer.metrics();
        const ready = this.ready && metrics.handoffEnabled;
        return {
            role: "active",
            roomId: opsiaRoomId(),
            ready,
            phase: ready ? "active" : "blocked",
            roomEpoch: this.roomEpoch,
            serverTick: metrics.serverTick,
            checksum: metrics.lastChecksum ?? this.authorityChecksum,
            caughtUp: ready,
            reason: ready ? undefined : metrics.lastError ?? "snapshot_handoff_disabled",
            observedAt: Date.now(),
        };
    }

    seedCandidate(game: Game, request: CandidateSeedRequest): Promise<OpsiaHandoffStatusData> {
        if (this.role !== "candidate") return Promise.reject(new Error("candidate_role_required"));
        if (!this.candidateLoader) return Promise.reject(new Error("candidate_not_started"));
        if (this.candidateSeedInFlight) return this.candidateSeedInFlight;
        this.candidateSeedInFlight = (async () => {
            const outcome = await this.candidateLoader!.seed(request);
            let stateChecksum: string | undefined;
            if (outcome.envelope) {
                try {
                    stateChecksum = this.applyCandidateEnvelope(game, outcome.envelope);
                } catch (error) {
                    this.candidateStatus = {
                        ...outcome.status,
                        ready: false,
                        phase: "blocked",
                        caughtUp: false,
                        reason: error instanceof Error ? error.message : "candidate_projection_apply_failed",
                        observedAt: Date.now(),
                    };
                    return this.candidateStatus;
                }
            }
            this.candidateStatus = { ...outcome.status, stateChecksum };
            this.authorityChecksum = outcome.status.checksum;
            jsonLog(this.candidateStatus.ready ? "info" : "warn", "candidate_seed_evaluated", {
                ...this.candidateStatus,
            });
            return this.candidateStatus;
        })().finally(() => {
            this.candidateSeedInFlight = undefined;
        });
        return this.candidateSeedInFlight;
    }

    async releaseActiveForHandoff(request: ActiveReleaseRequest): Promise<OpsiaHandoffStatusData> {
        if (this.role !== "active") throw new Error("active_role_required");
        if (
            !Number.isSafeInteger(request.expectedEpoch)
            || request.expectedEpoch !== this.roomEpoch
            || !/^[a-f\d]{64}$/.test(request.expectedChecksum)
        ) throw new Error("authority_release_precondition_failed");
        if (!this.gameMapName) throw new Error("candidate_map_unavailable");
        const beforeFlush = this.writer.metrics();
        const currentChecksum = beforeFlush.lastChecksum ?? this.authorityChecksum;
        if (!currentChecksum || currentChecksum !== request.expectedChecksum) {
            throw new Error("authority_release_checksum_conflict");
        }
        await this.writer.flush();
        const metrics = this.writer.metrics();
        // A checkpoint already in flight at the precondition check may finish
        // during flush. That newer, lease-owned checksum is the only permitted
        // divergence and is returned so the Candidate can perform one final
        // seed before promotion.
        this.authorityChecksum = metrics.lastChecksum ?? currentChecksum;
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.leaseTimer = undefined;
        await this.releaseLeaseOnly();
        this.role = "candidate";
        this.journal = new RoomStateJournal({
            roomId: opsiaRoomId(),
            client: this.client,
            maxEntryBytes: Math.min(64 * 1024 * 1024, this.snapshotConfig.maxPayloadBytes + 64 * 1024),
        });
        // A former Active is the rollback target. It must be able to load the
        // new authority's latest full checkpoint before it may reacquire a
        // higher epoch; merely retaining its pre-cutover in-memory state is
        // stale as soon as the Candidate advances the simulation.
        this.candidateLoader = new CandidateStateLoader<LooseGameSnapshot>({
            roomId: opsiaRoomId(),
            mapName: this.gameMapName,
            maxPayloadBytes: this.snapshotConfig.maxPayloadBytes,
            readSnapshot: () => this.readSerializedSnapshot(),
            journal: this.journal,
        });
        this.candidateStatus = {
            role: "candidate",
            roomId: opsiaRoomId(),
            ready: true,
            phase: "seeded",
            roomEpoch: this.roomEpoch,
            serverTick: metrics.serverTick,
            snapshotTick: metrics.serverTick,
            checksum: this.authorityChecksum,
            caughtUp: true,
            observedAt: Date.now(),
        };
        jsonLog("info", "room_authority_released", {
            roomEpoch: this.roomEpoch,
            checksum: this.authorityChecksum,
        });
        return this.candidateStatus;
    }

    async promoteCandidate(request: CandidatePromoteRequest): Promise<OpsiaHandoffStatusData> {
        if (this.role !== "candidate") throw new Error("candidate_role_required");
        if (
            !Number.isSafeInteger(request.expectedEpoch)
            || !Number.isSafeInteger(request.nextEpoch)
            || request.nextEpoch !== request.expectedEpoch + 1
            || !/^[a-f\d]{64}$/.test(request.expectedChecksum)
            || !this.candidateStatus?.ready
            || this.candidateStatus.checksum !== request.expectedChecksum
        ) throw new Error("candidate_promotion_precondition_failed");
        this.roomEpoch = request.nextEpoch;
        try {
            await this.acquireLease();
        } catch (error) {
            this.roomEpoch = this.candidateStatus.roomEpoch ?? request.expectedEpoch;
            throw error;
        }
        this.role = "active";
        this.authorityChecksum = request.expectedChecksum;
        this.journal = new RoomStateJournal({
            roomId: opsiaRoomId(),
            client: this.client,
            lease: this.client ? { key: this.leaseKey, owner: this.owner } : undefined,
            maxEntryBytes: Math.min(64 * 1024 * 1024, this.snapshotConfig.maxPayloadBytes + 64 * 1024),
            memoryFence: () => this.hasMemoryLease(),
        });
        this.startLeaseRefresh();
        this.candidateStatus = undefined;
        this.ready = true;
        jsonLog("info", "room_authority_promoted", {
            roomEpoch: this.roomEpoch,
            checksum: this.authorityChecksum,
        });
        return this.handoffStatus();
    }

    private async persistEnvelope(
        serialized: string,
        _envelope: GameSnapshotEnvelope<LooseGameSnapshot>,
    ): Promise<void> {
        if (this.client) {
            // A stopped StatefulSet ordinal can remain offline for longer than a
            // minute. Keep the latest acknowledged projection until an explicit
            // room reset/delete clears it.
            const saved = await this.client.eval(saveSnapshotScript, {
                keys: [this.leaseKey, this.snapshotKey],
                arguments: [this.owner, serialized],
            });
            if (Number(saved) !== 1) throw new Error("room_lease_lost");
        } else {
            if (!this.hasMemoryLease()) throw new Error("room_lease_lost");
            memorySnapshots.set(this.snapshotKey, serialized);
        }
        const persistedEnvelope = parseSnapshotEnvelope<LooseGameSnapshot>(serialized, {
            roomId: opsiaRoomId(),
            maxPayloadBytes: this.snapshotConfig.maxPayloadBytes,
        });
        const base = this.lastJournalEnvelope;
        if (
            base
            && base.roomEpoch === persistedEnvelope.roomEpoch
            && persistedEnvelope.serverTick > base.serverTick
        ) {
            const delta = createSnapshotEnvelopeDelta(base, persistedEnvelope);
            const deltaBytes = Buffer.byteLength(JSON.stringify(delta), "utf8");
            if (deltaBytes <= this.snapshotConfig.maxPayloadBytes) {
                await this.journal?.append({
                    roomEpoch: persistedEnvelope.roomEpoch,
                    serverTick: persistedEnvelope.serverTick,
                    eventType: "state-delta",
                    payload: delta,
                });
            } else {
                // Redis already contains the complete latest seed. Do not turn a
                // pathological mutation into another full journal checkpoint;
                // a Candidate will re-read the seed on its next bounded attempt.
                jsonLog("warn", "SnapshotDeltaSkipped", {
                    roomEpoch: persistedEnvelope.roomEpoch,
                    serverTick: persistedEnvelope.serverTick,
                    deltaBytes,
                    maxDeltaBytes: this.snapshotConfig.maxPayloadBytes,
                });
            }
        }
        this.lastJournalEnvelope = persistedEnvelope;
    }

    async stop(): Promise<void> {
        this.ready = false;
        await this.writer.flush();
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.leaseTimer = undefined;
        if (this.client?.isOpen) {
            if (this.role === "active") await this.releaseLeaseOnly();
            await this.client.quit();
            return;
        }
        if (this.role === "active") await this.releaseLeaseOnly();
    }

    /** A console-requested logical room reset discards only this room's game
     * projection. Pod replacement never calls this method. */
    async clearSnapshot(): Promise<void> {
        if (this.role === "candidate") throw new Error("candidate_read_only");
        await this.writer.flush();
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
        await this.journal?.clear();
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

    private startLeaseRefresh(): void {
        if (this.leaseTimer) clearInterval(this.leaseTimer);
        this.leaseTimer = setInterval(() => {
            void this.refreshLease().catch((error) => {
                jsonLog("error", "room_lease_refresh_failed", { message: String(error) });
                process.exit(1);
            });
        }, leaseRefreshMs);
    }

    private async releaseLeaseOnly(): Promise<void> {
        if (this.client?.isOpen) {
            await this.client.eval(releaseLeaseScript, {
                keys: [this.leaseKey],
                arguments: [this.owner],
            });
            return;
        }
        if (this.client) throw new Error("room_lease_lost");
        const current = memoryLeases.get(this.leaseKey);
        if (current?.owner === this.owner) memoryLeases.delete(this.leaseKey);
    }

    private hasMemoryLease(): boolean {
        const lease = memoryLeases.get(this.leaseKey);
        return Boolean(lease && lease.owner === this.owner && lease.expiresAt > Date.now());
    }

    private applyCandidateEnvelope(game: Game, envelope: GameSnapshotEnvelope<LooseGameSnapshot>): string {
        if (game.playerBarn.players.some((player) => !player.disconnected)) {
            throw new Error("candidate_sessions_already_attached");
        }
        this.alignMapSeed(game, envelope.mapSeed);
        const stateChecksum = restoreGame(game, envelope.payload);
        this.snapshotTick = envelope.snapshotTick;
        this.lastJournalEnvelope = envelope;
        return stateChecksum;
    }

    private alignMapSeed(game: Game, mapSeed: number | undefined): void {
        // Zero is the explicit unavailable value used by lightweight control
        // tests. Real Survev snapshots must regenerate the Candidate's map from
        // the Active seed before any player or world projection is restored.
        if (mapSeed === undefined || mapSeed === 0) return;
        if (!Number.isSafeInteger(mapSeed) || mapSeed < 0) throw new Error("invalid_snapshot_map_seed");
        if (!game.map || game.map.seed === mapSeed) return;
        if (typeof game.map.regenerate !== "function") throw new Error("map_seed_restore_unsupported");
        game.map.regenerate(mapSeed);
        if (game.map.seed !== mapSeed) throw new Error("map_seed_restore_failed");
    }

    private async readSerializedSnapshot(): Promise<string | undefined> {
        const text = this.client ? await this.client.get(this.snapshotKey) : undefined;
        return text ?? memorySnapshots.get(this.snapshotKey);
    }

    private async load(): Promise<LooseGameSnapshot | undefined> {
        this.loadedMapSeed = undefined;
        const serialized = await this.readSerializedSnapshot();
        if (!serialized) return undefined;
        let parsed: unknown;
        try {
            parsed = JSON.parse(serialized);
        } catch {
            throw new Error("invalid_snapshot_json");
        }
        if (
            typeof parsed === "object"
            && parsed !== null
            && "kind" in parsed
            && parsed.kind === "opsia.game-snapshot"
        ) {
            const envelope = parseSnapshotEnvelope<LooseGameSnapshot>(serialized, {
                roomId: opsiaRoomId(),
                maxPayloadBytes: this.snapshotConfig.maxPayloadBytes,
            });
            this.loadedMapSeed = envelope.mapSeed;
            this.snapshotTick = envelope.snapshotTick;
            this.lastJournalEnvelope = envelope;
            return envelope.payload;
        }
        // One-release compatibility path for snapshots written before the
        // checksum envelope existed. The next successful save upgrades it.
        return parsed as LooseGameSnapshot;
    }
}

export const resetRestoredPlayers = (game: Game): void => {
    restoredPlayers.delete(game);
    restoredObstaclePlayerRefs.delete(game);
    restoredLootOwners.delete(game);
    restoredProjectileSources.delete(game);
    restoredBulletSources.delete(game);
    restoredBulletDamagedPlayers.delete(game);
    restoredBulletReflectPlayers.delete(game);
    restoredExplosionSources.delete(game);
    restoredDeadBodySources.delete(game);
    restoredActionTargets.delete(game);
    processedInputSequences.delete(game);
    inputWindows.delete(game);
    inputCounters.delete(game);
    // Keep snapshot storage intact: logical reset is deliberate and handled by
    // an explicit room control endpoint, never by a pod replacement.
};
