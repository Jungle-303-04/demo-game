import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readControlToken } from "../../control-plane-auth.js";
import { HttpRoomDirectory, Matchmaker } from "./matchmaker.js";

const port = Number(process.env.PORT ?? 8081);
const log = (event: { level: string; event: string; [key: string]: unknown }) => process.stdout.write(`${JSON.stringify(event)}\n`);
const controlToken = readControlToken();
const matchmaker = new Matchmaker(
  new HttpRoomDirectory(process.env.ORCHESTRATOR_URL ?? "http://room-orchestrator:8082", controlToken),
  Number(process.env.MAX_FIND_GAME_PER_SECOND ?? 25),
  Date.now,
  log,
);
const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};
const send = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
const publicRoomUrl = (roomId: string, ordinal: number, fallbackOrigin: string): string => {
  const configured = (process.env.PUBLIC_ROOM_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${roomId}=`));
  if (configured) return configured.slice(configured.indexOf("=") + 1);
  const template = process.env.PUBLIC_ROOM_URL_TEMPLATE ?? `${fallbackOrigin}/play/{roomId}/`;
  return template.replaceAll("{roomId}", roomId).replaceAll("{ordinal}", String(ordinal));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return send(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      matchmaker.refreshMetrics();
      response.writeHead(200, { "content-type": matchmaker.registry.contentType });
      return response.end(`${await matchmaker.registry.metrics()}\n`);
    }
    if (request.method === "POST" && url.pathname === "/api/find-game") {
      const body = await readJson(request); const sessionId = String(body.sessionId ?? ""); const nickname = String(body.nickname ?? "");
      if (!sessionId) return send(response, 400, { error: "sessionId_required" });
      const requestedRoomId = body.roomId === undefined ? undefined : String(body.roomId);
      if (requestedRoomId !== undefined && !/^room-\d+$/.test(requestedRoomId)) {
        return send(response, 400, { error: "roomId_invalid" });
      }
      const safeHeader = (name: string): string | undefined => {
        const value = request.headers[name];
        const text = Array.isArray(value) ? value[0] : value;
        if (!text || text.length > 160 || !/^[a-zA-Z0-9_.:/-]+$/.test(text)) return undefined;
        return text;
      };
      const room = await matchmaker.findGame(sessionId, nickname, requestedRoomId, {
        correlationId: safeHeader("x-opsia-correlation-id"),
        scenario: safeHeader("x-opsia-scenario"),
        syntheticLoad: request.headers["x-opsia-synthetic-load"] === "true",
      });
      // This service chooses a live room Deployment only. The participant then
      // uses that room's real survev `/api/find_game` + WebSocket protocol.
      const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");
      const protocol = String(request.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
      return send(response, 200, { room, playUrl: publicRoomUrl(room.roomId, room.ordinal, `${protocol}://${host}`) });
    }
    const match = url.pathname.match(/^\/(play|watch)\/(room-\d+)\/?$/);
    if (request.method === "GET" && match) return send(response, 200, { mode: match[1], roomId: match[2], reconnectOverlay: "reconnecting", accountsEnabled: false });
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    const status = message.includes("rate_limited")
      ? 429
      : message.includes("no_room") || message.includes("room_unavailable") || message.includes("directory_unavailable")
        ? 503
        : 400;
    return send(response, status, { error: message });
  }
});
server.listen(port, () => log({ level: "info", event: "api_server_listening", detail: { port } }));
