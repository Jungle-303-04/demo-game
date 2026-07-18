import { describe, expect, test } from "vitest";
import { type BotBrainSnapshot, createBotBrainState, decideBotIntent } from "../../server/src/opsia/botBrain.ts";

const snapshot = (overrides: Partial<BotBrainSnapshot> = {}): BotBrainSnapshot => ({
    capturedAt: 1,
    map: { width: 1_000, height: 1_000 },
    zone: { x: 500, y: 500, radius: 460 },
    players: [
        { sessionId: "self", team: "red", x: 500, y: 500, alive: true, connected: true },
        { sessionId: "enemy", team: "blue", x: 600, y: 500, alive: true, connected: true },
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

    test("prioritizes returning to the safe zone", () => {
        const state = createBotBrainState(() => 0.5);
        const stateSnapshot = snapshot({
            zone: { x: 500, y: 500, radius: 200 },
            players: [
                { sessionId: "self", team: "red", x: 800, y: 500, alive: true, connected: true },
                { sessionId: "enemy", team: "blue", x: 820, y: 500, alive: true, connected: true },
            ],
        });
        const intent = decideBotIntent(stateSnapshot, "self", state, 1_000, () => 0.5);

        expect(intent.mode).toBe("zone");
        expect(Math.abs(intent.moveAngle)).toBeCloseTo(Math.PI);
    });

    test("ignores teammates when choosing a combat target", () => {
        const state = createBotBrainState(() => 0.5);
        const stateSnapshot = snapshot({
            players: [
                { sessionId: "self", team: "red", x: 500, y: 500, alive: true, connected: true },
                { sessionId: "ally", team: "red", x: 510, y: 500, alive: true, connected: true },
                { sessionId: "enemy", team: "blue", x: 500, y: 600, alive: true, connected: true },
            ],
        });
        const intent = decideBotIntent(stateSnapshot, "self", state, 1_000, () => 0.5);

        expect(intent.mode).toBe("combat");
        expect(intent.aimAngle).toBeCloseTo(Math.PI / 2);
    });

    test("changes course after repeated snapshots show no movement", () => {
        const state = createBotBrainState(() => 0.5);
        for (let index = 1; index <= 5; index++) {
            decideBotIntent(snapshot({ capturedAt: index }), "self", state, index * 300, () => 0.5);
        }
        const intent = decideBotIntent(snapshot({ capturedAt: 6 }), "self", state, 1_600, () => 0.5);

        expect(intent.mode).toBe("unstuck");
    });
});
