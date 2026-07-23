import { describe, expect, it } from "vitest";
import {
    CandidateStateLoader,
    createSnapshotEnvelopeDelta,
} from "../../server/src/opsia/candidate.ts";
import { createRoomJournalEntry, parseRoomJournalEntry, RoomStateJournal } from "../../server/src/opsia/journal.ts";
import {
    BoundedSnapshotWriter,
    checksumOrderedValue,
    createSnapshotEnvelope,
    parseSnapshotEnvelope,
    readSnapshotRuntimeConfig,
    type SnapshotRuntimeConfig,
} from "../../server/src/opsia/snapshot.ts";

interface TestSnapshot {
    schemaVersion: 1;
    marker: number;
    nested?: Record<string, number>;
}

interface CandidateTestSnapshot {
    schemaVersion: 3;
    roomId: string;
    mapName: string;
    players: Array<{ sessionId: string }>;
    marker: number;
}

const config = (overrides: Partial<SnapshotRuntimeConfig> = {}): SnapshotRuntimeConfig => ({
    intervalMs: 1_000,
    minIntervalMs: 250,
    timeoutMs: 100,
    maxPayloadBytes: 64 * 1024,
    failureThreshold: 3,
    circuitCooldownMs: 1_000,
    ...overrides,
});

const request = (marker: number) => ({
    context: {
        roomId: "room-snapshot-test",
        roomEpoch: 7,
        serverTick: marker,
        snapshotTick: marker,
        gameBuildRevision: "test-revision",
        mapSeed: 42,
        createdAt: 1_700_000_000_000,
    },
    payload: { schemaVersion: 1 as const, marker },
});

describe("snapshot envelope", () => {
    it("uses a canonical checksum and rejects a mutated payload", () => {
        const first = createSnapshotEnvelope(
            { schemaVersion: 1 as const, marker: 1, nested: { z: 2, a: 1 } },
            request(1).context,
        );
        const reordered = createSnapshotEnvelope(
            { schemaVersion: 1 as const, marker: 1, nested: { a: 1, z: 2 } },
            request(1).context,
        );
        expect(first.checksum).toBe(reordered.checksum);
        expect(parseSnapshotEnvelope<TestSnapshot>(JSON.stringify(first)).payload.marker).toBe(1);

        const tampered = structuredClone(first);
        tampered.payload.marker = 99;
        expect(() => parseSnapshotEnvelope<TestSnapshot>(JSON.stringify(tampered))).toThrow(
            "snapshot_checksum_mismatch",
        );
    });

    it("hashes deterministic ordered projections without coercing unsupported numbers", () => {
        expect(checksumOrderedValue({ schemaVersion: 4, world: { tick: 7 }, players: [] }))
            .toMatch(/^[a-f\d]{64}$/);
        expect(() => checksumOrderedValue({ value: Number.NaN }))
            .toThrow("snapshot_contains_non_finite_number");
    });

    it("rejects a configured interval below the independently validated minimum", () => {
        expect(() =>
            readSnapshotRuntimeConfig({
                OPSIA_SNAPSHOT_INTERVAL_MS: "50",
                OPSIA_SNAPSHOT_MIN_INTERVAL_MS: "250",
            } as NodeJS.ProcessEnv)
        ).toThrow("opsia_snapshot_interval_ms_invalid");
        expect(() =>
            readSnapshotRuntimeConfig({
                OPSIA_SNAPSHOT_INTERVAL_MS: "100",
                OPSIA_SNAPSHOT_MIN_INTERVAL_MS: "250",
            } as NodeJS.ProcessEnv)
        ).toThrow("opsia_snapshot_interval_below_minimum");
        expect(readSnapshotRuntimeConfig({ OPSIA_SNAPSHOT_INTERVAL_MS: "500" } as NodeJS.ProcessEnv).intervalMs)
            .toBe(500);
        expect(readSnapshotRuntimeConfig({} as NodeJS.ProcessEnv).maxPayloadBytes)
            .toBe(8 * 1024 * 1024);
    });
});

describe("bounded snapshot writer", () => {
    it("keeps one write in flight and coalesces all waiting callers into the latest state", async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const writes: number[] = [];
        let activeWrites = 0;
        let peakWrites = 0;
        const writer = new BoundedSnapshotWriter<TestSnapshot>({
            config: config(),
            write: async (_serialized, envelope) => {
                activeWrites++;
                peakWrites = Math.max(peakWrites, activeWrites);
                writes.push(envelope.payload.marker);
                if (envelope.payload.marker === 1) await firstGate;
                activeWrites--;
            },
        });

        const first = writer.request(() => request(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        const replaced = writer.request(() => request(2));
        const latest = writer.request(() => request(3));
        expect(writer.metrics()).toMatchObject({ inflight: 1, pending: 1, coalescedTotal: 2 });

        releaseFirst();
        const results = await Promise.all([first, replaced, latest]);
        expect(results.map((result) => result.status)).toEqual(["saved", "saved", "saved"]);
        expect(writes).toEqual([1, 3]);
        expect(peakWrites).toBe(1);
        expect(results[1]?.checksum).toBe(results[2]?.checksum);
        await writer.flush();
        expect(writer.metrics()).toMatchObject({ inflight: 0, pending: 0, coalescedTotal: 2 });
    });

    it("times out callers, preserves physical single-flight, and opens the handoff circuit", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const events: string[] = [];
        const writer = new BoundedSnapshotWriter<TestSnapshot>({
            config: config({ timeoutMs: 20, failureThreshold: 1 }),
            write: () => gate,
            onEvent: (subject) => events.push(subject),
        });

        const first = await writer.request(() => request(1));
        expect(first).toMatchObject({ status: "timeout", error: "snapshot_write_timeout" });
        expect(writer.metrics()).toMatchObject({
            inflight: 1,
            failuresTotal: 1,
            timeoutsTotal: 1,
            circuitOpen: true,
            handoffEnabled: false,
        });
        await expect(writer.request(() => request(2))).resolves.toMatchObject({ status: "circuit_open" });
        expect(events).toContain("SnapshotSaveFailed");
        expect(events).toContain("SnapshotCircuitOpened");

        release();
        await writer.flush();
        expect(writer.metrics().inflight).toBe(0);
    });
});

describe("room state journal", () => {
    it("retains a bounded stream and catches a candidate up to a target tick", async () => {
        const journal = new RoomStateJournal({
            roomId: `room-journal-${Date.now()}`,
            maxEntries: 8,
            now: () => 1_700_000_000_000,
        });
        for (let tick = 1; tick <= 10; tick++) {
            await journal.append({ roomEpoch: 4, serverTick: tick, eventType: "state-checkpoint", payload: { tick } });
        }

        const retained = await journal.readAfter<{ tick: number }>();
        expect(retained.map((entry) => entry.serverTick)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
        const caughtUp = await journal.catchUp<{ tick: number }>({
            roomEpoch: 4,
            afterTick: 2,
            targetTick: 10,
            maxEntries: 8,
            batchSize: 3,
        });
        expect(caughtUp).toMatchObject({ caughtUp: true, latestTick: 10, limitReached: false });
        expect(caughtUp.entries).toHaveLength(8);

        const bounded = await journal.catchUp({
            roomEpoch: 4,
            targetTick: 10,
            maxEntries: 2,
        });
        expect(bounded).toMatchObject({ caughtUp: false, limitReached: true, latestTick: 4 });
        await journal.clear();
        await expect(journal.readAfter()).resolves.toEqual([]);
    });

    it("rejects checksum mutation and a candidate reading the wrong epoch", async () => {
        const entry = createRoomJournalEntry({
            roomId: "room-journal-checksum",
            roomEpoch: 9,
            serverTick: 15,
            eventType: "input-applied",
            createdAt: 1_700_000_000_000,
            payload: { sequence: 2 },
        });
        const tampered = structuredClone(entry);
        (tampered.payload as { sequence: number }).sequence = 3;
        expect(() => parseRoomJournalEntry(JSON.stringify(tampered))).toThrow("room_journal_checksum_mismatch");

        const journal = new RoomStateJournal({ roomId: `room-journal-epoch-${Date.now()}` });
        await journal.append({ roomEpoch: 9, serverTick: 15, eventType: "input-applied", payload: {} });
        await expect(journal.readAfter("0-0", { roomEpoch: 8 })).rejects.toThrow("room_journal_epoch_mismatch");
        await journal.clear();
    });
});

describe("candidate state loader", () => {
    const candidateEnvelope = (
        roomId: string,
        roomEpoch: number,
        serverTick: number,
        marker = serverTick,
    ) => createSnapshotEnvelope<CandidateTestSnapshot>({
        schemaVersion: 3,
        roomId,
        mapName: "faction",
        players: [{ sessionId: "stable-session" }],
        marker,
    }, {
        roomId,
        roomEpoch,
        serverTick,
        snapshotTick: serverTick,
        gameBuildRevision: "candidate-test",
        mapSeed: 7,
        createdAt: 1_700_000_000_000 + serverTick,
    });

    it("loads a read-only envelope and advances through bounded payload deltas", async () => {
        const roomId = `room-candidate-loader-${Date.now()}`;
        const seed = candidateEnvelope(roomId, 8, 10);
        const checkpoint = candidateEnvelope(roomId, 8, 12);
        const journal = new RoomStateJournal({ roomId });
        await journal.append({ roomEpoch: 7, serverTick: 99, eventType: "state-checkpoint", payload: seed });
        await journal.append({ roomEpoch: 8, serverTick: 9, eventType: "state-checkpoint", payload: seed });
        const delta = createSnapshotEnvelopeDelta(seed, checkpoint);
        expect(delta.target).not.toHaveProperty("payload");
        expect(delta.operations).toContainEqual({ op: "set", path: ["marker"], value: 12 });
        await journal.append({ roomEpoch: 8, serverTick: 12, eventType: "state-delta", payload: delta });
        const loader = new CandidateStateLoader<CandidateTestSnapshot>({
            roomId,
            mapName: "faction",
            maxPayloadBytes: 64 * 1024,
            readSnapshot: async () => JSON.stringify(seed),
            journal,
        });

        const outcome = await loader.seed({ expectedEpoch: 8, targetTick: 12, expectedChecksum: checkpoint.checksum });
        expect(outcome.status).toMatchObject({
            ready: true,
            caughtUp: true,
            roomEpoch: 8,
            serverTick: 12,
            checksum: checkpoint.checksum,
        });
        expect(outcome.envelope?.payload.marker).toBe(12);
        expect(outcome.status.scannedEntries).toBe(3);
        await journal.clear();
    });

    it("blocks epoch and checksum mismatches without returning a projection", async () => {
        const roomId = `room-candidate-block-${Date.now()}`;
        const seed = candidateEnvelope(roomId, 4, 20);
        const journal = new RoomStateJournal({ roomId });
        const loader = new CandidateStateLoader<CandidateTestSnapshot>({
            roomId,
            mapName: "faction",
            maxPayloadBytes: 64 * 1024,
            readSnapshot: async () => JSON.stringify(seed),
            journal,
        });

        const wrongEpoch = await loader.seed({ expectedEpoch: 5, targetTick: 20 });
        expect(wrongEpoch.status).toMatchObject({ ready: false, reason: "candidate_epoch_mismatch" });
        expect(wrongEpoch.envelope).toBeUndefined();
        const wrongChecksum = await loader.seed({ expectedEpoch: 4, targetTick: 20, expectedChecksum: "0".repeat(64) });
        expect(wrongChecksum.status).toMatchObject({ ready: false, reason: "candidate_checksum_mismatch" });
        expect(wrongChecksum.envelope).toBeUndefined();
        await journal.clear();
    });
});
