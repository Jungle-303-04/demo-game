import { describe, expect, test } from "vitest";
import {
    botFindGameUrl,
    botWebsocketUrl,
    normalizeSessionGatewayUrl,
} from "../../server/src/opsia/botRouting.ts";

describe("bot data-path routing", () => {
    test("routes every live room matchmaking and WebSocket through the stable Session Gateway", () => {
        const gateway = normalizeSessionGatewayUrl("http://session-gateway:8083/");
        expect(botFindGameUrl("room-3", "http://game-room-3:8001", gateway)).toBe(
            "http://session-gateway:8083/play/room-3/api/find_game",
        );
        expect(botWebsocketUrl("room-3", {
            gameId: "game-live-3",
            useHttps: false,
            addrs: ["game-room-3:8001"],
        }, "opsia-bot-stable-session-0003", gateway)).toBe(
            "ws://session-gateway:8083/play/room-3?gameId=game-live-3&sessionId=opsia-bot-stable-session-0003",
        );
    });

    test("keeps validation-only canary bots on the isolated direct endpoint", () => {
        expect(botFindGameUrl("canary-room", "http://canary-room:8001/", undefined)).toBe(
            "http://canary-room:8001/api/find_game",
        );
        expect(botWebsocketUrl("canary-room", {
            gameId: "canary-game",
            useHttps: false,
            addrs: ["canary-room:8001"],
        }, "canary-session-is-not-forwarded", undefined)).toBe(
            "ws://canary-room:8001/play?gameId=canary-game",
        );
    });

    test("fails closed when a live bot has no Gateway", () => {
        expect(() => botFindGameUrl("room-0", "http://game-room-0:8001", undefined))
            .toThrow("session_gateway_url_required_for_live_bots");
        expect(() => botWebsocketUrl("room-0", {
            gameId: "game-0",
            useHttps: false,
            addrs: ["game-room-0:8001"],
        }, "opsia-bot-stable-session-0000", undefined)).toThrow(
            "session_gateway_url_required_for_live_bots",
        );
    });
});
