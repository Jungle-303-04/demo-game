import { describe, expect, test } from "vitest";
import {
    type BotBrainMapObstacle,
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
    isBot: true,
    ...overrides,
});

const snapshot = (overrides: Partial<BotBrainSnapshot> = {}): BotBrainSnapshot => ({
    capturedAt: 1,
    map: { width: 1_000, height: 1_000 },
    zone: { x: 500, y: 500, radius: 460, nextX: 500, nextY: 500, nextRadius: 460 },
    loot: [],
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

    test("farms a useful real loot item before pursuing a distant enemy", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                loot: [{ id: 7, type: "m9", kind: "gun", x: 560, y: 500, count: 1 }],
                players: [
                    player({ weapon: "fists", ammo: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 900 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("loot");
        expect(intent.moving).toBe(true);
        expect(intent.moveAngle).toBeCloseTo(0);
        expect(intent.interact).toBe(false);
        expect(state.targetLootId).toBe(7);
    });

    test("stops and interacts when it reaches its loot target", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                loot: [{ id: 8, type: "bandage", kind: "heal", x: 501.5, y: 500, count: 5 }],
                players: [player({ health: 60 })],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("loot");
        expect(intent.moving).toBe(false);
        expect(intent.interact).toBe(true);
    });

    test("interrupts farming to fight an immediate threat", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                loot: [{ id: 9, type: "m9", kind: "gun", x: 510, y: 500, count: 1 }],
                players: [
                    player({ weapon: "fists", ammo: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 560 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("combat");
        expect(intent.shoot).toBe(false);
    });

    test("disengages a non-immediate enemy to arm itself", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                loot: [{ id: 10, type: "m9", kind: "gun", x: 520, y: 500, count: 1 }],
                players: [
                    player({ weapon: "fists", ammo: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 580 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("loot");
        expect(intent.moving).toBe(true);
        expect(intent.shoot).toBe(false);
    });

    test("leads a moving enemy instead of aiming at a stale position", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player(),
                    player({ sessionId: "enemy", team: "blue", x: 600, y: 500, vy: 80 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("combat");
        expect(intent.aimAngle).toBeGreaterThan(0);
    });

    test("respects the real projectile range before spending short-range ammunition", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({ weapon: "mac10", ammo: 32 }),
                    player({ sessionId: "enemy", team: "blue", x: 560 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("combat");
        expect(intent.shoot).toBe(false);
        expect(Math.abs(intent.moveAngle)).toBeLessThan(0.3);
    });

    test("keeps firing while force-retreating at critical health", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({ health: 20, bandages: 0, healthkits: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 560 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("retreat");
        expect(intent.moving).toBe(true);
        expect(intent.shoot).toBe(true);
        expect(Math.cos(intent.moveAngle)).toBeLessThan(-0.9);
    });

    test("tactically reloads a low magazine before a distant engagement", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({ ammo: 2 }),
                    player({ sessionId: "enemy", team: "blue", x: 700 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("combat");
        expect(intent.shoot).toBe(false);
        expect(intent.reload).toBe(true);
    });

    test("upgrades an armed bot when real weapon ballistics are materially stronger", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                loot: [{ id: 11, type: "m249", kind: "gun", x: 510, y: 500, count: 1 }],
                players: [
                    player({ weapon: "m9", ammo: 15 }),
                    player({ sessionId: "enemy", team: "blue", x: 900 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("loot");
        expect(state.targetLootId).toBe(11);
    });

    test("spreads equally useful loot targets across bot identities", () => {
        const realLoot = [
            { id: 1, type: "m9", kind: "gun", x: 510, y: 500, count: 1 },
            { id: 2, type: "m9", kind: "gun", x: 490, y: 500, count: 1 },
        ];
        const choose = (sessionId: string): number | undefined => {
            const state = createBotBrainState(() => 0.5);
            decideBotIntent(
                snapshot({
                    loot: realLoot,
                    players: [
                        player({ sessionId, weapon: "fists", ammo: 0 }),
                        player({ sessionId: "enemy", team: "blue", x: 900 }),
                    ],
                }),
                sessionId,
                state,
                1_000,
                () => 0.5,
            );
            return state.targetLootId;
        };

        expect(choose("bot-a")).toBe(1);
        expect(choose("bot-b")).toBe(2);
    });

    test("farms ammunition required by a real holstered weapon", () => {
        const state = createBotBrainState(() => 0.5);
        decideBotIntent(
            snapshot({
                loot: [
                    { id: 31, type: "9mm", kind: "ammo", x: 510, y: 500, count: 60 },
                    { id: 32, type: "762mm", kind: "ammo", x: 490, y: 500, count: 60 },
                ],
                players: [
                    player({
                        activeSlot: 0,
                        primaryWeapon: "m9",
                        primaryAmmo: 15,
                        primaryReserve: 180,
                        secondaryWeapon: "mosin",
                        secondaryAmmo: 0,
                        secondaryReserve: 0,
                    }),
                    player({ sessionId: "enemy", team: "blue", x: 900 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(state.targetLootId).toBe(32);
    });

    test("gives different bot identities distinct combat movement signatures", () => {
        const chooseAngle = (sessionId: string): number => {
            const state = createBotBrainState(() => 0.5);
            const intent = decideBotIntent(
                snapshot({
                    players: [
                        player({ sessionId }),
                        player({ sessionId: "enemy", team: "blue", x: 600 }),
                    ],
                }),
                sessionId,
                state,
                1_000,
                () => 0.5,
            );
            return intent.moveAngle;
        };

        const angles = ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e", "bot-f"]
            .map(chooseAngle);
        expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.2);
    });

    test("keeps travelling through combat decisions without dropping aim", () => {
        const state = createBotBrainState(() => 0.5);
        state.movementPhase = "travel";
        state.movementPhaseUntil = 1_200;
        const stateSnapshot = snapshot({ capturedAt: 1_000 });

        const travelling = decideBotIntent(stateSnapshot, "self", state, 1_100, () => 0.5);
        const resting = decideBotIntent(stateSnapshot, "self", state, 1_300, () => 0.5);
        const stillResting = decideBotIntent(stateSnapshot, "self", state, 1_999, () => 0.5);
        const travellingAgain = decideBotIntent(stateSnapshot, "self", state, 2_001, () => 0.5);

        expect(travelling.moving).toBe(true);
        expect(resting.moving).toBe(true);
        expect(stillResting.moving).toBe(true);
        expect(travellingAgain.moving).toBe(true);
        for (const intent of [travelling, resting, stillResting, travellingAgain]) {
            expect(intent.mode).toBe("combat");
            expect(intent.aimAngle).toBeCloseTo(0);
            expect(intent.shoot).toBe(true);
        }
    });

    test("immediately resumes travel from a legacy rest state", () => {
        const state = createBotBrainState(() => 0.5);
        state.movementPhase = "rest";
        state.movementPhaseUntil = 5_000;

        const intent = decideBotIntent(snapshot(), "self", state, 1_100, () => 0.5);

        expect(intent.moving).toBe(true);
        expect(state.movementPhase).toBe("travel");
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

    test("finishes a wounded armed threat when it is only slightly farther away", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player(),
                    player({ sessionId: "near", team: "blue", x: 600, health: 100 }),
                    player({ sessionId: "wounded", team: "blue", x: 500, y: 625, health: 10 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(state.targetSessionId).toBe("wounded");
        expect(intent.aimAngle).toBeCloseTo(Math.PI / 2);
    });

    test("prioritizes a nearby real user over a slightly closer bot", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player(),
                    player({ sessionId: "bot-enemy", team: "blue", x: 585 }),
                    player({ sessionId: "human-enemy", team: "blue", x: 500, y: 610, isBot: false }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(state.targetSessionId).toBe("human-enemy");
        expect(intent.aimAngle).toBeCloseTo(Math.PI / 2);
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

    test("does not shoot through an authoritative wall and commits to a flank waypoint", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                map: {
                    width: 1_000,
                    height: 1_000,
                    navigation: [{ id: 90, kind: "wall", x: 535, y: 500, width: 6, height: 120 }],
                },
                players: [
                    player(),
                    player({ sessionId: "enemy", team: "blue", x: 600, y: 500 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("flank");
        expect(intent.shoot).toBe(false);
        expect(Math.abs(intent.moveAngle)).toBeGreaterThan(1);
        expect(state.flankUntil).toBeGreaterThan(1_000);
        expect(state.flankX).toBeDefined();
        expect(state.flankY).toBeDefined();
    });

    test("reuses a snapshot spatial index instead of rescanning distant wall geometry", () => {
        let distantGeometryReads = 0;
        const distantWalls = Array.from({ length: 2_000 }, (_, index): BotBrainMapObstacle => ({
            id: 1_000 + index,
            kind: "wall",
            get x() {
                distantGeometryReads++;
                return 2_000 + index % 50 * 20;
            },
            y: 2_000 + Math.floor(index / 50) * 20,
            width: 4,
            height: 4,
        }));
        const crowded = snapshot({
            map: {
                width: 5_000,
                height: 5_000,
                navigation: [
                    { id: 99, kind: "wall", x: 535, y: 500, width: 6, height: 120 },
                    ...distantWalls,
                ],
            },
        });

        const first = decideBotIntent(crowded, "self", createBotBrainState(() => 0.5), 1_000, () => 0.5);
        expect(first.mode).toBe("flank");
        expect(distantGeometryReads).toBeGreaterThanOrEqual(distantWalls.length);

        distantGeometryReads = 0;
        const cached = decideBotIntent(crowded, "self", createBotBrainState(() => 0.5), 1_000, () => 0.5);

        expect(cached.mode).toBe("flank");
        expect(distantGeometryReads).toBe(0);
    });

    test("keeps a stable flank side instead of oscillating around a wall", () => {
        const state = createBotBrainState(() => 0.5);
        const blocked = snapshot({
            capturedAt: 900,
            map: {
                width: 1_000,
                height: 1_000,
                navigation: [{ id: 91, kind: "wall", x: 535, y: 500, width: 6, height: 120 }],
            },
        });
        const first = decideBotIntent(blocked, "self", state, 1_000, () => 0.5);
        const firstFlankY = state.flankY;
        const second = decideBotIntent({ ...blocked, capturedAt: 1_100 }, "self", state, 1_200, () => 0.1);

        expect(Math.sign(first.moveAngle)).toBe(Math.sign(second.moveAngle));
        expect(state.flankY).toBe(firstFlankY);
        expect(state.flankUntil).toBeGreaterThan(1_200);
    });

    test("force-dodges after taking damage instead of waiting in a movement rest", () => {
        const state = createBotBrainState(() => 0.5);
        state.movementPhase = "rest";
        state.movementPhaseUntil = 5_000;
        decideBotIntent(snapshot({ capturedAt: 900 }), "self", state, 1_000, () => 0.5);
        const hit = decideBotIntent(
            snapshot({
                capturedAt: 1_100,
                players: [
                    player({ health: 82 }),
                    player({ sessionId: "enemy", team: "blue", x: 600 }),
                ],
            }),
            "self",
            state,
            1_200,
            () => 0.5,
        );

        expect(hit.mode).toBe("combat");
        expect(hit.moving).toBe(true);
        expect(state.underFireUntil).toBeGreaterThan(1_200);
        expect(state.strafeSign).toBe(-1);
    });

    test("preserves direct loot entry so bots can use building doors", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                map: {
                    width: 1_000,
                    height: 1_000,
                    objects: [{ id: 92, kind: "building", x: 535, y: 500, width: 30, height: 80 }],
                },
                loot: [{ id: 93, type: "m9", kind: "gun", x: 560, y: 500, count: 1 }],
                players: [
                    player({ weapon: "fists", ammo: 0 }),
                    player({ sessionId: "enemy", team: "blue", x: 900 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("loot");
        expect(intent.moveAngle).toBeCloseTo(0);
    });

    test("uses authoritative wall colliders instead of a coarse building box at open doors", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                map: {
                    width: 1_000,
                    height: 1_000,
                    objects: [{ id: 94, kind: "building", x: 550, y: 500, width: 90, height: 90 }],
                    navigation: [{ id: 95, kind: "wall", x: 550, y: 540, width: 90, height: 5 }],
                },
                players: [
                    player(),
                    player({ sessionId: "enemy", team: "blue", x: 600, y: 500 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("combat");
        expect(intent.shoot).toBe(true);
    });

    test("hunts a distant live enemy instead of wandering away from the fight", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                map: { width: 3_000, height: 3_000 },
                zone: { x: 1_500, y: 1_500, radius: 1_450, nextX: 1_500, nextY: 1_500, nextRadius: 1_450 },
                players: [
                    player({ x: 1_000, y: 1_500 }),
                    player({ sessionId: "enemy", team: "blue", x: 2_200, y: 1_500 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("hunt");
        expect(intent.moving).toBe(true);
        expect(Math.abs(intent.moveAngle)).toBeLessThan(0.3);
    });

    test("chooses the real secondary gun when it better fits long range", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({
                        activeSlot: 0,
                        primaryWeapon: "m9",
                        primaryAmmo: 15,
                        primaryReserve: 30,
                        secondaryWeapon: "mosin",
                        secondaryAmmo: 5,
                        secondaryReserve: 20,
                    }),
                    player({ sessionId: "enemy", team: "blue", x: 760 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.equip).toBe("secondary");
    });

    test("paces long-range automatic fire in observable bursts", () => {
        const state = createBotBrainState(() => 0.5);
        const combat = snapshot({
            capturedAt: 900,
            players: [
                player({ weapon: "ak47", ammo: 30 }),
                player({ sessionId: "enemy", team: "blue", x: 700 }),
            ],
        });
        const first = decideBotIntent(combat, "self", state, 1_000, () => 0.5);
        const pause = decideBotIntent({ ...combat, capturedAt: 1_499 }, "self", state, 1_500, () => 0.5);

        expect(first.shoot).toBe(true);
        expect(pause.shoot).toBe(false);
        expect(state.nextBurstAt).toBeGreaterThan(1_500);
    });

    test("equips, cooks, releases, and recovers from a real frag grenade", () => {
        const state = createBotBrainState(() => 0.5);
        const grenadeFight = (capturedAt: number, activeSlot = 0, weapon = "m9") => snapshot({
            capturedAt,
            players: [
                player({
                    activeSlot,
                    weapon,
                    throwableWeapon: "frag",
                    throwableCount: 2,
                    primaryWeapon: "m9",
                    primaryAmmo: 15,
                    primaryReserve: 30,
                }),
                player({ sessionId: "enemy", team: "blue", teamId: 2, x: 550 }),
                player({ sessionId: "enemy-2", team: "blue", teamId: 2, x: 555, y: 505 }),
            ],
        });

        const equip = decideBotIntent(grenadeFight(900), "self", state, 1_000, () => 0.5);
        const cookStart = decideBotIntent(grenadeFight(1_099, 3, "frag"), "self", state, 1_100, () => 0.5);
        const cooking = decideBotIntent(grenadeFight(1_499, 3, "frag"), "self", state, 1_500, () => 0.5);
        const release = decideBotIntent(grenadeFight(2_099, 3, "frag"), "self", state, 2_100, () => 0.5);
        const recover = decideBotIntent(grenadeFight(2_199, 3, "frag"), "self", state, 2_200, () => 0.5);

        expect(equip.equip).toBe("throwable");
        expect(cookStart.shoot).toBe(true);
        expect(cookStart.forceShootStart).toBe(true);
        expect(cooking.shoot).toBe(true);
        expect(release.shoot).toBe(false);
        expect(recover.equip).toBe("lastWeapon");
        expect(state.grenadeCooldownUntil).toBeGreaterThan(2_200);
    });

    test("never throws an explosive into an allied blast radius", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({ throwableWeapon: "frag", throwableCount: 2 }),
                    player({ sessionId: "enemy", team: "blue", teamId: 2, x: 550 }),
                    player({ sessionId: "enemy-2", team: "blue", teamId: 2, x: 555 }),
                    player({ sessionId: "ally", teamId: 1, x: 552 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).not.toBe("grenade");
        expect(intent.equip).not.toBe("throwable");
    });

    test("crawls toward support while downed and revives a safe teammate", () => {
        const downedState = createBotBrainState(() => 0.5);
        const downed = decideBotIntent(
            snapshot({
                players: [
                    player({ downed: true }),
                    player({ sessionId: "ally", teamId: 1, x: 530 }),
                ],
            }),
            "self",
            downedState,
            1_000,
            () => 0.5,
        );
        const rescueState = createBotBrainState(() => 0.5);
        const rescue = decideBotIntent(
            snapshot({
                players: [
                    player(),
                    player({ sessionId: "ally", teamId: 1, x: 504, downed: true }),
                ],
            }),
            "self",
            rescueState,
            1_000,
            () => 0.5,
        );

        expect(downed.mode).toBe("downed");
        expect(downed.moving).toBe(true);
        expect(downed.moveAngle).toBeCloseTo(0);
        expect(rescue.mode).toBe("rescue");
        expect(rescue.moving).toBe(false);
        expect(rescue.interact).toBe(true);
    });

    test("uses a real boost item during a safe tactical pause", () => {
        const state = createBotBrainState(() => 0.5);
        const intent = decideBotIntent(
            snapshot({
                players: [
                    player({ boost: 0, sodas: 1 }),
                    player({ sessionId: "enemy", team: "blue", x: 800 }),
                ],
            }),
            "self",
            state,
            1_000,
            () => 0.5,
        );

        expect(intent.mode).toBe("heal");
        expect(intent.useItem).toBe("soda");
        expect(intent.moving).toBe(false);
    });
});
