import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GameMetrics } from "./metrics.js";
import { consoleJsonLog } from "./logger.js";
import { GameRuntime } from "./runtime.js";
import { createSnapshotStore } from "./snapshot-store.js";
import type { InputPacket } from "./types.js";

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};
const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const roomId = process.env.ROOM_ID ?? "room-0";
const podName = process.env.POD_NAME ?? "game-0";
const port = Number(process.env.PORT ?? 8080);
const strictMode = process.env.STRICT_MODE === "true";
const runtime = new GameRuntime({ roomId, podName, strictMode, store: createSnapshotStore(), baseUrl: process.env.PUBLIC_BASE_URL, log: consoleJsonLog });
const metrics = new GameMetrics();

await runtime.start();
const tickTimer = setInterval(() => {
  const started = performance.now();
  runtime.tick();
  metrics.observeTick((runtime as unknown as { room: import("./room.js").DemoRoom }).room, performance.now() - started);
}, 100);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok", roomId, strictMode });
    if (request.method === "GET" && url.pathname === "/metrics") {
      response.writeHead(200, { "content-type": metrics.registry.contentType });
      return response.end(await metrics.registry.metrics());
    }
    if (request.method === "GET" && url.pathname === "/summary") return send(response, 200, runtime.summary());
    if (request.method === "GET" && url.pathname === "/ops/snapshot") return send(response, 200, runtime.opsSnapshot());
    if (request.method === "POST" && url.pathname === "/join") {
      const body = await readJson(request);
      const sessionId = String(body.sessionId ?? "");
      if (!sessionId) return send(response, 400, { error: "sessionId_required" });
      return send(response, 200, runtime.join(sessionId, String(body.nickname ?? ""), body.isBot === true));
    }
    if (request.method === "POST" && url.pathname === "/input") {
      const body = await readJson(request);
      const result = runtime.input(String(body.sessionId ?? ""), body as unknown as InputPacket);
      metrics.observeInput(roomId, result.accepted, result.reason);
      return send(response, result.kick ? 403 : 200, result);
    }
    if (request.method === "POST" && url.pathname === "/ops/end") { await runtime.reset(); return send(response, 200, { status: "reset", roomId }); }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    consoleJsonLog({ level: "error", event: "request_error", roomId, server: podName, detail: { message: error instanceof Error ? error.message : String(error) } });
    return send(response, 400, { error: error instanceof Error ? error.message : "bad_request" });
  }
});
server.listen(port, () => consoleJsonLog({ level: "info", event: "room_server_listening", roomId, server: podName, detail: { port, strictMode } }));
const shutdown = async (): Promise<void> => { clearInterval(tickTimer); server.close(); await runtime.stop(); };
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
