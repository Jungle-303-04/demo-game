import { createHash, timingSafeEqual } from "node:crypto";

export const SNAPSHOT_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 1_000;
export const DEFAULT_MIN_SNAPSHOT_INTERVAL_MS = 250;
export const ABSOLUTE_MIN_SNAPSHOT_INTERVAL_MS = 100;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 750;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_FAILURE_THRESHOLD = 3;
export const DEFAULT_SNAPSHOT_CIRCUIT_COOLDOWN_MS = 5_000;

export interface SnapshotEnvelopeContext {
    roomId: string;
    roomEpoch: number;
    serverTick: number;
    snapshotTick: number;
    gameBuildRevision: string;
    mapSeed: number;
    createdAt?: number;
}

export interface GameSnapshotEnvelope<T> {
    kind: "opsia.game-snapshot";
    schemaVersion: typeof SNAPSHOT_ENVELOPE_SCHEMA_VERSION;
    payloadSchemaVersion: number;
    roomId: string;
    roomEpoch: number;
    serverTick: number;
    snapshotTick: number;
    gameBuildRevision: string;
    mapSeed: number;
    createdAt: number;
    checksumAlgorithm: "sha256";
    checksum: string;
    payload: T;
}

export interface SnapshotRuntimeConfig {
    intervalMs: number;
    minIntervalMs: number;
    timeoutMs: number;
    maxPayloadBytes: number;
    failureThreshold: number;
    circuitCooldownMs: number;
}

export interface SnapshotWriterMetrics {
    roomEpoch: number;
    serverTick: number;
    inflight: 0 | 1;
    pending: 0 | 1;
    payloadBytes: number;
    writeDurationMs: number;
    coalescedTotal: number;
    failuresTotal: number;
    timeoutsTotal: number;
    consecutiveFailures: number;
    circuitOpen: boolean;
    handoffEnabled: boolean;
    oldestPendingAgeMs: number;
    lastChecksum?: string;
    lastError?: string;
}

export type SnapshotOperationEvent =
    | "SnapshotSaveStarted"
    | "SnapshotSaveCompleted"
    | "SnapshotSaveCoalesced"
    | "SnapshotBacklogDetected"
    | "SnapshotSaveFailed"
    | "SnapshotCircuitOpened"
    | "SnapshotCircuitHalfOpened"
    | "SnapshotCircuitClosed";

export interface SnapshotWriterOptions<T> {
    config: SnapshotRuntimeConfig;
    write: (serialized: string, envelope: GameSnapshotEnvelope<T>) => Promise<void>;
    onEvent?: (subject: SnapshotOperationEvent, payload: Record<string, unknown>) => void;
    now?: () => number;
}

export interface SnapshotSaveRequest<T> {
    context: SnapshotEnvelopeContext;
    payload: T;
}

export interface SnapshotSaveResult {
    status: "saved" | "failed" | "timeout" | "circuit_open";
    checksum?: string;
    payloadBytes?: number;
    durationMs?: number;
    error?: string;
}

interface PendingWrite<T> {
    factory: () => SnapshotSaveRequest<T>;
    requestedAt: number;
    waiters: Array<(result: SnapshotSaveResult) => void>;
}

const integerSetting = (
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name.toLowerCase()}_invalid`);
    }
    return value;
};

export const readSnapshotRuntimeConfig = (env: NodeJS.ProcessEnv = process.env): SnapshotRuntimeConfig => {
    const minIntervalMs = integerSetting(
        env,
        "OPSIA_SNAPSHOT_MIN_INTERVAL_MS",
        DEFAULT_MIN_SNAPSHOT_INTERVAL_MS,
        ABSOLUTE_MIN_SNAPSHOT_INTERVAL_MS,
        60_000,
    );
    const intervalMs = integerSetting(
        env,
        "OPSIA_SNAPSHOT_INTERVAL_MS",
        DEFAULT_SNAPSHOT_INTERVAL_MS,
        ABSOLUTE_MIN_SNAPSHOT_INTERVAL_MS,
        60_000,
    );
    if (intervalMs < minIntervalMs) throw new Error("opsia_snapshot_interval_below_minimum");

    return {
        intervalMs,
        minIntervalMs,
        timeoutMs: integerSetting(env, "OPSIA_SNAPSHOT_TIMEOUT_MS", DEFAULT_SNAPSHOT_TIMEOUT_MS, 50, 60_000),
        maxPayloadBytes: integerSetting(
            env,
            "OPSIA_SNAPSHOT_MAX_BYTES",
            DEFAULT_SNAPSHOT_MAX_BYTES,
            1_024,
            64 * 1024 * 1024,
        ),
        failureThreshold: integerSetting(
            env,
            "OPSIA_SNAPSHOT_FAILURE_THRESHOLD",
            DEFAULT_SNAPSHOT_FAILURE_THRESHOLD,
            1,
            100,
        ),
        circuitCooldownMs: integerSetting(
            env,
            "OPSIA_SNAPSHOT_CIRCUIT_COOLDOWN_MS",
            DEFAULT_SNAPSHOT_CIRCUIT_COOLDOWN_MS,
            100,
            5 * 60_000,
        ),
    };
};

const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("snapshot_contains_non_finite_number");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const fields = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
        return `{${fields.join(",")}}`;
    }
    throw new Error("snapshot_contains_unsupported_value");
};

export const checksumValue = (value: unknown): string =>
    createHash("sha256").update(canonicalJson(value)).digest("hex");

const envelopeContent = <T>(envelope: Omit<GameSnapshotEnvelope<T>, "checksum">) => ({
    kind: envelope.kind,
    schemaVersion: envelope.schemaVersion,
    payloadSchemaVersion: envelope.payloadSchemaVersion,
    roomId: envelope.roomId,
    roomEpoch: envelope.roomEpoch,
    serverTick: envelope.serverTick,
    snapshotTick: envelope.snapshotTick,
    gameBuildRevision: envelope.gameBuildRevision,
    mapSeed: envelope.mapSeed,
    createdAt: envelope.createdAt,
    checksumAlgorithm: envelope.checksumAlgorithm,
    payload: envelope.payload,
});

export const createSnapshotEnvelope = <T extends { schemaVersion: number }>(
    payload: T,
    context: SnapshotEnvelopeContext,
): GameSnapshotEnvelope<T> => {
    if (!context.roomId || !Number.isSafeInteger(context.roomEpoch) || context.roomEpoch < 0) {
        throw new Error("invalid_snapshot_context");
    }
    if (!Number.isSafeInteger(context.serverTick) || context.serverTick < 0) {
        throw new Error("invalid_snapshot_server_tick");
    }
    if (!Number.isSafeInteger(context.snapshotTick) || context.snapshotTick < 0) {
        throw new Error("invalid_snapshot_tick");
    }
    if (!Number.isSafeInteger(payload.schemaVersion) || payload.schemaVersion < 1) {
        throw new Error("invalid_snapshot_payload_schema");
    }

    const unsigned: Omit<GameSnapshotEnvelope<T>, "checksum"> = {
        kind: "opsia.game-snapshot",
        schemaVersion: SNAPSHOT_ENVELOPE_SCHEMA_VERSION,
        payloadSchemaVersion: payload.schemaVersion,
        roomId: context.roomId,
        roomEpoch: context.roomEpoch,
        serverTick: context.serverTick,
        snapshotTick: context.snapshotTick,
        gameBuildRevision: context.gameBuildRevision,
        mapSeed: context.mapSeed,
        createdAt: context.createdAt ?? Date.now(),
        checksumAlgorithm: "sha256",
        payload,
    };
    return { ...unsigned, checksum: checksumValue(envelopeContent(unsigned)) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const verifySnapshotEnvelope = <T extends { schemaVersion: number }>(
    value: unknown,
    expected?: { roomId?: string; maxPayloadBytes?: number },
): GameSnapshotEnvelope<T> => {
    if (!isRecord(value)) throw new Error("invalid_snapshot_envelope");
    if (
        value.kind !== "opsia.game-snapshot"
        || value.schemaVersion !== SNAPSHOT_ENVELOPE_SCHEMA_VERSION
        || value.checksumAlgorithm !== "sha256"
        || typeof value.checksum !== "string"
        || value.checksum.length !== 64
        || typeof value.roomId !== "string"
        || value.roomId.length === 0
        || !Number.isSafeInteger(value.roomEpoch)
        || Number(value.roomEpoch) < 0
        || !Number.isSafeInteger(value.serverTick)
        || Number(value.serverTick) < 0
        || !Number.isSafeInteger(value.snapshotTick)
        || Number(value.snapshotTick) < 0
        || typeof value.gameBuildRevision !== "string"
        || value.gameBuildRevision.length === 0
        || !Number.isFinite(value.mapSeed)
        || !Number.isSafeInteger(value.createdAt)
        || Number(value.createdAt) < 0
        || !isRecord(value.payload)
        || !Number.isSafeInteger(value.payloadSchemaVersion)
        || Number(value.payloadSchemaVersion) < 1
        || value.payload.schemaVersion !== value.payloadSchemaVersion
        || (typeof value.payload.roomId === "string" && value.payload.roomId !== value.roomId)
    ) {
        throw new Error("invalid_snapshot_envelope");
    }
    if (expected?.roomId !== undefined && value.roomId !== expected.roomId) {
        throw new Error("snapshot_room_mismatch");
    }
    if (
        expected?.maxPayloadBytes !== undefined
        && Buffer.byteLength(JSON.stringify(value), "utf8") > expected.maxPayloadBytes
    ) {
        throw new Error("snapshot_payload_too_large");
    }

    const envelope = value as unknown as GameSnapshotEnvelope<T>;
    const { checksum, ...unsigned } = envelope;
    const calculated = checksumValue(envelopeContent(unsigned));
    const suppliedBytes = Buffer.from(checksum, "hex");
    const calculatedBytes = Buffer.from(calculated, "hex");
    if (suppliedBytes.length !== calculatedBytes.length || !timingSafeEqual(suppliedBytes, calculatedBytes)) {
        throw new Error("snapshot_checksum_mismatch");
    }
    return envelope;
};

export const parseSnapshotEnvelope = <T extends { schemaVersion: number }>(
    serialized: string,
    expected?: { roomId?: string; maxPayloadBytes?: number },
): GameSnapshotEnvelope<T> => {
    if (
        expected?.maxPayloadBytes !== undefined
        && Buffer.byteLength(serialized, "utf8") > expected.maxPayloadBytes
    ) {
        throw new Error("snapshot_payload_too_large");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    } catch {
        throw new Error("invalid_snapshot_json");
    }
    return verifySnapshotEnvelope<T>(parsed, expected);
};

export class BoundedSnapshotWriter<T extends { schemaVersion: number }> {
    private readonly config: SnapshotRuntimeConfig;
    private readonly write: SnapshotWriterOptions<T>["write"];
    private readonly onEvent: NonNullable<SnapshotWriterOptions<T>["onEvent"]>;
    private readonly now: () => number;
    private readonly state: SnapshotWriterMetrics = {
        roomEpoch: 0,
        serverTick: 0,
        inflight: 0,
        pending: 0,
        payloadBytes: 0,
        writeDurationMs: 0,
        coalescedTotal: 0,
        failuresTotal: 0,
        timeoutsTotal: 0,
        consecutiveFailures: 0,
        circuitOpen: false,
        handoffEnabled: true,
        oldestPendingAgeMs: 0,
    };
    private inFlight: Promise<void> | undefined;
    private pending: PendingWrite<T> | undefined;
    private circuitOpenUntil = 0;
    private inFlightStartedAt = 0;

    constructor(options: SnapshotWriterOptions<T>) {
        this.config = options.config;
        this.write = options.write;
        this.onEvent = options.onEvent ?? (() => undefined);
        this.now = options.now ?? Date.now;
    }

    metrics(): SnapshotWriterMetrics {
        const now = this.now();
        return {
            ...this.state,
            circuitOpen: this.state.circuitOpen,
            handoffEnabled: !this.state.circuitOpen
                && this.state.consecutiveFailures < this.config.failureThreshold,
            oldestPendingAgeMs: this.pending ? Math.max(0, now - this.pending.requestedAt) : 0,
        };
    }

    request(factory: () => SnapshotSaveRequest<T>): Promise<SnapshotSaveResult> {
        const now = this.now();
        if (this.circuitOpenUntil > now) {
            return Promise.resolve({ status: "circuit_open", error: "snapshot_circuit_open" });
        }
        if (this.state.circuitOpen) {
            this.state.circuitOpen = false;
            this.onEvent("SnapshotCircuitHalfOpened", { consecutiveFailures: this.state.consecutiveFailures });
        }

        return new Promise((resolve) => {
            const task: PendingWrite<T> = { factory, requestedAt: now, waiters: [resolve] };
            if (!this.inFlight) {
                this.inFlight = this.run(task).finally(() => {
                    this.inFlight = undefined;
                    this.inFlightStartedAt = 0;
                    this.state.inflight = 0;
                    this.state.pending = this.pending ? 1 : 0;
                });
                return;
            }

            const replaced = this.pending;
            task.requestedAt = replaced?.requestedAt ?? task.requestedAt;
            if (replaced) task.waiters.unshift(...replaced.waiters);
            this.pending = task;
            this.state.pending = 1;
            this.state.coalescedTotal++;
            const inflightDurationMs = Math.max(0, now - this.inFlightStartedAt);
            this.onEvent("SnapshotSaveCoalesced", {
                skippedRequestCount: this.state.coalescedTotal,
                inflightDurationMs,
                pending: 1,
            });
            this.onEvent("SnapshotBacklogDetected", {
                inflight: 1,
                pending: 1,
                oldestAgeMs: inflightDurationMs,
                threshold: 1,
            });
        });
    }

    async flush(): Promise<void> {
        await this.inFlight;
    }

    private async run(first: PendingWrite<T>): Promise<void> {
        let current: PendingWrite<T> | undefined = first;
        while (current) {
            this.inFlightStartedAt = this.now();
            this.state.inflight = 1;
            this.state.pending = this.pending ? 1 : 0;
            const execution = this.execute(current.factory);
            const result = await execution.result;
            for (const resolve of current.waiters) resolve(result);
            // A timed-out Redis command may still be executing. Waiting for its
            // settlement here preserves physical single-flight while callers and
            // the game loop are released at the configured deadline.
            await execution.settled;

            current = this.pending;
            this.pending = undefined;
            this.state.pending = 0;
            if (current && this.circuitOpenUntil > this.now()) {
                const blocked: SnapshotSaveResult = { status: "circuit_open", error: "snapshot_circuit_open" };
                for (const resolve of current.waiters) resolve(blocked);
                current = undefined;
            }
        }
    }

    private execute(factory: () => SnapshotSaveRequest<T>): {
        result: Promise<SnapshotSaveResult>;
        settled: Promise<void>;
    } {
        let request: SnapshotSaveRequest<T>;
        let envelope: GameSnapshotEnvelope<T>;
        let serialized: string;
        const startedAt = this.now();
        try {
            request = factory();
            envelope = createSnapshotEnvelope(request.payload, request.context);
            serialized = JSON.stringify(envelope);
            const payloadBytes = Buffer.byteLength(serialized, "utf8");
            if (payloadBytes > this.config.maxPayloadBytes) throw new Error("snapshot_payload_too_large");
            this.state.payloadBytes = payloadBytes;
            this.state.roomEpoch = envelope.roomEpoch;
            this.state.serverTick = envelope.serverTick;
            this.onEvent("SnapshotSaveStarted", {
                room: envelope.roomId,
                podUid: process.env.POD_UID ?? process.env.POD_NAME ?? "unavailable",
                epoch: envelope.roomEpoch,
                tick: envelope.serverTick,
                payloadBytes,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "snapshot_build_failed";
            const result = this.recordFailure(message, "failed", startedAt);
            return { result: Promise.resolve(result), settled: Promise.resolve() };
        }

        let lateError: unknown;
        const operation = Promise.resolve()
            .then(() => this.write(serialized, envelope))
            .catch((error) => {
                lateError = error;
                throw error;
            });
        const settled = operation.then(() => undefined, () => undefined);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), this.config.timeoutMs);
        });
        const result = Promise.race([operation.then(() => "saved" as const), timeout])
            .then((status): SnapshotSaveResult => {
                if (timer) clearTimeout(timer);
                if (status === "timeout") {
                    this.state.timeoutsTotal++;
                    return this.recordFailure("snapshot_write_timeout", "timeout", startedAt);
                }
                const durationMs = Math.max(0, this.now() - startedAt);
                const circuitWasOpen = this.state.circuitOpen || this.state.consecutiveFailures > 0;
                this.state.writeDurationMs = durationMs;
                this.state.consecutiveFailures = 0;
                this.state.circuitOpen = false;
                this.circuitOpenUntil = 0;
                this.state.handoffEnabled = true;
                this.state.lastChecksum = envelope.checksum;
                delete this.state.lastError;
                this.onEvent("SnapshotSaveCompleted", {
                    room: envelope.roomId,
                    epoch: envelope.roomEpoch,
                    tick: envelope.serverTick,
                    durationMs,
                    checksum: envelope.checksum,
                    payloadBytes: this.state.payloadBytes,
                    rssBytes: process.memoryUsage().rss,
                });
                if (circuitWasOpen) this.onEvent("SnapshotCircuitClosed", { durationMs });
                return {
                    status: "saved",
                    checksum: envelope.checksum,
                    payloadBytes: this.state.payloadBytes,
                    durationMs,
                };
            })
            .catch((error): SnapshotSaveResult => {
                if (timer) clearTimeout(timer);
                const message = error instanceof Error ? error.message : String(lateError ?? "snapshot_write_failed");
                return this.recordFailure(message, "failed", startedAt);
            });

        return { result, settled };
    }

    private recordFailure(
        message: string,
        status: "failed" | "timeout",
        startedAt: number,
    ): SnapshotSaveResult {
        const durationMs = Math.max(0, this.now() - startedAt);
        this.state.writeDurationMs = durationMs;
        this.state.failuresTotal++;
        this.state.consecutiveFailures++;
        this.state.lastError = message;
        this.onEvent("SnapshotSaveFailed", {
            durationMs,
            reason: message,
            consecutiveFailures: this.state.consecutiveFailures,
            timedOut: status === "timeout",
        });
        if (this.state.consecutiveFailures >= this.config.failureThreshold) {
            this.circuitOpenUntil = this.now() + this.config.circuitCooldownMs;
            this.state.circuitOpen = true;
            this.state.handoffEnabled = false;
            this.onEvent("SnapshotCircuitOpened", {
                reason: message,
                consecutiveFailures: this.state.consecutiveFailures,
                retryAt: this.circuitOpenUntil,
            });
        }
        return { status, error: message, durationMs };
    }
}
