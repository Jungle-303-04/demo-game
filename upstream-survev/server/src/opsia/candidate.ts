import { type RoomStateJournal } from "./journal.ts";
import { type GameSnapshotEnvelope, parseSnapshotEnvelope, verifySnapshotEnvelope } from "./snapshot.ts";

export const SNAPSHOT_DELTA_SCHEMA_VERSION = 1 as const;

export type SnapshotDeltaOperation =
    | { op: "set"; path: Array<string | number>; value: unknown }
    | { op: "delete"; path: Array<string | number> }
    | { op: "truncate"; path: Array<string | number>; length: number };

export interface SnapshotEnvelopeDelta<T> {
    kind: "opsia.snapshot-delta";
    schemaVersion: typeof SNAPSHOT_DELTA_SCHEMA_VERSION;
    baseChecksum: string;
    baseServerTick: number;
    target: Omit<GameSnapshotEnvelope<T>, "payload">;
    operations: SnapshotDeltaOperation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const appendDeltaOperations = (
    before: unknown,
    after: unknown,
    path: Array<string | number>,
    operations: SnapshotDeltaOperation[],
): void => {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
        const shared = Math.min(before.length, after.length);
        for (let index = 0; index < shared; index++) {
            appendDeltaOperations(before[index], after[index], [...path, index], operations);
        }
        if (after.length < before.length) {
            operations.push({ op: "truncate", path: [...path], length: after.length });
        } else {
            for (let index = before.length; index < after.length; index++) {
                operations.push({ op: "set", path: [...path, index], value: cloneJson(after[index]) });
            }
        }
        return;
    }
    if (isRecord(before) && isRecord(after)) {
        const beforeKeys = Object.keys(before).sort();
        const afterKeys = Object.keys(after).sort();
        const afterSet = new Set(afterKeys);
        for (const key of beforeKeys) {
            if (!afterSet.has(key)) operations.push({ op: "delete", path: [...path, key] });
        }
        for (const key of afterKeys) {
            if (!(key in before)) {
                operations.push({ op: "set", path: [...path, key], value: cloneJson(after[key]) });
            } else {
                appendDeltaOperations(before[key], after[key], [...path, key], operations);
            }
        }
        return;
    }
    operations.push({ op: "set", path: [...path], value: cloneJson(after) });
};

/** Produces a payload-only field/object patch; envelope metadata is carried once. */
export const createSnapshotEnvelopeDelta = <T>(
    base: GameSnapshotEnvelope<T>,
    targetEnvelope: GameSnapshotEnvelope<T>,
): SnapshotEnvelopeDelta<T> => {
    if (
        base.roomId !== targetEnvelope.roomId
        || base.roomEpoch !== targetEnvelope.roomEpoch
        || targetEnvelope.serverTick <= base.serverTick
    ) throw new Error("snapshot_delta_context_mismatch");
    const before = cloneJson(base.payload);
    const after = cloneJson(targetEnvelope.payload);
    const operations: SnapshotDeltaOperation[] = [];
    appendDeltaOperations(before, after, [], operations);
    const { payload: _payload, ...target } = targetEnvelope;
    return {
        kind: "opsia.snapshot-delta",
        schemaVersion: SNAPSHOT_DELTA_SCHEMA_VERSION,
        baseChecksum: base.checksum,
        baseServerTick: base.serverTick,
        target,
        operations,
    };
};

const unsafePathKey = (value: string): boolean =>
    value === "__proto__" || value === "prototype" || value === "constructor";

function validatePath(path: unknown): asserts path is Array<string | number> {
    if (!Array.isArray(path) || path.length > 64) throw new Error("snapshot_delta_path_invalid");
    for (const segment of path) {
        if (typeof segment === "string") {
            if (unsafePathKey(segment)) throw new Error("snapshot_delta_path_invalid");
        } else if (!Number.isSafeInteger(segment) || Number(segment) < 0) {
            throw new Error("snapshot_delta_path_invalid");
        }
    }
}

const deltaParent = (root: unknown, path: Array<string | number>): { parent: unknown; key: string | number } => {
    if (path.length === 0) throw new Error("snapshot_delta_path_invalid");
    let parent = root;
    for (const segment of path.slice(0, -1)) {
        if (Array.isArray(parent)) {
            if (typeof segment !== "number" || segment >= parent.length) throw new Error("snapshot_delta_path_invalid");
            parent = parent[segment];
        } else if (isRecord(parent)) {
            if (typeof segment !== "string" || !(segment in parent)) throw new Error("snapshot_delta_path_invalid");
            parent = parent[segment];
        } else {
            throw new Error("snapshot_delta_path_invalid");
        }
    }
    return { parent, key: path[path.length - 1]! };
};

export const applySnapshotEnvelopeDelta = <T extends { schemaVersion: number }>(
    base: GameSnapshotEnvelope<T>,
    value: unknown,
    expected?: { roomId?: string; maxPayloadBytes?: number },
): GameSnapshotEnvelope<T> => {
    if (
        !isRecord(value)
        || value.kind !== "opsia.snapshot-delta"
        || value.schemaVersion !== SNAPSHOT_DELTA_SCHEMA_VERSION
        || typeof value.baseChecksum !== "string"
        || value.baseChecksum !== base.checksum
        || value.baseServerTick !== base.serverTick
        || !isRecord(value.target)
        || !Array.isArray(value.operations)
        || value.operations.length > 250_000
    ) throw new Error("snapshot_delta_base_mismatch");

    let payload: unknown = cloneJson(base.payload);
    for (const rawOperation of value.operations) {
        if (!isRecord(rawOperation) || typeof rawOperation.op !== "string") {
            throw new Error("snapshot_delta_operation_invalid");
        }
        validatePath(rawOperation.path);
        const path = rawOperation.path;
        if (rawOperation.op === "set") {
            if (!("value" in rawOperation)) throw new Error("snapshot_delta_operation_invalid");
            if (path.length === 0) {
                payload = cloneJson(rawOperation.value);
                continue;
            }
            const { parent, key } = deltaParent(payload, path);
            if (Array.isArray(parent)) {
                if (typeof key !== "number" || key > parent.length) throw new Error("snapshot_delta_path_invalid");
                parent[key] = cloneJson(rawOperation.value);
            } else if (isRecord(parent) && typeof key === "string") {
                parent[key] = cloneJson(rawOperation.value);
            } else {
                throw new Error("snapshot_delta_path_invalid");
            }
        } else if (rawOperation.op === "delete") {
            const { parent, key } = deltaParent(payload, path);
            if (!isRecord(parent) || typeof key !== "string" || !(key in parent)) {
                throw new Error("snapshot_delta_path_invalid");
            }
            delete parent[key];
        } else if (rawOperation.op === "truncate") {
            if (!Number.isSafeInteger(rawOperation.length) || Number(rawOperation.length) < 0) {
                throw new Error("snapshot_delta_operation_invalid");
            }
            let array: unknown = payload;
            for (const segment of path) {
                if (Array.isArray(array) && typeof segment === "number" && segment < array.length) {
                    array = array[segment];
                } else if (isRecord(array) && typeof segment === "string" && segment in array) {
                    array = array[segment];
                } else {
                    throw new Error("snapshot_delta_path_invalid");
                }
            }
            if (!Array.isArray(array) || Number(rawOperation.length) > array.length) {
                throw new Error("snapshot_delta_path_invalid");
            }
            array.length = Number(rawOperation.length);
        } else {
            throw new Error("snapshot_delta_operation_invalid");
        }
    }
    const reconstructed = { ...value.target, payload };
    const envelope = verifySnapshotEnvelope<T>(reconstructed, expected);
    if (
        envelope.roomId !== base.roomId
        || envelope.roomEpoch !== base.roomEpoch
        || envelope.serverTick <= base.serverTick
    ) throw new Error("snapshot_delta_context_mismatch");
    return envelope;
};

export type OpsiaRuntimeRole = "active" | "candidate";
export type OpsiaConfiguredRole = OpsiaRuntimeRole | "auto";

export interface CandidatePromoteRequest {
    expectedEpoch: number;
    nextEpoch: number;
    expectedChecksum: string;
}

export interface ActiveReleaseRequest {
    expectedEpoch: number;
    expectedChecksum: string;
}

export interface CandidateSnapshotPayload {
    schemaVersion: number;
    roomId: string;
    mapName: string;
    players: unknown[];
}

export interface CandidateSeedRequest {
    expectedEpoch: number;
    targetTick: number;
    expectedChecksum?: string;
    maxEntries?: number;
}

export interface OpsiaHandoffStatusData {
    role: OpsiaRuntimeRole;
    roomId: string;
    ready: boolean;
    phase: "active" | "waiting_snapshot" | "seeded" | "blocked";
    roomEpoch?: number;
    serverTick?: number;
    snapshotTick?: number;
    checksum?: string;
    /** Canonical checksum recomputed after the Candidate materializes the world. */
    stateChecksum?: string;
    mapName?: string;
    players?: number;
    targetTick?: number;
    journalCursor?: string;
    journalEntries?: number;
    scannedEntries?: number;
    caughtUp?: boolean;
    reason?: string;
    observedAt: number;
}

export interface CandidateSeedOutcome<T extends CandidateSnapshotPayload> {
    status: OpsiaHandoffStatusData;
    envelope?: GameSnapshotEnvelope<T>;
}

export interface CandidateStateLoaderOptions<T extends CandidateSnapshotPayload> {
    roomId: string;
    mapName: string;
    maxPayloadBytes: number;
    readSnapshot: () => Promise<string | undefined>;
    journal: RoomStateJournal;
    now?: () => number;
}

const checksumPattern = /^[a-f\d]{64}$/;

export class CandidateStateLoader<T extends CandidateSnapshotPayload> {
    private readonly roomId: string;
    private readonly mapName: string;
    private readonly maxPayloadBytes: number;
    private readonly readSnapshot: () => Promise<string | undefined>;
    private readonly journal: RoomStateJournal;
    private readonly now: () => number;

    constructor(options: CandidateStateLoaderOptions<T>) {
        this.roomId = options.roomId;
        this.mapName = options.mapName;
        this.maxPayloadBytes = options.maxPayloadBytes;
        this.readSnapshot = options.readSnapshot;
        this.journal = options.journal;
        this.now = options.now ?? Date.now;
    }

    async loadLatest(expectedEpoch?: number): Promise<CandidateSeedOutcome<T>> {
        return this.seedInternal({ expectedEpoch, targetTick: 0, maxEntries: 1 });
    }

    async seed(request: CandidateSeedRequest): Promise<CandidateSeedOutcome<T>> {
        if (
            !Number.isSafeInteger(request.expectedEpoch)
            || request.expectedEpoch < 0
            || !Number.isSafeInteger(request.targetTick)
            || request.targetTick < 0
            || (request.expectedChecksum !== undefined && !checksumPattern.test(request.expectedChecksum))
            || (request.maxEntries !== undefined
                && (!Number.isSafeInteger(request.maxEntries) || request.maxEntries < 1 || request.maxEntries > 512))
        ) {
            return this.blocked("candidate_seed_invalid", request.targetTick);
        }
        return this.seedInternal({
            expectedEpoch: request.expectedEpoch,
            targetTick: request.targetTick,
            expectedChecksum: request.expectedChecksum,
            maxEntries: request.maxEntries ?? 128,
        });
    }

    private async seedInternal(input: {
        expectedEpoch?: number;
        targetTick: number;
        expectedChecksum?: string;
        maxEntries: number;
    }): Promise<CandidateSeedOutcome<T>> {
        let serialized: string | undefined;
        try {
            serialized = await this.readSnapshot();
        } catch (error) {
            return this.blocked(
                error instanceof Error ? error.message : "candidate_snapshot_read_failed",
                input.targetTick,
            );
        }
        if (!serialized) return this.waiting("candidate_snapshot_missing", input.targetTick);

        let envelope: GameSnapshotEnvelope<T>;
        try {
            envelope = parseSnapshotEnvelope<T>(serialized, {
                roomId: this.roomId,
                maxPayloadBytes: this.maxPayloadBytes,
            });
        } catch (error) {
            return this.blocked(error instanceof Error ? error.message : "invalid_snapshot_envelope", input.targetTick);
        }
        if (envelope.payload.mapName !== this.mapName) {
            return this.blocked("candidate_map_mismatch", input.targetTick, envelope);
        }
        if (input.expectedEpoch !== undefined && envelope.roomEpoch !== input.expectedEpoch) {
            return this.blocked("candidate_epoch_mismatch", input.targetTick, envelope);
        }

        let finalEnvelope = envelope;
        let journalCursor = "0-0";
        let journalEntries = 0;
        let scannedEntries = 0;
        if (finalEnvelope.serverTick < input.targetTick) {
            let catchUp;
            try {
                catchUp = await this.journal.catchUp<unknown>({
                    afterTick: finalEnvelope.serverTick,
                    targetTick: input.targetTick,
                    roomEpoch: finalEnvelope.roomEpoch,
                    maxEntries: input.maxEntries,
                });
            } catch (error) {
                return this.blocked(
                    error instanceof Error ? error.message : "candidate_journal_read_failed",
                    input.targetTick,
                    finalEnvelope,
                );
            }
            journalCursor = catchUp.cursor;
            journalEntries = catchUp.entries.length;
            scannedEntries = catchUp.scannedEntries;
            for (const record of catchUp.entries) {
                if (record.eventType === "state-delta") {
                    try {
                        finalEnvelope = applySnapshotEnvelopeDelta<T>(finalEnvelope, record.payload, {
                            roomId: this.roomId,
                            maxPayloadBytes: this.maxPayloadBytes,
                        });
                    } catch (error) {
                        return this.blocked(
                            error instanceof Error ? error.message : "candidate_journal_delta_invalid",
                            input.targetTick,
                            finalEnvelope,
                        );
                    }
                    if (
                        finalEnvelope.serverTick !== record.serverTick
                        || finalEnvelope.payload.mapName !== this.mapName
                    ) {
                        return this.blocked("candidate_journal_delta_mismatch", input.targetTick, finalEnvelope);
                    }
                    continue;
                }
                // Read compatibility for journals produced during the schema-3
                // rollout. New writers emit payload deltas only.
                if (record.eventType !== "state-checkpoint") continue;
                let checkpoint: GameSnapshotEnvelope<T>;
                try {
                    checkpoint = verifySnapshotEnvelope<T>(record.payload, {
                        roomId: this.roomId,
                        maxPayloadBytes: this.maxPayloadBytes,
                    });
                } catch (error) {
                    return this.blocked(
                        error instanceof Error ? error.message : "candidate_journal_envelope_invalid",
                        input.targetTick,
                        finalEnvelope,
                    );
                }
                if (
                    checkpoint.roomEpoch !== finalEnvelope.roomEpoch
                    || checkpoint.serverTick !== record.serverTick
                    || checkpoint.payload.mapName !== this.mapName
                ) {
                    return this.blocked("candidate_journal_envelope_mismatch", input.targetTick, finalEnvelope);
                }
                finalEnvelope = checkpoint;
            }
        }

        if (finalEnvelope.serverTick < input.targetTick) {
            return {
                status: {
                    ...this.statusForEnvelope(finalEnvelope),
                    ready: false,
                    phase: "blocked",
                    targetTick: input.targetTick,
                    journalCursor,
                    journalEntries,
                    scannedEntries,
                    caughtUp: false,
                    reason: "candidate_not_caught_up",
                },
            };
        }
        if (input.expectedChecksum !== undefined && finalEnvelope.checksum !== input.expectedChecksum) {
            return this.blocked("candidate_checksum_mismatch", input.targetTick, finalEnvelope);
        }

        return {
            envelope: finalEnvelope,
            status: {
                ...this.statusForEnvelope(finalEnvelope),
                ready: true,
                phase: "seeded",
                targetTick: input.targetTick || finalEnvelope.serverTick,
                journalCursor,
                journalEntries,
                scannedEntries,
                caughtUp: true,
            },
        };
    }

    private statusForEnvelope(envelope: GameSnapshotEnvelope<T>): OpsiaHandoffStatusData {
        return {
            role: "candidate",
            roomId: this.roomId,
            ready: false,
            phase: "blocked",
            roomEpoch: envelope.roomEpoch,
            serverTick: envelope.serverTick,
            snapshotTick: envelope.snapshotTick,
            checksum: envelope.checksum,
            mapName: envelope.payload.mapName,
            players: envelope.payload.players.length,
            observedAt: this.now(),
        };
    }

    private blocked(
        reason: string,
        targetTick: number,
        envelope?: GameSnapshotEnvelope<T>,
    ): CandidateSeedOutcome<T> {
        return {
            status: {
                ...(envelope
                    ? this.statusForEnvelope(envelope)
                    : {
                        role: "candidate" as const,
                        roomId: this.roomId,
                        ready: false,
                        phase: "blocked" as const,
                        observedAt: this.now(),
                    }),
                ready: false,
                phase: "blocked",
                targetTick,
                caughtUp: false,
                reason,
            },
        };
    }

    private waiting(reason: string, targetTick: number): CandidateSeedOutcome<T> {
        return {
            status: {
                role: "candidate",
                roomId: this.roomId,
                ready: false,
                phase: "waiting_snapshot",
                targetTick,
                caughtUp: false,
                reason,
                observedAt: this.now(),
            },
        };
    }
}
