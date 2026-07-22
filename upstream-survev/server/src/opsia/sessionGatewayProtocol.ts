import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as net from "../../../shared/net/net.ts";

export const GATEWAY_SIGNATURE_VERSION = "v1";
export const GATEWAY_SIGNATURE_MAX_SKEW_MS = 30_000;
const GATEWAY_NONCE_PATTERN = /^[a-f\d]{32}$/;
const GATEWAY_SIGNATURE_PATTERN = /^[a-f\d]{64}$/;

export interface GatewayConnectionIdentity {
    roomId: string;
    gameId: string;
    sessionId: string;
    roomEpoch: number;
    issuedAt: number;
    nonce: string;
}

const gatewaySignaturePayload = (identity: GatewayConnectionIdentity): string => [
    GATEWAY_SIGNATURE_VERSION,
    identity.roomId,
    identity.gameId,
    identity.sessionId,
    String(identity.roomEpoch),
    String(identity.issuedAt),
    identity.nonce,
].join("\n");

export const assertGatewaySharedSecret = (secret: string): void => {
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("session_gateway_shared_secret_too_short");
};

export const isGatewayConnectionIdentityValid = (
    identity: GatewayConnectionIdentity,
    now = Date.now(),
): boolean => /^room-\d+$/.test(identity.roomId)
    && identity.gameId.length > 0
    && identity.gameId.length <= 256
    && identity.sessionId.length >= 16
    && identity.sessionId.length <= 128
    && Number.isSafeInteger(identity.roomEpoch)
    && identity.roomEpoch >= 1
    && Number.isSafeInteger(identity.issuedAt)
    && Math.abs(now - identity.issuedAt) <= GATEWAY_SIGNATURE_MAX_SKEW_MS
    && GATEWAY_NONCE_PATTERN.test(identity.nonce);

export const signGatewayConnection = (
    secret: string,
    identity: GatewayConnectionIdentity,
): string => {
    assertGatewaySharedSecret(secret);
    return createHmac("sha256", secret).update(gatewaySignaturePayload(identity), "utf8").digest("hex");
};

export const verifyGatewayConnection = (
    secret: string,
    identity: GatewayConnectionIdentity,
    signature: string,
    now = Date.now(),
): boolean => {
    if (!isGatewayConnectionIdentityValid(identity, now) || !GATEWAY_SIGNATURE_PATTERN.test(signature)) return false;
    try {
        const actual = Buffer.from(signature, "hex");
        const expected = Buffer.from(signGatewayConnection(secret, identity), "hex");
        return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
};

export interface GatewayRoomRoute {
    roomId: string;
    endpoint: string;
    epoch: number;
    revision?: string;
}

export interface BufferedGatewayInput {
    sequence: number;
    payload: Uint8Array;
    bytes: number;
}

export class GatewayBufferOverflowError extends Error {
    constructor(readonly reason: "message_limit" | "byte_limit" | "sequence_exhausted") {
        super(`gateway_input_buffer_overflow:${reason}`);
    }
}

/**
 * A fail-closed buffer for messages that reached the stable browser socket but
 * are not yet known to have produced an authoritative upstream response.
 */
export class BoundedGatewayInputBuffer {
    private readonly entries: BufferedGatewayInput[] = [];
    private nextSequence = 1;
    private acknowledgedSequence = 0;
    private bufferedBytes = 0;

    constructor(
        readonly maxMessages = 256,
        readonly maxBytes = 1024 * 1024,
    ) {
        if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("invalid_gateway_message_limit");
        if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error("invalid_gateway_byte_limit");
    }

    push(payload: ArrayBuffer | Uint8Array): BufferedGatewayInput {
        if (this.nextSequence >= Number.MAX_SAFE_INTEGER) {
            throw new GatewayBufferOverflowError("sequence_exhausted");
        }
        const copy = payload instanceof Uint8Array
            ? Uint8Array.from(payload)
            : new Uint8Array(payload.slice(0));
        if (this.entries.length + 1 > this.maxMessages) {
            throw new GatewayBufferOverflowError("message_limit");
        }
        if (this.bufferedBytes + copy.byteLength > this.maxBytes) {
            throw new GatewayBufferOverflowError("byte_limit");
        }
        const entry = {
            sequence: this.nextSequence++,
            payload: copy,
            bytes: copy.byteLength,
        };
        this.entries.push(entry);
        this.bufferedBytes += entry.bytes;
        return entry;
    }

    acknowledge(sequence: number): void {
        if (!Number.isSafeInteger(sequence) || sequence <= this.acknowledgedSequence) return;
        this.acknowledgedSequence = Math.min(sequence, this.nextSequence - 1);
        while (this.entries[0] && this.entries[0].sequence <= this.acknowledgedSequence) {
            this.bufferedBytes -= this.entries.shift()!.bytes;
        }
    }

    replayAfter(sequence = this.acknowledgedSequence): BufferedGatewayInput[] {
        return this.entries
            .filter((entry) => entry.sequence > sequence)
            .map((entry) => ({ ...entry, payload: Uint8Array.from(entry.payload) }));
    }

    get latestSequence(): number {
        return this.nextSequence - 1;
    }

    get lastAcknowledgedSequence(): number {
        return this.acknowledgedSequence;
    }

    get size(): number {
        return this.entries.length;
    }

    get bytes(): number {
        return this.bufferedBytes;
    }
}

const normalizeRoute = (route: GatewayRoomRoute): GatewayRoomRoute => {
    if (!/^room-\d+$/.test(route.roomId)) throw new Error("invalid_gateway_room_id");
    const endpoint = new URL(route.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new Error("invalid_gateway_room_endpoint");
    }
    if (!Number.isSafeInteger(route.epoch) || route.epoch < 1) throw new Error("invalid_room_epoch");
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
    return { ...route, endpoint: endpoint.toString().replace(/\/$/, "") };
};

/** In-memory CAS view used by a Gateway replica; the orchestrator remains authoritative. */
export class FencedGatewayRoomRegistry {
    private readonly routes = new Map<string, GatewayRoomRoute>();

    constructor(initialRoutes: GatewayRoomRoute[]) {
        for (const route of initialRoutes) {
            const normalized = normalizeRoute(route);
            if (this.routes.has(normalized.roomId)) throw new Error("duplicate_gateway_room");
            this.routes.set(normalized.roomId, normalized);
        }
    }

    get(roomId: string): GatewayRoomRoute | undefined {
        const route = this.routes.get(roomId);
        return route ? { ...route } : undefined;
    }

    list(): GatewayRoomRoute[] {
        return [...this.routes.values()]
            .map((route) => ({ ...route }))
            .sort((left, right) => Number(left.roomId.slice(5)) - Number(right.roomId.slice(5)));
    }

    /** Registers a new stable room route without permitting an implicit cutover. */
    register(route: GatewayRoomRoute): GatewayRoomRoute {
        const normalized = normalizeRoute(route);
        const current = this.routes.get(normalized.roomId);
        if (current) {
            if (current.endpoint !== normalized.endpoint || current.epoch !== normalized.epoch) {
                throw new Error("gateway_room_registration_conflict");
            }
            return { ...current };
        }
        this.routes.set(normalized.roomId, normalized);
        return { ...normalized };
    }

    compareAndSwap(
        roomId: string,
        expectedEpoch: number,
        candidate: Omit<GatewayRoomRoute, "roomId">,
    ): GatewayRoomRoute {
        const current = this.routes.get(roomId);
        if (!current) throw new Error("gateway_room_not_found");
        if (current.epoch !== expectedEpoch) throw new Error("gateway_epoch_conflict");
        // Recovery may need to skip an epoch that was already granted to an
        // authority even when the Gateway never observed the first cutover.
        // Strictly increasing fencing, rather than contiguity, is the safety
        // property: an older writer can never regain authority at the same id.
        if (candidate.epoch <= expectedEpoch) throw new Error("gateway_epoch_not_monotonic");
        const next = normalizeRoute({ roomId, ...candidate });
        this.routes.set(roomId, next);
        return { ...next };
    }
}

export interface GatewayJoinTemplate {
    matchPriv: string;
    protocol: number;
    name: string;
    useTouch: boolean;
    isMobile: boolean;
    bot: boolean;
    loadout: net.JoinMsg["loadout"];
}

export const readGatewayJoin = (payload: ArrayBuffer | Uint8Array): GatewayJoinTemplate | undefined => {
    const stream = new net.MsgStream(payload);
    if (stream.deserializeMsgType() !== net.MsgType.Join) return undefined;
    const join = new net.JoinMsg();
    join.deserialize(stream.stream);
    return {
        matchPriv: join.matchPriv,
        protocol: join.protocol,
        name: join.name,
        useTouch: join.useTouch,
        isMobile: join.isMobile,
        bot: join.bot,
        loadout: {
            ...join.loadout,
            emotes: [...join.loadout.emotes],
        },
    };
};

/** Candidate reattach emits a normal Survev bootstrap before live updates.
 * The already-initialized browser must never observe that second Joined/Map. */
export const isGatewayResumeBootstrapFrame = (payload: Uint8Array): boolean =>
    payload[0] === net.MsgType.Joined || payload[0] === net.MsgType.Map;

interface GatewayJoinAdmission {
    sessionId: string;
    expiresAt: number;
}

/** One-time binding between the proxied find_game token and its stable session. */
export class GatewayJoinAdmissionRegistry {
    private readonly admissions = new Map<string, GatewayJoinAdmission>();

    constructor(private readonly ttlMs = 15_000) {}

    issue(key: string, sessionId: string, now = Date.now()): void {
        this.admissions.set(key, { sessionId, expiresAt: now + this.ttlMs });
    }

    consume(key: string, sessionId: string, now = Date.now()): boolean {
        const admission = this.admissions.get(key);
        if (!admission || admission.expiresAt < now || admission.sessionId !== sessionId) return false;
        this.admissions.delete(key);
        return true;
    }
}

export interface GatewayFreezeIntent {
    operationId: string;
    expectedEpoch: number;
    supersedesOperationId?: string;
}

export const sameGatewayFreezeIntent = (left: GatewayFreezeIntent, right: GatewayFreezeIntent): boolean =>
    left.operationId === right.operationId
    && left.expectedEpoch === right.expectedEpoch
    && left.supersedesOperationId === right.supersedesOperationId;

export const writeGatewayJoin = (template: GatewayJoinTemplate, matchPriv: string): Uint8Array => {
    if (!matchPriv || matchPriv.length > 16 * 1024) throw new Error("invalid_resume_match_token");
    const join = new net.JoinMsg();
    join.protocol = template.protocol;
    join.matchPriv = matchPriv;
    join.name = template.name;
    join.useTouch = template.useTouch;
    join.isMobile = template.isMobile;
    join.bot = template.bot;
    join.loadout = {
        ...template.loadout,
        emotes: [...template.loadout.emotes],
    };
    const stream = new net.MsgStream(new ArrayBuffer(Math.max(8_192, matchPriv.length + 1024)));
    stream.serializeMsg(net.MsgType.Join, join);
    return stream.getBuffer();
};

export const roomIdFromGatewayPath = (pathname: string): string | undefined =>
    pathname.match(/^\/(?:play|watch)\/(room-\d+)(?:\/|$)/)?.[1];

export const websocketEndpoint = (
    endpoint: string,
    gameId: string,
    gateway?: { roomId: string; sessionId: string; roomEpoch: number; sharedSecret: string },
): string => {
    const url = new URL(endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/play";
    const identity = gateway
        ? {
            roomId: gateway.roomId,
            gameId,
            sessionId: gateway.sessionId,
            roomEpoch: gateway.roomEpoch,
            issuedAt: Date.now(),
            nonce: randomBytes(16).toString("hex"),
        }
        : undefined;
    url.search = new URLSearchParams({
        gameId,
        ...(gateway && identity
            ? {
                opsiaGateway: "1",
                gatewaySessionId: gateway.sessionId,
                roomEpoch: String(gateway.roomEpoch),
                gatewayIssuedAt: String(identity.issuedAt),
                gatewayNonce: identity.nonce,
                gatewaySignature: signGatewayConnection(gateway.sharedSecret, identity),
            }
            : {}),
    }).toString();
    return url.toString();
};
