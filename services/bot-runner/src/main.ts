import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BotRunner, type BotMode } from "./runner.js";

const port = Number(process.env.PORT ?? 8084);
const runner = new BotRunner(process.env.ORCHESTRATOR_URL ?? "http://room-orchestrator:8082");
const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; };
const send = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (request.method === "GET" && path === "/healthz") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && path === "/bots") return send(response, 200, { bots: runner.list() });
    if (request.method === "POST" && path === "/bots/spawn") {
      const body = await readJson(request);
      const bots = await runner.spawn(Number(body.count), body.room ? String(body.room) : undefined, body.mode === "hack" ? "hack" : "normal", body.nickname ? String(body.nickname) : undefined);
      return send(response, 201, { bots: bots.map(({ timer: _timer, ...bot }) => bot) });
    }
    if (request.method === "POST" && path === "/bots/kill") { const body = await readJson(request); return send(response, 200, { killed: await runner.kill(body.sessionId ? String(body.sessionId) : undefined) }); }
    return send(response, 404, { error: "not_found" });
  } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : "bad_request" }); }
});
server.listen(port, () => process.stdout.write(`${JSON.stringify({ level: "info", event: "bot_runner_listening", detail: { port } })}\n`));
