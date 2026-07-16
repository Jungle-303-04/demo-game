import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpRoomDirectory, Matchmaker } from "./matchmaker.js";

const port = Number(process.env.PORT ?? 8081);
const log = (event: { level: string; event: string; [key: string]: unknown }) => process.stdout.write(`${JSON.stringify(event)}\n`);
const matchmaker = new Matchmaker(new HttpRoomDirectory(process.env.ORCHESTRATOR_URL ?? "http://room-orchestrator:8082"), Number(process.env.MAX_FIND_GAME_PER_SECOND ?? 25), Date.now, log);
const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; };
const send = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/metrics") { response.writeHead(200, { "content-type": matchmaker.registry.contentType }); return response.end(await matchmaker.registry.metrics()); }
    if (request.method === "POST" && url.pathname === "/api/find-game") {
      const body = await readJson(request); const sessionId = String(body.sessionId ?? ""); const nickname = String(body.nickname ?? "");
      if (!sessionId) return send(response, 400, { error: "sessionId_required" });
      const room = await matchmaker.findGame(sessionId, nickname);
      // This service chooses a StatefulSet ordinal only. The participant then
      // uses that room's real survev `/api/find_game` + WebSocket protocol.
      return send(response, 200, { room, playUrl: `${room.endpoint}/play/${room.roomId}` });
    }
    const match = url.pathname.match(/^\/(play|watch)\/(room-\d+)$/);
    if (request.method === "GET" && match) return send(response, 200, { mode: match[1], roomId: match[2], reconnectOverlay: "reconnecting", accountsEnabled: false });
    return send(response, 404, { error: "not_found" });
  } catch (error) { return send(response, 429, { error: error instanceof Error ? error.message : "request_failed" }); }
});
server.listen(port, () => log({ level: "info", event: "api_server_listening", detail: { port } }));
