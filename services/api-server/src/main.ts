import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { consoleJsonLog } from "../../game-server/src/logger.js";
import { HttpRoomDirectory, Matchmaker } from "./matchmaker.js";

const port = Number(process.env.PORT ?? 8081);
const matchmaker = new Matchmaker(new HttpRoomDirectory(process.env.ORCHESTRATOR_URL ?? "http://room-orchestrator:8082"), Number(process.env.MAX_FIND_GAME_PER_SECOND ?? 25), Date.now, consoleJsonLog);
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
      const joined = await fetch(`${room.endpoint}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, nickname }) });
      if (!joined.ok) throw new Error(`game_join_failed:${joined.status}`);
      return send(response, 200, { room, joined: await joined.json() });
    }
    const match = url.pathname.match(/^\/(play|watch)\/(room-\d+)$/);
    if (request.method === "GET" && match) return send(response, 200, { mode: match[1], roomId: match[2], reconnectOverlay: "reconnecting", accountsEnabled: false });
    return send(response, 404, { error: "not_found" });
  } catch (error) { return send(response, 429, { error: error instanceof Error ? error.message : "request_failed" }); }
});
server.listen(port, () => consoleJsonLog({ level: "info", event: "api_server_listening", detail: { port } }));
