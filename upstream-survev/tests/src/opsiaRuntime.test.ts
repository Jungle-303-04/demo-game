import { afterEach, describe, expect, it } from "vitest";
import type { Game, JoinTokenData } from "../../server/src/game/game.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { DamageType, TeamMode } from "../../shared/gameConfig.ts";
import { createGame } from "./gameTestHelpers.ts";
import { RoomStateJournal } from "../../server/src/opsia/journal.ts";
import {
    type LooseGameSnapshot,
    OpsiaSnapshotStore,
    lastProcessedGatewayInput,
    recordProcessedGatewayInput,
    restoreGame,
    restorePlayer,
    serializeGame,
} from "../../server/src/opsia/runtime.ts";

const originalRoomId = process.env.ROOM_ID;
const originalRedisUrl = process.env.REDIS_URL;
const originalOpsiaRole = process.env.OPSIA_ROLE;
const originalRoomEpoch = process.env.ROOM_EPOCH;
const originalSourceEpoch = process.env.OPSIA_SOURCE_EPOCH;

afterEach(() => {
    if (originalRoomId === undefined) delete process.env.ROOM_ID;
    else process.env.ROOM_ID = originalRoomId;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalOpsiaRole === undefined) delete process.env.OPSIA_ROLE;
    else process.env.OPSIA_ROLE = originalOpsiaRole;
    if (originalRoomEpoch === undefined) delete process.env.ROOM_EPOCH;
    else process.env.ROOM_EPOCH = originalRoomEpoch;
    if (originalSourceEpoch === undefined) delete process.env.OPSIA_SOURCE_EPOCH;
    else process.env.OPSIA_SOURCE_EPOCH = originalSourceEpoch;
});

const fakeGame = (): Game => ({
    mapName: "faction",
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
    it("persists the exact stable-session input ACK in the snapshot contract", () => {
        process.env.ROOM_ID = "room-input-ack";
        const game = fakeGame();
        game.playerBarn.players = [{
            opsiaSessionId: "stable-input-session",
            client: { findGameIp: "127.0.0.1" },
            name: "Input",
            teamId: 1,
            pos: { x: 1, y: 2 },
            health: 100,
            kills: 0,
            inventory: {},
        }] as unknown as Player[];

        recordProcessedGatewayInput(game, "stable-input-session", 41);
        recordProcessedGatewayInput(game, "stable-input-session", 40);
        expect(lastProcessedGatewayInput(game, "stable-input-session")).toBe(41);
        expect(serializeGame(game).players[0]?.lastInputSequence).toBe(41);
    });

    it("consumes a restored player projection exactly once", () => {
        process.env.ROOM_ID = "room-restore-once";
        const source = fakeGame();
        source.playerBarn.players = [{
            opsiaSessionId: "session-restore-0001",
            client: { findGameIp: "127.0.0.1" },
            name: "Restored",
            teamId: 1,
            pos: { x: 12, y: 34 },
            health: 75,
            kills: 4,
            inventory: {},
        }] as unknown as Player[];
        const snapshot = serializeGame(source);
        const game = fakeGame();
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

    it("rejects a player projection captured from a different map", () => {
        process.env.ROOM_ID = "room-map-mismatch";
        const game = fakeGame();
        const snapshot: LooseGameSnapshot = { ...serializeGame(game), mapName: "desert" };

        expect(() => restoreGame(game, snapshot)).toThrow("invalid_opsia_snapshot");
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

    it("lets a candidate seed under an active lease without acquiring, refreshing, or overwriting it", async () => {
        const roomId = `room-candidate-readonly-${Date.now()}`;
        process.env.ROOM_ID = roomId;
        process.env.ROOM_EPOCH = "6";
        process.env.OPSIA_ROLE = "active";
        delete process.env.REDIS_URL;
        const sourceGame = fakeGame();
        sourceGame.playerBarn.players = [{
            opsiaSessionId: "candidate-stable-session",
            client: { findGameIp: "127.0.0.1" },
            name: "Persisted",
            teamId: 1,
            pos: { x: 41, y: 73 },
            health: 64,
            kills: 5,
            inventory: {},
        }] as unknown as Player[];
        const active = new OpsiaSnapshotStore();
        await active.start(sourceGame);
        await active.save(sourceGame, 30);

        process.env.OPSIA_ROLE = "candidate";
        const candidateGame = fakeGame();
        const candidate = new OpsiaSnapshotStore();
        await expect(candidate.start(candidateGame)).resolves.toBe(true);
        expect(candidate.handoffStatus()).toMatchObject({
            role: "candidate",
            ready: true,
            roomEpoch: 6,
            serverTick: 30,
            players: 1,
        });
        sourceGame.playerBarn.players[0]!.pos.x = 55;
        await active.save(sourceGame, 40);
        const latestChecksum = active.snapshotMetrics().lastChecksum;
        expect(latestChecksum).toBeTypeOf("string");
        const journalEntries = await new RoomStateJournal({ roomId }).readAfter();
        expect(journalEntries).toHaveLength(1);
        expect(journalEntries[0]).toMatchObject({ eventType: "state-delta", serverTick: 40 });
        expect(journalEntries[0]?.payload).not.toHaveProperty("payload");
        expect(journalEntries[0]?.payload).not.toHaveProperty("world");
        const seeded = await candidate.seedCandidate(candidateGame, {
            expectedEpoch: 6,
            targetTick: 40,
            expectedChecksum: latestChecksum,
        });
        expect(seeded).toMatchObject({ ready: true, serverTick: 40, checksum: latestChecksum });
        const resumed = {
            opsiaSessionId: "",
            client: { findGameIp: "127.0.0.1" },
            teamId: 1,
            team: undefined,
            name: "Resume",
            pos: { x: 0, y: 0 },
            health: 100,
            kills: 0,
            invManager: { isValid: () => false, set: () => undefined },
        } as unknown as Player;
        expect(restorePlayer(
            candidateGame,
            resumed,
            { opsiaSessionId: "candidate-stable-session" } as JoinTokenData,
        )).toBe(true);
        expect(resumed.pos).toEqual({ x: 55, y: 73 });
        await expect(candidate.save(candidateGame, 31)).rejects.toThrow("candidate_read_only");
        await expect(candidate.clearSnapshot()).rejects.toThrow("candidate_read_only");

        await active.stop();
        process.env.OPSIA_ROLE = "active";
        const replacementGame = fakeGame();
        const replacement = new OpsiaSnapshotStore();
        await expect(replacement.start(replacementGame)).resolves.toBe(true);
        const restored = {
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
        expect(restorePlayer(
            replacementGame,
            restored,
            { opsiaSessionId: "candidate-stable-session" } as JoinTokenData,
        )).toBe(true);
        expect(restored.pos).toEqual({ x: 55, y: 73 });

        await candidate.stop();
        await expect(replacement.save(replacementGame, 31)).resolves.toBeUndefined();
        await replacement.clearSnapshot();
        await replacement.stop();
    });

    it("auto role holds the old pod until a verified candidate receives the lease and supports fenced rollback", async () => {
        process.env.ROOM_ID = `room-auto-handoff-${Date.now()}`;
        process.env.ROOM_EPOCH = "8";
        delete process.env.REDIS_URL;
        process.env.OPSIA_ROLE = "active";
        const activeGame = fakeGame();
        const active = new OpsiaSnapshotStore();
        await active.start(activeGame);
        expect(active.acceptsGatewayInput(8)).toBe(true);
        expect(active.acceptsGatewayInput(9)).toBe(false);
        await active.save(activeGame, 80);
        const checksum = active.snapshotMetrics().lastChecksum!;

        process.env.OPSIA_ROLE = "auto";
        const candidate = new OpsiaSnapshotStore();
        await candidate.start(fakeGame());
        expect(candidate.handoffStatus()).toMatchObject({ role: "candidate", checksum });
        expect(candidate.acceptsGatewayInput(9)).toBe(false);

        await expect(active.releaseActiveForHandoff({
            expectedEpoch: 8,
            expectedChecksum: "f".repeat(64),
        })).rejects.toThrow("authority_release_checksum_conflict");
        expect(active.acceptsGatewayInput(8)).toBe(true);
        await active.releaseActiveForHandoff({ expectedEpoch: 8, expectedChecksum: checksum });
        expect(active.handoffStatus()).toMatchObject({ role: "candidate", roomEpoch: 8 });
        expect(active.acceptsGatewayInput(8)).toBe(false);
        await candidate.promoteCandidate({ expectedEpoch: 8, nextEpoch: 9, expectedChecksum: checksum });
        expect(candidate.handoffStatus()).toMatchObject({ role: "active", roomEpoch: 9, checksum });
        expect(candidate.acceptsGatewayInput(9)).toBe(true);
        expect(candidate.acceptsGatewayInput(8)).toBe(false);

        await candidate.releaseActiveForHandoff({ expectedEpoch: 9, expectedChecksum: checksum });
        await active.promoteCandidate({ expectedEpoch: 9, nextEpoch: 10, expectedChecksum: checksum });
        expect(active.handoffStatus()).toMatchObject({ role: "active", roomEpoch: 10, checksum });
        expect(active.acceptsGatewayInput(10)).toBe(true);
        expect(candidate.acceptsGatewayInput(9)).toBe(false);

        await candidate.stop();
        await active.stop();
    });

    it("regenerates a Candidate map from the Active snapshot seed before restore", async () => {
        process.env.ROOM_ID = `room-map-seed-${Date.now()}`;
        process.env.ROOM_EPOCH = "3";
        delete process.env.REDIS_URL;
        process.env.OPSIA_ROLE = "active";
        const activeGame = fakeGame();
        activeGame.map = {
            seed: 424_242,
        } as Game["map"];
        const active = new OpsiaSnapshotStore();
        await active.start(activeGame);
        await active.save(activeGame, 50);

        process.env.OPSIA_ROLE = "auto";
        const regenerated: number[] = [];
        const candidateGame = fakeGame();
        candidateGame.map = {
            seed: 9,
            regenerate(seed?: number) {
                regenerated.push(seed ?? 0);
                this.seed = seed ?? 0;
            },
        } as Game["map"];
        const candidate = new OpsiaSnapshotStore();
        await candidate.start(candidateGame);

        expect(regenerated).toEqual([424_242]);
        expect(candidateGame.map.seed).toBe(424_242);

        await candidate.stop();
        await active.stop();
    });

    it("materializes gas, map dynamics, loot, projectiles, bullets, explosions, and effects exactly", () => {
        process.env.ROOM_ID = `room-full-world-${Date.now()}`;
        const mapSeed = 782_341;
        const active = createGame(TeamMode.Solo, "main");
        active.map.regenerate(mapSeed);
        const firstFixedLayout = active.map.obstacles.map((item) => item.type);
        active.map.regenerate(mapSeed);
        expect(active.map.obstacles.map((item) => item.type)).toEqual(firstFixedLayout);
        const sourcePlayer = active.playerBarn.addTestPlayer({});
        sourcePlayer.opsiaSessionId = "full-world-player";

        active.started = true;
        active.startedTime = 23.5;
        active.timeRunning = 41.25;
        active.gas.circleIdx = 3;
        active.gas.stage = 4;
        active.gas.currentPos = { x: 87, y: 91 };
        active.gas.posOld = { x: 80, y: 82 };
        active.gas.posNew = { x: 102, y: 106 };
        active.gas.currentRad = 143;
        active.gas.radOld = 150;
        active.gas.radNew = 119;
        active.gas.gasT = 0.42;

        const obstacle = active.map.obstacles.find((candidate) => candidate.destructible && !candidate.dead)!;
        obstacle.health = Math.max(1, obstacle.maxHealth * 0.37);
        obstacle.healthT = obstacle.health / obstacle.maxHealth;
        obstacle.scale = obstacle.minScale + (obstacle.maxScale - obstacle.minScale) * obstacle.healthT;
        obstacle.regrowTicker = 7.5;
        obstacle.interactedBy = sourcePlayer;
        obstacle.ownerId = sourcePlayer.__id;
        obstacle.shouldApplyLootOwner = true;
        obstacle.updateCollider();

        const door = active.map.obstacles.find((candidate) => candidate.door && !candidate.dead);
        door?.openDoor(undefined, { x: 1, y: 0 });

        const loot = active.lootBarn.loots.find((candidate) => !candidate.destroyed)!;
        loot.pos.x += 4;
        loot.pos.y += 3;
        loot.vel.x = 1.25;
        loot.vel.y = -0.75;
        loot.cleanupAfterSeconds = 25;
        loot.cleanupAgeSeconds = 6;
        loot.refresh();

        active.projectileBarn.addProjectile(
            0,
            "frag",
            { x: 70, y: 72 },
            1.2,
            0,
            { x: 2.5, y: -1.5 },
            2.8,
            DamageType.Player,
            { x: 1, y: 0 },
            "frag",
        );
        const bullet = active.bulletBarn.fireBullet({
            bulletType: "bullet_frag",
            gameSourceType: "frag",
            pos: { x: 64, y: 65 },
            dir: { x: 1, y: 0.2 },
            layer: 0,
            damageMult: 1,
            damageType: DamageType.Player,
            playerId: sourcePlayer.__id,
            varianceT: 0.25,
        });
        bullet.damagedObjIds.add(sourcePlayer.__id);
        bullet.reflectObjId = sourcePlayer.__id;
        active.explosionBarn.addExplosion("explosion_frag", { x: 66, y: 67 }, 0, {
            damageType: DamageType.Player,
            gameSourceType: "frag",
        });
        active.smokeBarn.addEmitter({ x: 90, y: 92 }, 0);
        active.airdropBarn.addAirdrop({ x: 110, y: 115 }, "airdrop_crate_01");
        active.deadBodyBarn.addDeadBody({ x: 120, y: 121 }, 0, 0, { x: 1, y: 0 });
        const decal = active.decalBarn.addDecal("decal_frag_explosion", { x: 130, y: 131 }, 0);
        decal.lifeTime = 12;

        const snapshot = serializeGame(active);
        expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThan(4 * 1024 * 1024);
        const candidate = createGame(TeamMode.Solo, "main");
        candidate.map.regenerate(mapSeed);
        expect(candidate.map.obstacles.map((item) => item.type)).toEqual(
            active.map.obstacles.map((item) => item.type),
        );

        expect(restoreGame(candidate, snapshot)).toBe(snapshot.stateChecksum);
        const resumedPlayer = candidate.playerBarn.addTestPlayer({});
        expect(restorePlayer(candidate, resumedPlayer, {
            opsiaSessionId: "full-world-player",
        } as JoinTokenData)).toBe(true);
        const materialized = serializeGame(candidate);
        expect(materialized.stateChecksum).toBe(snapshot.stateChecksum);
        expect(materialized.world.gas).toEqual(snapshot.world.gas);
        expect(materialized.world.projectiles).toEqual(snapshot.world.projectiles);
        expect(materialized.world.bullets).toEqual(snapshot.world.bullets);
        expect(materialized.world.explosions).toEqual(snapshot.world.explosions);
        expect(materialized.world.smokes).toEqual(snapshot.world.smokes);
        expect(materialized.world.airdrops).toEqual(snapshot.world.airdrops);
        expect(materialized.destroyedObstacleIds).toEqual(snapshot.destroyedObstacleIds);
    });

    it("refuses a checkpoint while an unmaterializable authoritative effect is pending", () => {
        process.env.ROOM_ID = `room-unsupported-world-${Date.now()}`;
        const game = createGame(TeamMode.Solo, "main");
        game.bulletBarn.damages.push({} as Game["bulletBarn"]["damages"][number]);

        expect(() => serializeGame(game)).toThrow(
            "snapshot_world_state_unsupported:pending_bullet_damage",
        );
    });
});
