import { describe, expect, test } from "vitest";
import {
    MAX_BOTS_PER_ROOM,
    parseBotTarget,
    RoomBotTargets,
} from "../../server/src/opsia/botPopulation.ts";

describe("room bot population targets", () => {
    test("uses the configured default until a room receives an explicit target", () => {
        const targets = new RoomBotTargets(60);

        expect(targets.get("room-0")).toBe(60);
        expect(targets.set("room-0", 10)).toBe(10);
        expect(targets.get("room-0")).toBe(10);
        expect(targets.get("room-1")).toBe(60);
    });

    test("allows an operator to set a room to zero bots", () => {
        const targets = new RoomBotTargets(60);

        targets.set("room-2", 0);

        expect(targets.get("room-2")).toBe(0);
    });

    test.each([
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        MAX_BOTS_PER_ROOM + 1,
        "not-a-number",
        "25",
        "",
        null,
        false,
    ])("rejects invalid target %p", (target) => {
        expect(() => parseBotTarget(target)).toThrow("invalid_bot_target");
    });

    test("returns deterministic room overrides for status responses", () => {
        const targets = new RoomBotTargets(60);
        targets.set("room-4", 25);
        targets.set("room-1", 70);

        expect(targets.entries()).toEqual([
            ["room-1", 70],
            ["room-4", 25],
        ]);
    });

    test("hydrates persisted room targets before reconciliation", () => {
        const targets = new RoomBotTargets(60);

        targets.hydrate([["room-2", 25], ["room-4", 70]]);

        expect(targets.get("room-2")).toBe(25);
        expect(targets.get("room-4")).toBe(70);
        expect(targets.get("room-1")).toBe(60);
    });
});
