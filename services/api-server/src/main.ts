import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { controlTokenMatches, readControlToken } from "../../control-plane-auth.js";
import { AdmissionOverloadFuse } from "./admission-overload.js";
import { HttpRoomDirectory, Matchmaker } from "./matchmaker.js";

const port = Number(process.env.PORT ?? 8081);
const log = (event: { level: string; event: string; [key: string]: unknown }) => process.stdout.write(`${JSON.stringify(event)}\n`);
const controlToken = readControlToken();
const overloadExitCode = Number.parseInt(process.env.ADMISSION_OVERLOAD_EXIT_CODE ?? "70", 10);
if (!Number.isInteger(overloadExitCode) || overloadExitCode < 1 || overloadExitCode > 255) {
  throw new Error("admission_overload_exit_code_invalid");
}
const overloadFuse = new AdmissionOverloadFuse({
  thresholdRequests: Number.parseInt(process.env.ADMISSION_OVERLOAD_THRESHOLD_REQUESTS ?? "35", 10),
  windowMs: Number.parseInt(process.env.ADMISSION_OVERLOAD_WINDOW_MS ?? "1000", 10),
  onTrip: (status) => {
    log({
      level: "error",
      event: "admission_server_overload_failure",
      detail: { ...status, exitCode: overloadExitCode, recoveryOwner: "external-service" },
    });
    const exitTimer = setTimeout(() => process.exit(overloadExitCode), 25);
    exitTimer.unref();
  },
});
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
      return send(response, 200, { status: "ok", admissionOverload: overloadFuse.status() });
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      const overload = overloadFuse.status();
      response.writeHead(200, { "content-type": matchmaker.registry.contentType });
      return response.end(`${await matchmaker.registry.metrics()}\n# TYPE admission_overload_armed gauge\nadmission_overload_armed ${overload.armed ? 1 : 0}\n# TYPE admission_overload_recent_requests gauge\nadmission_overload_recent_requests ${overload.recentRequests}\n# TYPE admission_overload_threshold_requests gauge\nadmission_overload_threshold_requests ${overload.thresholdRequests}\n`);
    }
    if (request.method === "POST" && url.pathname === "/ops/failure/admission-overload/arm") {
      if (!controlTokenMatches(request.headers.authorization, controlToken)) {
        response.setHeader("www-authenticate", "Bearer realm=\"demo-game-control\"");
        return send(response, 401, { error: "unauthorized" });
      }
      const status = overloadFuse.arm();
      log({ level: "warn", event: "admission_overload_armed", detail: status });
      return send(response, 200, status);
    }
    if (request.method === "POST" && url.pathname === "/ops/failure/admission-overload/disarm") {
      if (!controlTokenMatches(request.headers.authorization, controlToken)) {
        response.setHeader("www-authenticate", "Bearer realm=\"demo-game-control\"");
        return send(response, 401, { error: "unauthorized" });
      }
      const status = overloadFuse.disarm();
      log({ level: "info", event: "admission_overload_disarmed", detail: status });
      return send(response, 200, status);
    }
    if (request.method === "POST" && url.pathname === "/api/find-game") {
      overloadFuse.observeRequest();
      const body = await readJson(request); const sessionId = String(body.sessionId ?? ""); const nickname = String(body.nickname ?? "");
      if (!sessionId) return send(response, 400, { error: "sessionId_required" });
      const room = await matchmaker.findGame(sessionId, nickname);
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
      : message.includes("no_room") || message.includes("directory_unavailable")
        ? 503
        : 400;
    return send(response, status, { error: message });
  }
});
server.listen(port, () => log({ level: "info", event: "api_server_listening", detail: { port } }));
