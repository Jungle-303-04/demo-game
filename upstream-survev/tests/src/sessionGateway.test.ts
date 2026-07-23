import { describe, expect, test } from "vitest";
import * as net from "../../shared/net/net.ts";
import {
    decodeGatewayFrame,
    encodeGatewayAck,
    encodeGatewayInput,
    encodeGatewayOutput,
} from "../../server/src/opsia/gatewayWire.ts";
import { frameGameProcessOutput } from "../../server/src/game/gameProcessManager.ts";
import {
    BoundedGatewayInputBuffer,
    type GatewayConnectionIdentity,
    FencedGatewayRoomRegistry,
    GatewayBufferOverflowError,
    GatewayJoinAdmissionRegistry,
    isGatewayResumeBootstrapFrame,
    readGatewayJoin,
    roomIdFromGatewayPath,
    sameGatewayFreezeIntent,
    signGatewayConnection,
    verifyGatewayConnection,
    websocketEndpoint,
    writeGatewayJoin,
} from "../../server/src/opsia/sessionGatewayProtocol.ts";

describe("session gateway handoff protocol", () => {
    test("drops only reattach bootstrap frames before forwarding candidate output", () => {
        expect(isGatewayResumeBootstrapFrame(Uint8Array.of(net.MsgType.Joined, 1, 2))).toBe(true);
        expect(isGatewayResumeBootstrapFrame(Uint8Array.of(net.MsgType.Map, 1, 2))).toBe(true);
        expect(isGatewayResumeBootstrapFrame(Uint8Array.of(net.MsgType.Update, 1, 2))).toBe(false);
    });

    test("binds each proxied join token to exactly one matching stable session", () => {
        const admissions = new GatewayJoinAdmissionRegistry(1_000);
        admissions.issue("room-1/game-1/token-1", "stable-session-0001", 100);
        expect(admissions.consume("room-1/game-1/token-1", "wrong-session-0002", 200)).toBe(false);
        expect(admissions.consume("room-1/game-1/token-1", "stable-session-0001", 200)).toBe(true);
        expect(admissions.consume("room-1/game-1/token-1", "stable-session-0001", 200)).toBe(false);
    });

    test("recognizes a response-loss freeze retry only when the complete intent is identical", () => {
        const first = { operationId: "op-1", expectedEpoch: 41, supersedesOperationId: "op-0" };
        expect(sameGatewayFreezeIntent(first, { ...first })).toBe(true);
        expect(sameGatewayFreezeIntent(first, { ...first, expectedEpoch: 42 })).toBe(false);
        expect(sameGatewayFreezeIntent(first, { ...first, supersedesOperationId: undefined })).toBe(false);
    });

    test("keeps only unacknowledged messages in monotonic replay order", () => {
        const buffer = new BoundedGatewayInputBuffer(4, 4_096);
        const first = buffer.push(Uint8Array.of(1));
        const second = buffer.push(Uint8Array.of(2));
        const third = buffer.push(Uint8Array.of(3));

        expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
        buffer.acknowledge(second.sequence);
        expect(buffer.lastAcknowledgedSequence).toBe(2);
        expect(buffer.replayAfter().map((entry) => [...entry.payload])).toEqual([[3]]);
        expect(buffer.bytes).toBe(1);
    });

    test("fails closed instead of silently dropping an overflowing input buffer", () => {
        const byCount = new BoundedGatewayInputBuffer(1, 4_096);
        byCount.push(Uint8Array.of(1));
        expect(() => byCount.push(Uint8Array.of(2))).toThrowError(GatewayBufferOverflowError);

        const byBytes = new BoundedGatewayInputBuffer(8, 1_024);
        expect(() => byBytes.push(new Uint8Array(1_025))).toThrowError(
            "gateway_input_buffer_overflow:byte_limit",
        );
    });

    test("atomically fences stale room epochs", () => {
        const registry = new FencedGatewayRoomRegistry([
            { roomId: "room-1", endpoint: "http://active:8001", epoch: 41 },
        ]);

        const next = registry.compareAndSwap("room-1", 41, {
            endpoint: "http://candidate:8001",
            epoch: 42,
            revision: "safe-revision",
        });
        expect(next).toMatchObject({ endpoint: "http://candidate:8001", epoch: 42 });
        expect(() => registry.compareAndSwap("room-1", 41, {
            endpoint: "http://stale:8001",
            epoch: 42,
        })).toThrowError("gateway_epoch_conflict");
        expect(registry.compareAndSwap("room-1", 42, {
            endpoint: "http://recovered:8001",
            epoch: 44,
        })).toMatchObject({ endpoint: "http://recovered:8001", epoch: 44 });
        expect(() => registry.compareAndSwap("room-1", 44, {
            endpoint: "http://stale-again:8001",
            epoch: 44,
        })).toThrowError("gateway_epoch_not_monotonic");
    });

    test("registers a newly discovered labeled room without treating its workload name as identity", () => {
        const registry = new FencedGatewayRoomRegistry([]);
        expect(registry.register({
            roomId: "room-6",
            endpoint: "http://game-room-6:8001",
            epoch: 1,
        })).toMatchObject({ roomId: "room-6", endpoint: "http://game-room-6:8001", epoch: 1 });
        expect(registry.register({
            roomId: "room-6",
            endpoint: "http://game-room-6:8001",
            epoch: 1,
        })).toMatchObject({ roomId: "room-6" });
        expect(() => registry.register({
            roomId: "room-6",
            endpoint: "http://other-service:8001",
            epoch: 1,
        })).toThrowError("gateway_room_registration_conflict");
    });

    test("reconciles only a newer epoch for the unchanged stable room Service", () => {
        const registry = new FencedGatewayRoomRegistry([
            { roomId: "room-1", endpoint: "http://game-room-1:8001", epoch: 1 },
        ]);
        expect(registry.reconcileStableRoute({
            roomId: "room-1",
            endpoint: "http://game-room-1:8001",
            epoch: 7,
        })).toMatchObject({ roomId: "room-1", epoch: 7 });
        expect(() => registry.reconcileStableRoute({
            roomId: "room-1",
            endpoint: "http://other-service:8001",
            epoch: 8,
        })).toThrowError("gateway_room_reconciliation_endpoint_conflict");
        expect(() => registry.reconcileStableRoute({
            roomId: "room-1",
            endpoint: "http://game-room-1:8001",
            epoch: 6,
        })).toThrowError("gateway_room_reconciliation_epoch_regression");
    });

    test("rewrites only the one-time match token when resuming a stable session", () => {
        const original = new net.JoinMsg();
        original.protocol = 1021;
        original.matchPriv = "old-one-time-token";
        original.name = "handoff-player";
        original.useTouch = false;
        original.isMobile = false;
        original.bot = false;
        original.loadout = {
            outfit: "outfitBase",
            melee: "fists",
            heal: "heal_basic",
            boost: "boost_basic",
            emotes: ["emote_happyface"],
        };
        const stream = new net.MsgStream(new ArrayBuffer(8_192));
        stream.serializeMsg(net.MsgType.Join, original);

        const template = readGatewayJoin(stream.getBuffer());
        expect(template).toBeDefined();
        const resumed = writeGatewayJoin(template!, "candidate-match-token");
        const decodedStream = new net.MsgStream(resumed);
        expect(decodedStream.deserializeMsgType()).toBe(net.MsgType.Join);
        const decoded = new net.JoinMsg();
        decoded.deserialize(decodedStream.stream);

        expect(decoded.matchPriv).toBe("candidate-match-token");
        expect(decoded.name).toBe(original.name);
        expect(decoded.loadout).toEqual(original.loadout);
    });

    test("routes any numeric room through the fixed gateway endpoint", () => {
        expect(roomIdFromGatewayPath("/play/room-4/")).toBe("room-4");
        expect(roomIdFromGatewayPath("/watch/room-17/assets/main.js")).toBe("room-17");
        expect(roomIdFromGatewayPath("/play/not-a-room/")).toBeUndefined();
        expect(websocketEndpoint("https://candidate.internal:8001/", "game-id"))
            .toBe("wss://candidate.internal:8001/play?gameId=game-id");
        const sharedSecret = "test-session-gateway-secret-at-least-32-bytes";
        const signedUrl = new URL(websocketEndpoint("http://candidate.internal:8001", "game-id", {
            roomId: "room-4",
            sessionId: "stable-session-id",
            roomEpoch: 42,
            sharedSecret,
        }));
        expect(`${signedUrl.protocol}//${signedUrl.host}${signedUrl.pathname}`).toBe(
            "ws://candidate.internal:8001/play",
        );
        expect(signedUrl.searchParams.get("opsiaGateway")).toBe("1");
        const identity: GatewayConnectionIdentity = {
            roomId: "room-4",
            gameId: signedUrl.searchParams.get("gameId")!,
            sessionId: signedUrl.searchParams.get("gatewaySessionId")!,
            roomEpoch: Number(signedUrl.searchParams.get("roomEpoch")),
            issuedAt: Number(signedUrl.searchParams.get("gatewayIssuedAt")),
            nonce: signedUrl.searchParams.get("gatewayNonce")!,
        };
        expect(verifyGatewayConnection(
            sharedSecret,
            identity,
            signedUrl.searchParams.get("gatewaySignature")!,
        )).toBe(true);
    });

    test("binds signed Gateway authority to room, game, session, epoch, nonce, and a short time window", () => {
        const secret = "test-session-gateway-secret-at-least-32-bytes";
        const now = 1_800_000_000_000;
        const identity: GatewayConnectionIdentity = {
            roomId: "room-2",
            gameId: "game-7",
            sessionId: "stable-session-0007",
            roomEpoch: 7,
            issuedAt: now,
            nonce: "0123456789abcdef0123456789abcdef",
        };
        const signature = signGatewayConnection(secret, identity);
        expect(verifyGatewayConnection(secret, identity, signature, now)).toBe(true);
        expect(verifyGatewayConnection(secret, { ...identity, roomEpoch: 8 }, signature, now)).toBe(false);
        expect(verifyGatewayConnection(secret, { ...identity, roomId: "room-3" }, signature, now)).toBe(false);
        expect(verifyGatewayConnection(secret, identity, signature, now + 30_001)).toBe(false);
        expect(verifyGatewayConnection("a different gateway secret of sufficient length", identity, signature, now))
            .toBe(false);
    });

    test("frames exact input sequences and authoritative ACKs without exposing them to the browser protocol", () => {
        const encodedInput = encodeGatewayInput({
            roomEpoch: 42,
            inputSequence: 9_007,
            clientTick: 81,
            payload: Uint8Array.of(3, 1, 4),
        });
        expect(decodeGatewayFrame(encodedInput)).toEqual({
            kind: "input",
            roomEpoch: 42,
            inputSequence: 9_007,
            clientTick: 81,
            payload: Uint8Array.of(3, 1, 4),
        });

        const encodedAck = encodeGatewayAck({
            roomEpoch: 42,
            lastAckInputSequence: 9_007,
            serverTick: 91_820,
        });
        expect(decodeGatewayFrame(encodedAck)).toEqual({
            kind: "ack",
            roomEpoch: 42,
            lastAckInputSequence: 9_007,
            serverTick: 91_820,
        });
        expect(decodeGatewayFrame(Uint8Array.of(1, 2, 3))).toBeUndefined();
    });

    test("frames authoritative game output and drops stale-epoch process output", () => {
        const browserPayload = Uint8Array.of(9, 8, 7, 6);
        const encoded = encodeGatewayOutput({
            roomEpoch: 42,
            serverTick: 91_821,
            payload: browserPayload,
        });
        expect(decodeGatewayFrame(encoded)).toEqual({
            kind: "output",
            roomEpoch: 42,
            serverTick: 91_821,
            payload: browserPayload,
        });

        const socket = { gatewaySessionId: "stable-session", roomEpoch: 42 };
        const framed = frameGameProcessOutput(socket, browserPayload, 42, 91_821);
        expect(framed).toBeDefined();
        expect(decodeGatewayFrame(framed!)).toMatchObject({
            kind: "output",
            roomEpoch: 42,
            serverTick: 91_821,
        });
        expect(frameGameProcessOutput(socket, browserPayload, 41, 91_820)).toBeUndefined();
        expect(frameGameProcessOutput({ roomEpoch: 42 }, browserPayload, undefined, 0)).toBe(browserPayload);
    });
});
