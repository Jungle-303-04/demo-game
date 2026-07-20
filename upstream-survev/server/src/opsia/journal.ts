import type { RedisClientType } from "redis";
import { checksumValue } from "./snapshot.ts";

export const ROOM_JOURNAL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ROOM_JOURNAL_MAX_ENTRIES = 128;
export const DEFAULT_ROOM_JOURNAL_READ_BATCH = 64;

export interface RoomJournalEntry<T = unknown> {
    kind: "opsia.room-journal-entry";
    schemaVersion: typeof ROOM_JOURNAL_SCHEMA_VERSION;
    roomId: string;
    roomEpoch: number;
    serverTick: number;
    eventType: string;
    createdAt: number;
    checksumAlgorithm: "sha256";
    checksum: string;
    payload: T;
}

export interface RoomJournalRecord<T = unknown> extends RoomJournalEntry<T> {
    id: string;
}

export interface JournalCatchUpResult<T = unknown> {
    entries: Array<RoomJournalRecord<T>>;
    cursor: string;
    latestTick: number;
    targetTick: number;
    caughtUp: boolean;
    limitReached: boolean;
    scannedEntries: number;
}

export interface RoomStateJournalOptions {
    roomId: string;
    client?: RedisClientType;
    lease?: { key: string; owner: string };
    maxEntries?: number;
    maxEntryBytes?: number;
    memoryFence?: () => boolean;
    now?: () => number;
}

export interface JournalCatchUpOptions {
    afterId?: string;
    afterTick?: number;
    targetTick: number;
    roomEpoch: number;
    batchSize?: number;
    maxEntries?: number;
}

interface StoredMemoryRecord {
    id: string;
    encoded: string;
}

const memoryJournals = new Map<string, StoredMemoryRecord[]>();
let memorySequence = 0;

const appendFencedScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
return redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'entry', ARGV[3])
`;
const clearFencedScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
return redis.call('DEL', KEYS[2])
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const journalContent = <T>(entry: Omit<RoomJournalEntry<T>, "checksum">) => ({
    kind: entry.kind,
    schemaVersion: entry.schemaVersion,
    roomId: entry.roomId,
    roomEpoch: entry.roomEpoch,
    serverTick: entry.serverTick,
    eventType: entry.eventType,
    createdAt: entry.createdAt,
    checksumAlgorithm: entry.checksumAlgorithm,
    payload: entry.payload,
});

export const createRoomJournalEntry = <T>(input: {
    roomId: string;
    roomEpoch: number;
    serverTick: number;
    eventType: string;
    createdAt?: number;
    payload: T;
}): RoomJournalEntry<T> => {
    if (
        !input.roomId
        || !input.eventType
        || !Number.isSafeInteger(input.roomEpoch)
        || input.roomEpoch < 0
        || !Number.isSafeInteger(input.serverTick)
        || input.serverTick < 0
    ) {
        throw new Error("invalid_room_journal_entry");
    }
    const unsigned: Omit<RoomJournalEntry<T>, "checksum"> = {
        kind: "opsia.room-journal-entry",
        schemaVersion: ROOM_JOURNAL_SCHEMA_VERSION,
        roomId: input.roomId,
        roomEpoch: input.roomEpoch,
        serverTick: input.serverTick,
        eventType: input.eventType,
        createdAt: input.createdAt ?? Date.now(),
        checksumAlgorithm: "sha256",
        payload: input.payload,
    };
    return { ...unsigned, checksum: checksumValue(journalContent(unsigned)) };
};

export const parseRoomJournalEntry = <T = unknown>(encoded: string): RoomJournalEntry<T> => {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch {
        throw new Error("invalid_room_journal_json");
    }
    if (
        !isRecord(value)
        || value.kind !== "opsia.room-journal-entry"
        || value.schemaVersion !== ROOM_JOURNAL_SCHEMA_VERSION
        || typeof value.roomId !== "string"
        || value.roomId.length === 0
        || !Number.isSafeInteger(value.roomEpoch)
        || Number(value.roomEpoch) < 0
        || !Number.isSafeInteger(value.serverTick)
        || Number(value.serverTick) < 0
        || typeof value.eventType !== "string"
        || value.eventType.length === 0
        || !Number.isSafeInteger(value.createdAt)
        || Number(value.createdAt) < 0
        || value.checksumAlgorithm !== "sha256"
        || typeof value.checksum !== "string"
        || value.checksum.length !== 64
    ) {
        throw new Error("invalid_room_journal_entry");
    }
    const entry = value as unknown as RoomJournalEntry<T>;
    const { checksum, ...unsigned } = entry;
    if (checksumValue(journalContent(unsigned)) !== checksum) throw new Error("room_journal_checksum_mismatch");
    return entry;
};

const compareStreamIds = (left: string, right: string): number => {
    const [leftMs = 0, leftSequence = 0] = left.split("-").map(Number);
    const [rightMs = 0, rightSequence = 0] = right.split("-").map(Number);
    return leftMs === rightMs ? leftSequence - rightSequence : leftMs - rightMs;
};

const positiveInteger = (value: number, name: string, min: number, max: number): number => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_invalid`);
    return value;
};

export class RoomStateJournal {
    readonly key: string;
    private readonly roomId: string;
    private readonly client: RedisClientType | undefined;
    private readonly lease: RoomStateJournalOptions["lease"];
    private readonly maxEntries: number;
    private readonly maxEntryBytes: number;
    private readonly memoryFence: () => boolean;
    private readonly now: () => number;

    constructor(options: RoomStateJournalOptions) {
        if (!options.roomId) throw new Error("room_journal_room_required");
        this.roomId = options.roomId;
        this.key = `room:${options.roomId}:journal`;
        this.client = options.client;
        this.lease = options.lease;
        this.maxEntries = positiveInteger(
            options.maxEntries ?? DEFAULT_ROOM_JOURNAL_MAX_ENTRIES,
            "room_journal_max_entries",
            8,
            10_000,
        );
        this.maxEntryBytes = positiveInteger(
            options.maxEntryBytes ?? 4 * 1024 * 1024,
            "room_journal_max_entry_bytes",
            1_024,
            64 * 1024 * 1024,
        );
        this.memoryFence = options.memoryFence ?? (() => true);
        this.now = options.now ?? Date.now;
    }

    async append<T>(input: {
        roomEpoch: number;
        serverTick: number;
        eventType: string;
        payload: T;
    }): Promise<string> {
        const entry = createRoomJournalEntry({
            roomId: this.roomId,
            roomEpoch: input.roomEpoch,
            serverTick: input.serverTick,
            eventType: input.eventType,
            createdAt: this.now(),
            payload: input.payload,
        });
        const encoded = JSON.stringify(entry);
        if (Buffer.byteLength(encoded, "utf8") > this.maxEntryBytes) throw new Error("room_journal_entry_too_large");

        if (this.client) {
            if (!this.lease) throw new Error("room_journal_lease_required");
            const id = await this.client.eval(appendFencedScript, {
                keys: [this.lease.key, this.key],
                arguments: [this.lease.owner, String(this.maxEntries), encoded],
            });
            if (typeof id !== "string") throw new Error("room_lease_lost");
            return id;
        }
        if (!this.memoryFence()) throw new Error("room_lease_lost");
        const id = `${this.now()}-${memorySequence++}`;
        const records = memoryJournals.get(this.key) ?? [];
        records.push({ id, encoded });
        if (records.length > this.maxEntries) records.splice(0, records.length - this.maxEntries);
        memoryJournals.set(this.key, records);
        return id;
    }

    async readAfter<T = unknown>(
        cursor = "0-0",
        options: { count?: number; roomEpoch?: number } = {},
    ): Promise<Array<RoomJournalRecord<T>>> {
        if (!/^\d+-\d+$/.test(cursor)) throw new Error("invalid_room_journal_cursor");
        const count = positiveInteger(options.count ?? DEFAULT_ROOM_JOURNAL_READ_BATCH, "journal_read_count", 1, 1_000);
        let encodedRecords: StoredMemoryRecord[];
        if (this.client) {
            const records = await this.client.xRange(this.key, `(${cursor}`, "+", { COUNT: count });
            encodedRecords = records.map((record) => {
                const encoded = record.message.entry;
                if (typeof encoded !== "string") throw new Error("invalid_room_journal_entry");
                return { id: record.id, encoded };
            });
        } else {
            encodedRecords = (memoryJournals.get(this.key) ?? [])
                .filter((record) => compareStreamIds(record.id, cursor) > 0)
                .slice(0, count);
        }

        return encodedRecords.map(({ id, encoded }) => {
            if (Buffer.byteLength(encoded, "utf8") > this.maxEntryBytes) {
                throw new Error("room_journal_entry_too_large");
            }
            const entry = parseRoomJournalEntry<T>(encoded);
            if (entry.roomId !== this.roomId) throw new Error("room_journal_room_mismatch");
            if (options.roomEpoch !== undefined && entry.roomEpoch !== options.roomEpoch) {
                throw new Error("room_journal_epoch_mismatch");
            }
            return { id, ...entry };
        });
    }

    async catchUp<T = unknown>(options: JournalCatchUpOptions): Promise<JournalCatchUpResult<T>> {
        const batchSize = positiveInteger(
            options.batchSize ?? DEFAULT_ROOM_JOURNAL_READ_BATCH,
            "journal_read_batch",
            1,
            1_000,
        );
        const maxEntries = positiveInteger(options.maxEntries ?? this.maxEntries, "journal_catchup_limit", 1, 10_000);
        let cursor = options.afterId ?? "0-0";
        let latestTick = options.afterTick ?? 0;
        const entries: Array<RoomJournalRecord<T>> = [];
        let scannedEntries = 0;

        while (scannedEntries < maxEntries && latestTick < options.targetTick) {
            const remaining = maxEntries - scannedEntries;
            const batch = await this.readAfter<T>(cursor, {
                count: Math.min(batchSize, remaining),
            });
            if (batch.length === 0) break;
            for (const record of batch) {
                scannedEntries++;
                cursor = record.id;
                if (record.roomEpoch < options.roomEpoch) continue;
                if (record.roomEpoch > options.roomEpoch) throw new Error("room_journal_epoch_mismatch");
                // A snapshot does not need to know its Redis stream ID. Skip
                // checkpoints already represented by the seed envelope while
                // still advancing the bounded cursor.
                if (record.serverTick <= latestTick) continue;
                entries.push(record);
                latestTick = record.serverTick;
                if (latestTick >= options.targetTick) break;
            }
            if (batch.length < Math.min(batchSize, remaining)) break;
        }

        return {
            entries,
            cursor,
            latestTick,
            targetTick: options.targetTick,
            caughtUp: latestTick >= options.targetTick,
            limitReached: scannedEntries >= maxEntries && latestTick < options.targetTick,
            scannedEntries,
        };
    }

    async clear(): Promise<void> {
        if (this.client) {
            if (!this.lease) throw new Error("room_journal_lease_required");
            const cleared = await this.client.eval(clearFencedScript, {
                keys: [this.lease.key, this.key],
                arguments: [this.lease.owner],
            });
            if (Number(cleared) === -1) throw new Error("room_lease_lost");
            return;
        }
        if (!this.memoryFence()) throw new Error("room_lease_lost");
        memoryJournals.delete(this.key);
    }
}
