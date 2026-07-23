import { createHash, randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { App, type HttpRequest, type HttpResponse, type WebSocket as UwsWebSocket } from "uWebSockets.js";
import { GameConfig } from "../../../shared/gameConfig.ts";
import { decodeGatewayFrame, encodeGatewayInput } from "./gatewayWire.ts";
import {
    BoundedGatewayInputBuffer,
    type BufferedGatewayInput,
    assertGatewaySharedSecret,
    FencedGatewayRoomRegistry,
    GatewayJoinAdmissionRegistry,
    type GatewayJoinTemplate,
    type GatewayRoomRoute,
    isGatewayResumeBootstrapFrame,
    readGatewayJoin,
    roomIdFromGatewayPath,
    sameGatewayFreezeIntent,
    websocketEndpoint,
    writeGatewayJoin,
} from "./sessionGatewayProtocol.ts";

type GatewayEventSubject =
    | "RoomEpochFenced"
    | "RoomGatewayCutover"
    | "RoomInputReplayCompleted"
    | "RoomHandoffFailed";

interface GatewayOperationEvent {
    event_id: string;
    subject: GatewayEventSubject;
    source: "demo-game/session-gateway";
    workspace_id: string;
    correlation_id: string;
    causation_id?: string;
    created_at: string;
    sequence: number;
    cursor: number;
    payload: Record<string, unknown>;
}

interface GatewaySocketData {
    id: string;
    roomId: string;
    sessionId: string;
    gameId: string;
    spectator: boolean;
    spectateSessionId?: string;
    closed: boolean;
    latencyProbeSentAt?: number;
    latencySamplesMs: number[];
    latencyMs?: number;
}

interface UpstreamConnection {
    socket: globalThis.WebSocket;
    epoch: number;
    endpoint: string;
    sentThroughSequence: number;
}

interface PreparedUpstream extends UpstreamConnection {
    route: GatewayRoomRoute;
    frames: Uint8Array[];
    committed: boolean;
}

interface FindGameMatch {
    gameId: string;
    data: string;
}

interface RoomPreparation {
    operationId: string;
    roomId: string;
    expectedEpoch: number;
    supersedesOperationId?: string;
    sessionIds: Set<string>;
    unackedInputs: number;
    startedAt: number;
    timeout: NodeJS.Timeout;
}

interface RoomVerification {
    operationId: string;
    roomId: string;
    epoch: number;
    sessionIds: Set<string>;
    startedAt: number;
}

type RoomCutoverOperationStatus = "preparing" | "registry_committed" | "committed" | "failed";

interface RoomCutoverOperation {
    operationId: string;
    roomId: string;
    expectedEpoch: number;
    nextEpoch: number;
    endpoint: string;
    revision?: string;
    status: RoomCutoverOperationStatus;
    sessionIds: Set<string>;
    replayedInputs: number;
    failure?: string;
    startedAt: number;
    updatedAt: number;
}

const workspaceId = process.env.WORKSPACE_ID ?? "demo-game";
const clusterId = process.env.CLUSTER_ID ?? "game-server";
const namespace = process.env.NAMESPACE ?? "sandbox";
const controlToken = process.env.OPS_CONTROL_TOKEN?.trim() ?? "";
const requireControlToken = process.env.REQUIRE_CONTROL_TOKEN === "true";
if (requireControlToken && !controlToken) throw new Error("ops_control_token_required");
const gatewaySharedSecret = process.env.SESSION_GATEWAY_SHARED_SECRET?.trim() ?? "";
assertGatewaySharedSecret(gatewaySharedSecret);

const safeSessionHash = (sessionId: string): string =>
    createHash("sha256").update(sessionId).digest("hex").slice(0, 16);

class GatewayEventLedger {
    private readonly events: GatewayOperationEvent[] = [];
    private readonly operationSequences = new Map<string, number>();
    private readonly operationTails = new Map<string, string>();
    private nextCursor = 1;

    emit(
        subject: GatewayEventSubject,
        operationId: string,
        payload: Record<string, unknown>,
    ): GatewayOperationEvent {
        const sequence = (this.operationSequences.get(operationId) ?? 0) + 1;
        const event: GatewayOperationEvent = {
            event_id: `evt_${randomUUID()}`,
            subject,
            source: "demo-game/session-gateway",
            workspace_id: workspaceId,
            correlation_id: operationId,
            causation_id: this.operationTails.get(operationId),
            created_at: new Date().toISOString(),
            sequence,
            cursor: this.nextCursor++,
            payload: {
                ...payload,
                operation_id: operationId,
                operation_sequence: sequence,
                workspace_id: workspaceId,
                observed_at: new Date().toISOString(),
            },
        };
        this.operationSequences.set(operationId, sequence);
        this.operationTails.set(operationId, event.event_id);
        this.events.push(event);
        if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
        process.stdout.write(`${JSON.stringify({ level: "info", event: subject, detail: event })}\n`);
        return event;
    }

    after(cursor: number): GatewayOperationEvent[] {
        return this.events.filter((event) => event.cursor > cursor).slice(0, 500);
    }
}

const ledger = new GatewayEventLedger();
const metrics = {
    connections: 0,
    upstreamSwitches: 0,
    replayedInputs: 0,
    continuityFailures: 0,
    bufferOverflows: 0,
};

const parseRoutes = (): GatewayRoomRoute[] => {
    const configured = process.env.SESSION_ROOM_ENDPOINTS
        ?? "room-0=http://game-0:8001,room-1=http://game-1:8001,room-2=http://game-2:8001,room-3=http://game-3:8001,room-4=http://game-4:8001";
    return configured.split(",").filter(Boolean).map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) throw new Error("invalid_session_room_endpoint");
        return {
            roomId: entry.slice(0, separator),
            endpoint: entry.slice(separator + 1),
            epoch: 1,
        };
    });
};

const registry = new FencedGatewayRoomRegistry(parseRoutes());
const sessions = new Map<string, GatewaySession>();
const downstreamSockets = new Map<string, UwsWebSocket<GatewaySocketData>>();
const roomPreparations = new Map<string, RoomPreparation>();
const roomVerifications = new Map<string, RoomVerification>();
const roomCutoverOperations = new Map<string, RoomCutoverOperation>();
const operationKey = (roomId: string, operationId: string): string => `${roomId}:${operationId}`;
const joinAdmissions = new GatewayJoinAdmissionRegistry();
const joinAdmissionKey = (roomId: string, gameId: string, matchPriv: string): string =>
    `${roomId}\n${gameId}\n${matchPriv}`;

const copyBinary = (value: unknown): Uint8Array | undefined => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    return undefined;
};

const sendBinary = (socket: globalThis.WebSocket, payload: Uint8Array): void => {
    if (socket.readyState === globalThis.WebSocket.OPEN) socket.send(Uint8Array.from(payload).buffer);
};

const sendInput = (
    socket: globalThis.WebSocket,
    payload: Uint8Array,
    roomEpoch: number,
    inputSequence: number,
    clientTick: number,
): void => sendBinary(socket, encodeGatewayInput({ roomEpoch, inputSequence, clientTick, payload }));

const waitForOpen = (socket: globalThis.WebSocket, timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
        settled = true;
        socket.close();
        reject(new Error("gateway_upstream_open_timeout"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("gateway_upstream_open_failed"));
    }, { once: true });
});

class GatewaySession {
    private readonly inputs = new BoundedGatewayInputBuffer(
        Number(process.env.GATEWAY_MAX_BUFFER_MESSAGES ?? 256),
        Number(process.env.GATEWAY_MAX_BUFFER_BYTES ?? 1024 * 1024),
    );
    private current?: UpstreamConnection;
    private prepared?: PreparedUpstream;
    private joinTemplate?: GatewayJoinTemplate;
    private initialJoin?: Uint8Array;
    private frozen = false;
    private stopped = false;
    private clientTick = 0;
    private verificationShadow: BufferedGatewayInput[] = [];
    private verificationShadowBytes = 0;
    private verificationActive = false;

    constructor(
        private readonly downstream: UwsWebSocket<GatewaySocketData>,
        readonly data: GatewaySocketData,
    ) {}

    async start(route: GatewayRoomRoute): Promise<void> {
        const socket = new globalThis.WebSocket(websocketEndpoint(route.endpoint, this.data.gameId, {
            roomId: this.data.roomId,
            sessionId: this.data.sessionId,
            roomEpoch: route.epoch,
            sharedSecret: gatewaySharedSecret,
        }));
        socket.binaryType = "arraybuffer";
        const connection: UpstreamConnection = {
            socket,
            epoch: route.epoch,
            endpoint: route.endpoint,
            sentThroughSequence: 0,
        };
        this.bindCurrent(connection);
        await waitForOpen(socket, 5_000);
        if (this.initialJoin) sendInput(socket, this.initialJoin, route.epoch, 0, this.clientTick);
        this.flushInputs(connection);
    }

    receive(payload: ArrayBuffer): void {
        if (this.stopped) return;
        const copy = new Uint8Array(payload.slice(0));
        if (!this.joinTemplate) {
            const template = readGatewayJoin(copy);
            if (template) {
                if (!joinAdmissions.consume(
                    joinAdmissionKey(this.data.roomId, this.data.gameId, template.matchPriv),
                    this.data.sessionId,
                )) {
                    this.downstream.end(1008, "gateway_session_identity_mismatch");
                    this.stop();
                    return;
                }
                this.joinTemplate = template;
                this.initialJoin = copy;
                if (this.current?.socket.readyState === globalThis.WebSocket.OPEN) {
                    sendInput(this.current.socket, copy, this.current.epoch, 0, this.clientTick);
                }
                return;
            }
        }

        try {
            const entry = this.inputs.push(copy);
            this.clientTick = (this.clientTick + 1) >>> 0;
            if (this.verificationActive) this.retainForRollback(entry);
            if (!this.frozen && this.current?.socket.readyState === globalThis.WebSocket.OPEN) {
                sendInput(this.current.socket, entry.payload, this.current.epoch, entry.sequence, this.clientTick);
                this.current.sentThroughSequence = entry.sequence;
            }
        } catch (error) {
            metrics.bufferOverflows++;
            metrics.continuityFailures++;
            const reason = error instanceof Error ? error.message : "gateway_input_buffer_overflow";
            ledger.emit("RoomHandoffFailed", `op_${randomUUID()}`, {
                cluster_id: clusterId,
                namespace,
                room_id: this.data.roomId,
                room_epoch: this.current?.epoch,
                status: "failed",
                reason_code: reason,
                session_hash: safeSessionHash(this.data.sessionId),
            });
            this.downstream.end(1013, "gateway_input_buffer_overflow");
            this.stop();
        }
    }

    async prepare(route: GatewayRoomRoute): Promise<void> {
        if (this.stopped) throw new Error("gateway_session_closed");
        if (!this.joinTemplate) throw new Error("gateway_join_not_observed");
        if (this.current?.epoch === route.epoch
            && this.current.endpoint === route.endpoint
            && this.current.socket.readyState === globalThis.WebSocket.OPEN) return;
        if (this.prepared) {
            if (this.prepared.epoch === route.epoch && this.prepared.route.endpoint === route.endpoint) return;
            throw new Error("gateway_candidate_already_prepared");
        }

        const match = await this.findCandidateMatch(route);
        const socket = new globalThis.WebSocket(websocketEndpoint(route.endpoint, match.gameId, {
            roomId: this.data.roomId,
            sessionId: this.data.sessionId,
            roomEpoch: route.epoch,
            sharedSecret: gatewaySharedSecret,
        }));
        socket.binaryType = "arraybuffer";
        const prepared: PreparedUpstream = {
            socket,
            epoch: route.epoch,
            endpoint: route.endpoint,
            sentThroughSequence: 0,
            route,
            frames: [],
            committed: false,
        };
        this.prepared = prepared;
        await waitForOpen(socket, 5_000);
        sendInput(socket, writeGatewayJoin(this.joinTemplate, match.data), route.epoch, 0, this.clientTick);

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                settled = true;
                reject(new Error("gateway_candidate_ready_timeout"));
            }, 5_000);
            socket.addEventListener("message", (event) => {
                const payload = copyBinary(event.data);
                if (!payload) return;
                let frame: ReturnType<typeof decodeGatewayFrame>;
                try {
                    frame = decodeGatewayFrame(payload);
                } catch {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error("gateway_candidate_wire_invalid"));
                    }
                    socket.close(1002, "invalid_gateway_wire_frame");
                    return;
                }
                if (!frame) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error("gateway_candidate_output_unframed"));
                    }
                    socket.close(1002, "unframed_gateway_output");
                    return;
                }
                if (frame?.kind === "ack") {
                    if (frame.roomEpoch === prepared.epoch) this.inputs.acknowledge(frame.lastAckInputSequence);
                    return;
                }
                if (frame.kind !== "output" || frame.roomEpoch !== prepared.epoch) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error("gateway_candidate_output_epoch_mismatch"));
                    }
                    socket.close(1002, "gateway_output_epoch_mismatch");
                    return;
                }
                const bootstrap = isGatewayResumeBootstrapFrame(frame.payload);
                if (!bootstrap && prepared.frames.length < 16) prepared.frames.push(frame.payload);
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve();
                }
                if (prepared.committed && !bootstrap) this.forwardCandidateFrame(prepared, frame.payload);
            });
            socket.addEventListener("close", () => {
                if (prepared.committed) {
                    metrics.continuityFailures++;
                    this.downstream.end(1012, "active_upstream_closed");
                    this.stop();
                    return;
                }
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(new Error("gateway_candidate_closed_before_ready"));
            }, { once: true });
            socket.addEventListener("error", () => {
                if (prepared.committed) return;
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(new Error("gateway_candidate_failed_before_ready"));
            }, { once: true });
        });
    }

    freeze(): void {
        this.frozen = true;
    }

    commitPrepared(route: GatewayRoomRoute): number {
        if (this.current?.epoch === route.epoch
            && this.current.endpoint === route.endpoint
            && this.current.socket.readyState === globalThis.WebSocket.OPEN) return 0;
        const prepared = this.prepared;
        if (!prepared) throw new Error("gateway_candidate_not_prepared");
        if (prepared.epoch !== route.epoch || prepared.route.endpoint !== route.endpoint) {
            throw new Error("gateway_candidate_route_conflict");
        }
        const previous = this.current;
        prepared.committed = true;
        this.current = prepared;
        this.prepared = undefined;
        previous?.socket.close(1000, "room_epoch_fenced");

        for (const frame of prepared.frames) {
            if (!this.stopped) this.downstream.send(frame, true, false);
        }
        const replay = this.mergeRollbackInputs(this.inputs.replayAfter());
        for (const entry of replay) {
            sendInput(prepared.socket, entry.payload, prepared.epoch, entry.sequence, this.clientTick);
        }
        this.setRollbackInputs(replay);
        this.verificationActive = true;
        prepared.sentThroughSequence = replay.at(-1)?.sequence ?? this.inputs.lastAcknowledgedSequence;
        this.frozen = false;
        metrics.replayedInputs += replay.length;
        return replay.length;
    }

    abortPrepared(): void {
        this.prepared?.socket.close(1012, "candidate_aborted");
        this.prepared = undefined;
        this.frozen = false;
        if (this.current) this.flushInputs(this.current);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.current?.socket.close();
        this.prepared?.socket.close();
        this.current = undefined;
        this.prepared = undefined;
    }

    get unackedInputs(): number {
        return this.inputs.size;
    }

    get verificationInputs(): number {
        return this.verificationShadow.length;
    }

    continuity(route: GatewayRoomRoute): { downstream: boolean; upstream: boolean; epoch: boolean } {
        return {
            downstream: !this.stopped && !this.data.closed,
            upstream: this.current?.socket.readyState === globalThis.WebSocket.OPEN
                && this.current.endpoint === route.endpoint,
            epoch: this.current?.epoch === route.epoch,
        };
    }

    finalizeVerification(): void {
        this.verificationActive = false;
        this.verificationShadow = [];
        this.verificationShadowBytes = 0;
    }

    private bindCurrent(connection: UpstreamConnection): void {
        this.current = connection;
        connection.socket.addEventListener("message", (event) => {
            const payload = copyBinary(event.data);
            if (!payload || this.stopped || this.current?.socket !== connection.socket) return;
            if (connection.epoch !== this.current.epoch) return;
            let frame: ReturnType<typeof decodeGatewayFrame>;
            try {
                frame = decodeGatewayFrame(payload);
            } catch {
                metrics.continuityFailures++;
                this.downstream.end(1011, "invalid_upstream_gateway_frame");
                this.stop();
                return;
            }
            if (!frame) {
                metrics.continuityFailures++;
                this.downstream.end(1011, "unframed_upstream_gateway_output");
                this.stop();
                return;
            }
            if (frame?.kind === "ack") {
                if (frame.roomEpoch === connection.epoch) this.inputs.acknowledge(frame.lastAckInputSequence);
                return;
            }
            if (frame.kind !== "output" || frame.roomEpoch !== connection.epoch) {
                metrics.continuityFailures++;
                this.downstream.end(1011, "upstream_gateway_output_epoch_mismatch");
                this.stop();
                return;
            }
            if (!this.data.closed) this.downstream.send(frame.payload, true, false);
        });
        connection.socket.addEventListener("close", () => {
            if (this.stopped || this.current?.socket !== connection.socket || this.frozen) return;
            metrics.continuityFailures++;
            this.downstream.end(1012, "active_upstream_closed");
            this.stop();
        });
    }

    private forwardCandidateFrame(prepared: PreparedUpstream, payload: Uint8Array): void {
        if (this.current?.socket !== prepared.socket || prepared.epoch !== this.current.epoch || this.stopped) return;
        this.downstream.send(payload, true, false);
    }

    private flushInputs(connection: UpstreamConnection): void {
        const replay = this.inputs.replayAfter(connection.sentThroughSequence);
        for (const entry of replay) {
            sendInput(connection.socket, entry.payload, connection.epoch, entry.sequence, this.clientTick);
        }
        connection.sentThroughSequence = replay.at(-1)?.sequence ?? connection.sentThroughSequence;
    }

    private retainForRollback(entry: BufferedGatewayInput): void {
        if (this.verificationShadow.some((candidate) => candidate.sequence === entry.sequence)) return;
        const maxMessages = Number(process.env.GATEWAY_MAX_BUFFER_MESSAGES ?? 256);
        const maxBytes = Number(process.env.GATEWAY_MAX_BUFFER_BYTES ?? 1024 * 1024);
        if (this.verificationShadow.length + 1 > maxMessages) {
            throw new Error("gateway_verification_buffer_overflow:message_limit");
        }
        if (this.verificationShadowBytes + entry.bytes > maxBytes) {
            throw new Error("gateway_verification_buffer_overflow:byte_limit");
        }
        this.verificationShadow.push({ ...entry, payload: Uint8Array.from(entry.payload) });
        this.verificationShadowBytes += entry.bytes;
    }

    private mergeRollbackInputs(unacked: BufferedGatewayInput[]): BufferedGatewayInput[] {
        const merged = new Map<number, BufferedGatewayInput>();
        for (const entry of [...this.verificationShadow, ...unacked]) {
            merged.set(entry.sequence, { ...entry, payload: Uint8Array.from(entry.payload) });
        }
        return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
    }

    private setRollbackInputs(entries: BufferedGatewayInput[]): void {
        this.verificationShadow = [];
        this.verificationShadowBytes = 0;
        for (const entry of entries) this.retainForRollback(entry);
    }

    private async findCandidateMatch(route: GatewayRoomRoute): Promise<FindGameMatch> {
        const response = await fetch(`${route.endpoint}/api/find_game`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(4_000),
            body: JSON.stringify({
                region: "local",
                zones: ["local"],
                version: GameConfig.protocolVersion,
                playerCount: this.data.spectator ? 0 : 1,
                autoFill: false,
                gameModeIdx: 2,
                opsiaSessionId: this.data.sessionId,
                spectator: this.data.spectator,
                spectateSessionId: this.data.spectateSessionId,
            }),
        });
        const body = await response.json() as { res?: FindGameMatch[]; error?: string };
        if (!response.ok || !body.res?.[0]) throw new Error(`gateway_resume_find_game_failed:${body.error ?? response.status}`);
        return body.res[0];
    }
}

const authorized = (authorization: string): boolean => {
    if (!controlToken) return !requireControlToken;
    return authorization === `Bearer ${controlToken}`;
};

const statusLine = (status: number): string => `${status} ${STATUS_CODES[status] ?? "Unknown"}`;

const isResponseAlreadyClosed = (error: unknown): boolean =>
    error instanceof Error && error.message.includes("uWS.HttpResponse must not be accessed");

const warnResponseAlreadyClosed = (context: string, error: unknown): void => {
    if (!isResponseAlreadyClosed(error)) throw error;
    console.warn(JSON.stringify({
        level: "warn",
        event: "session_gateway_http_response_closed",
        detail: { context },
    }));
};

const replyJson = (response: HttpResponse, status: number, body: unknown): void => {
    try {
        response.cork(() => {
            response.writeStatus(statusLine(status));
            response.writeHeader("content-type", "application/json; charset=utf-8");
            response.end(JSON.stringify(body));
        });
    } catch (error) {
        warnResponseAlreadyClosed("json_reply", error);
    }
};

const readBody = (response: HttpResponse, maxBytes = 1024 * 1024): Promise<Uint8Array> => new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    response.onData((chunk, last) => {
        const copy = new Uint8Array(chunk.slice(0));
        size += copy.byteLength;
        if (size > maxBytes) {
            reject(new Error("gateway_request_body_too_large"));
            return;
        }
        chunks.push(copy);
        if (!last) return;
        const body = new Uint8Array(size);
        let offset = 0;
        for (const entry of chunks) {
            body.set(entry, offset);
            offset += entry.byteLength;
        }
        resolve(body);
    });
});

const takePreparation = (roomId: string): RoomPreparation | undefined => {
    const preparation = roomPreparations.get(roomId);
    if (!preparation) return undefined;
    clearTimeout(preparation.timeout);
    roomPreparations.delete(roomId);
    return preparation;
};

const abortRoomPreparation = (roomId: string, operationId?: string): number => {
    const preparation = roomPreparations.get(roomId);
    if (!preparation) return 0;
    if (operationId && preparation.operationId !== operationId) {
        throw new Error("gateway_preparation_operation_conflict");
    }
    takePreparation(roomId);
    let resumed = 0;
    for (const sessionId of preparation.sessionIds) {
        const session = sessions.get(sessionId);
        if (!session) continue;
        session.abortPrepared();
        resumed++;
    }
    return resumed;
};

const freezeRoom = (
    roomId: string,
    operationId: string,
    expectedEpoch: number,
    supersedesOperationId?: string,
): { sessions: number; unackedInputs: number } => {
    const route = registry.get(roomId);
    if (!route) throw new Error("gateway_room_not_found");
    if (route.epoch !== expectedEpoch) throw new Error("gateway_epoch_conflict");
    if (!operationId) throw new Error("gateway_operation_id_required");
    const existing = roomPreparations.get(roomId);
    if (existing) {
        if (!sameGatewayFreezeIntent(existing, { operationId, expectedEpoch, supersedesOperationId })) {
            throw new Error(existing.operationId === operationId
                ? "gateway_freeze_request_conflict"
                : "gateway_room_preparation_in_progress");
        }
        return { sessions: existing.sessionIds.size, unackedInputs: existing.unackedInputs };
    }
    const verification = roomVerifications.get(roomId);
    if (verification && verification.operationId !== operationId) {
        if (!supersedesOperationId || verification.operationId !== supersedesOperationId) {
            throw new Error("gateway_room_verification_in_progress");
        }
        // Do not finalize the sessions here: their verification shadow is the
        // exact post-cutover input set that a rollback must replay. Only retire
        // the stale proof record so the new recovery operation owns it.
        roomVerifications.delete(roomId);
    }
    const selected = [...sessions.values()].filter((session) => session.data.roomId === roomId);
    selected.forEach((session) => session.freeze());
    const unackedInputs = selected.reduce((total, session) => total + session.unackedInputs, 0);
    const timeoutMs = Number(process.env.GATEWAY_PREPARE_TIMEOUT_MS ?? 15_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 60_000) {
        selected.forEach((session) => session.abortPrepared());
        throw new Error("gateway_prepare_timeout_invalid");
    }
    const preparation: RoomPreparation = {
        operationId,
        roomId,
        expectedEpoch,
        supersedesOperationId,
        sessionIds: new Set(selected.map((session) => session.data.id)),
        unackedInputs,
        startedAt: Date.now(),
        timeout: setTimeout(() => {
            const resumed = abortRoomPreparation(roomId, operationId);
            metrics.continuityFailures++;
            ledger.emit("RoomHandoffFailed", operationId, {
                cluster_id: clusterId,
                namespace,
                room_id: roomId,
                room_epoch: expectedEpoch,
                status: "failed",
                reason_code: "gateway_preparation_timeout",
                rollback: "active_resumed",
                sessions: resumed,
            });
        }, timeoutMs),
    };
    preparation.timeout.unref();
    roomPreparations.set(roomId, preparation);
    return {
        sessions: selected.length,
        unackedInputs,
    };
};

const finalizeRoomVerification = (roomId: string, operationId: string): { sessions: number; replayInputs: number } => {
    const verification = roomVerifications.get(roomId);
    if (!verification) return { sessions: 0, replayInputs: 0 };
    if (verification.operationId !== operationId) throw new Error("gateway_verification_operation_conflict");
    const proof = roomVerificationView(verification);
    if (!proof.continuous) throw new Error(`gateway_session_continuity_invalid:${proof.reason}`);
    let sessionsFinalized = 0;
    let replayInputs = 0;
    for (const sessionId of verification.sessionIds) {
        const session = sessions.get(sessionId);
        if (!session) continue;
        replayInputs += session.verificationInputs;
        session.finalizeVerification();
        sessionsFinalized++;
    }
    roomVerifications.delete(roomId);
    return { sessions: sessionsFinalized, replayInputs };
};

const roomVerificationView = (verification: RoomVerification): Record<string, unknown> & {
    continuous: boolean;
    reason: string;
} => {
    const route = registry.get(verification.roomId);
    const maxAgeMs = Number(process.env.GATEWAY_VERIFICATION_TIMEOUT_MS ?? 15_000);
    const stale = !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 120_000
        || Date.now() - verification.startedAt > maxAgeMs;
    let liveSessions = 0;
    let upstreamSessions = 0;
    let epochSessions = 0;
    for (const sessionId of verification.sessionIds) {
        const session = sessions.get(sessionId);
        if (!session || !route) continue;
        const continuity = session.continuity(route);
        if (continuity.downstream) liveSessions++;
        if (continuity.upstream) upstreamSessions++;
        if (continuity.epoch) epochSessions++;
    }
    const expectedSessions = verification.sessionIds.size;
    const routeMatches = route?.epoch === verification.epoch;
    const continuous = !stale
        && routeMatches
        && liveSessions === expectedSessions
        && upstreamSessions === expectedSessions
        && epochSessions === expectedSessions;
    const reason = stale
        ? "verification_stale"
        : !routeMatches
            ? "gateway_route_changed"
            : liveSessions !== expectedSessions
                ? "downstream_session_closed"
                : upstreamSessions !== expectedSessions
                    ? "upstream_session_closed"
                    : epochSessions !== expectedSessions
                        ? "session_epoch_mismatch"
                        : "ok";
    return {
        operationId: verification.operationId,
        roomId: verification.roomId,
        epoch: verification.epoch,
        sessions: expectedSessions,
        expectedSessions,
        liveSessions,
        upstreamSessions,
        epochSessions,
        startedAt: verification.startedAt,
        replayInputs: [...verification.sessionIds].reduce(
            (total, id) => total + (sessions.get(id)?.verificationInputs ?? 0),
            0,
        ),
        continuous,
        reason,
    };
};

const operationView = (operation: RoomCutoverOperation): Record<string, unknown> => ({
    operationId: operation.operationId,
    roomId: operation.roomId,
    expectedEpoch: operation.expectedEpoch,
    nextEpoch: operation.nextEpoch,
    endpoint: operation.endpoint,
    revision: operation.revision,
    status: operation.status,
    sessions: operation.sessionIds.size,
    replayedInputs: operation.replayedInputs,
    failure: operation.failure,
    startedAt: operation.startedAt,
    updatedAt: operation.updatedAt,
});

const cutoverRoom = async (
    roomId: string,
    body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
    const current = registry.get(roomId);
    if (!current) throw new Error("gateway_room_not_found");
    const expectedEpoch = Number(body.expectedEpoch);
    const nextEpoch = Number(body.nextEpoch);
    const endpoint = String(body.endpoint ?? "");
    const revision = body.revision ? String(body.revision) : undefined;
    const operationId = body.operationId ? String(body.operationId) : `op_${randomUUID()}`;
    const route: GatewayRoomRoute = { roomId, endpoint, epoch: nextEpoch, revision };
    const key = operationKey(roomId, operationId);
    const existing = roomCutoverOperations.get(key);
    if (existing && (existing.expectedEpoch !== expectedEpoch
        || existing.nextEpoch !== nextEpoch
        || existing.endpoint !== endpoint
        || existing.revision !== revision)) {
        throw new Error("gateway_operation_request_conflict");
    }
    if (existing?.status === "committed") {
        return {
            operationId,
            route: registry.get(roomId),
            sessions: existing.sessionIds.size,
            replayedInputs: existing.replayedInputs,
            status: existing.status,
        };
    }
    if (existing?.status === "failed") throw new Error(existing.failure ?? "gateway_cutover_failed");
    const preparation = roomPreparations.get(roomId);
    if (preparation && preparation.operationId !== operationId) {
        throw new Error("gateway_preparation_operation_conflict");
    }
    if (preparation && preparation.expectedEpoch !== expectedEpoch) {
        throw new Error("gateway_preparation_epoch_conflict");
    }
    const initiallySelected = preparation
        ? [...preparation.sessionIds].map((id) => sessions.get(id)).filter((session): session is GatewaySession => Boolean(session))
        : [...sessions.values()].filter((session) => session.data.roomId === roomId);
    const operation = existing ?? {
        operationId,
        roomId,
        expectedEpoch,
        nextEpoch,
        endpoint,
        revision,
        status: "preparing" as const,
        sessionIds: new Set(initiallySelected.map((session) => session.data.id)),
        replayedInputs: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
    roomCutoverOperations.set(key, operation);
    const selected = [...operation.sessionIds]
        .map((id) => sessions.get(id))
        .filter((session): session is GatewaySession => Boolean(session));

    try {
        if (!preparation
            && operation.status !== "registry_committed"
            && process.env.GATEWAY_ALLOW_UNPREPARED_CUTOVER !== "true") {
            throw new Error("gateway_room_not_frozen");
        }
        if (body.checksumMatched !== true) throw new Error("gateway_checksum_not_verified");
        if (body.caughtUp !== true) throw new Error("gateway_candidate_not_caught_up");
        if (selected.length !== operation.sessionIds.size) {
            throw new Error("gateway_session_continuity_lost_before_cutover");
        }
        await Promise.all(selected.map((session) => session.prepare(route)));
        if (!preparation && operation.status !== "registry_committed") {
            selected.forEach((session) => session.freeze());
        }
        let next = registry.get(roomId)!;
        if (next.epoch === expectedEpoch) {
            next = registry.compareAndSwap(roomId, expectedEpoch, { endpoint, epoch: nextEpoch, revision });
            ledger.emit("RoomEpochFenced", operationId, {
                operation_id: operationId,
                cluster_id: clusterId,
                namespace,
                room_id: roomId,
                room_epoch: next.epoch,
                git_revision: revision,
                status: "completed",
            });
        } else if (next.epoch !== nextEpoch || next.endpoint !== new URL(endpoint).toString().replace(/\/$/, "")) {
            throw new Error("gateway_epoch_conflict");
        }
        operation.status = "registry_committed";
        operation.updatedAt = Date.now();
        takePreparation(roomId);
        let replayed = operation.replayedInputs;
        for (const session of selected) {
            replayed += session.commitPrepared(next);
            operation.replayedInputs = replayed;
        }
        roomVerifications.set(roomId, {
            operationId,
            roomId,
            epoch: next.epoch,
            sessionIds: new Set(selected.map((session) => session.data.id)),
            startedAt: Date.now(),
        });
        operation.status = "committed";
        operation.failure = undefined;
        operation.updatedAt = Date.now();
        metrics.upstreamSwitches++;
        ledger.emit("RoomGatewayCutover", operationId, {
            operation_id: operationId,
            cluster_id: clusterId,
            namespace,
            room_id: roomId,
            room_epoch: next.epoch,
            sessions: selected.length,
            status: "completed",
        });
        ledger.emit("RoomInputReplayCompleted", operationId, {
            operation_id: operationId,
            cluster_id: clusterId,
            namespace,
            room_id: roomId,
            room_epoch: next.epoch,
            replayed_inputs: replayed,
            status: "completed",
        });
        return { operationId, route: next, sessions: selected.length, replayedInputs: replayed, status: operation.status };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "gateway_cutover_failed";
        operation.failure = reason;
        operation.updatedAt = Date.now();
        if (operation.status !== "registry_committed") {
            operation.status = "failed";
            selected.forEach((session) => session.abortPrepared());
            takePreparation(roomId);
        }
        metrics.continuityFailures++;
        ledger.emit("RoomHandoffFailed", operationId, {
            operation_id: operationId,
            cluster_id: clusterId,
            namespace,
            room_id: roomId,
            room_epoch: current.epoch,
            status: "failed",
            reason_code: reason,
            rollback: operation.status === "registry_committed" ? "candidate_retained" : "active_preserved",
        });
        throw error;
    }
};

const metricsText = (): string => [
    "# TYPE game_session_gateway_connections gauge",
    `game_session_gateway_connections ${metrics.connections}`,
    "# TYPE game_session_gateway_upstream_switch_total counter",
    `game_session_gateway_upstream_switch_total ${metrics.upstreamSwitches}`,
    "# TYPE game_session_gateway_unacked_inputs gauge",
    `game_session_gateway_unacked_inputs ${[...sessions.values()].reduce((total, session) => total + session.unackedInputs, 0)}`,
    "# TYPE game_session_gateway_replayed_inputs_total counter",
    `game_session_gateway_replayed_inputs_total ${metrics.replayedInputs}`,
    "# TYPE game_session_continuity_failures_total counter",
    `game_session_continuity_failures_total ${metrics.continuityFailures}`,
    "# TYPE game_session_gateway_buffer_overflow_total counter",
    `game_session_gateway_buffer_overflow_total ${metrics.bufferOverflows}`,
    "",
].join("\n");

const app = App();

const LATENCY_PROBE_INTERVAL_MS = 2_000;
const LATENCY_PROBE_TIMEOUT_MS = 5_000;
const LATENCY_MEDIAN_WINDOW = 5;

const recordLatencySample = (data: GatewaySocketData, latencyMs: number): void => {
    data.latencySamplesMs.push(Math.max(0, Math.round(latencyMs)));
    if (data.latencySamplesMs.length > LATENCY_MEDIAN_WINDOW) data.latencySamplesMs.shift();
    const sorted = data.latencySamplesMs.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    data.latencyMs = sorted.length % 2 === 0
        ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
        : sorted[middle]!;
};

const probeDownstreamLatency = (socket: UwsWebSocket<GatewaySocketData>): void => {
    const data = socket.getUserData();
    const now = Date.now();
    if (data.closed || (
        data.latencyProbeSentAt !== undefined
        && now - data.latencyProbeSentAt < LATENCY_PROBE_TIMEOUT_MS
    )) return;
    data.latencyProbeSentAt = now;
    try {
        socket.ping("opsia-latency");
    } catch {
        data.latencyProbeSentAt = undefined;
    }
};

const latencyProbeTimer = setInterval(() => {
    for (const socket of downstreamSockets.values()) probeDownstreamLatency(socket);
}, LATENCY_PROBE_INTERVAL_MS);
latencyProbeTimer.unref();

app.get("/healthz", (response) => replyJson(response, 200, {
    status: "ok",
    rooms: registry.list().length,
    connections: metrics.connections,
    preparations: roomPreparations.size,
    verifications: roomVerifications.size,
}));

app.get("/metrics", (response) => {
    response.writeHeader("content-type", "text/plain; version=0.0.4");
    response.end(metricsText());
});

app.get("/ops/events", (response, request) => {
    const cursor = Number(new URLSearchParams(request.getQuery()).get("cursor") ?? 0);
    replyJson(response, 200, { events: ledger.after(Number.isSafeInteger(cursor) ? cursor : 0) });
});

app.get("/internal/rooms", (response, request) => {
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    replyJson(response, 200, {
        rooms: registry.list(),
        preparations: [...roomPreparations.values()].map((preparation) => ({
            operationId: preparation.operationId,
            roomId: preparation.roomId,
            expectedEpoch: preparation.expectedEpoch,
            sessions: preparation.sessionIds.size,
            startedAt: preparation.startedAt,
        })),
        verifications: [...roomVerifications.values()].map(roomVerificationView),
        operations: [...roomCutoverOperations.values()].map(operationView),
    });
});

app.get("/internal/latencies", (response, request) => {
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    replyJson(response, 200, {
        sessions: [...downstreamSockets.values()]
            .map((socket) => socket.getUserData())
            .filter((data) => !data.closed && data.latencyMs !== undefined)
            .map((data) => ({
                roomId: data.roomId,
                sessionId: data.sessionId,
                latencyMs: data.latencyMs,
                sampleCount: data.latencySamplesMs.length,
                spectator: data.spectator,
            })),
    });
});

app.post("/internal/rooms/:room/register", (response, request) => {
    let aborted = false;
    response.onAborted(() => { aborted = true; });
    const roomId = request.getParameter(0) ?? "";
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    void readBody(response, 64 * 1024).then((payload) => {
        const body = payload.byteLength
            ? JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>
            : {};
        const endpoint = String(body.endpoint ?? "").trim();
        const epoch = Number(body.epoch ?? 1);
        if (!endpoint) throw new Error("gateway_room_endpoint_required");
        const route = registry.register({ roomId, endpoint, epoch });
        if (!aborted) replyJson(response, 201, { route, status: "registered" });
    }).catch((error) => {
        if (!aborted) replyJson(response, 409, { error: error instanceof Error ? error.message : "gateway_room_register_failed" });
    });
});

app.get("/internal/rooms/:room/operations/:operation", (response, request) => {
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    const roomId = request.getParameter(0) ?? "";
    const operationId = request.getParameter(1) ?? "";
    const operation = roomCutoverOperations.get(operationKey(roomId, operationId));
    if (!operation) return replyJson(response, 404, { error: "gateway_operation_not_found" });
    const verification = roomVerifications.get(roomId);
    replyJson(response, 200, {
        ...operationView(operation),
        route: registry.get(roomId),
        verification: verification?.operationId === operationId
            ? roomVerificationView(verification)
            : undefined,
    });
});

app.post("/internal/rooms/:room/freeze", (response, request) => {
    let aborted = false;
    response.onAborted(() => { aborted = true; });
    const roomId = request.getParameter(0) ?? "";
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    void readBody(response, 64 * 1024).then((payload) => {
        const body = payload.byteLength
            ? JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>
            : {};
        const operationId = String(body.operationId ?? "");
        const expectedEpoch = Number(body.expectedEpoch);
        const supersedesOperationId = body.supersedesOperationId
            ? String(body.supersedesOperationId)
            : undefined;
        const frozen = freezeRoom(roomId, operationId, expectedEpoch, supersedesOperationId);
        if (!aborted) replyJson(response, 200, { operationId, roomId, expectedEpoch, ...frozen });
    }).catch((error) => {
        if (!aborted) replyJson(response, 409, { error: error instanceof Error ? error.message : "gateway_freeze_failed" });
    });
});

app.post("/internal/rooms/:room/abort", (response, request) => {
    let aborted = false;
    response.onAborted(() => { aborted = true; });
    const roomId = request.getParameter(0) ?? "";
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    void readBody(response, 64 * 1024).then((payload) => {
        const body = payload.byteLength
            ? JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>
            : {};
        const operationId = body.operationId ? String(body.operationId) : undefined;
        const sessions = abortRoomPreparation(roomId, operationId);
        if (!aborted) replyJson(response, 200, { operationId, roomId, sessions, status: "active_resumed" });
    }).catch((error) => {
        if (!aborted) replyJson(response, 409, { error: error instanceof Error ? error.message : "gateway_abort_failed" });
    });
});

app.post("/internal/rooms/:room/finalize", (response, request) => {
    let aborted = false;
    response.onAborted(() => { aborted = true; });
    const roomId = request.getParameter(0) ?? "";
    if (!authorized(request.getHeader("authorization"))) return replyJson(response, 401, { error: "unauthorized" });
    void readBody(response, 64 * 1024).then((payload) => {
        const body = payload.byteLength
            ? JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>
            : {};
        const operationId = String(body.operationId ?? "");
        if (!operationId) throw new Error("gateway_operation_id_required");
        const finalized = finalizeRoomVerification(roomId, operationId);
        if (!aborted) replyJson(response, 200, { operationId, roomId, status: "verified", ...finalized });
    }).catch((error) => {
        if (!aborted) replyJson(response, 409, { error: error instanceof Error ? error.message : "gateway_finalize_failed" });
    });
});

app.post("/internal/rooms/:room/cutover", (response, request) => {
    let aborted = false;
    response.onAborted(() => { aborted = true; });
    const roomId = request.getParameter(0) ?? "";
    const authorization = request.getHeader("authorization");
    if (!authorized(authorization)) return replyJson(response, 401, { error: "unauthorized" });
    void readBody(response, 64 * 1024).then(async (payload) => {
        const body = payload.byteLength
            ? JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>
            : {};
        const result = await cutoverRoom(roomId, body);
        if (!aborted) replyJson(response, 200, result);
    }).catch((error) => {
        if (!aborted) replyJson(response, 409, { error: error instanceof Error ? error.message : "gateway_cutover_failed" });
    });
});

const proxyHttp = async (
    response: HttpResponse,
    details: {
        method: string;
        pathname: string;
        query: string;
        roomId: string;
        contentType: string;
        host: string;
        forwardedHost: string;
        forwardedProto: string;
    },
): Promise<void> => {
    let aborted = false;
    const controller = new AbortController();
    response.onAborted(() => {
        aborted = true;
        controller.abort();
    });
    try {
        const route = registry.get(details.roomId);
        if (!route) return replyJson(response, 404, { error: "gateway_room_not_found" });
        const body = details.method === "GET" || details.method === "HEAD" ? undefined : await readBody(response);
        let requestedSessionId: string | undefined;
        if (/\/api\/find_game$/.test(details.pathname) && body?.byteLength) {
            try {
                const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as { opsiaSessionId?: unknown };
                if (typeof parsed.opsiaSessionId === "string") requestedSessionId = parsed.opsiaSessionId;
            } catch {
                // The upstream remains responsible for returning the canonical bad-request response.
            }
        }
        const upstream = await fetch(`${route.endpoint}${details.pathname}${details.query ? `?${details.query}` : ""}`, {
            method: details.method,
            headers: details.contentType ? { "content-type": details.contentType } : undefined,
            body: body?.byteLength ? Buffer.from(body) : undefined,
            signal: controller.signal,
        });
        let payload = new Uint8Array(await upstream.arrayBuffer());
        let contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        if (/\/api\/find_game$/.test(details.pathname) && contentType.includes("application/json")) {
            const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as {
                res?: Array<Record<string, unknown>>;
            };
            const publicHost = details.forwardedHost || details.host;
            const useHttps = details.forwardedProto === "https";
            for (const match of parsed.res ?? []) {
                if (requestedSessionId && typeof match.gameId === "string" && typeof match.data === "string") {
                    joinAdmissions.issue(
                        joinAdmissionKey(details.roomId, match.gameId, match.data),
                        requestedSessionId,
                    );
                }
                match.hosts = [publicHost];
                match.addrs = [publicHost];
                match.useHttps = useHttps;
            }
            payload = Buffer.from(JSON.stringify(parsed));
            contentType = "application/json; charset=utf-8";
        }
        if (aborted) return;
        try {
            response.cork(() => {
                response.writeStatus(statusLine(upstream.status));
                response.writeHeader("content-type", contentType);
                const cacheControl = upstream.headers.get("cache-control");
                if (cacheControl) response.writeHeader("cache-control", cacheControl);
                response.end(payload);
            });
        } catch (error) {
            warnResponseAlreadyClosed("proxy_reply", error);
        }
    } catch (error) {
        if (!aborted) replyJson(response, 502, {
            error: error instanceof Error ? error.message : "gateway_proxy_failed",
        });
    }
};

app.ws<GatewaySocketData>("/play/*", {
    idleTimeout: 60,
    maxPayloadLength: 1024 * 1024,
    upgrade(response, request, context) {
        const roomId = roomIdFromGatewayPath(request.getUrl());
        const query = new URLSearchParams(request.getQuery());
        const gameId = query.get("gameId") ?? "";
        const sessionId = query.get("sessionId") ?? "";
        if (!roomId || !registry.get(roomId) || !gameId || sessionId.length < 16 || sessionId.length > 128) {
            response.writeStatus("400 Bad Request").end("invalid_gateway_session");
            return;
        }
        if (roomPreparations.has(roomId) || roomVerifications.has(roomId)) {
            response.writeStatus("503 Service Unavailable")
                .writeHeader("retry-after", "2")
                .end("room_handoff_in_progress");
            return;
        }
        response.upgrade(
            {
                id: randomUUID(),
                roomId,
                sessionId,
                gameId,
                spectator: query.get("spectator") === "1",
                spectateSessionId: query.get("target") ?? undefined,
                closed: false,
                latencySamplesMs: [],
            },
            request.getHeader("sec-websocket-key"),
            request.getHeader("sec-websocket-protocol"),
            request.getHeader("sec-websocket-extensions"),
            context,
        );
    },
    open(socket) {
        const data = socket.getUserData();
        const route = registry.get(data.roomId);
        if (!route) {
            socket.end(1013, "gateway_room_not_found");
            return;
        }
        const session = new GatewaySession(socket, data);
        sessions.set(data.id, session);
        downstreamSockets.set(data.id, socket);
        metrics.connections++;
        probeDownstreamLatency(socket);
        void session.start(route).catch(() => {
            if (!data.closed) {
                try {
                    socket.end(1013, "gateway_upstream_unavailable");
                } catch {
                    data.closed = true;
                }
            }
            session.stop();
            if (sessions.delete(data.id)) {
                metrics.connections = Math.max(0, metrics.connections - 1);
            }
        });
    },
    message(socket, payload) {
        sessions.get(socket.getUserData().id)?.receive(payload);
    },
    pong(socket) {
        const data = socket.getUserData();
        if (data.latencyProbeSentAt === undefined) return;
        recordLatencySample(data, Date.now() - data.latencyProbeSentAt);
        data.latencyProbeSentAt = undefined;
    },
    close(socket) {
        const data = socket.getUserData();
        data.closed = true;
        downstreamSockets.delete(data.id);
        sessions.get(data.id)?.stop();
        if (sessions.delete(data.id)) {
            metrics.connections = Math.max(0, metrics.connections - 1);
        }
    },
});

// uWebSockets routes are registered in order. The HTTP fallback must follow
// the WebSocket behavior or an upgrade GET can be consumed as a proxy call.
app.any("/*", (response, request) => {
    const pathname = request.getUrl();
    const roomId = roomIdFromGatewayPath(pathname);
    if (!roomId) return replyJson(response, 404, { error: "gateway_route_not_found" });
    const details = {
        method: request.getCaseSensitiveMethod(),
        pathname,
        query: request.getQuery(),
        roomId,
        contentType: request.getHeader("content-type"),
        host: request.getHeader("host"),
        forwardedHost: request.getHeader("x-forwarded-host"),
        forwardedProto: request.getHeader("x-forwarded-proto"),
    };
    void proxyHttp(response, details);
});

const port = Number(process.env.PORT ?? 8083);
app.listen(port, (token) => {
    if (!token) throw new Error("session_gateway_listen_failed");
    process.stdout.write(`${JSON.stringify({
        level: "info",
        event: "session_gateway_listening",
        detail: { port, rooms: registry.list() },
    })}\n`);
});
