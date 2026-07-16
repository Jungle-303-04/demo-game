import { proxy } from "./proxy.ts";

export const api = {
    resolveUrl(url: string) {
        const proxyDef = proxy.getProxyDef();
        if (proxyDef && proxyDef.def.apiUrl) {
            return proxyDef.def.apiUrl + url;
        }
        // A StatefulSet room is exposed as /play/room-N (or /watch/room-N).
        // Keep site-info and find-game requests under that prefix so ingress
        // selects the same real survev GameServer process as the websocket.
        const roomPath = window.location.pathname.match(/^\/(?:play|watch)\/room-\d+/)?.[0];
        return roomPath ? `${roomPath}${url}` : url;
    },
    resolveRoomHost() {
        const proxyDef = proxy.getProxyDef();
        if (proxyDef && proxyDef.def.apiUrl) {
            return new URL(proxyDef.def.apiUrl).host;
        }
        return window.location.host;
    },
};
