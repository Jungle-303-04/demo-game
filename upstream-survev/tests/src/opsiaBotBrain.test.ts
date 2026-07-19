import { describe, expect, test } from "vitest";
import {
    type BotBrainPlayer,
    type BotBrainSnapshot,
    createBotBrainState,
    decideBotIntent,
} from "../../server/src/opsia/botBrain.ts";

const player = (overrides: Partial<BotBrainPlayer> = {}): BotBrainPlayer => ({
    sessionId: "self",
    teamId: overrides.team === "blue" ? 2 : 1,
    team: "red",
    x: 500,
    y: 500,
    vx: 0,
    vy: 0,
    alive: true,
    connected: true,
    health: 100,
    armor: 0,
    weapon: "m9",
    ammo: 15,
    bandages: 0,
    healthkits: 0,
    ...overrides,
});

const snapshot = (overrides: Partial<BotBrainSnapshot> = {}): BotBrainSnapshot => ({
    capturedAt: 1,
    map: { width: 1_000, height: 1_000 },
    zone: { x: 500, y: 500, radius: 460, nextX: 500, nextY: 500, nextRadius: 460 },
    players: [
        player(),
        player({ sessionId: "enemy", team: "blue", x: 600, y: 500 }),
    ],
    ...overrides,
});

describe("Opsia protocol bot brain", () => {
    test("tracks and shoots a nearby enemy instead of firing randomly", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(snapshot(), "self", state, 1_000, () => 0.5);

        expect(intent.mode).toBe("combat");
        expect(intent.aimAngle).toBeCloseTo(0);
        expect(intent.aimDistance).toBeLessThanOrEqual(64);
        expect(intent.shoot).toBe(true);
    });

    test("alternates travel and rest without dropping combat aim", () => {
        const state = createBotBrainState(() => 0.5);
        state.movementPhase = "travel";
        state.movementPhaseUntil = 1_200;
        const stateSnapshot = snapshot({ capturedAt: 1_000 });

        const travelling = decideBotIntent(stateSnapshot, "self", state, 1_100, () => 0.5);
        const resting = decideBotIntent(stateSnapshot, "self", state, 1_300, () => 0.5);
        const stillResting = decideBotIntent(stateSnapshot, "self", state, 1_999, () => 0.5);
        const travellingAgain = decideBotIntent(stateSnapshot, "self", state, 2_001, () => 0.5);

        expect(travelling.moving).toBe(true);
        expect(resting.moving).toBe(false);
        expect(stillResting.moving).toBe(false);
        expect(travellingAgain.moving).toBe(true);
        for (const intent of [travelling, resting, stillResting, travellingAgain]) {
            expect(intent.mode).toBe("combat");
            expect(intent.aimAngle).toBeCloseTo(0);
            expect(intent.shoot).toBe(true);
        }
    });

    test("does not treat an intentional rest as being stuck", () => {
        const state = createBotBrainState(() => 0.5);
        state.movementPhase = "rest";
        state.movementPhaseUntil = 5_000;

        for (let index = 0; index < 6; index++) {
            const intent = decideBotIntent(
                snapshot({ capturedAt: 1_000 + index }),
                "self",
                state,
                1_100 + index * 200,
                () => 0.5,
            );
            expect(intent.mode).not.toBe("unstuck");
            expect(intent.moving).toBe(false);
        }
        expect(state.stuckSamples).toBe(0);
    });

    test("prioritizes returning to the safe zone and keeps moving outside gas", () => {
        const state = createBotBrainState(() => 0.5);
        state.movementPhase = "rest";
        state.movementPhaseUntil = 5_000;
        const stateSnapshot = snapshot({
            zone: { x: 500, y: 500, radius: 200, nextX: 500, nextY: 500, nextRadius: 200 },
            players: [
                player({ x: 800 }),
                player({ sessionId: "enemy", team: "blue", x: 820 }),
            ],
        });
        const intent = decideBotIntent(stateSnapshot, "self", state, 1_000, () => 0.5);

        expect(intent.mode).toBe("zone");
        expect(Math.abs(intent.moveAngle)).toBeCloseTo(Math.PI);
        expect(intent.moving).toBe(true);
    });

    test("prepositions for the next safe circle before current gas is urgent", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                zone: { x: 500, y: 500, radius: 460, nextX: 780, nextY: 500, nextRadius: 120 },
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("zone");
        expect(intent.moveAngle).toBeCloseTo(0);
    });

    test("ignores teammates when choosing a combat target", () => {
        const state = createBotBrainState(() => 0.5);
        const stateSnapshot = snapshot({
            players: [
                player(),
                player({ sessionId: "ally", x: 510 }),
                player({ sessionId: "enemy", team: "blue", x: 500, y: 600 }),
            ],
        });
        const intent = decideBotIntent(stateSnapshot, "self", state, 1_000, () => 0.5);

        expect(intent.mode).toBe("combat");
        expect(intent.aimAngle).toBeCloseTo(Math.PI / 2);
    });

    test("treats solo players with unique team IDs as enemies even when their color matches", () => {
        const state = createBotBrainState(() => 0.5);
        const stateSnapshot = snapshot({
            players: [
                player({ team: "blue", teamId: 2 }),
                player({ sessionId: "solo-enemy", team: "blue", teamId: 3, x: 600 }),
            ],
        });
        const intent = decideBotIntent(stateSnapshot, "self", state, 1_000, () => 0.5);

        expect(intent.mode).toBe("combat");
        expect(intent.aimAngle).toBeCloseTo(0);
    });

    test("holds a target briefly to avoid aim jitter, then retargets", () => {
        const state = createBotBrainState(() => 0.5);
        const initial = snapshot({
            capturedAt: 1_000,
            players: [
                player(),
                player({ sessionId: "east", team: "blue", x: 620 }),
                player({ sessionId: "north", team: "blue", x: 500, y: 700 }),
            ],
        });
        const changed = snapshot({
            capturedAt: 1_200,
            players: [
                player(),
                player({ sessionId: "east", team: "blue", x: 620 }),
                player({ sessionId: "north", team: "blue", x: 500, y: 590 }),
            ],
        });

        expect(decideBotIntent(initial, "self", state, 1_100, () => 0.5).aimAngle).toBeCloseTo(0);
        expect(decideBotIntent(changed, "self", state, 1_300, () => 0.5).aimAngle).toBeCloseTo(0);
        expect(decideBotIntent({ ...changed, capturedAt: 2_600 }, "self", state, 2_700, () => 0.5).aimAngle)
            .toBeCloseTo(Math.PI / 2);
    });

    test("reloads an empty gun, then tries another gun after the reload grace", () => {
        const state = createBotBrainState(() => 0.5);
        const emptyGun = snapshot({
            capturedAt: 900,
            players: [
                player({ weapon: "m9", ammo: 0 }),
                player({ sessionId: "enemy", team: "blue", x: 600 }),
            ],
        });
        const reloading = decideBotIntent(emptyGun, "self", state, 1_000, () => 0.5);
        const swapping = decideBotIntent({ ...emptyGun, capturedAt: 3_800 }, "self", state, 3_801, () => 0.5);

        expect(reloading.shoot).toBe(false);
        expect(reloading.reload).toBe(true);
        expect(reloading.equip).toBeUndefined();
        expect(swapping.shoot).toBe(false);
        expect(swapping.reload).toBe(false);
        expect(swapping.equip).toBe("otherGun");
    });

    test("waits for a slow weapon reload before trying another gun", () => {
        const state = createBotBrainState(() => 0.5);
        const emptyLmg = snapshot({
            capturedAt: 900,
            players: [
                player({ weapon: "m249", ammo: 0 }),
                player({ sessionId: "enemy", team: "blue", x: 600 }),
            ],
        });

        expect(decideBotIntent(emptyLmg, "self", state, 1_000, () => 0.5).reload).toBe(true);
        expect(decideBotIntent({ ...emptyLmg, capturedAt: 4_000 }, "self", state, 4_100, () => 0.5).equip)
            .toBeUndefined();
        expect(decideBotIntent({ ...emptyLmg, capturedAt: 8_500 }, "self", state, 8_600, () => 0.5).equip)
            .toBe("otherGun");
    });

    test("does not swing fists at gun range but attacks in melee range", () => {
        const farState = createBotBrainState(() => 0.5);
        const far = decideBotIntent(
            snapshot({
                players: [
                    player({ weapon: "fists", ammo: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 600 }),
                ],
            }),
            "self",
            farState,
            1_000,
            () => 0.5,
        );
        const closeState = createBotBrainState(() => 0.5);
        const close = decideBotIntent(
            snapshot({
                players: [
                    player({ weapon: "fists", ammo: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 504 }),
                ],
            }),
            "self",
            closeState,
            1_000,
            () => 0.5,
        );

        expect(far.shoot).toBe(false);
        expect(far.equip).toBe("otherGun");
        expect(close.shoot).toBe(true);
        expect(close.equip).toBeUndefined();
        expect(close.moveAngle).toBeCloseTo(0);
    });

    test("pauses to heal when safe and cancels the pause for a close threat", () => {
        const state = createBotBrainState(() => 0.5);
        const safe = snapshot({
            capturedAt: 900,
            players: [
                player({ health: 35, bandages: 1 }),
                player({ sessionId: "enemy", team: "blue", x: 800 }),
            ],
        });
        const healing = decideBotIntent(safe, "self", state, 1_000, () => 0.5);
        const threatened = decideBotIntent(
            snapshot({
                capturedAt: 1_100,
                players: [
                    player({ health: 35, bandages: 1 }),
                    player({ sessionId: "enemy", team: "blue", x: 600 }),
                ],
            }),
            "self",
            state,
            1_200,
            () => 0.5,
        );

        expect(healing.mode).toBe("heal");
        expect(healing.moving).toBe(false);
        expect(healing.useItem).toBe("bandage");
        expect(threatened.mode).toBe("combat");
        expect(threatened.useItem).toBeUndefined();
    });

    test("does not pause to heal without a healing item", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({ health: 20, bandages: 0, healthkits: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 800 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("combat");
        expect(intent.useItem).toBeUndefined();
    });

    test("breaks a distant target lock when a much closer threat arrives", () => {
        const state = createBotBrainState(() => 0.5);
        decideBotIntent(
            snapshot({
                capturedAt: 900,
                players: [
                    player({ health: 35, bandages: 1 }),
                    player({ sessionId: "far", team: "blue", x: 800 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        const threatened = decideBotIntent(
            snapshot({
                capturedAt: 1_100,
                players: [
                    player({ health: 35, bandages: 1 }),
                    player({ sessionId: "far", team: "blue", x: 800 }),
                    player({ sessionId: "close", team: "blue", x: 600 }),
                ],
            }),
            "self",
            state,
            1_200,
            () => 0.5,
        );

        expect(threatened.mode).toBe("combat");
        expect(threatened.aimAngle).toBeCloseTo(0);
        expect(threatened.useItem).toBeUndefined();
        expect(state.targetSessionId).toBe("close");
    });

    test("preserves stuck evidence across an intentional rest", () => {
        const state = createBotBrainState(() => 0.5);
        state.lastX = 500;
        state.lastY = 500;
        state.lastSnapshotAt = 900;
        state.lastMovementCommanded = false;
        state.stuckSamples = 3;

        decideBotIntent(snapshot({ capturedAt: 1_000 }), "self", state, 1_100, () => 0.5);

        expect(state.stuckSamples).toBe(3);
        expect(state.unstuckUntil).toBe(0);
    });

    test("changes course after repeated moving snapshots show no movement", () => {
        const state = createBotBrainState(() => 0.5);
        for (let index = 1; index <= 5; index++) {
            decideBotIntent(snapshot({ capturedAt: index }), "self", state, index * 300, () => 0.5);
        }
        const intent = decideBotIntent(snapshot({ capturedAt: 6 }), "self", state, 1_600, () => 0.5);

        expect(intent.mode).toBe("unstuck");
        expect(intent.moving).toBe(true);
        expect(state.strafeSign).toBe(-1);
    });

    test("falls back to non-shooting wander on a stale room snapshot", () => {
        const state = createBotBrainState(() => 0.5);
        state.targetSessionId = "enemy";
        state.targetLockedUntil = 9_000;
        const intent = decideBotIntent(snapshot({ capturedAt: 1_000 }), "self", state, 3_001, () => 0.5);

        expect(intent.mode).toBe("wander");
        expect(intent.shoot).toBe(false);
        expect(state.targetSessionId).toBeUndefined();
    });
});
