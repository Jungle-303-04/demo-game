import { afterEach, expect, test } from "vitest";
import type { Client } from "../../server/src/game/client.ts";
import { NoOpSocket } from "../../server/src/game/socket.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { JoinMsg } from "../../shared/net/net.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

const originalOpsiaRoom = process.env.OPSIA_ROOM;

afterEach(() => {
    if (originalOpsiaRoom === undefined) delete process.env.OPSIA_ROOM;
    else process.env.OPSIA_ROOM = originalOpsiaRoom;
});

const addJoinToken = (game: ReturnType<typeof createGame>, token: string, sessionId: string): JoinMsg => {
    game.joinTokens.set(token, {
        expiresAt: Date.now() + 10_000,
        userId: null,
        findGameIp: "127.0.0.1",
        opsiaSessionId: sessionId,
        groupData: {
            autoFill: false,
            playerCount: 1,
            groupHashToJoin: "",
        },
    });
    const join = new JoinMsg();
    join.matchPriv = token;
    join.name = "Reattached";
    return join;
};

class GatewayNoOpSocket<T> extends NoOpSocket<T> {
    constructor(override gatewaySessionId: string) {
        super();
    }
}

test("rejects a join token whose session differs from the signed Gateway socket", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const socket = new GatewayNoOpSocket<Client | undefined>("signed-session-0001");
    const joined = game.clientBarn.addClient(
        socket,
        addJoinToken(game, "mismatched-token", "token-session-0002"),
    );

    expect(joined).toBeUndefined();
    expect(socket.closed()).toBe(true);
    expect(game.clientBarn.clients).toHaveLength(0);
});

test("a stable Opsia session reattaches to the retained Player object without resetting state", () => {
    process.env.OPSIA_ROOM = "true";
    const game = createGame(TeamMode.Solo, "test_normal");
    game.preventStart = true;
    const player = game.playerBarn.addTestPlayer({});
    const sessionId = "stable-session-reattach-0001";
    player.opsiaSessionId = sessionId;
    player.pos.x = 17;
    player.pos.y = 29;
    player.health = 63;
    player.kills = 4;
    const originalClient = player.client;

    game.clientBarn.handleSocketClose(originalClient.socket);
    expect(player.disconnected).toBe(true);
    expect(game.playerBarn.players).toContain(player);

    const socket = new NoOpSocket<Client | undefined>();
    const reattached = game.clientBarn.addClient(socket, addJoinToken(game, "reattach-token", sessionId));

    expect(reattached?.player).toBe(player);
    expect(player.client).toBe(reattached);
    expect(player.disconnected).toBe(false);
    expect(player.pos).toEqual({ x: 17, y: 29 });
    expect(player.health).toBe(63);
    expect(player.kills).toBe(4);
    expect(game.playerBarn.players.filter((candidate) => candidate.opsiaSessionId === sessionId)).toEqual([player]);
});

test("a second live connection cannot take over an already connected stable session", () => {
    process.env.OPSIA_ROOM = "true";
    const game = createGame(TeamMode.Solo, "test_normal");
    game.preventStart = true;
    const player = game.playerBarn.addTestPlayer({});
    const sessionId = "stable-session-connected-0002";
    player.opsiaSessionId = sessionId;
    const socket = new NoOpSocket<Client | undefined>();

    const duplicate = game.clientBarn.addClient(socket, addJoinToken(game, "duplicate-token", sessionId));

    expect(duplicate).toBeUndefined();
    expect(socket.closed()).toBe(true);
    expect(game.playerBarn.players.filter((candidate) => candidate.opsiaSessionId === sessionId)).toEqual([player]);
});
