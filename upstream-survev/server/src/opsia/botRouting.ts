export interface BotMatchRoute {
    gameId: string;
    useHttps: boolean;
    addrs: string[];
}

const normalizeHttpEndpoint = (endpoint: string, error: string): string => {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(error);
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
};

export const normalizeSessionGatewayUrl = (configured: string | undefined): string | undefined => {
    const value = configured?.trim();
    if (!value) return undefined;
    return normalizeHttpEndpoint(value, "invalid_session_gateway_url");
};

export const botFindGameUrl = (
    roomId: string,
    roomEndpoint: string,
    sessionGatewayUrl: string | undefined,
): string => {
    if (roomId === "canary-room") {
        return `${normalizeHttpEndpoint(roomEndpoint, "invalid_canary_room_endpoint")}/api/find_game`;
    }
    if (!/^room-\d+$/.test(roomId)) throw new Error("invalid_live_room_id");
    if (!sessionGatewayUrl) throw new Error("session_gateway_url_required_for_live_bots");
    return `${normalizeHttpEndpoint(sessionGatewayUrl, "invalid_session_gateway_url")}/play/${roomId}/api/find_game`;
};

export const botWebsocketUrl = (
    roomId: string,
    match: BotMatchRoute,
    sessionId: string,
    sessionGatewayUrl: string | undefined,
): string => {
    if (roomId === "canary-room") {
        const address = match.addrs[0];
        if (!address) throw new Error("canary_match_address_missing");
        return `ws${match.useHttps ? "s" : ""}://${address}/play?gameId=${encodeURIComponent(match.gameId)}`;
    }
    if (!/^room-\d+$/.test(roomId)) throw new Error("invalid_live_room_id");
    if (!sessionGatewayUrl) throw new Error("session_gateway_url_required_for_live_bots");
    const url = new URL(`/play/${roomId}`, normalizeHttpEndpoint(sessionGatewayUrl, "invalid_session_gateway_url"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ gameId: match.gameId, sessionId }).toString();
    return url.toString();
};
