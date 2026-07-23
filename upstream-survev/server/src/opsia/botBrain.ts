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
    indoors?: boolean;
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
    obstacles?: BotBrainObstacle[];
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

export interface BotBrainObstacle extends BotBrainMapObstacle {
    type?: string;
    kind?: string;
    destructible: boolean;
    containsLoot: boolean;
    health: number;
}

export interface BotBrainLoot {
    id: number;
    type: string;
    kind: string;
    x: number;
    y: number;
    count: number;
}

export type BotIntentMode =
    | "wander"
    | "loot"
    | "break"
    | "hunt"
    | "combat"
    | "flank"
    | "retreat"
    | "rescue"
    | "downed"
    | "grenade"
    | "zone"
    | "edge"
    | "unstuck"
    | "heal";
export type BotEquipIntent = "otherGun" | "primary" | "secondary" | "melee" | "throwable" | "lastWeapon";
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
    lastMoveAngle?: number;
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
    targetBreakableId?: number;
    breakableLockedUntil: number;
    navigationGoalKey?: string;
    navigationWaypoints: Array<{ x: number; y: number }>;
    navigationWaypointIndex: number;
    navigationReplanAt: number;
    roamX?: number;
    roamY?: number;
    roamSequence: number;
    targetLastSeenX?: number;
    targetLastSeenY?: number;
    targetMemoryUntil: number;
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
type BreakableTarget = { obstacle: BotBrainObstacle; distance: number; utility: number };
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
const combatAwarenessDistance = 520;

const distance = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

const angleTo = (ax: number, ay: number, bx: number, by: number): number => Math.atan2(by - ay, bx - ax);

const navigationCellSize = 64;
const navigationIndexPadding = 4;
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
    const liveObstacles = snapshot.obstacles ?? [];
    const authoritativeWalls = snapshot.map.navigation ?? [];
    // Presence of the live projection is authoritative even when it is empty:
    // a formerly present crate or window may have just been destroyed.
    if (snapshot.obstacles !== undefined) return liveObstacles;
    if (authoritativeWalls.length > 0) return authoritativeWalls;
    // Coarse building/structure boxes contain walkable rooms and open doors;
    // treating them as solid is worse than having no fallback navigation.
    return [];
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
): boolean =>
    x >= obstacle.x - obstacle.width / 2 - padding
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
    padding = 0.35,
): boolean => {
    if (insideObstacle(ax, ay, obstacle)) return false;
    const minX = obstacle.x - obstacle.width / 2 - padding;
    const maxX = obstacle.x + obstacle.width / 2 + padding;
    const minY = obstacle.y - obstacle.height / 2 - padding;
    const maxY = obstacle.y + obstacle.height / 2 + padding;
    const dx = bx - ax;
    const dy = by - ay;
    let low = 0;
    let high = 1;
    for (
        const [origin, delta, min, max] of [
            [ax, dx, minX, maxX],
            [ay, dy, minY, maxY],
        ] as const
    ) {
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

const segmentIsNavigable = (
    snapshot: BotBrainSnapshot,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): boolean =>
    !navigationEntriesAlongSegment(snapshot, ax, ay, bx, by).some(
        ({ obstacle }) => segmentHitsObstacle(ax, ay, bx, by, obstacle, 3),
    );

type NavigationPoint = { x: number; y: number };
type OpenPathNode = NavigationPoint & { key: string; g: number; f: number };

const pathCellSize = 10;
const maxPathExpansions = 7_500;

const pushOpenNode = (heap: OpenPathNode[], node: OpenPathNode): void => {
    heap.push(node);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent]!.f <= node.f) break;
        heap[index] = heap[parent]!;
        index = parent;
    }
    heap[index] = node;
};

const popOpenNode = (heap: OpenPathNode[]): OpenPathNode | undefined => {
    const first = heap[0];
    const last = heap.pop();
    if (!first || heap.length === 0 || !last) return first;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && heap[right]!.f < heap[left]!.f ? right : left;
        if (heap[child]!.f >= last.f) break;
        heap[index] = heap[child]!;
        index = child;
    }
    heap[index] = last;
    return first;
};

const pathCellKey = (x: number, y: number): string => `${x}:${y}`;

const pathPointBlocked = (snapshot: BotBrainSnapshot, x: number, y: number): boolean =>
    navigationEntriesAtPoint(snapshot, x, y).some(
        ({ obstacle }) => insideObstacle(x, y, obstacle, 3),
    );

const nearestOpenPathCell = (
    snapshot: BotBrainSnapshot,
    worldX: number,
    worldY: number,
): NavigationPoint | undefined => {
    const centerX = Math.round(worldX / pathCellSize);
    const centerY = Math.round(worldY / pathCellSize);
    for (let radius = 0; radius <= 4; radius++) {
        const candidates: NavigationPoint[] = [];
        for (let xOffset = -radius; xOffset <= radius; xOffset++) {
            for (let yOffset = -radius; yOffset <= radius; yOffset++) {
                if (radius > 0 && Math.abs(xOffset) !== radius && Math.abs(yOffset) !== radius) continue;
                const x = centerX + xOffset;
                const y = centerY + yOffset;
                const pointX = x * pathCellSize;
                const pointY = y * pathCellSize;
                if (
                    pointX < 5
                    || pointY < 5
                    || pointX > snapshot.map.width - 5
                    || pointY > snapshot.map.height - 5
                    || pathPointBlocked(snapshot, pointX, pointY)
                ) continue;
                candidates.push({ x, y });
            }
        }
        candidates.sort((left, right) =>
            distance(left.x * pathCellSize, left.y * pathCellSize, worldX, worldY)
            - distance(right.x * pathCellSize, right.y * pathCellSize, worldX, worldY)
        );
        if (candidates[0]) return candidates[0];
    }
    return undefined;
};

const planNavigationPath = (
    snapshot: BotBrainSnapshot,
    startX: number,
    startY: number,
    goalX: number,
    goalY: number,
): NavigationPoint[] => {
    if (segmentIsNavigable(snapshot, startX, startY, goalX, goalY)) return [{ x: goalX, y: goalY }];
    const start = nearestOpenPathCell(snapshot, startX, startY);
    const goal = nearestOpenPathCell(snapshot, goalX, goalY);
    if (!start || !goal) return [];

    const directDistance = distance(startX, startY, goalX, goalY);
    const margin = Math.min(220, Math.max(80, directDistance * 0.24));
    const minCellX = Math.max(1, Math.floor((Math.min(startX, goalX) - margin) / pathCellSize));
    const maxCellX = Math.min(
        Math.floor(snapshot.map.width / pathCellSize) - 1,
        Math.ceil((Math.max(startX, goalX) + margin) / pathCellSize),
    );
    const minCellY = Math.max(1, Math.floor((Math.min(startY, goalY) - margin) / pathCellSize));
    const maxCellY = Math.min(
        Math.floor(snapshot.map.height / pathCellSize) - 1,
        Math.ceil((Math.max(startY, goalY) + margin) / pathCellSize),
    );
    const startKey = pathCellKey(start.x, start.y);
    const goalKey = pathCellKey(goal.x, goal.y);
    const costs = new Map<string, number>([[startKey, 0]]);
    const parents = new Map<string, string>();
    const cells = new Map<string, NavigationPoint>([[startKey, start]]);
    const open: OpenPathNode[] = [];
    const heuristic = (x: number, y: number): number => {
        const dx = Math.abs(goal.x - x);
        const dy = Math.abs(goal.y - y);
        return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    pushOpenNode(open, { ...start, key: startKey, g: 0, f: heuristic(start.x, start.y) });
    const directions = [
        { x: 1, y: 0, cost: 1 },
        { x: -1, y: 0, cost: 1 },
        { x: 0, y: 1, cost: 1 },
        { x: 0, y: -1, cost: 1 },
        { x: 1, y: 1, cost: Math.SQRT2 },
        { x: 1, y: -1, cost: Math.SQRT2 },
        { x: -1, y: 1, cost: Math.SQRT2 },
        { x: -1, y: -1, cost: Math.SQRT2 },
    ];
    let expansions = 0;
    while (open.length > 0 && expansions++ < maxPathExpansions) {
        const current = popOpenNode(open)!;
        if (current.g > (costs.get(current.key) ?? Number.POSITIVE_INFINITY)) continue;
        if (current.key === goalKey) break;
        const currentWorldX = current.x * pathCellSize;
        const currentWorldY = current.y * pathCellSize;
        for (const direction of directions) {
            const x = current.x + direction.x;
            const y = current.y + direction.y;
            if (x < minCellX || x > maxCellX || y < minCellY || y > maxCellY) continue;
            const worldX = x * pathCellSize;
            const worldY = y * pathCellSize;
            if (pathPointBlocked(snapshot, worldX, worldY)) continue;
            if (!segmentIsNavigable(snapshot, currentWorldX, currentWorldY, worldX, worldY)) continue;
            if (direction.x !== 0 && direction.y !== 0) {
                if (
                    pathPointBlocked(snapshot, currentWorldX + direction.x * pathCellSize, currentWorldY)
                    || pathPointBlocked(snapshot, currentWorldX, currentWorldY + direction.y * pathCellSize)
                ) continue;
            }
            const key = pathCellKey(x, y);
            const nextCost = current.g + direction.cost;
            if (nextCost >= (costs.get(key) ?? Number.POSITIVE_INFINITY)) continue;
            costs.set(key, nextCost);
            parents.set(key, current.key);
            cells.set(key, { x, y });
            pushOpenNode(open, { x, y, key, g: nextCost, f: nextCost + heuristic(x, y) });
        }
    }
    if (!costs.has(goalKey)) return [];

    const gridPath: NavigationPoint[] = [];
    let key = goalKey;
    while (key !== startKey) {
        const cell = cells.get(key);
        if (!cell) return [];
        gridPath.push({ x: cell.x * pathCellSize, y: cell.y * pathCellSize });
        const parent = parents.get(key);
        if (!parent) return [];
        key = parent;
    }
    gridPath.reverse();
    gridPath.push({ x: goalX, y: goalY });

    const simplified: NavigationPoint[] = [];
    let anchorX = startX;
    let anchorY = startY;
    let index = 0;
    while (index < gridPath.length) {
        let furthest = index;
        for (let candidate = index + 1; candidate < gridPath.length; candidate++) {
            if (!segmentIsNavigable(snapshot, anchorX, anchorY, gridPath[candidate]!.x, gridPath[candidate]!.y)) break;
            furthest = candidate;
        }
        const waypoint = gridPath[furthest]!;
        simplified.push(waypoint);
        anchorX = waypoint.x;
        anchorY = waypoint.y;
        index = furthest + 1;
    }
    return simplified;
};

const navigateTo = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    goalX: number,
    goalY: number,
    goalKey: string,
    now: number,
): number => {
    const clampedX = Math.max(6, Math.min(snapshot.map.width - 6, goalX));
    const clampedY = Math.max(6, Math.min(snapshot.map.height - 6, goalY));
    if (segmentIsNavigable(snapshot, self.x, self.y, clampedX, clampedY)) {
        state.navigationGoalKey = undefined;
        state.navigationWaypoints = [];
        state.navigationWaypointIndex = 0;
        return angleTo(self.x, self.y, clampedX, clampedY);
    }

    const routeIsReusable = state.navigationGoalKey === goalKey
        && now < state.navigationReplanAt
        && state.navigationWaypointIndex < state.navigationWaypoints.length;
    if (!routeIsReusable) {
        state.navigationGoalKey = goalKey;
        state.navigationWaypoints = planNavigationPath(snapshot, self.x, self.y, clampedX, clampedY);
        state.navigationWaypointIndex = 0;
        state.navigationReplanAt = now + 1_350;
    }
    while (
        state.navigationWaypointIndex < state.navigationWaypoints.length - 1
        && distance(
                self.x,
                self.y,
                state.navigationWaypoints[state.navigationWaypointIndex]!.x,
                state.navigationWaypoints[state.navigationWaypointIndex]!.y,
            ) <= 7
    ) state.navigationWaypointIndex++;
    const waypoint = state.navigationWaypoints[state.navigationWaypointIndex];
    if (waypoint && segmentIsNavigable(snapshot, self.x, self.y, waypoint.x, waypoint.y)) {
        return angleTo(self.x, self.y, waypoint.x, waypoint.y);
    }
    state.navigationReplanAt = 0;
    return steerAroundWalls(snapshot, self, state, angleTo(self.x, self.y, clampedX, clampedY), now);
};

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
    movementPhase: "travel",
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
    breakableLockedUntil: 0,
    navigationWaypoints: [],
    navigationWaypointIndex: 0,
    navigationReplanAt: 0,
    roamSequence: 0,
    targetMemoryUntil: 0,
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
    // Keep normal bots in motion like active players. Tactical stop policies
    // still pause for healing, reviving, pickups, grenade cooking, and downed
    // states, but roaming and combat no longer inject artificial idle periods.
    if (state.movementPhase !== "travel" || now >= state.movementPhaseUntil) {
        state.movementPhase = "travel";
        state.movementPhaseUntil = now + movementPhaseDuration(mode, "travel", random);
    }
    return true;
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
    if (moving) state.lastMoveAngle = intent.moveAngle;
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

const tacticalGunSlots = (self: BotBrainPlayer): TacticalGunSlot[] =>
    ([
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

const hashUnit = (sessionId: string, trait: string): number => stableHash(`${sessionId}:${trait}`) / 0xffff_ffff;

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
    const nearbyEnemies =
        enemies.filter(({ player }) => distance(target.player.x, target.player.y, player.x, player.y) <= 24).length;
    const allyInBlastRadius = allies.some(({ player }) =>
        distance(target.player.x, target.player.y, player.x, player.y) <= 28
    );
    if (allyInBlastRadius) return false;
    return nearbyEnemies >= 2 || !hasClearShot(snapshot, self, target.player);
};

const lootAffinity = (sessionId: string, lootId: number): number => stableHash(`${sessionId}:${lootId}`) % 13;

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

const selectBreakableTarget = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    now: number,
    sessionId: string,
): BreakableTarget | undefined => {
    const personality = botPersonality(sessionId);
    const allies = snapshot.players.filter((player) =>
        player.connected
        && player.alive
        && player.sessionId !== sessionId
        && player.teamId === self.teamId
    );
    const candidates = (snapshot.obstacles ?? [])
        .filter((obstacle) => obstacle.destructible && obstacle.containsLoot && obstacle.health > 0)
        .map((obstacle) => {
            const obstacleDistance = distance(self.x, self.y, obstacle.x, obstacle.y);
            const competition = allies.filter((ally) =>
                distance(ally.x, ally.y, obstacle.x, obstacle.y) + 12 < obstacleDistance
            ).length;
            const utility = 104
                + Math.min(24, obstacle.health * 0.06)
                + lootAffinity(sessionId, obstacle.id) * 1.8
                - obstacleDistance * (0.22 + personality.caution * 0.04)
                - competition * 34;
            return { obstacle, distance: obstacleDistance, utility };
        })
        .filter((candidate) => candidate.distance <= Math.min(190, personality.lootRadius * 0.55))
        .sort((left, right) => right.utility - left.utility);
    const locked = now < state.breakableLockedUntil
        ? candidates.find((candidate) => candidate.obstacle.id === state.targetBreakableId)
        : undefined;
    const target = locked ?? candidates[0];
    if (!target || target.utility < 34) {
        state.targetBreakableId = undefined;
        state.breakableLockedUntil = 0;
        return undefined;
    }
    if (target.obstacle.id !== state.targetBreakableId) {
        state.targetBreakableId = target.obstacle.id;
        state.breakableLockedUntil = now + 1_700;
    }
    return target;
};

const movementWithSeparation = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    desiredAngle: number,
): number => {
    let x = Math.cos(desiredAngle);
    let y = Math.sin(desiredAngle);
    for (const player of snapshot.players) {
        if (
            !player.connected
            || !player.alive
            || player.sessionId === self.sessionId
            || player.teamId !== self.teamId
        ) continue;
        const allyDistance = distance(self.x, self.y, player.x, player.y);
        if (allyDistance <= 0.01 || allyDistance >= 18) continue;
        const strength = (18 - allyDistance) / 18 * 1.35;
        x += (self.x - player.x) / allyDistance * strength;
        y += (self.y - player.y) / allyDistance * strength;
    }
    const separatedAngle = Math.atan2(y, x);
    return rayClearance(snapshot, self, separatedAngle, 20) >= 16
        ? separatedAngle
        : desiredAngle;
};

const distributedDestination = (
    sessionId: string,
    purpose: string,
    centerX: number,
    centerY: number,
    radius: number,
): NavigationPoint => {
    const angle = hashUnit(sessionId, `${purpose}:angle`) * Math.PI * 2;
    const distanceScale = 0.28 + hashUnit(sessionId, `${purpose}:radius`) * 0.48;
    return {
        x: centerX + Math.cos(angle) * radius * distanceScale,
        y: centerY + Math.sin(angle) * radius * distanceScale,
    };
};

const updateRoamDestination = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    sessionId: string,
    now: number,
): NavigationPoint => {
    if (
        state.roamX !== undefined
        && state.roamY !== undefined
        && now < state.decisionUntil
        && distance(self.x, self.y, state.roamX, state.roamY) > 14
    ) return { x: state.roamX, y: state.roamY };
    state.roamSequence++;
    const zoneUsable = snapshot.zone.radius > 0;
    const centerX = zoneUsable ? snapshot.zone.x : snapshot.map.width / 2;
    const centerY = zoneUsable ? snapshot.zone.y : snapshot.map.height / 2;
    const maxRadius = zoneUsable
        ? Math.min(snapshot.zone.radius * 0.68, Math.min(snapshot.map.width, snapshot.map.height) * 0.36)
        : Math.min(snapshot.map.width, snapshot.map.height) * 0.34;
    const purpose = `roam:${state.roamSequence}`;
    const destination = distributedDestination(sessionId, purpose, centerX, centerY, maxRadius);
    const margin = Math.max(28, Math.min(snapshot.map.width, snapshot.map.height) * 0.045);
    state.roamX = Math.max(margin, Math.min(snapshot.map.width - margin, destination.x));
    state.roamY = Math.max(margin, Math.min(snapshot.map.height - margin, destination.y));
    state.decisionUntil = now + 3_200 + hashUnit(sessionId, `${purpose}:duration`) * 4_600;
    return { x: state.roamX, y: state.roamY };
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
            // Room snapshots arrive every 750 ms. Two consecutive stationary
            // samples are enough to distinguish a blocked bot from normal
            // movement while avoiding the previous ~6 second wall-stall.
            if (state.stuckSamples >= 2) {
                state.stuckSamples = 0;
                state.unstuckUntil = now + 1_100 + random() * 650;
                const blockedAngle = state.lastMoveAngle ?? state.wanderAngle;
                const escapeAngles = [
                    blockedAngle + state.strafeSign * Math.PI / 2,
                    blockedAngle - state.strafeSign * Math.PI / 2,
                    blockedAngle + Math.PI,
                ].sort((left, right) =>
                    rayClearance(snapshot, self, right, 64) - rayClearance(snapshot, self, left, 64)
                );
                state.wanderAngle = escapeAngles[0]!;
                state.strafeSign = state.strafeSign === 1 ? -1 : 1;
                state.navigationReplanAt = 0;
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

/**
 * Linear-time combat for high bot counts. This intentionally skips the full
 * navigation, flank, and spatial-index work while retaining visible looting,
 * gun fights, reloading, and crate attacks.
 */
export const decideLightweightCombatIntent = (
    snapshot: BotBrainSnapshot | undefined,
    sessionId: string,
    state: BotBrainState,
    now = Date.now(),
    random: () => number = Math.random,
): BotIntent => {
    const snapshotIsFresh = snapshot && now - snapshot.capturedAt <= snapshotFreshnessMs;
    const self = snapshotIsFresh
        ? snapshot.players.find((player) => player.sessionId === sessionId && player.connected)
        : undefined;
    if (!snapshotIsFresh || !self || !self.alive) {
        if (now >= state.decisionUntil) {
            state.wanderAngle = random() * Math.PI * 2;
            state.decisionUntil = now + 550 + random() * 500;
        }
        return finishIntent(
            state,
            {
                mode: "wander",
                moveAngle: state.wanderAngle,
                aimAngle: state.wanderAngle,
                aimDistance: 48,
                shoot: false,
                interact: false,
                reload: false,
            },
            "force",
            now,
            random,
        );
    }

    if (snapshot.capturedAt !== state.lastSnapshotAt) {
        if (state.lastX !== undefined && state.lastY !== undefined && state.lastMovementCommanded) {
            const moved = distance(state.lastX, state.lastY, self.x, self.y);
            // A doorway stall is visible one snapshot sooner through the
            // authoritative indoors flag. Outdoors we retain the two-sample
            // guard so normal movement pauses do not trigger false escapes.
            const stuckDistance = self.indoors ? 1.35 : 0.8;
            const requiredStuckSamples = self.indoors ? 1 : 2;
            state.stuckSamples = moved < stuckDistance ? state.stuckSamples + 1 : 0;
            if (state.stuckSamples >= requiredStuckSamples) {
                state.stuckSamples = 0;
                state.unstuckUntil = now + 950 + random() * 450;
                state.wanderAngle = (state.lastMoveAngle ?? state.wanderAngle)
                    + state.strafeSign * (Math.PI * 0.62 + (random() - 0.5) * 0.55);
                state.strafeSign = state.strafeSign === 1 ? -1 : 1;
                if (state.targetLootId !== undefined) state.lootLockedUntil = now + 3_000;
                if (state.targetBreakableId !== undefined) state.breakableLockedUntil = now + 3_000;
            }
        }
        state.lastX = self.x;
        state.lastY = self.y;
        state.lastSnapshotAt = snapshot.capturedAt;
    }
    if (now < state.unstuckUntil) {
        return finishIntent(
            state,
            {
                mode: "unstuck",
                moveAngle: state.wanderAngle,
                aimAngle: state.wanderAngle,
                aimDistance: 48,
                shoot: false,
                interact: false,
                reload: false,
            },
            "force",
            now,
            random,
        );
    }

    let enemy: Target | undefined;
    for (const player of snapshot.players) {
        if (
            !player.connected
            || !player.alive
            || player.downed === true
            || player.sessionId === sessionId
            || player.teamId === self.teamId
        ) continue;
        const targetDistance = distance(self.x, self.y, player.x, player.y);
        if (!enemy || targetDistance < enemy.distance) enemy = { player, distance: targetDistance };
    }

    const activeKind = weaponKind(self.weapon);
    const gunSlots = tacticalGunSlots(self);
    const loadedGun = gunSlots.find((slot) => slot.ammo > 0);
    const storedGun = loadedGun ?? gunSlots[0];
    const activeGunHasAmmo = activeKind === "gun" && self.ammo > 0;
    if (enemy && enemy.distance <= 300 && (activeGunHasAmmo || storedGun)) {
        state.targetLootId = undefined;
        state.targetBreakableId = undefined;
        const profile = weaponProfile(self.weapon);
        const shouldEquip = activeKind !== "gun"
            ? storedGun?.equip
            : self.ammo <= 0 && loadedGun && loadedGun.slot !== self.activeSlot
            ? loadedGun.equip
            : undefined;
        const shouldReload = activeKind === "gun" && self.ammo <= 0 && shouldEquip === undefined;
        const travelSeconds = Number.isFinite(profile.projectileSpeed)
            ? Math.min(0.45, enemy.distance / Math.max(1, profile.projectileSpeed))
            : 0;
        const targetAngle = angleTo(
            self.x,
            self.y,
            enemy.player.x + enemy.player.vx * travelSeconds,
            enemy.player.y + enemy.player.vy * travelSeconds,
        );
        if (now >= state.nextStrafeFlipAt) {
            state.strafeSign = state.strafeSign === 1 ? -1 : 1;
            state.nextStrafeFlipAt = now + 750 + random() * 550;
        }
        const preferredRange = profile.kind === "gun" ? profile.preferredRange : 90;
        const moveAngle = enemy.distance > preferredRange * 1.25
            ? targetAngle
            : enemy.distance < preferredRange * 0.55
            ? targetAngle + Math.PI
            : targetAngle + state.strafeSign * Math.PI / 2;
        const canShoot = activeGunHasAmmo
            && profile.kind === "gun"
            && enemy.distance <= profile.effectiveRange;
        return finishIntent(
            state,
            {
                mode: "combat",
                moveAngle,
                aimAngle: targetAngle,
                aimDistance: Math.min(64, Math.max(18, enemy.distance)),
                shoot: canShoot,
                interact: false,
                reload: shouldReload,
                equip: shouldEquip,
                forceShootStart: canShoot,
            },
            "force",
            now,
            random,
        );
    }

    const activeDefinition = GameObjectDefs.typeToDefSafe(self.weapon);
    const wantedAmmo = activeDefinition?.type === "gun" ? activeDefinition.ammo : undefined;
    let lootTarget: BotBrainLoot | undefined;
    let lootDistance = Number.POSITIVE_INFINITY;
    const needsGun = gunSlots.length === 0 && activeKind !== "gun";
    const needsAmmo = activeKind === "gun" && self.ammo <= 0 && gunSlots.every((slot) => slot.reserve <= 0);
    for (const loot of snapshot.loot ?? []) {
        if (!(needsGun && loot.kind === "gun") && !(needsAmmo && loot.kind === "ammo" && loot.type === wantedAmmo)) {
            continue;
        }
        const candidateDistance = distance(self.x, self.y, loot.x, loot.y);
        if (candidateDistance < lootDistance) {
            lootTarget = loot;
            lootDistance = candidateDistance;
        }
    }
    const lootTemporarilyBlocked = Boolean(
        lootTarget && now < state.lootLockedUntil && lootTarget.id === state.targetLootId
    );
    if (lootTarget && lootDistance <= 96 && !lootTemporarilyBlocked) {
        state.targetLootId = lootTarget.id;
        state.targetBreakableId = undefined;
        const lootAngle = angleTo(self.x, self.y, lootTarget.x, lootTarget.y);
        return finishIntent(
            state,
            {
                mode: "loot",
                moveAngle: lootAngle,
                aimAngle: lootAngle,
                aimDistance: Math.min(64, Math.max(12, lootDistance)),
                shoot: false,
                interact: lootDistance <= 2.2,
                reload: false,
            },
            "force",
            now,
            random,
        );
    }

    let crate: BotBrainObstacle | undefined;
    let crateDistance = Number.POSITIVE_INFINITY;
    for (const obstacle of snapshot.obstacles ?? []) {
        if (!obstacle.destructible || !obstacle.containsLoot || obstacle.health <= 0) continue;
        if (now < state.breakableLockedUntil && obstacle.id === state.targetBreakableId) continue;
        const candidateDistance = distance(self.x, self.y, obstacle.x, obstacle.y);
        if (candidateDistance < crateDistance) {
            crate = obstacle;
            crateDistance = candidateDistance;
        }
    }
    if (crate && crateDistance <= 190) {
        state.targetBreakableId = crate.id;
        state.targetLootId = undefined;
        const crateAngle = angleTo(self.x, self.y, crate.x, crate.y);
        const perimeterDistance = Math.max(0, crateDistance - Math.max(crate.width, crate.height) / 2);
        const activeGunSlot = gunSlots.find((slot) => slot.slot === self.activeSlot);
        const shouldReloadGun = activeKind === "gun"
            && self.ammo <= 0
            && (activeGunSlot?.reserve ?? 0) > 0;
        const canShootCrate = activeKind === "gun" && self.ammo > 0 && perimeterDistance <= 58;
        const shouldEquipMelee = activeKind !== "melee"
            && !shouldReloadGun
            && !(activeKind === "gun" && self.ammo > 0)
            && perimeterDistance <= 20;
        // Fists reach 1.35 units forward with a 0.9 radius collider. Using the
        // broader player-combat distance made bots stop 3-5 units from crates.
        const canStrike = activeKind === "melee" && perimeterDistance <= 2.25;
        return finishIntent(
            state,
            {
                mode: "break",
                moveAngle: crateAngle,
                aimAngle: crateAngle,
                aimDistance: Math.min(64, Math.max(8, crateDistance)),
                shoot: canShootCrate || canStrike,
                interact: false,
                reload: shouldReloadGun,
                equip: shouldEquipMelee ? "melee" : undefined,
                forceShootStart: canShootCrate || canStrike,
            },
            canShootCrate || canStrike || shouldEquipMelee || shouldReloadGun ? "stop" : "force",
            now,
            random,
        );
    }

    if (lootTarget && lootDistance <= 520 && !lootTemporarilyBlocked) {
        state.targetLootId = lootTarget.id;
        state.targetBreakableId = undefined;
        const lootAngle = angleTo(self.x, self.y, lootTarget.x, lootTarget.y);
        return finishIntent(
            state,
            {
                mode: "loot",
                moveAngle: lootAngle,
                aimAngle: lootAngle,
                aimDistance: Math.min(64, Math.max(12, lootDistance)),
                shoot: false,
                interact: lootDistance <= 2.2,
                reload: false,
            },
            "force",
            now,
            random,
        );
    }

    state.targetLootId = undefined;
    state.targetBreakableId = undefined;
    if (now >= state.decisionUntil) {
        state.wanderAngle = random() * Math.PI * 2;
        state.decisionUntil = now + 700 + random() * 650;
    }
    return finishIntent(
        state,
        {
            mode: "wander",
            moveAngle: state.wanderAngle,
            aimAngle: enemy ? angleTo(self.x, self.y, enemy.player.x, enemy.player.y) : state.wanderAngle,
            aimDistance: enemy ? Math.min(64, Math.max(18, enemy.distance)) : 48,
            shoot: false,
            interact: false,
            reload: activeKind === "gun" && self.ammo <= 0,
        },
        "force",
        now,
        random,
    );
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
        state.targetBreakableId = undefined;
        state.breakableLockedUntil = 0;
        state.navigationGoalKey = undefined;
        state.navigationWaypoints = [];
        state.navigationWaypointIndex = 0;
        state.targetMemoryUntil = 0;
        if (now >= state.decisionUntil) {
            state.wanderAngle = random() * Math.PI * 2;
            // The lightweight high-population mode has no world snapshot.
            // Re-pick a heading about once per second so a bot that reaches a
            // wall quickly finds an open direction instead of pushing against
            // the same obstacle for several seconds.
            state.decisionUntil = now + 550 + random() * 500;
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

    const allEnemies = snapshot.players
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
    const sightRange = 350 + hashUnit(sessionId, "sight-range") * 170;
    const directlyPerceived = allEnemies.filter(({ player, distance: targetDistance }) =>
        targetDistance <= 125
        || (targetDistance <= sightRange && hasClearShot(snapshot, self, player))
        || (now < state.underFireUntil && targetDistance <= 300)
    );
    const rememberedTarget = now < state.targetMemoryUntil
        ? allEnemies.find(({ player }) => player.sessionId === state.targetSessionId)
        : undefined;
    const enemies = [...directlyPerceived];
    if (rememberedTarget && !enemies.some(({ player }) => player.sessionId === rememberedTarget.player.sessionId)) {
        enemies.push(rememberedTarget);
        enemies.sort((left, right) => left.distance - right.distance);
    }
    const target = selectTarget(enemies, state, now, random);
    if (target && directlyPerceived.some(({ player }) => player.sessionId === target.player.sessionId)) {
        state.targetLastSeenX = target.player.x;
        state.targetLastSeenY = target.player.y;
        state.targetMemoryUntil = now + 2_200 + personality.aggression * 450;
    } else if (!target) {
        state.targetLastSeenX = undefined;
        state.targetLastSeenY = undefined;
        state.targetMemoryUntil = 0;
    }
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
            ? navigateTo(
                snapshot,
                self,
                state,
                rescueAlly.player.x,
                rescueAlly.player.y,
                `downed:${rescueAlly.player.sessionId}`,
                now,
            )
            : target
            ? targetAngle + Math.PI
            : angleTo(self.x, self.y, snapshot.zone.x, snapshot.zone.y);
        return finishIntent(
            state,
            {
                mode: "downed",
                moveAngle: movementWithSeparation(
                    snapshot,
                    self,
                    steerAroundWalls(snapshot, self, state, crawlAngle, now),
                ),
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
        const edgeDestination = distributedDestination(
            sessionId,
            "map-edge",
            snapshot.map.width / 2,
            snapshot.map.height / 2,
            Math.min(snapshot.map.width, snapshot.map.height) * 0.24,
        );
        const centerAngle = navigateTo(
            snapshot,
            self,
            state,
            edgeDestination.x,
            edgeDestination.y,
            `edge:${Math.round(edgeDestination.x)}:${Math.round(edgeDestination.y)}`,
            now,
        );
        const atHardEdge = self.x < edgeMargin * 0.35
            || self.y < edgeMargin * 0.35
            || self.x > snapshot.map.width - edgeMargin * 0.35
            || self.y > snapshot.map.height - edgeMargin * 0.35;
        return finishIntent(
            state,
            {
                mode: "edge",
                moveAngle: movementWithSeparation(snapshot, self, centerAngle),
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
        const zoneRadius = shouldReturnToCurrentZone ? snapshot.zone.radius : snapshot.zone.nextRadius;
        const safeDestination = distributedDestination(
            sessionId,
            shouldReturnToCurrentZone ? "current-zone" : "next-zone",
            zoneX,
            zoneY,
            zoneRadius * 0.58,
        );
        const safeAngle = navigateTo(
            snapshot,
            self,
            state,
            safeDestination.x,
            safeDestination.y,
            `zone:${Math.round(zoneX)}:${Math.round(zoneY)}:${Math.round(zoneRadius)}`,
            now,
        );
        const outsideCurrentZone = snapshot.zone.radius > 0 && zoneDistance > snapshot.zone.radius;
        return finishIntent(
            state,
            {
                mode: "zone",
                moveAngle: movementWithSeparation(snapshot, self, safeAngle),
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
        const rescueAngle = navigateTo(
            snapshot,
            self,
            state,
            downedAlly.player.x,
            downedAlly.player.y,
            `rescue:${downedAlly.player.sessionId}`,
            now,
        );
        const canRevive = downedAlly.distance <= 5.5;
        return finishIntent(
            state,
            {
                mode: "rescue",
                moveAngle: movementWithSeparation(snapshot, self, rescueAngle),
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
    const breakableTarget = selectBreakableTarget(snapshot, self, state, now, sessionId);
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
    const canBreakCrate = !target || target.distance > (needsWeaponOrAmmo ? 110 : 240);
    const shouldBreakCrate = Boolean(
        breakableTarget
            && canBreakCrate
            && (
                !lootTarget
                || breakableTarget.utility + (needsWeaponOrAmmo ? 48 : 22) > lootTarget.utility
            ),
    );
    if (breakableTarget && shouldBreakCrate) {
        const obstacle = breakableTarget.obstacle;
        const obstacleRadius = Math.max(obstacle.width, obstacle.height) / 2;
        const perimeterDistance = Math.max(0, breakableTarget.distance - obstacleRadius);
        const obstacleAngle = angleTo(self.x, self.y, obstacle.x, obstacle.y);
        const activeKind = weaponKind(self.weapon);
        const shouldEquipMelee = activeKind !== "melee" && perimeterDistance <= 22;
        const canStrike = activeKind === "melee" && perimeterDistance <= meleeAttackDistance;
        const approachDistance = obstacleRadius + 2.8;
        const approachX = obstacle.x - Math.cos(obstacleAngle) * approachDistance;
        const approachY = obstacle.y - Math.sin(obstacleAngle) * approachDistance;
        const moveAngle = navigateTo(
            snapshot,
            self,
            state,
            approachX,
            approachY,
            `break:${obstacle.id}`,
            now,
        );
        return finishIntent(
            state,
            {
                mode: "break",
                moveAngle: movementWithSeparation(snapshot, self, moveAngle),
                aimAngle: obstacleAngle,
                aimDistance: Math.min(64, Math.max(8, breakableTarget.distance)),
                shoot: canStrike,
                interact: false,
                reload: false,
                equip: shouldEquipMelee ? "melee" : undefined,
                forceShootStart: canStrike,
            },
            canStrike || shouldEquipMelee ? "stop" : "force",
            now,
            random,
        );
    }
    if (lootTarget && canBreakForLoot) {
        const lootAngle = angleTo(self.x, self.y, lootTarget.loot.x, lootTarget.loot.y);
        const lootMoveAngle = navigateTo(
            snapshot,
            self,
            state,
            lootTarget.loot.x,
            lootTarget.loot.y,
            `loot:${lootTarget.loot.id}`,
            now,
        );
        // The authoritative player pickup check uses player radius + loot radius
        // (normally 2-2.25 world units), so do not stop outside that circle.
        const withinPickupRange = lootTarget.distance <= 1.8;
        return finishIntent(
            state,
            {
                mode: "loot",
                moveAngle: movementWithSeparation(snapshot, self, lootMoveAngle),
                aimAngle: target ? targetAngle : lootAngle,
                aimDistance: aimDistance(target, Math.min(64, Math.max(12, lootTarget.distance))),
                shoot: false,
                interact: withinPickupRange,
                reload: false,
            },
            // Keep crossing the pickup circle while interacting. Stopping on
            // its edge made some watched bots appear frozen beside loot.
            "force",
            now,
            random,
        );
    }

    if (target && target.distance <= combatAwarenessDistance && !hasClearShot(snapshot, self, target.player)) {
        const waypoint = selectFlankWaypoint(snapshot, self, target.player, state, now);
        if (waypoint) {
            return finishIntent(
                state,
                {
                    mode: "flank",
                    moveAngle: movementWithSeparation(
                        snapshot,
                        self,
                        navigateTo(
                            snapshot,
                            self,
                            state,
                            waypoint.x,
                            waypoint.y,
                            `flank:${target.player.sessionId}`,
                            now,
                        ),
                    ),
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
                moveAngle: movementWithSeparation(
                    snapshot,
                    self,
                    steerAroundWalls(snapshot, self, state, moveAngle, now),
                ),
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
        const huntX = waypoint?.x ?? state.targetLastSeenX ?? target.player.x;
        const huntY = waypoint?.y ?? state.targetLastSeenY ?? target.player.y;
        const huntAngle = navigateTo(
            snapshot,
            self,
            state,
            huntX,
            huntY,
            `hunt:${target.player.sessionId}:${waypoint ? "flank" : "seen"}`,
            now,
        ) + state.strafeSign * personality.orbitAngle * (
                    personality.style === "flanker" ? 0.08 : 0.025
                );
        return finishIntent(
            state,
            {
                mode: "hunt",
                moveAngle: movementWithSeparation(snapshot, self, huntAngle),
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

    const roamDestination = updateRoamDestination(snapshot, self, state, sessionId, now);
    const nearestAlly = allies[0];
    const followSmallSquad = allies.length <= 3 && nearestAlly && nearestAlly.distance > 260;
    const wanderX = followSmallSquad ? nearestAlly.player.x : roamDestination.x;
    const wanderY = followSmallSquad ? nearestAlly.player.y : roamDestination.y;
    const wanderAngle = navigateTo(
        snapshot,
        self,
        state,
        wanderX,
        wanderY,
        followSmallSquad ? `squad:${nearestAlly.player.sessionId}` : `roam:${state.roamSequence}`,
        now,
    ) + (followSmallSquad ? formationOffset(sessionId) : personality.roamBias * 0.05);
    return finishIntent(
        state,
        {
            mode: "wander",
            moveAngle: movementWithSeparation(snapshot, self, wanderAngle),
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
