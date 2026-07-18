export interface BotBrainPlayer {
    sessionId: string;
    team: "red" | "blue";
    x: number;
    y: number;
    alive: boolean;
    connected: boolean;
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
    };
    players: BotBrainPlayer[];
}

export type BotIntentMode = "wander" | "combat" | "zone" | "edge" | "unstuck";
export type BotEquipIntent = "primary" | "secondary" | "melee";

export interface BotBrainState {
    wanderAngle: number;
    decisionUntil: number;
    strafeSign: -1 | 1;
    lastSnapshotAt: number;
    lastX?: number;
    lastY?: number;
    stuckSamples: number;
    unstuckUntil: number;
    nextInteractAt: number;
    nextEquipAt: number;
    equipIndex: number;
}

export interface BotIntent {
    mode: BotIntentMode;
    moveAngle: number;
    aimAngle: number;
    aimDistance: number;
    shoot: boolean;
    interact: boolean;
    equip?: BotEquipIntent;
}

const distance = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

const angleTo = (ax: number, ay: number, bx: number, by: number): number => Math.atan2(by - ay, bx - ax);

export const createBotBrainState = (random: () => number = Math.random): BotBrainState => ({
    wanderAngle: random() * Math.PI * 2,
    decisionUntil: 0,
    strafeSign: random() < 0.5 ? -1 : 1,
    lastSnapshotAt: 0,
    stuckSamples: 0,
    unstuckUntil: 0,
    nextInteractAt: 0,
    nextEquipAt: 0,
    equipIndex: 0,
});

const periodicActions = (
    state: BotBrainState,
    now: number,
    random: () => number,
): Pick<BotIntent, "interact" | "equip"> => {
    const interact = now >= state.nextInteractAt;
    if (interact) state.nextInteractAt = now + 420 + random() * 380;

    let equip: BotEquipIntent | undefined;
    if (now >= state.nextEquipAt) {
        const equipOrder: BotEquipIntent[] = ["primary", "secondary", "melee"];
        equip = equipOrder[state.equipIndex % equipOrder.length];
        state.equipIndex += 1;
        state.nextEquipAt = now + 3_800 + random() * 2_400;
    }
    return { interact, equip };
};

export const decideBotIntent = (
    snapshot: BotBrainSnapshot | undefined,
    sessionId: string,
    state: BotBrainState,
    now = Date.now(),
    random: () => number = Math.random,
): BotIntent => {
    const actions = periodicActions(state, now, random);
    const self = snapshot?.players.find((player) => player.sessionId === sessionId && player.connected);

    if (!snapshot || !self || !self.alive) {
        if (now >= state.decisionUntil) {
            state.wanderAngle = random() * Math.PI * 2;
            state.decisionUntil = now + 1_500 + random() * 2_000;
        }
        return {
            mode: "wander",
            moveAngle: state.wanderAngle,
            aimAngle: state.wanderAngle,
            aimDistance: 48,
            shoot: false,
            ...actions,
        };
    }

    if (snapshot.capturedAt !== state.lastSnapshotAt) {
        if (state.lastX !== undefined && state.lastY !== undefined) {
            const moved = distance(state.lastX, state.lastY, self.x, self.y);
            state.stuckSamples = moved < 1.1 ? state.stuckSamples + 1 : 0;
            if (state.stuckSamples >= 4) {
                state.stuckSamples = 0;
                state.unstuckUntil = now + 900 + random() * 500;
                state.wanderAngle += state.strafeSign * (Math.PI * (0.55 + random() * 0.35));
                state.strafeSign = state.strafeSign === 1 ? -1 : 1;
            }
        }
        state.lastX = self.x;
        state.lastY = self.y;
        state.lastSnapshotAt = snapshot.capturedAt;
    }

    const enemies = snapshot.players
        .filter((player) => player.connected && player.alive && player.team !== self.team)
        .map((player) => ({
            player,
            distance: distance(self.x, self.y, player.x, player.y),
        }))
        .sort((left, right) => left.distance - right.distance);
    const target = enemies[0];
    const targetAngle = target
        ? angleTo(self.x, self.y, target.player.x, target.player.y)
        : state.wanderAngle;

    if (now < state.unstuckUntil) {
        return {
            mode: "unstuck",
            moveAngle: state.wanderAngle,
            aimAngle: targetAngle,
            aimDistance: target ? Math.min(64, Math.max(30, target.distance)) : 48,
            shoot: Boolean(target && target.distance <= 150),
            ...actions,
        };
    }

    const edgeMargin = Math.max(70, Math.min(snapshot.map.width, snapshot.map.height) * 0.07);
    const outsideMapCenter = self.x < edgeMargin
        || self.y < edgeMargin
        || self.x > snapshot.map.width - edgeMargin
        || self.y > snapshot.map.height - edgeMargin;
    if (outsideMapCenter) {
        const centerAngle = angleTo(
            self.x,
            self.y,
            snapshot.map.width / 2,
            snapshot.map.height / 2,
        );
        return {
            mode: "edge",
            moveAngle: centerAngle,
            aimAngle: targetAngle,
            aimDistance: target ? Math.min(64, Math.max(30, target.distance)) : 60,
            shoot: Boolean(target && target.distance <= 180),
            ...actions,
        };
    }

    const zoneDistance = distance(self.x, self.y, snapshot.zone.x, snapshot.zone.y);
    if (snapshot.zone.radius > 0 && zoneDistance > snapshot.zone.radius * 0.78) {
        const safeAngle = angleTo(self.x, self.y, snapshot.zone.x, snapshot.zone.y);
        return {
            mode: "zone",
            moveAngle: safeAngle,
            aimAngle: targetAngle,
            aimDistance: target ? Math.min(64, Math.max(30, target.distance)) : 60,
            shoot: Boolean(target && target.distance <= 180),
            ...actions,
        };
    }

    if (target && target.distance <= 520) {
        let moveAngle = targetAngle;
        if (target.distance < 38) {
            moveAngle += Math.PI;
        } else if (target.distance <= 105) {
            moveAngle += state.strafeSign * Math.PI / 2;
        }
        return {
            mode: "combat",
            moveAngle,
            aimAngle: targetAngle,
            aimDistance: Math.min(64, Math.max(30, target.distance)),
            shoot: target.distance <= 220,
            ...actions,
        };
    }

    if (now >= state.decisionUntil) {
        state.wanderAngle += (random() - 0.5) * Math.PI * 1.35;
        state.decisionUntil = now + 1_800 + random() * 2_800;
        if (random() < 0.28) state.strafeSign = state.strafeSign === 1 ? -1 : 1;
    }
    return {
        mode: "wander",
        moveAngle: state.wanderAngle,
        aimAngle: targetAngle,
        aimDistance: target ? Math.min(64, Math.max(30, target.distance)) : 48,
        shoot: false,
        ...actions,
    };
};
