import { GameObjectDefs } from "../../../shared/defs/register.ts";

export interface BotBrainPlayer {
    sessionId: string;
    teamId: number;
    team: "red" | "blue";
    x: number;
    y: number;
    vx: number;
    vy: number;
    alive: boolean;
    connected: boolean;
    health: number;
    armor: number;
    weapon: string;
    ammo: number;
    bandages?: number;
    healthkits?: number;
    sodas?: number;
    painkillers?: number;
    boost?: number;
    downed?: boolean;
    activeSlot?: number;
    primaryWeapon?: string;
    primaryAmmo?: number;
    primaryReserve?: number;
    secondaryWeapon?: string;
    secondaryAmmo?: number;
    secondaryReserve?: number;
    throwableWeapon?: string;
    throwableCount?: number;
    isBot?: boolean;
}

export interface BotBrainSnapshot {
    capturedAt: number;
    map: {
        width: number;
        height: number;
        objects?: BotBrainMapObstacle[];
        navigation?: BotBrainMapObstacle[];
    };
    zone: {
        x: number;
        y: number;
        radius: number;
        nextX: number;
        nextY: number;
        nextRadius: number;
    };
    loot?: BotBrainLoot[];
    players: BotBrainPlayer[];
}

export interface BotBrainMapObstacle {
    id: number;
    kind?: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface BotBrainLoot {
    id: number;
    type: string;
    kind: string;
    x: number;
    y: number;
    count: number;
}

export type BotIntentMode = "wander" | "loot" | "hunt" | "combat" | "flank" | "retreat" | "rescue" | "downed" | "grenade" | "zone" | "edge" | "unstuck" | "heal";
export type BotEquipIntent = "otherGun" | "primary" | "secondary" | "throwable" | "lastWeapon";
export type BotUseItemIntent = "bandage" | "healthkit" | "soda" | "painkiller";
export type BotMovementPhase = "travel" | "rest";
export type BotGrenadePhase = "idle" | "equip" | "cook" | "release" | "recover";

export interface BotBrainState {
    wanderAngle: number;
    decisionUntil: number;
    strafeSign: -1 | 1;
    movementPhase: BotMovementPhase;
    movementPhaseUntil: number;
    lastMovementCommanded: boolean;
    lastSnapshotAt: number;
    lastX?: number;
    lastY?: number;
    stuckSamples: number;
    unstuckUntil: number;
    nextInteractAt: number;
    targetSessionId?: string;
    targetLockedUntil: number;
    targetLootId?: number;
    lootLockedUntil: number;
    nextStrafeFlipAt: number;
    emptyAmmoWeapon?: string;
    emptyAmmoSince: number;
    nextReloadAt: number;
    nextWeaponSwapAt: number;
    healingUntil: number;
    nextHealAt: number;
    avoidanceSign: -1 | 1;
    avoidanceUntil: number;
    lastHealth?: number;
    underFireUntil: number;
    flankTargetSessionId?: string;
    flankX?: number;
    flankY?: number;
    flankUntil: number;
    nextWeaponEvaluationAt: number;
    nextBurstAt: number;
    burstUntil: number;
    nextCombatFeintAt: number;
    combatFeintAngle: number;
    grenadePhase: BotGrenadePhase;
    grenadeCookUntil: number;
    grenadeCooldownUntil: number;
    grenadeTargetSessionId?: string;
}

export interface BotIntent {
    mode: BotIntentMode;
    moving: boolean;
    moveAngle: number;
    aimAngle: number;
    aimDistance: number;
    shoot: boolean;
    interact: boolean;
    reload: boolean;
    equip?: BotEquipIntent;
    useItem?: BotUseItemIntent;
    forceShootStart?: boolean;
}

type BotIntentWithoutMovement = Omit<BotIntent, "moving">;
type MovementPolicy = "rhythm" | "force" | "stop";
type Target = { player: BotBrainPlayer; distance: number };
type LootTarget = { loot: BotBrainLoot; distance: number; utility: number };
type WeaponProfile = {
    kind: "gun" | "melee" | "other";
    effectiveRange: number;
    preferredRange: number;
    projectileSpeed: number;
    powerScore: number;
    maxClip: number;
};

const snapshotFreshnessMs = 2_000;
const targetLockMinMs = 1_000;
const targetLockJitterMs = 800;
const meleeAttackDistance = 5.5;
const combatAwarenessDistance = 900;

const distance = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

const angleTo = (ax: number, ay: number, bx: number, by: number): number => Math.atan2(by - ay, bx - ax);

const navigationCellSize = 64;
const navigationIndexPadding = 2.4;
const maxIndexedCellsPerObstacle = 256;

interface NavigationObstacleEntry {
    obstacle: BotBrainMapObstacle;
    order: number;
}

interface NavigationSpatialIndex {
    entries: NavigationObstacleEntry[];
    cells: Map<string, NavigationObstacleEntry[]>;
    unindexed: NavigationObstacleEntry[];
}

const navigationIndexCache = new WeakMap<BotBrainSnapshot, NavigationSpatialIndex>();

const navigationCellKey = (cellX: number, cellY: number): string => `${cellX}:${cellY}`;

const navigationObstacles = (snapshot: BotBrainSnapshot): BotBrainMapObstacle[] => {
    const authoritativeWalls = snapshot.map.navigation ?? [];
    if (authoritativeWalls.length > 0) return authoritativeWalls;
    return (snapshot.map.objects ?? []).filter(
        (object) => object.kind === "building" || object.kind === "structure",
    );
};

const navigationSpatialIndex = (snapshot: BotBrainSnapshot): NavigationSpatialIndex => {
    const cached = navigationIndexCache.get(snapshot);
    if (cached) return cached;

    const entries = navigationObstacles(snapshot).map((obstacle, order) => ({ obstacle, order }));
    const cells = new Map<string, NavigationObstacleEntry[]>();
    const unindexed: NavigationObstacleEntry[] = [];
    for (const entry of entries) {
        const { obstacle } = entry;
        const minX = obstacle.x - obstacle.width / 2 - navigationIndexPadding;
        const maxX = obstacle.x + obstacle.width / 2 + navigationIndexPadding;
        const minY = obstacle.y - obstacle.height / 2 - navigationIndexPadding;
        const maxY = obstacle.y + obstacle.height / 2 + navigationIndexPadding;
        if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
            unindexed.push(entry);
            continue;
        }

        const startCellX = Math.floor(Math.min(minX, maxX) / navigationCellSize);
        const endCellX = Math.floor(Math.max(minX, maxX) / navigationCellSize);
        const startCellY = Math.floor(Math.min(minY, maxY) / navigationCellSize);
        const endCellY = Math.floor(Math.max(minY, maxY) / navigationCellSize);
        const coveredCellCount = (endCellX - startCellX + 1) * (endCellY - startCellY + 1);
        if (coveredCellCount > maxIndexedCellsPerObstacle) {
            unindexed.push(entry);
            continue;
        }

        for (let cellX = startCellX; cellX <= endCellX; cellX++) {
            for (let cellY = startCellY; cellY <= endCellY; cellY++) {
                const key = navigationCellKey(cellX, cellY);
                const bucket = cells.get(key);
                if (bucket) bucket.push(entry);
                else cells.set(key, [entry]);
            }
        }
    }

    const index = { entries, cells, unindexed };
    navigationIndexCache.set(snapshot, index);
    return index;
};

const navigationEntriesAtPoint = (
    snapshot: BotBrainSnapshot,
    x: number,
    y: number,
): NavigationObstacleEntry[] => {
    const index = navigationSpatialIndex(snapshot);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return index.entries;
    const bucket = index.cells.get(navigationCellKey(
        Math.floor(x / navigationCellSize),
        Math.floor(y / navigationCellSize),
    )) ?? [];
    if (index.unindexed.length === 0) return bucket;
    return [...bucket, ...index.unindexed].sort((left, right) => left.order - right.order);
};

const navigationEntriesAlongSegment = (
    snapshot: BotBrainSnapshot,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): NavigationObstacleEntry[] => {
    const index = navigationSpatialIndex(snapshot);
    if (![ax, ay, bx, by].every(Number.isFinite)) return index.entries;

    const candidates = new Map<number, NavigationObstacleEntry>();
    const addCell = (cellX: number, cellY: number): void => {
        for (const entry of index.cells.get(navigationCellKey(cellX, cellY)) ?? []) {
            candidates.set(entry.order, entry);
        }
    };
    for (const entry of index.unindexed) candidates.set(entry.order, entry);

    let cellX = Math.floor(ax / navigationCellSize);
    let cellY = Math.floor(ay / navigationCellSize);
    const endCellX = Math.floor(bx / navigationCellSize);
    const endCellY = Math.floor(by / navigationCellSize);
    const dx = bx - ax;
    const dy = by - ay;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : navigationCellSize / Math.abs(dx);
    const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : navigationCellSize / Math.abs(dy);
    let tMaxX = stepX === 0
        ? Number.POSITIVE_INFINITY
        : ((stepX > 0 ? cellX + 1 : cellX) * navigationCellSize - ax) / dx;
    let tMaxY = stepY === 0
        ? Number.POSITIVE_INFINITY
        : ((stepY > 0 ? cellY + 1 : cellY) * navigationCellSize - ay) / dy;

    addCell(cellX, cellY);
    while (cellX !== endCellX || cellY !== endCellY) {
        if (Math.abs(tMaxX - tMaxY) <= 1e-12) {
            addCell(cellX + stepX, cellY);
            addCell(cellX, cellY + stepY);
            cellX += stepX;
            cellY += stepY;
            tMaxX += tDeltaX;
            tMaxY += tDeltaY;
        } else if (tMaxX < tMaxY) {
            cellX += stepX;
            tMaxX += tDeltaX;
        } else {
            cellY += stepY;
            tMaxY += tDeltaY;
        }
        addCell(cellX, cellY);
    }

    return [...candidates.values()].sort((left, right) => left.order - right.order);
};

const insideObstacle = (
    x: number,
    y: number,
    obstacle: BotBrainMapObstacle,
    padding = 0,
): boolean => x >= obstacle.x - obstacle.width / 2 - padding
    && x <= obstacle.x + obstacle.width / 2 + padding
    && y >= obstacle.y - obstacle.height / 2 - padding
    && y <= obstacle.y + obstacle.height / 2 + padding;

const rayClearance = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    angle: number,
    maxDistance = 52,
): number => {
    for (let travelled = 4; travelled <= maxDistance; travelled += 4) {
        const x = self.x + Math.cos(angle) * travelled;
        const y = self.y + Math.sin(angle) * travelled;
        for (const { obstacle } of navigationEntriesAtPoint(snapshot, x, y)) {
            // Root building bounds contain rooms and doors. Once inside one,
            // only its real wall colliders should steer the bot.
            if (insideObstacle(self.x, self.y, obstacle)) continue;
            if (insideObstacle(x, y, obstacle, 2.4)) return travelled;
        }
    }
    return maxDistance;
};

const steerAroundWalls = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    desiredAngle: number,
    now: number,
): number => {
    const lookAhead = 52;
    if (rayClearance(snapshot, self, desiredAngle, lookAhead) >= lookAhead) {
        if (now >= state.avoidanceUntil) return desiredAngle;
        return desiredAngle + state.avoidanceSign * Math.PI * 0.18;
    }

    if (now >= state.avoidanceUntil) {
        const left = Math.max(
            rayClearance(snapshot, self, desiredAngle - Math.PI / 3, lookAhead),
            rayClearance(snapshot, self, desiredAngle - Math.PI / 2, lookAhead),
        );
        const right = Math.max(
            rayClearance(snapshot, self, desiredAngle + Math.PI / 3, lookAhead),
            rayClearance(snapshot, self, desiredAngle + Math.PI / 2, lookAhead),
        );
        state.avoidanceSign = left > right ? -1 : right > left ? 1 : state.avoidanceSign;
    }
    state.avoidanceUntil = now + 850;
    return desiredAngle + state.avoidanceSign * Math.PI / 2;
};

const segmentHitsObstacle = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    obstacle: BotBrainMapObstacle,
): boolean => {
    if (insideObstacle(ax, ay, obstacle)) return false;
    const minX = obstacle.x - obstacle.width / 2 - 0.35;
    const maxX = obstacle.x + obstacle.width / 2 + 0.35;
    const minY = obstacle.y - obstacle.height / 2 - 0.35;
    const maxY = obstacle.y + obstacle.height / 2 + 0.35;
    const dx = bx - ax;
    const dy = by - ay;
    let low = 0;
    let high = 1;
    for (const [origin, delta, min, max] of [
        [ax, dx, minX, maxX],
        [ay, dy, minY, maxY],
    ] as const) {
        if (Math.abs(delta) < 1e-6) {
            if (origin < min || origin > max) return false;
            continue;
        }
        const first = (min - origin) / delta;
        const second = (max - origin) / delta;
        low = Math.max(low, Math.min(first, second));
        high = Math.min(high, Math.max(first, second));
        if (low > high) return false;
    }
    return high >= 0 && low <= 1;
};

const hasClearShot = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    target: BotBrainPlayer,
): boolean =>
    !navigationEntriesAlongSegment(snapshot, self.x, self.y, target.x, target.y).some(
        ({ obstacle }) => segmentHitsObstacle(self.x, self.y, target.x, target.y, obstacle),
    );

const segmentIsClear = (
    snapshot: BotBrainSnapshot,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): boolean =>
    !navigationEntriesAlongSegment(snapshot, ax, ay, bx, by).some(
        ({ obstacle }) => segmentHitsObstacle(ax, ay, bx, by, obstacle),
    );

const firstBlockingObstacle = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    target: BotBrainPlayer,
): BotBrainMapObstacle | undefined =>
    navigationEntriesAlongSegment(snapshot, self.x, self.y, target.x, target.y)
        .map(({ obstacle }) => obstacle)
        .filter((obstacle) => segmentHitsObstacle(self.x, self.y, target.x, target.y, obstacle))
        .sort((left, right) =>
            distance(self.x, self.y, left.x, left.y) - distance(self.x, self.y, right.x, right.y)
        )[0];

const selectFlankWaypoint = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    target: BotBrainPlayer,
    state: BotBrainState,
    now: number,
): { x: number; y: number } | undefined => {
    if (
        state.flankTargetSessionId === target.sessionId
        && now < state.flankUntil
        && state.flankX !== undefined
        && state.flankY !== undefined
        && distance(self.x, self.y, state.flankX, state.flankY) > 7
        && segmentIsClear(snapshot, self.x, self.y, state.flankX, state.flankY)
    ) {
        return { x: state.flankX, y: state.flankY };
    }

    const blocker = firstBlockingObstacle(snapshot, self, target);
    if (!blocker) {
        state.flankTargetSessionId = undefined;
        state.flankX = undefined;
        state.flankY = undefined;
        state.flankUntil = 0;
        return undefined;
    }

    const padding = 8;
    const minX = blocker.x - blocker.width / 2 - padding;
    const maxX = blocker.x + blocker.width / 2 + padding;
    const minY = blocker.y - blocker.height / 2 - padding;
    const maxY = blocker.y + blocker.height / 2 + padding;
    const directX = target.x - self.x;
    const directY = target.y - self.y;
    const candidates = [
        { x: minX, y: minY },
        { x: minX, y: maxY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
    ]
        .filter((candidate) =>
            candidate.x > 8
            && candidate.y > 8
            && candidate.x < snapshot.map.width - 8
            && candidate.y < snapshot.map.height - 8
            && segmentIsClear(snapshot, self.x, self.y, candidate.x, candidate.y)
        )
        .map((candidate) => {
            const side = Math.sign(directX * (candidate.y - self.y) - directY * (candidate.x - self.x));
            const sidePenalty = side !== 0 && side !== state.avoidanceSign ? 18 : 0;
            const exposesTarget = segmentIsClear(snapshot, candidate.x, candidate.y, target.x, target.y);
            const score = distance(self.x, self.y, candidate.x, candidate.y)
                + distance(candidate.x, candidate.y, target.x, target.y) * 0.45
                + sidePenalty
                - (exposesTarget ? 90 : 0);
            return { ...candidate, score };
        })
        .sort((left, right) => left.score - right.score);
    const waypoint = candidates[0];
    if (!waypoint) return undefined;
    state.flankTargetSessionId = target.sessionId;
    state.flankX = waypoint.x;
    state.flankY = waypoint.y;
    state.flankUntil = now + 1_500;
    return waypoint;
};

const aimDistance = (target: Target | undefined, fallback = 48): number =>
    target ? Math.min(64, Math.max(30, target.distance)) : fallback;

export const createBotBrainState = (random: () => number = Math.random): BotBrainState => ({
    wanderAngle: random() * Math.PI * 2,
    decisionUntil: 0,
    strafeSign: random() < 0.5 ? -1 : 1,
    movementPhase: random() < 0.2 ? "rest" : "travel",
    movementPhaseUntil: 0,
    lastMovementCommanded: false,
    lastSnapshotAt: 0,
    stuckSamples: 0,
    unstuckUntil: 0,
    nextInteractAt: 0,
    targetLockedUntil: 0,
    lootLockedUntil: 0,
    nextStrafeFlipAt: 0,
    emptyAmmoSince: 0,
    nextReloadAt: 0,
    nextWeaponSwapAt: 0,
    healingUntil: 0,
    nextHealAt: 0,
    avoidanceSign: random() < 0.5 ? -1 : 1,
    avoidanceUntil: 0,
    underFireUntil: 0,
    flankUntil: 0,
    nextWeaponEvaluationAt: 0,
    nextBurstAt: 0,
    burstUntil: 0,
    nextCombatFeintAt: 0,
    combatFeintAngle: 0,
    grenadePhase: "idle",
    grenadeCookUntil: 0,
    grenadeCooldownUntil: 0,
});

const periodicActions = (
    state: BotBrainState,
    now: number,
    random: () => number,
): Pick<BotIntent, "interact" | "reload"> => {
    const interact = now >= state.nextInteractAt;
    if (interact) state.nextInteractAt = now + 420 + random() * 380;
    return { interact, reload: false };
};

const movementPhaseDuration = (
    mode: BotIntentMode,
    phase: BotMovementPhase,
    random: () => number,
): number => {
    if (mode === "combat") {
        return phase === "travel" ? 650 + random() * 600 : 450 + random() * 500;
    }
    if (mode === "zone" || mode === "edge") {
        return phase === "travel" ? 1_300 + random() * 800 : 250 + random() * 300;
    }
    if (mode === "hunt") {
        return phase === "travel" ? 2_100 + random() * 1_200 : 180 + random() * 260;
    }
    return phase === "travel" ? 1_000 + random() * 900 : 650 + random() * 700;
};

const rhythmicMovement = (
    state: BotBrainState,
    mode: BotIntentMode,
    now: number,
    random: () => number,
): boolean => {
    if (state.movementPhaseUntil <= 0) {
        state.movementPhaseUntil = now + movementPhaseDuration(mode, state.movementPhase, random);
    } else if (now >= state.movementPhaseUntil) {
        state.movementPhase = state.movementPhase === "travel" ? "rest" : "travel";
        state.movementPhaseUntil = now + movementPhaseDuration(mode, state.movementPhase, random);
    }
    return state.movementPhase === "travel";
};

const finishIntent = (
    state: BotBrainState,
    intent: BotIntentWithoutMovement,
    policy: MovementPolicy,
    now: number,
    random: () => number,
): BotIntent => {
    const moving = policy === "force"
        ? true
        : policy === "stop"
        ? false
        : rhythmicMovement(state, intent.mode, now, random);
    state.lastMovementCommanded = moving;
    return { ...intent, moving };
};

const weaponKind = (weapon: string): "gun" | "melee" | "other" => {
    const definition = GameObjectDefs.typeToDefSafe(weapon);
    if (definition?.type === "gun") return "gun";
    if (definition?.type === "melee" || weapon === "fists") return "melee";
    return "other";
};

const weaponProfile = (weapon: string): WeaponProfile => {
    const definition = GameObjectDefs.typeToDefSafe(weapon);
    if (definition?.type === "gun") {
        const bullet = GameObjectDefs.typeToDefSafe(definition.bulletType);
        const bulletDistance = bullet?.type === "bullet" ? bullet.distance : 100;
        const projectileSpeed = bullet?.type === "bullet" ? bullet.speed : 85;
        const bulletDamage = bullet?.type === "bullet" ? bullet.damage : 10;
        const effectiveRange = Math.min(360, Math.max(18, bulletDistance));
        const preferredRange = effectiveRange * (definition.bulletCount > 1 ? 0.62 : 0.68);
        const sustainedDamage = bulletDamage * definition.bulletCount / Math.max(0.05, definition.fireDelay);
        return {
            kind: "gun",
            effectiveRange,
            preferredRange,
            projectileSpeed,
            powerScore: sustainedDamage * Math.sqrt(effectiveRange),
            maxClip: Math.max(1, definition.maxClip),
        };
    }
    if (definition?.type === "melee" || weapon === "fists") {
        return {
            kind: "melee",
            effectiveRange: meleeAttackDistance,
            preferredRange: meleeAttackDistance * 0.72,
            projectileSpeed: Number.POSITIVE_INFINITY,
            powerScore: 1,
            maxClip: 0,
        };
    }
    return {
        kind: "other",
        effectiveRange: 0,
        preferredRange: 0,
        projectileSpeed: Number.POSITIVE_INFINITY,
        powerScore: 0,
        maxClip: 0,
    };
};

const reloadGraceMs = (weapon: string): number => {
    const definition = GameObjectDefs.typeToDefSafe(weapon);
    if (definition?.type !== "gun") return 2_800;
    const longestReloadSeconds = Math.max(definition.reloadTime, definition.reloadTimeAlt ?? 0);
    return Math.max(2_800, longestReloadSeconds * 1_000 + 750);
};

type TacticalGunSlot = {
    slot: 0 | 1;
    equip: "primary" | "secondary";
    weapon: string;
    ammo: number;
    reserve: number;
};

const tacticalGunSlots = (self: BotBrainPlayer): TacticalGunSlot[] => ([
    {
        slot: 0,
        equip: "primary",
        weapon: self.primaryWeapon ?? "",
        ammo: self.primaryAmmo ?? 0,
        reserve: self.primaryReserve ?? 0,
    },
    {
        slot: 1,
        equip: "secondary",
        weapon: self.secondaryWeapon ?? "",
        ammo: self.secondaryAmmo ?? 0,
        reserve: self.secondaryReserve ?? 0,
    },
] satisfies TacticalGunSlot[]).filter(
    (slot) => weaponKind(slot.weapon) === "gun" && slot.ammo + slot.reserve > 0,
);

const weaponRangeScore = (weapon: string, targetDistance: number): number => {
    const profile = weaponProfile(weapon);
    if (profile.kind !== "gun") return Number.NEGATIVE_INFINITY;
    const beyondRangePenalty = targetDistance > profile.effectiveRange
        ? (targetDistance - profile.effectiveRange) * 7
        : 0;
    const rangeFit = 180 - Math.abs(targetDistance - profile.preferredRange) * 0.55;
    return rangeFit + Math.log2(Math.max(2, profile.powerScore)) * 18 - beyondRangePenalty;
};

const preferredGunEquip = (
    state: BotBrainState,
    self: BotBrainPlayer,
    targetDistance: number | undefined,
    now: number,
): BotEquipIntent | undefined => {
    if (
        targetDistance === undefined
        || now < state.nextWeaponEvaluationAt
        || now < state.nextWeaponSwapAt
    ) return undefined;
    state.nextWeaponEvaluationAt = now + 450;
    const candidates = tacticalGunSlots(self)
        .map((slot) => ({ ...slot, score: weaponRangeScore(slot.weapon, targetDistance) }))
        .sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best || best.slot === self.activeSlot) return undefined;
    const currentScore = weaponRangeScore(self.weapon, targetDistance);
    const activeEmpty = self.ammo <= 0 && (self.activeSlot === 0 || self.activeSlot === 1);
    if (weaponKind(self.weapon) !== "gun" || activeEmpty || best.score > currentScore + 18) {
        state.nextWeaponSwapAt = now + 800;
        return best.equip;
    }
    return undefined;
};

const weaponActions = (
    state: BotBrainState,
    self: BotBrainPlayer,
    targetDistance: number | undefined,
    now: number,
): Pick<BotIntent, "reload" | "equip"> => {
    const kind = weaponKind(self.weapon);
    const tacticalEquip = preferredGunEquip(state, self, targetDistance, now);
    if (tacticalEquip) return { reload: false, equip: tacticalEquip };
    if (kind === "gun" && self.ammo <= 0) {
        if (state.emptyAmmoWeapon !== self.weapon) {
            state.emptyAmmoWeapon = self.weapon;
            state.emptyAmmoSince = now;
            state.nextReloadAt = now;
        }
        if (now - state.emptyAmmoSince >= reloadGraceMs(self.weapon) && now >= state.nextWeaponSwapAt) {
            state.emptyAmmoSince = now;
            state.nextReloadAt = now + 300;
            state.nextWeaponSwapAt = now + 1_800;
            return { reload: false, equip: "otherGun" };
        }
        if (now >= state.nextReloadAt) {
            state.nextReloadAt = now + 900;
            return { reload: true };
        }
        return { reload: false };
    }

    state.emptyAmmoWeapon = undefined;
    state.emptyAmmoSince = 0;
    if (kind === "gun") {
        const profile = weaponProfile(self.weapon);
        const tacticalReloadThreshold = Math.max(2, Math.floor(profile.maxClip * 0.2));
        const safeToReload = targetDistance === undefined || targetDistance > profile.effectiveRange * 0.9;
        if (self.ammo <= tacticalReloadThreshold && safeToReload && now >= state.nextReloadAt) {
            state.nextReloadAt = now + 2_400;
            return { reload: true };
        }
    }
    if (
        kind !== "gun"
        && now >= state.nextWeaponSwapAt
        && (targetDistance === undefined || targetDistance > meleeAttackDistance)
    ) {
        state.nextWeaponSwapAt = now + 1_800;
        return { reload: false, equip: "otherGun" };
    }
    return { reload: false };
};

const canShootTarget = (self: BotBrainPlayer, target: Target | undefined): boolean => {
    if (!target) return false;
    const profile = weaponProfile(self.weapon);
    if (profile.kind === "gun") return self.ammo > 0 && target.distance <= profile.effectiveRange;
    if (profile.kind === "melee") return target.distance <= meleeAttackDistance;
    return false;
};

const controlledFire = (
    state: BotBrainState,
    self: BotBrainPlayer,
    target: Target | undefined,
    clearShot: boolean,
    now: number,
    random: () => number,
): boolean => {
    if (!clearShot || !canShootTarget(self, target)) return false;
    const definition = GameObjectDefs.typeToDefSafe(self.weapon);
    if (!target || definition?.type !== "gun") return true;
    const profile = weaponProfile(self.weapon);
    const needsBurstDiscipline = target.distance > profile.preferredRange * 0.82;
    if (!needsBurstDiscipline || definition.fireMode === "single") {
        state.burstUntil = 0;
        state.nextBurstAt = 0;
        return true;
    }
    if (now < state.burstUntil) return true;
    if (now < state.nextBurstAt) return false;
    const burstDuration = definition.fireMode === "burst"
        ? 380 + random() * 220
        : 260 + random() * 320;
    state.burstUntil = now + burstDuration;
    state.nextBurstAt = state.burstUntil + 160 + random() * 300;
    return true;
};

const selectTarget = (
    enemies: Target[],
    state: BotBrainState,
    now: number,
    random: () => number,
): Target | undefined => {
    const nearest = enemies[0];
    const priority = enemies.reduce<Target | undefined>((best, candidate) => {
        const score = candidate.distance
            - (100 - Math.max(0, candidate.player.health)) * 0.42
            - (weaponKind(candidate.player.weapon) === "gun" && candidate.player.ammo > 0 ? 14 : 0)
            - (candidate.player.isBot === false ? 52 : 0);
        if (!best) return candidate;
        const bestScore = best.distance
            - (100 - Math.max(0, best.player.health)) * 0.42
            - (weaponKind(best.player.weapon) === "gun" && best.player.ammo > 0 ? 14 : 0)
            - (best.player.isBot === false ? 52 : 0);
        return score < bestScore ? candidate : best;
    }, undefined);
    const locked = now < state.targetLockedUntil
        ? enemies.find(({ player }) => player.sessionId === state.targetSessionId)
        : undefined;
    const immediateThreat = nearest
        && locked
        && (nearest.distance < 70 || nearest.distance < locked.distance * 0.55);
    const humanOpportunity = enemies.find(({ player, distance: targetDistance }) =>
        player.isBot === false
        && (!locked || targetDistance <= Math.max(220, locked.distance * 1.3))
    );
    const target = immediateThreat ? nearest : humanOpportunity ?? locked ?? priority;

    if (!target) {
        state.targetSessionId = undefined;
        state.targetLockedUntil = 0;
        return undefined;
    }
    if (target.player.sessionId !== state.targetSessionId || now >= state.targetLockedUntil) {
        state.targetSessionId = target.player.sessionId;
        state.targetLockedUntil = now + targetLockMinMs + random() * targetLockJitterMs;
    }
    return target;
};

const lootUtility = (self: BotBrainPlayer, loot: BotBrainLoot): number => {
    const gunSlots = [
        { weapon: self.primaryWeapon ?? "", ammo: self.primaryAmmo ?? 0, reserve: self.primaryReserve ?? 0 },
        { weapon: self.secondaryWeapon ?? "", ammo: self.secondaryAmmo ?? 0, reserve: self.secondaryReserve ?? 0 },
    ].filter((slot) => weaponKind(slot.weapon) === "gun");
    if (gunSlots.length === 0 && weaponKind(self.weapon) === "gun") {
        gunSlots.push({ weapon: self.weapon, ammo: self.ammo, reserve: 0 });
    }
    const matchingAmmoSlots = gunSlots.filter((slot) => {
        const definition = GameObjectDefs.typeToDefSafe(slot.weapon);
        return definition?.type === "gun" && definition.ammo === loot.type;
    });
    switch (loot.kind) {
        case "gun": {
            const candidateProfile = weaponProfile(loot.type);
            if (candidateProfile.kind !== "gun") return 8;
            if (gunSlots.length === 0) return 138;
            if (gunSlots.length < 2) return 118;
            const weakestProfile = gunSlots
                .map((slot) => weaponProfile(slot.weapon))
                .sort((left, right) => left.powerScore - right.powerScore)[0]!;
            const upgradeRatio = candidateProfile.powerScore / Math.max(1, weakestProfile.powerScore);
            if (upgradeRatio >= 1.35) return 112;
            if (upgradeRatio >= 1.12) return 82;
            return 24;
        }
        case "ammo": {
            if (matchingAmmoSlots.length === 0) return 14;
            const supply = matchingAmmoSlots.reduce(
                (total, slot) => total + slot.ammo + slot.reserve,
                0,
            );
            return supply < 20 ? 128 : supply < 60 ? 96 : supply < 120 ? 58 : 22;
        }
        case "heal":
            return self.health < 45 ? 122 : (self.bandages ?? 0) + (self.healthkits ?? 0) < 2 ? 82 : 30;
        case "chest":
        case "helmet":
            return self.armor < 35 ? 92 : self.armor < 70 ? 56 : 18;
        case "backpack":
        case "scope":
            return 48;
        case "boost":
            return self.health < 80 || (self.boost ?? 0) < 35 ? 58 : 28;
        case "melee":
            return weaponKind(self.weapon) === "gun" ? 20 : 38;
        case "throwable":
            return (self.throwableCount ?? 0) <= 1 ? 58 : 30;
        default:
            return 8;
    }
};

const stableHash = (value: string): number => {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
};

type CombatStyle = "breacher" | "flanker" | "marksman";

interface BotPersonality {
    style: CombatStyle;
    aggression: number;
    caution: number;
    lootDrive: number;
    lootRadius: number;
    preferredRangeScale: number;
    orbitAngle: number;
    cadenceScale: number;
    roamBias: number;
}

const personalityCache = new Map<string, BotPersonality>();

const hashUnit = (sessionId: string, trait: string): number =>
    stableHash(`${sessionId}:${trait}`) / 0xffff_ffff;

const botPersonality = (sessionId: string): BotPersonality => {
    const cached = personalityCache.get(sessionId);
    if (cached) return cached;
    const styles: CombatStyle[] = ["breacher", "flanker", "marksman"];
    const style = styles[stableHash(sessionId) % styles.length]!;
    const personality = {
        style,
        aggression: 0.78 + hashUnit(sessionId, "aggression") * 0.58,
        caution: 0.72 + hashUnit(sessionId, "caution") * 0.58,
        lootDrive: 0.82 + hashUnit(sessionId, "loot-drive") * 0.62,
        lootRadius: 280 + hashUnit(sessionId, "loot-radius") * 240,
        preferredRangeScale: 0.78 + hashUnit(sessionId, "range") * 0.5,
        orbitAngle: Math.PI * (0.34 + hashUnit(sessionId, "orbit") * 0.4),
        cadenceScale: 0.68 + hashUnit(sessionId, "cadence") * 0.82,
        roamBias: (hashUnit(sessionId, "roam") - 0.5) * Math.PI * 0.62,
    };
    personalityCache.set(sessionId, personality);
    return personality;
};

const isExplosiveThrowable = (weapon: string): boolean => {
    const definition = GameObjectDefs.typeToDefSafe(weapon);
    return definition?.type === "throwable" && !/smoke|sensor|snowball/i.test(weapon);
};

const grenadeOpportunity = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    target: Target | undefined,
    enemies: Target[],
    allies: Target[],
    state: BotBrainState,
    now: number,
): boolean => {
    if (
        !target
        || now < state.grenadeCooldownUntil
        || (self.throwableCount ?? 0) <= 0
        || !isExplosiveThrowable(self.throwableWeapon ?? "")
        || target.distance < 24
        || target.distance > 68
        || target.player.downed === true
    ) return false;
    const nearbyEnemies = enemies.filter(({ player }) =>
        distance(target.player.x, target.player.y, player.x, player.y) <= 24
    ).length;
    const allyInBlastRadius = allies.some(({ player }) =>
        distance(target.player.x, target.player.y, player.x, player.y) <= 28
    );
    if (allyInBlastRadius) return false;
    return nearbyEnemies >= 2 || !hasClearShot(snapshot, self, target.player);
};

const lootAffinity = (sessionId: string, lootId: number): number =>
    stableHash(`${sessionId}:${lootId}`) % 13;

const lootGridCache = new WeakMap<BotBrainSnapshot, Map<string, BotBrainLoot[]>>();

const lootGrid = (snapshot: BotBrainSnapshot): Map<string, BotBrainLoot[]> => {
    const cached = lootGridCache.get(snapshot);
    if (cached) return cached;
    const grid = new Map<string, BotBrainLoot[]>();
    for (const loot of snapshot.loot ?? []) {
        const key = `${Math.floor(loot.x / 32)}:${Math.floor(loot.y / 32)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(loot);
        else grid.set(key, [loot]);
    }
    lootGridCache.set(snapshot, grid);
    return grid;
};

const nearbyLoot = (
    grid: Map<string, BotBrainLoot[]>,
    loot: BotBrainLoot,
): BotBrainLoot[] => {
    const cellX = Math.floor(loot.x / 32);
    const cellY = Math.floor(loot.y / 32);
    const nearby: BotBrainLoot[] = [];
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
        for (let yOffset = -1; yOffset <= 1; yOffset++) {
            nearby.push(...(grid.get(`${cellX + xOffset}:${cellY + yOffset}`) ?? []));
        }
    }
    return nearby;
};

const selectLootTarget = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    now: number,
    sessionId: string,
): LootTarget | undefined => {
    const personality = botPersonality(sessionId);
    const realLoot = snapshot.loot ?? [];
    const spatialLoot = lootGrid(snapshot);
    const enemies = snapshot.players.filter((player) =>
        player.connected
        && player.alive
        && player.downed !== true
        && player.teamId !== self.teamId
    );
    const candidates = realLoot
        .map((loot) => {
            const lootDistance = distance(self.x, self.y, loot.x, loot.y);
            const utility = lootUtility(self, loot);
            return { loot, distance: lootDistance, utility };
        })
        .filter((candidate) => candidate.distance <= personality.lootRadius && candidate.utility >= 20)
        .map(({ loot, distance: lootDistance, utility }) => {
            const clusterUtility = nearbyLoot(spatialLoot, loot).reduce((total, nearby) => {
                if (nearby.id === loot.id || distance(loot.x, loot.y, nearby.x, nearby.y) > 24) return total;
                return total + Math.max(0, lootUtility(self, nearby) - 16) * 0.12;
            }, 0);
            const nearestEnemyDistance = enemies.reduce(
                (nearest, enemy) => Math.min(nearest, distance(loot.x, loot.y, enemy.x, enemy.y)),
                Number.POSITIVE_INFINITY,
            );
            const exposedPenalty = nearestEnemyDistance < 75
                ? (75 - nearestEnemyDistance) * 0.42 * personality.caution
                : 0;
            const pathPenalty = segmentIsClear(snapshot, self.x, self.y, loot.x, loot.y)
                ? 0
                : 26 + lootDistance * 0.045;
            const score = utility * personality.lootDrive
                + Math.min(42, clusterUtility)
                + lootAffinity(sessionId, loot.id)
                - lootDistance * (0.075 + personality.caution * 0.035)
                - exposedPenalty
                - pathPenalty;
            return { loot, distance: lootDistance, utility, score };
        })
        .sort((left, right) => right.score - left.score);
    const locked = now < state.lootLockedUntil
        ? candidates.find((candidate) => candidate.loot.id === state.targetLootId)
        : undefined;
    const target = locked ?? candidates[0];
    if (!target) {
        state.targetLootId = undefined;
        state.lootLockedUntil = 0;
        return undefined;
    }
    if (target.loot.id !== state.targetLootId) {
        state.targetLootId = target.loot.id;
        state.lootLockedUntil = now + 850 + personality.caution * 450;
    }
    return target;
};

const updateStuckState = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    now: number,
    random: () => number,
): void => {
    if (snapshot.capturedAt === state.lastSnapshotAt) return;
    if (state.lastX !== undefined && state.lastY !== undefined) {
        const moved = distance(state.lastX, state.lastY, self.x, self.y);
        if (state.lastMovementCommanded) {
            state.stuckSamples = moved < 1.1 ? state.stuckSamples + 1 : 0;
            if (state.stuckSamples >= 4) {
                state.stuckSamples = 0;
                state.unstuckUntil = now + 900 + random() * 500;
                state.wanderAngle += state.strafeSign * (Math.PI * (0.55 + random() * 0.35));
                state.strafeSign = state.strafeSign === 1 ? -1 : 1;
            }
        }
    }
    state.lastX = self.x;
    state.lastY = self.y;
    state.lastSnapshotAt = snapshot.capturedAt;
};

const formationOffset = (sessionId: string): number => {
    let hash = 0;
    for (let index = 0; index < sessionId.length; index++) hash = (hash * 31 + sessionId.charCodeAt(index)) | 0;
    return ((Math.abs(hash) % 1_001) / 1_000 - 0.5) * 0.36;
};

export const decideBotIntent = (
    snapshot: BotBrainSnapshot | undefined,
    sessionId: string,
    state: BotBrainState,
    now = Date.now(),
    random: () => number = Math.random,
): BotIntent => {
    const actions = periodicActions(state, now, random);
    const snapshotIsFresh = snapshot && now - snapshot.capturedAt <= snapshotFreshnessMs;
    const self = snapshotIsFresh
        ? snapshot.players.find((player) => player.sessionId === sessionId && player.connected)
        : undefined;

    if (!snapshotIsFresh || !self || !self.alive) {
        state.targetSessionId = undefined;
        state.targetLockedUntil = 0;
        state.targetLootId = undefined;
        state.lootLockedUntil = 0;
        state.healingUntil = 0;
        state.lastHealth = undefined;
        state.underFireUntil = 0;
        state.flankTargetSessionId = undefined;
        state.flankX = undefined;
        state.flankY = undefined;
        state.flankUntil = 0;
        state.grenadePhase = "idle";
        state.grenadeCookUntil = 0;
        state.grenadeTargetSessionId = undefined;
        if (now >= state.decisionUntil) {
            state.wanderAngle = random() * Math.PI * 2;
            state.decisionUntil = now + 1_500 + random() * 2_000;
        }
        return finishIntent(
            state,
            {
                mode: "wander",
                moveAngle: state.wanderAngle,
                aimAngle: state.wanderAngle,
                aimDistance: 48,
                shoot: false,
                ...actions,
            },
            "rhythm",
            now,
            random,
        );
    }

    updateStuckState(snapshot, self, state, now, random);
    if (state.lastHealth !== undefined && self.health < state.lastHealth - 0.5) {
        state.underFireUntil = now + 1_100;
        state.strafeSign = state.strafeSign === 1 ? -1 : 1;
        state.nextStrafeFlipAt = state.underFireUntil;
        state.movementPhase = "travel";
        state.movementPhaseUntil = state.underFireUntil;
    }
    state.lastHealth = self.health;

    const enemies = snapshot.players
        .filter((player) =>
            player.connected
            && player.alive
            && player.downed !== true
            && player.sessionId !== sessionId
            && player.teamId !== self.teamId
        )
        .map((player) => ({
            player,
            distance: distance(self.x, self.y, player.x, player.y),
        }))
        .sort((left, right) => left.distance - right.distance);
    const allies = snapshot.players
        .filter((player) =>
            player.connected
            && player.alive
            && player.teamId === self.teamId
            && player.sessionId !== sessionId
        )
        .map((player) => ({
            player,
            distance: distance(self.x, self.y, player.x, player.y),
        }))
        .sort((left, right) => left.distance - right.distance);
    const personality = botPersonality(sessionId);
    const target = selectTarget(enemies, state, now, random);
    const selfWeapon = weaponProfile(self.weapon);
    const projectileTravelSeconds = target && Number.isFinite(selfWeapon.projectileSpeed)
        ? Math.min(0.72, target.distance / Math.max(1, selfWeapon.projectileSpeed))
        : 0;
    const targetAngle = target
        ? angleTo(
            self.x,
            self.y,
            target.player.x + target.player.vx * projectileTravelSeconds,
            target.player.y + target.player.vy * projectileTravelSeconds,
        )
        : state.wanderAngle;
    const combatActions = { ...actions, ...weaponActions(state, self, target?.distance, now) };
    const clearShot = Boolean(target && hasClearShot(snapshot, self, target.player));
    const shoot = controlledFire(state, self, target, clearShot, now, random);

    if (self.downed) {
        state.healingUntil = 0;
        state.grenadePhase = "idle";
        const rescueAlly = allies.find(({ player }) => player.downed !== true);
        const crawlAngle = rescueAlly
            ? angleTo(self.x, self.y, rescueAlly.player.x, rescueAlly.player.y)
            : target
            ? targetAngle + Math.PI
            : angleTo(self.x, self.y, snapshot.zone.x, snapshot.zone.y);
        return finishIntent(
            state,
            {
                mode: "downed",
                moveAngle: steerAroundWalls(snapshot, self, state, crawlAngle, now),
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot: false,
                interact: false,
                reload: false,
            },
            "force",
            now,
            random,
        );
    }

    if (state.grenadePhase !== "idle") {
        const grenadeTarget = enemies.find(({ player }) => player.sessionId === state.grenadeTargetSessionId)
            ?? target;
        const grenadeAngle = grenadeTarget
            ? angleTo(self.x, self.y, grenadeTarget.player.x, grenadeTarget.player.y)
            : targetAngle;
        if (state.grenadePhase === "equip") {
            if (self.activeSlot === 3 && isExplosiveThrowable(self.weapon)) {
                state.grenadePhase = "cook";
                state.grenadeCookUntil = now + 720 + random() * 420;
                return finishIntent(
                    state,
                    {
                        mode: "grenade",
                        moveAngle: grenadeAngle + state.strafeSign * Math.PI / 2,
                        aimAngle: grenadeAngle,
                        aimDistance: aimDistance(grenadeTarget),
                        shoot: true,
                        interact: false,
                        reload: false,
                        forceShootStart: true,
                    },
                    "rhythm",
                    now,
                    random,
                );
            }
            if (!grenadeTarget || now >= state.grenadeCookUntil) {
                state.grenadePhase = "recover";
            } else {
                return finishIntent(
                    state,
                    {
                        mode: "grenade",
                        moveAngle: grenadeAngle + state.strafeSign * Math.PI / 2,
                        aimAngle: grenadeAngle,
                        aimDistance: aimDistance(grenadeTarget),
                        shoot: false,
                        interact: false,
                        reload: false,
                        equip: "throwable",
                    },
                    "rhythm",
                    now,
                    random,
                );
            }
        }
        if (state.grenadePhase === "cook") {
            if (grenadeTarget && now < state.grenadeCookUntil) {
                return finishIntent(
                    state,
                    {
                        mode: "grenade",
                        moveAngle: grenadeAngle + state.strafeSign * Math.PI / 2,
                        aimAngle: grenadeAngle,
                        aimDistance: aimDistance(grenadeTarget),
                        shoot: true,
                        interact: false,
                        reload: false,
                    },
                    "rhythm",
                    now,
                    random,
                );
            }
            state.grenadePhase = "release";
            return finishIntent(
                state,
                {
                    mode: "grenade",
                    moveAngle: grenadeAngle + Math.PI,
                    aimAngle: grenadeAngle,
                    aimDistance: aimDistance(grenadeTarget),
                    shoot: false,
                    interact: false,
                    reload: false,
                },
                "force",
                now,
                random,
            );
        }
        if (state.grenadePhase === "release") state.grenadePhase = "recover";
        if (state.grenadePhase === "recover") {
            state.grenadePhase = "idle";
            state.grenadeCooldownUntil = now + 7_000 + random() * 5_000;
            state.grenadeTargetSessionId = undefined;
            return finishIntent(
                state,
                {
                    mode: "grenade",
                    moveAngle: grenadeAngle + Math.PI,
                    aimAngle: grenadeAngle,
                    aimDistance: aimDistance(grenadeTarget),
                    shoot: false,
                    interact: false,
                    reload: false,
                    equip: "lastWeapon",
                },
                "force",
                now,
                random,
            );
        }
    }

    if (now < state.unstuckUntil) {
        state.healingUntil = 0;
        return finishIntent(
            state,
            {
                mode: "unstuck",
                moveAngle: state.wanderAngle,
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot,
                ...combatActions,
            },
            "force",
            now,
            random,
        );
    }

    const edgeMargin = Math.max(70, Math.min(snapshot.map.width, snapshot.map.height) * 0.07);
    const outsideMapCenter = self.x < edgeMargin
        || self.y < edgeMargin
        || self.x > snapshot.map.width - edgeMargin
        || self.y > snapshot.map.height - edgeMargin;
    if (outsideMapCenter) {
        state.healingUntil = 0;
        const centerAngle = angleTo(
            self.x,
            self.y,
            snapshot.map.width / 2,
            snapshot.map.height / 2,
        );
        const atHardEdge = self.x < edgeMargin * 0.35
            || self.y < edgeMargin * 0.35
            || self.x > snapshot.map.width - edgeMargin * 0.35
            || self.y > snapshot.map.height - edgeMargin * 0.35;
        return finishIntent(
            state,
            {
                mode: "edge",
                moveAngle: steerAroundWalls(snapshot, self, state, centerAngle, now),
                aimAngle: targetAngle,
                aimDistance: aimDistance(target, 60),
                shoot,
                ...combatActions,
            },
            atHardEdge ? "force" : "rhythm",
            now,
            random,
        );
    }

    const zoneDistance = distance(self.x, self.y, snapshot.zone.x, snapshot.zone.y);
    const shouldReturnToCurrentZone = snapshot.zone.radius > 0 && zoneDistance > snapshot.zone.radius * 0.78;
    const nextZoneDistance = distance(self.x, self.y, snapshot.zone.nextX, snapshot.zone.nextY);
    const shouldPrepositionForNextZone = !shouldReturnToCurrentZone
        && snapshot.zone.nextRadius > 0
        && snapshot.zone.nextRadius < snapshot.zone.radius * 0.98
        && nextZoneDistance > snapshot.zone.nextRadius * 0.82;
    if (shouldReturnToCurrentZone || shouldPrepositionForNextZone) {
        state.healingUntil = 0;
        const zoneX = shouldReturnToCurrentZone ? snapshot.zone.x : snapshot.zone.nextX;
        const zoneY = shouldReturnToCurrentZone ? snapshot.zone.y : snapshot.zone.nextY;
        const safeAngle = angleTo(self.x, self.y, zoneX, zoneY);
        const outsideCurrentZone = snapshot.zone.radius > 0 && zoneDistance > snapshot.zone.radius;
        return finishIntent(
            state,
            {
                mode: "zone",
                moveAngle: steerAroundWalls(snapshot, self, state, safeAngle, now),
                aimAngle: targetAngle,
                aimDistance: aimDistance(target, 60),
                shoot,
                ...combatActions,
            },
            outsideCurrentZone ? "force" : "rhythm",
            now,
            random,
        );
    }

    const nearestEnemy = enemies[0];
    const closeThreatDistance = selfWeapon.kind === "gun"
        ? Math.max(70, Math.min(220, selfWeapon.effectiveRange * 1.15))
        : 70;
    const closeThreat = Boolean(nearestEnemy && nearestEnemy.distance <= closeThreatDistance);
    if (grenadeOpportunity(snapshot, self, target, enemies, allies, state, now)) {
        state.grenadePhase = "equip";
        state.grenadeCookUntil = now + 1_600;
        state.grenadeTargetSessionId = target?.player.sessionId;
        return finishIntent(
            state,
            {
                mode: "grenade",
                moveAngle: targetAngle + state.strafeSign * Math.PI / 2,
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot: false,
                interact: false,
                reload: false,
                equip: "throwable",
            },
            "rhythm",
            now,
            random,
        );
    }
    if (state.healingUntil > now && !closeThreat) {
        return finishIntent(
            state,
            {
                mode: "heal",
                moveAngle: state.wanderAngle,
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot: false,
                interact: false,
                reload: false,
            },
            "stop",
            now,
            random,
        );
    }
    if (closeThreat || self.health >= 90) state.healingUntil = 0;
    if (self.health < 68 && !closeThreat && now >= state.nextHealAt) {
        const bandages = self.bandages ?? 0;
        const healthkits = self.healthkits ?? 0;
        const useItem: BotUseItemIntent | undefined = self.health <= 32 && healthkits > 0
            ? "healthkit"
            : bandages > 0
            ? "bandage"
            : healthkits > 0
            ? "healthkit"
            : undefined;
        if (!useItem) {
            state.healingUntil = 0;
        } else {
            state.healingUntil = now + (useItem === "healthkit" ? 6_200 : 3_200);
            state.nextHealAt = now + 10_000;
            return finishIntent(
                state,
                {
                    mode: "heal",
                    moveAngle: state.wanderAngle,
                    aimAngle: targetAngle,
                    aimDistance: aimDistance(target),
                    shoot: false,
                    interact: false,
                    reload: false,
                    useItem,
                },
                "stop",
                now,
                random,
            );
        }
    }

    if ((self.boost ?? 0) < 35 && !closeThreat && now >= state.nextHealAt) {
        const useItem: BotUseItemIntent | undefined = (self.painkillers ?? 0) > 0
            ? "painkiller"
            : (self.sodas ?? 0) > 0
            ? "soda"
            : undefined;
        if (useItem) {
            state.healingUntil = now + (useItem === "painkiller" ? 5_200 : 3_200);
            state.nextHealAt = now + 8_000;
            return finishIntent(
                state,
                {
                    mode: "heal",
                    moveAngle: state.wanderAngle,
                    aimAngle: targetAngle,
                    aimDistance: aimDistance(target),
                    shoot: false,
                    interact: false,
                    reload: false,
                    useItem,
                },
                "stop",
                now,
                random,
            );
        }
    }

    const downedAlly = allies.find(({ player }) => player.downed === true);
    const exposedRescueThreat = target
        && target.distance <= 150
        && hasClearShot(snapshot, target.player, self);
    if (downedAlly && !exposedRescueThreat) {
        const rescueAngle = angleTo(self.x, self.y, downedAlly.player.x, downedAlly.player.y);
        const canRevive = downedAlly.distance <= 5.5;
        return finishIntent(
            state,
            {
                mode: "rescue",
                moveAngle: steerAroundWalls(snapshot, self, state, rescueAngle, now),
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot: false,
                interact: canRevive,
                reload: false,
            },
            canRevive ? "stop" : "force",
            now,
            random,
        );
    }

    const lootTarget = selectLootTarget(snapshot, self, state, now, sessionId);
    const needsWeaponOrAmmo = weaponKind(self.weapon) !== "gun" || self.ammo <= 0;
    const valuableLootBreakDistance = 65 + personality.lootDrive * 28;
    const canBreakForLoot = !target
        || target.distance > (
            needsWeaponOrAmmo
                ? 70
                : (lootTarget?.utility ?? 0) >= 82
                ? valuableLootBreakDistance
                : 560 + personality.caution * 70
        );
    if (lootTarget && canBreakForLoot) {
        const lootAngle = angleTo(self.x, self.y, lootTarget.loot.x, lootTarget.loot.y);
        // The authoritative player pickup check uses player radius + loot radius
        // (normally 2-2.25 world units), so do not stop outside that circle.
        const withinPickupRange = lootTarget.distance <= 1.8;
        return finishIntent(
            state,
            {
                mode: "loot",
                moveAngle: lootAngle,
                aimAngle: target ? targetAngle : lootAngle,
                aimDistance: aimDistance(target, Math.min(64, Math.max(12, lootTarget.distance))),
                shoot: false,
                interact: withinPickupRange,
                reload: false,
            },
            withinPickupRange ? "stop" : "force",
            now,
            random,
        );
    }

    if (target && target.distance <= combatAwarenessDistance && !hasClearShot(snapshot, self, target.player)) {
        const waypoint = selectFlankWaypoint(snapshot, self, target.player, state, now);
        if (waypoint) {
            const flankAngle = angleTo(self.x, self.y, waypoint.x, waypoint.y);
            return finishIntent(
                state,
                {
                    mode: "flank",
                    moveAngle: steerAroundWalls(snapshot, self, state, flankAngle, now),
                    aimAngle: targetAngle,
                    aimDistance: aimDistance(target),
                    shoot: false,
                    ...combatActions,
                },
                "force",
                now,
                random,
            );
        }
    } else if (target) {
        state.flankTargetSessionId = undefined;
        state.flankX = undefined;
        state.flankY = undefined;
        state.flankUntil = 0;
    }

    if (target && target.distance <= combatAwarenessDistance) {
        if (now >= state.nextCombatFeintAt) {
            state.combatFeintAngle = (random() - 0.5) * personality.orbitAngle * 0.8;
            state.nextCombatFeintAt = now + (480 + random() * 1_750) * personality.cadenceScale;
        }
        if (state.nextStrafeFlipAt <= 0) {
            state.nextStrafeFlipAt = now + (420 + random() * 1_100) * personality.cadenceScale;
        } else if (now >= state.nextStrafeFlipAt) {
            if (random() < 0.48 + personality.aggression * 0.2) {
                state.strafeSign = state.strafeSign === 1 ? -1 : 1;
            }
            state.nextStrafeFlipAt = now + (420 + random() * 1_100) * personality.cadenceScale;
        }
        let moveAngle = targetAngle;
        let mode: BotIntentMode = "combat";
        let movementPolicy: MovementPolicy = now < state.underFireUntil ? "force" : "rhythm";
        if (selfWeapon.kind === "gun") {
            const style = personality.style;
            const preferredRange = selfWeapon.preferredRange * (
                style === "breacher" ? 0.72 : style === "marksman" ? 1.22 : 0.95
            ) * personality.preferredRangeScale;
            const criticalHealthRetreat = self.health <= 28
                && target.distance <= Math.max(100, selfWeapon.effectiveRange * 1.45);
            if (criticalHealthRetreat) {
                mode = "retreat";
                movementPolicy = "force";
                moveAngle += Math.PI + state.strafeSign * 0.18;
            } else if (target.distance < preferredRange * (style === "marksman" ? 0.88 : 0.62)) {
                moveAngle += Math.PI;
            } else if (target.distance <= preferredRange * 1.3) {
                moveAngle += state.strafeSign * personality.orbitAngle + state.combatFeintAngle;
            } else {
                moveAngle += state.strafeSign * (
                    (style === "flanker" ? 0.2 : 0.08) + personality.aggression * 0.08
                ) + state.combatFeintAngle * 0.35;
                if (style === "breacher") movementPolicy = "force";
            }
            if (now < state.underFireUntil && mode === "combat") {
                moveAngle += state.strafeSign * 0.24;
            }
        }
        return finishIntent(
            state,
            {
                mode,
                moveAngle: steerAroundWalls(snapshot, self, state, moveAngle, now),
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot,
                ...combatActions,
            },
            movementPolicy,
            now,
            random,
        );
    }

    if (target) {
        const waypoint = !clearShot
            ? selectFlankWaypoint(snapshot, self, target.player, state, now)
            : undefined;
        const huntAngle = waypoint
            ? angleTo(self.x, self.y, waypoint.x, waypoint.y)
            : targetAngle + state.strafeSign * personality.orbitAngle * (
                personality.style === "flanker" ? 0.12 : 0.04
            );
        return finishIntent(
            state,
            {
                mode: "hunt",
                moveAngle: steerAroundWalls(snapshot, self, state, huntAngle, now),
                aimAngle: targetAngle,
                aimDistance: aimDistance(target, 64),
                shoot: false,
                ...combatActions,
            },
            weaponKind(self.weapon) === "gun" ? "force" : "rhythm",
            now,
            random,
        );
    }

    if (now >= state.decisionUntil) {
        state.wanderAngle += (random() - 0.5) * Math.PI * 1.35 + personality.roamBias * 0.35;
        state.decisionUntil = now + (1_350 + random() * 3_400) * personality.cadenceScale;
        if (random() < 0.28) state.strafeSign = state.strafeSign === 1 ? -1 : 1;
    }
    const nearestAlly = allies[0];
    const wanderAngle = nearestAlly && nearestAlly.distance > 220
        ? angleTo(self.x, self.y, nearestAlly.player.x, nearestAlly.player.y)
            + formationOffset(sessionId)
            + personality.roamBias * 0.25
        : state.wanderAngle + personality.roamBias * 0.18;
    return finishIntent(
        state,
        {
            mode: "wander",
            moveAngle: steerAroundWalls(snapshot, self, state, wanderAngle, now),
            aimAngle: targetAngle,
            aimDistance: aimDistance(target),
            shoot: false,
            ...combatActions,
        },
        "rhythm",
        now,
        random,
    );
};
