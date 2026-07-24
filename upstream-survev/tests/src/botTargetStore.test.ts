import { describe, expect, test } from "vitest";
import {
    MemoryBotTargetStore,
    parsePersistedBotTarget,
} from "../../server/src/opsia/botTargetStore.ts";

describe("bot target persistence", () => {
    test("restores exact per-room targets from a store", async () => {
        const store = new MemoryBotTargetStore();
        await store.connect();
        await store.set("room-2", 25);
        await store.set("room-4", 70);

        expect(await store.load()).toEqual([
            ["room-2", 25],
            ["room-4", 70],
        ]);

        await store.delete("room-2");
        expect(await store.load()).toEqual([["room-4", 70]]);
        await store.close();
    });

    test.each(["", "-1", "1.5", "025", "false", "501"])(
        "rejects corrupt persisted target %p",
        (target) => {
            expect(() => parsePersistedBotTarget(target)).toThrow();
        },
    );
});
