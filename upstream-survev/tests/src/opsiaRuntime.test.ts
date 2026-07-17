import { afterEach, describe, expect, it } from "vitest";
import type { Game, JoinTokenData } from "../../server/src/game/game.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import {
    type LooseGameSnapshot,
    OpsiaSnapshotStore,
    restoreGame,
    restorePlayer,
} from "../../server/src/opsia/runtime.ts";

const originalRoomId = process.env.ROOM_ID;
const originalRedisUrl = process.env.REDIS_URL;

afterEach(() => {
    if (originalRoomId === undefined) delete process.env.ROOM_ID;
    else process.env.ROOM_ID = originalRoomId;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
});

const fakeGame = (): Game => ({
    gas: {
        circleIdx: 0,
        currentPos: { x: 0, y: 0 },
        currentRad: 100,
        posNew: { x: 0, y: 0 },
        radNew: 50,
    },
    playerBarn: { players: [], teams: [] },
    grid: { updateObject: () => undefined },
} as unknown as Game);

describe("Opsia recovery ownership", () => {
    it("consumes a restored player projection exactly once", () => {
        process.env.ROOM_ID = "room-restore-once";
        const game = fakeGame();
        const snapshot: LooseGameSnapshot = {
            schemaVersion: 2,
            roomId: "room-restore-once",
            savedAt: Date.now(),
            gasPhase: 0,
            destroyedObstacleIds: [],
            players: [{
                sessionId: "session-restore-0001",
                name: "Restored",
                teamId: 1,
                x: 12,
                y: 34,
                health: 75,
                score: 4,
                inventory: {},
            }],
        };
        restoreGame(game, snapshot);
        const player = {
            opsiaSessionId: "",
            client: { findGameIp: "127.0.0.1" },
            teamId: 1,
            team: undefined,
            name: "New",
            pos: { x: 0, y: 0 },
            health: 100,
            kills: 0,
            invManager: { isValid: () => false, set: () => undefined },
        } as unknown as Player;
        const join = { opsiaSessionId: "session-restore-0001" } as JoinTokenData;

        expect(restorePlayer(game, player, join)).toBe(true);
        expect(player.pos).toEqual({ x: 12, y: 34 });
        player.pos.x = 99;
        expect(restorePlayer(game, player, join)).toBe(false);
        expect(player.pos.x).toBe(99);
    });

    it("prevents a stale store from clearing or releasing the new owner's state", async () => {
        process.env.ROOM_ID = `room-owner-${Date.now()}`;
        delete process.env.REDIS_URL;
        const previous = new OpsiaSnapshotStore();
        const replacement = new OpsiaSnapshotStore();
        await previous.start(fakeGame());
        await previous.save(fakeGame());
        await previous.stop();
        await replacement.start(fakeGame());

        await expect(previous.clearSnapshot()).rejects.toThrow("room_lease_lost");
        await previous.stop();
        await expect(replacement.save(fakeGame())).resolves.toBeUndefined();
        await replacement.clearSnapshot();
        await replacement.stop();
    });
});
