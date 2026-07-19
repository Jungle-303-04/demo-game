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
}

export interface BotBrainSnapshot {
    capturedAt: number;
    map: {
        width: number;
        height: number;
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

export interface BotBrainLoot {
    id: number;
    type: string;
    kind: string;
    x: number;
    y: number;
    count: number;
}

export type BotIntentMode = "wander" | "loot" | "combat" | "zone" | "edge" | "unstuck" | "heal";
export type BotEquipIntent = "otherGun";
export type BotUseItemIntent = "bandage" | "healthkit";
export type BotMovementPhase = "travel" | "rest";

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
}

type BotIntentWithoutMovement = Omit<BotIntent, "moving">;
type MovementPolicy = "rhythm" | "force" | "stop";
type Target = { player: BotBrainPlayer; distance: number };
type LootTarget = { loot: BotBrainLoot; distance: number; utility: number };

const snapshotFreshnessMs = 2_000;
const targetLockMinMs = 1_000;
const targetLockJitterMs = 800;
const gunFireDistance = 220;
const meleeAttackDistance = 5.5;
const combatAwarenessDistance = 900;
const lootAwarenessDistance = 340;

const distance = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

const angleTo = (ax: number, ay: number, bx: number, by: number): number => Math.atan2(by - ay, bx - ax);

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

const reloadGraceMs = (weapon: string): number => {
    const definition = GameObjectDefs.typeToDefSafe(weapon);
    if (definition?.type !== "gun") return 2_800;
    const longestReloadSeconds = Math.max(definition.reloadTime, definition.reloadTimeAlt ?? 0);
    return Math.max(2_800, longestReloadSeconds * 1_000 + 750);
};

const weaponActions = (
    state: BotBrainState,
    self: BotBrainPlayer,
    targetDistance: number | undefined,
    now: number,
): Pick<BotIntent, "reload" | "equip"> => {
    const kind = weaponKind(self.weapon);
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
    const kind = weaponKind(self.weapon);
    if (kind === "gun") return self.ammo > 0 && target.distance <= gunFireDistance;
    if (kind === "melee") return target.distance <= meleeAttackDistance;
    return false;
};

const selectTarget = (
    enemies: Target[],
    state: BotBrainState,
    now: number,
    random: () => number,
): Target | undefined => {
    const nearest = enemies[0];
    const locked = now < state.targetLockedUntil
        ? enemies.find(({ player }) => player.sessionId === state.targetSessionId)
        : undefined;
    const immediateThreat = nearest
        && (!locked || nearest.distance < 70 || nearest.distance < locked.distance * 0.55);
    const target = immediateThreat ? nearest : locked ?? nearest;

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
    const currentWeapon = GameObjectDefs.typeToDefSafe(self.weapon);
    const matchingAmmo = currentWeapon?.type === "gun" && currentWeapon.ammo === loot.type;
    switch (loot.kind) {
        case "gun":
            return weaponKind(self.weapon) === "gun" && self.ammo > 0 ? 58 : 120;
        case "ammo":
            return matchingAmmo ? (self.ammo < 12 ? 115 : self.ammo < 45 ? 82 : 24) : 18;
        case "heal":
            return self.health < 45 ? 110 : (self.bandages ?? 0) + (self.healthkits ?? 0) < 2 ? 72 : 28;
        case "chest":
        case "helmet":
            return self.armor < 35 ? 92 : self.armor < 70 ? 56 : 18;
        case "backpack":
        case "scope":
            return 48;
        case "boost":
            return self.health < 80 ? 52 : 34;
        case "melee":
        case "throwable":
            return weaponKind(self.weapon) === "gun" ? 20 : 38;
        default:
            return 8;
    }
};

const selectLootTarget = (
    snapshot: BotBrainSnapshot,
    self: BotBrainPlayer,
    state: BotBrainState,
    now: number,
): LootTarget | undefined => {
    const candidates = (snapshot.loot ?? [])
        .map((loot) => ({
            loot,
            distance: distance(self.x, self.y, loot.x, loot.y),
            utility: lootUtility(self, loot),
        }))
        .filter((candidate) => candidate.distance <= lootAwarenessDistance && candidate.utility >= 20)
        .sort((left, right) =>
            (right.utility - right.distance * 0.12) - (left.utility - left.distance * 0.12)
        );
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
        state.lootLockedUntil = now + 1_200;
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

    const enemies = snapshot.players
        .filter((player) =>
            player.connected
            && player.alive
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
    const target = selectTarget(enemies, state, now, random);
    const targetAngle = target
        ? angleTo(
            self.x,
            self.y,
            target.player.x + target.player.vx * Math.min(0.45, target.distance / 500),
            target.player.y + target.player.vy * Math.min(0.45, target.distance / 500),
        )
        : state.wanderAngle;
    const combatActions = { ...actions, ...weaponActions(state, self, target?.distance, now) };
    const shoot = canShootTarget(self, target);

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
                moveAngle: centerAngle,
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
                moveAngle: safeAngle,
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
    const closeThreat = Boolean(nearestEnemy && nearestEnemy.distance <= gunFireDistance);
    if (state.healingUntil > now && !closeThreat && self.health < 90) {
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
    if (self.health < 45 && !closeThreat && now >= state.nextHealAt) {
        const bandages = self.bandages ?? 0;
        const healthkits = self.healthkits ?? 0;
        const useItem: BotUseItemIntent | undefined = self.health <= 25 && healthkits > 0
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

    const lootTarget = selectLootTarget(snapshot, self, state, now);
    const needsWeaponOrAmmo = weaponKind(self.weapon) !== "gun" || self.ammo <= 0;
    const canBreakForLoot = !target
        || target.distance > (needsWeaponOrAmmo || (lootTarget?.utility ?? 0) >= 90 ? 180 : 520);
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

    if (target && target.distance <= combatAwarenessDistance) {
        if (state.nextStrafeFlipAt <= 0) {
            state.nextStrafeFlipAt = now + 550 + random() * 900;
        } else if (now >= state.nextStrafeFlipAt) {
            if (random() < 0.7) state.strafeSign = state.strafeSign === 1 ? -1 : 1;
            state.nextStrafeFlipAt = now + 550 + random() * 900;
        }
        let moveAngle = targetAngle;
        if (weaponKind(self.weapon) === "gun") {
            if (target.distance < 45) {
                moveAngle += Math.PI;
            } else if (target.distance <= 180) {
                moveAngle += state.strafeSign * Math.PI / 2;
            } else {
                moveAngle += state.strafeSign * 0.2;
            }
        }
        return finishIntent(
            state,
            {
                mode: "combat",
                moveAngle,
                aimAngle: targetAngle,
                aimDistance: aimDistance(target),
                shoot,
                ...combatActions,
            },
            "rhythm",
            now,
            random,
        );
    }

    if (now >= state.decisionUntil) {
        state.wanderAngle += (random() - 0.5) * Math.PI * 1.35;
        state.decisionUntil = now + 1_800 + random() * 2_800;
        if (random() < 0.28) state.strafeSign = state.strafeSign === 1 ? -1 : 1;
    }
    const nearestAlly = allies[0];
    const wanderAngle = nearestAlly && nearestAlly.distance > 220
        ? angleTo(self.x, self.y, nearestAlly.player.x, nearestAlly.player.y) + formationOffset(sessionId)
        : state.wanderAngle;
    return finishIntent(
        state,
        {
            mode: "wander",
            moveAngle: wanderAngle,
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
