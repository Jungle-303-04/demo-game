import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAdminRooms,
  fetchJson,
  getRegistryState,
  listRegistryRooms,
  type AdminRoom,
  type RegistryRoom,
  UpstreamError,
} from "./admin.js";
import { isPublicControlPlaneRead } from "./public-api.js";

interface TimelineEvent {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

type EventTone = "info" | "success" | "warning" | "danger";

const port = Number(process.env.PORT ?? 8085);
const orchestrator = process.env.ORCHESTRATOR_URL ?? "http://room-orchestrator:8082";
const botRunner = process.env.BOT_RUNNER_URL ?? "http://bot-runner:8084";
const webRoot = resolve(process.env.OPS_CONSOLE_WEB_ROOT ?? fileURLToPath(new URL("../web", import.meta.url)));
const adminToken = process.env.OPS_ADMIN_TOKEN?.trim() ?? "";
if (process.env.REQUIRE_ADMIN_TOKEN === "true" && !adminToken) {
  throw new Error("OPS_ADMIN_TOKEN is required when REQUIRE_ADMIN_TOKEN=true");
}
const timeline: TimelineEvent[] = [];

const tokenMatches = (request: IncomingMessage): boolean => {
  if (!adminToken) return true;
  const supplied = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const expectedBytes = Buffer.from(adminToken);
  const suppliedBytes = Buffer.from(supplied);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new UpstreamError(413, { error: "request_body_too_large" }, "request_body_too_large");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const jsonRequest = <T>(url: string, method: string, body?: Record<string, unknown>, timeoutMs?: number) =>
  fetchJson<T>(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);

const recordEvent = (
  type: string,
  roomId: string,
  source: string,
  message: string,
  tone: EventTone = "info",
  extra: Record<string, unknown> = {},
) => {
  timeline.unshift({ at: new Date().toISOString(), type, detail: { roomId, source, message, tone, ...extra } });
  timeline.splice(80);
};

const adminEvents = () => timeline.map((event, index) => ({
  id: `${event.at}-${index}`,
  roomId: String(event.detail.roomId ?? "global"),
  time: new Date(event.at).toLocaleTimeString("ko-KR", { hour12: false }),
  tone: event.detail.tone ?? "info",
  source: String(event.detail.source ?? "opsia"),
  message: String(event.detail.message ?? event.type),
}));

const roomRecord = async (roomId: string): Promise<RegistryRoom> => {
  const room = (await listRegistryRooms(orchestrator)).find((candidate) => candidate.roomId === roomId);
  if (!room) throw new UpstreamError(404, { error: "room_not_found" }, "room_not_found");
  return room;
};

const adminRoom = async (roomId: string): Promise<AdminRoom> => {
  const room = (await buildAdminRooms(orchestrator, botRunner)).find((candidate) => candidate.id === roomId);
  if (!room) throw new UpstreamError(404, { error: "room_not_found" }, "room_not_found");
  return room;
};

interface BotJobResponse {
  jobId: string;
  roomId: string;
  total: number;
  completed: number;
  intervalMs: number;
  state: "running" | "completed" | "cancelled" | "failed";
  error?: string;
}

const botJob = async (roomId: string, jobId: string): Promise<BotJobResponse> => {
  const job = await fetchJson<BotJobResponse>(`${botRunner}/bots/jobs/${encodeURIComponent(jobId)}`);
  if (job.roomId !== roomId) throw new UpstreamError(404, { error: "bot_job_not_found" }, "bot_job_not_found");
  return job;
};

const legacyRooms = async (request: IncomingMessage) => {
  const records = await listRegistryRooms(orchestrator);
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");
  const protocol = String(request.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  return Promise.all(records.filter((room) => room.status !== "inactive").map(async (room) => {
    const summary = await fetchJson<Record<string, unknown>>(`${room.endpoint}/summary`).catch(() => undefined);
    return {
      ...room,
      ...summary,
      qrUrl: `${protocol}://${host}/play/${room.roomId}/`,
    };
  }));
};

const commandRoom = async (roomId: string, command: string) => {
  const room = await roomRecord(roomId);
  switch (command) {
    case "start":
      await jsonRequest(`${orchestrator}/rooms/${roomId}/start`, "POST");
      recordEvent("ROOM_START_REQUESTED", roomId, "orchestrator", "게임 Pod 시작 요청", "info");
      return { accepted: true };
    case "stop":
      await jsonRequest(`${orchestrator}/rooms/${roomId}/stop`, "POST");
      recordEvent("ROOM_STOP_REQUESTED", roomId, "orchestrator", "snapshot 보존 후 scale-to-zero 요청", "warning");
      return { accepted: true };
    case "snapshot": {
      const result = await jsonRequest<Record<string, unknown>>(`${room.endpoint}/ops/snapshot/save`, "POST", undefined, 8_000);
      recordEvent("SNAPSHOT_SAVED", roomId, "redis", "수동 snapshot 저장 요청 완료", "success", result);
      return result;
    }
    case "inject-pod-failure": {
      const result = await jsonRequest<Record<string, unknown>>(`${orchestrator}/rooms/${roomId}/failure`, "POST");
      recordEvent("POD_FAILURE_INJECTED", roomId, "orchestrator", `${room.podName} 삭제 및 Room Recovery 시작`, "danger");
      return result;
    }
    default:
      throw new UpstreamError(400, { error: "unsupported_room_command" }, "unsupported_room_command");
  }
};

const contentType = (file: string) => ({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
}[extname(file)] ?? "application/octet-stream");

const serveWeb = async (pathname: string, response: ServerResponse) => {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let file = resolve(webRoot, relative);
  if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) return false;
  let data = await readFile(file).catch(() => undefined);
  if (!data && !extname(relative)) {
    file = resolve(webRoot, "index.html");
    data = await readFile(file).catch(() => undefined);
  }
  if (!data) return false;
  response.writeHead(200, {
    "content-type": contentType(file),
    "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  response.end(data);
  return true;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok", ui: "react", data: "live" });

    // The demo's live room directory and event stream are public read-only
    // telemetry. Every mutation and deeper operational endpoint remains
    // protected by the administrator token.
    const requiresAdmin =
      url.pathname.startsWith("/api/") &&
      !isPublicControlPlaneRead(request.method, url.pathname);
    if (requiresAdmin && !tokenMatches(request)) {
      response.setHeader("www-authenticate", 'Bearer realm="Survev Control Room"');
      return send(response, 401, { error: "admin_token_required" });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/rooms") {
      const registryState = await getRegistryState(orchestrator);
      const compact = url.searchParams.get("compact") === "1";
      const rooms = await buildAdminRooms(orchestrator, botRunner, registryState.rooms, compact);
      return send(response, 200, {
        rooms: compact
          ? rooms.map(({ mapLayout: _mapLayout, ...room }) => room)
          : rooms,
        capabilities: {
          scalingAvailable: registryState.scalingAvailable,
          maxRooms: registryState.maxRooms,
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/admin/events") {
      return send(response, 200, { events: adminEvents() });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/rooms") {
      const input = await readJson(request);
      const created = await jsonRequest<{ room: RegistryRoom }>(`${orchestrator}/rooms/create`, "POST", input);
      recordEvent("ROOM_CREATED", created.room.roomId, "orchestrator", `${created.room.spec?.name ?? created.room.roomId} 생성`, "success");
      const initialBots = Number(input.initialBots ?? 0);
      if (initialBots > 0) {
        void (async () => {
          for (let attempt = 0; attempt < 20; attempt++) {
            const summary = await fetchJson(`${created.room.endpoint}/summary`, undefined, 750).catch(() => undefined);
            if (summary) {
              await jsonRequest(`${botRunner}/bots/jobs`, "POST", { room: created.room.roomId, count: initialBots, intervalMs: 300, mode: "normal" }).catch(() => undefined);
              return;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
          }
        })();
      }
      return send(response, 201, { room: await adminRoom(created.room.roomId) });
    }

    const roomMatch = url.pathname.match(/^\/api\/admin\/rooms\/(room-\d+)$/);
    if (roomMatch && request.method === "PATCH") {
      const roomId = roomMatch[1]!;
      const input = await readJson(request);
      await jsonRequest(`${orchestrator}/rooms/${roomId}`, "PATCH", input);
      recordEvent("ROOM_UPDATED", roomId, "admin", "방 설정 저장 완료", "success");
      return send(response, 200, { room: await adminRoom(roomId) });
    }
    if (roomMatch && request.method === "DELETE") {
      const roomId = roomMatch[1]!;
      await jsonRequest(`${orchestrator}/rooms/${roomId}`, "DELETE");
      recordEvent("ROOM_DELETED", roomId, "orchestrator", "게임 방과 registry 레코드 삭제", "warning");
      return send(response, 200, { deleted: roomId });
    }

    const commandMatch = url.pathname.match(/^\/api\/admin\/rooms\/(room-\d+)\/commands$/);
    if (commandMatch && request.method === "POST") {
      const body = await readJson(request);
      return send(response, 202, await commandRoom(commandMatch[1]!, String(body.command ?? "")));
    }

    const botsMatch = url.pathname.match(/^\/api\/admin\/rooms\/(room-\d+)\/bots$/);
    if (botsMatch && request.method === "POST") {
      const roomId = botsMatch[1]!;
      const body = await readJson(request);
      const job = await jsonRequest<{ jobId: string; total: number }>(`${botRunner}/bots/jobs`, "POST", {
        room: roomId,
        count: Number(body.count),
        intervalMs: Number(body.intervalMs ?? 300),
        mode: body.mode === "hack" ? "hack" : "normal",
      });
      recordEvent("BOT_LOAD_STARTED", roomId, "load-generator", `LoadBot ${job.total}명 투입 시작`, "info", { jobId: job.jobId });
      return send(response, 202, { jobId: job.jobId, accepted: job.total });
    }
    if (botsMatch && request.method === "DELETE") {
      const roomId = botsMatch[1]!;
      const result = await jsonRequest<{ killed: number }>(`${botRunner}/bots/kill`, "POST", { room: roomId });
      recordEvent("BOTS_REMOVED", roomId, "load-generator", `LoadBot ${result.killed}명 연결 종료`, "warning");
      return send(response, 200, result);
    }

    const jobMatch = url.pathname.match(/^\/api\/admin\/rooms\/(room-\d+)\/bot-jobs\/([^/]+)$/);
    if (jobMatch && request.method === "GET") {
      return send(response, 200, await botJob(jobMatch[1]!, jobMatch[2]!));
    }
    const cancelJobMatch = url.pathname.match(/^\/api\/admin\/rooms\/(room-\d+)\/bot-jobs\/([^/]+)\/cancel$/);
    if (cancelJobMatch && request.method === "POST") {
      await botJob(cancelJobMatch[1]!, cancelJobMatch[2]!);
      const result = await jsonRequest<Record<string, unknown>>(`${botRunner}/bots/jobs/${encodeURIComponent(cancelJobMatch[2]!)}/cancel`, "POST");
      recordEvent("BOT_LOAD_CANCELLED", cancelJobMatch[1]!, "load-generator", "LoadBot ramp-up 취소", "warning");
      return send(response, 200, result);
    }

    const joinLockMatch = url.pathname.match(/^\/api\/admin\/rooms\/(room-\d+)\/join-lock$/);
    if (joinLockMatch && request.method === "PUT") {
      const roomId = joinLockMatch[1]!;
      const room = await roomRecord(roomId);
      const locked = (await readJson(request)).locked === true;
      await jsonRequest(`${orchestrator}/rooms/${roomId}/join-lock`, "PUT", { locked });
      let liveResult: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 3 && !liveResult; attempt += 1) {
        liveResult = await jsonRequest<Record<string, unknown>>(`${room.endpoint}/ops/join-lock/${locked}`, "POST", undefined, 2_000).catch(() => undefined);
        if (!liveResult && attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      recordEvent(
        "JOIN_LOCK_CHANGED",
        roomId,
        "admin",
        locked ? "신규 플레이어 입장 잠금" : "신규 플레이어 입장 허용",
        locked ? "warning" : "success",
        { appliedToLivePod: Boolean(liveResult), enforcement: "redis-on-admission" },
      );
      return send(response, liveResult ? 200 : 202, { roomId, locked, appliedToLivePod: Boolean(liveResult), enforcement: "redis-on-admission" });
    }

    // Backwards-compatible endpoints used by the existing scripts and tests.
    if (request.method === "GET" && url.pathname === "/api/rooms") {
      return send(response, 200, { rooms: await legacyRooms(request) });
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return send(response, 200, await jsonRequest(`${orchestrator}/rooms`, "POST", await readJson(request)));
    }
    const end = url.pathname.match(/^\/api\/rooms\/(room-\d+)\/end$/);
    if (request.method === "POST" && end) return send(response, 200, await commandRoom(end[1]!, "snapshot").then(async () => {
      const room = await roomRecord(end[1]!);
      const result = await jsonRequest<Record<string, unknown>>(`${room.endpoint}/ops/end`, "POST", undefined, 8_000);
      recordEvent("ROOM_RESET", room.roomId, "game-server", "논리적 방 초기화 완료", "warning");
      return result;
    }));
    if (request.method === "POST" && url.pathname === "/api/bots/spawn") return send(response, 201, await jsonRequest(`${botRunner}/bots/spawn`, "POST", await readJson(request), 30_000));
    if (request.method === "POST" && url.pathname === "/api/bots/kill") return send(response, 200, await jsonRequest(`${botRunner}/bots/kill`, "POST", await readJson(request)));
    if (request.method === "GET" && url.pathname === "/api/bots") return send(response, 200, await fetchJson(`${botRunner}/bots`));
    const snapshot = url.pathname.match(/^\/api\/ops\/snapshot\/(room-\d+)$/);
    if (request.method === "GET" && snapshot) {
      const room = await roomRecord(snapshot[1]!);
      return send(response, 200, await fetchJson(`${room.endpoint}/ops/snapshot`));
    }
    if (request.method === "POST" && url.pathname === "/api/ops/events") {
      const body = await readJson(request);
      const type = String(body.type ?? "");
      if (!type) return send(response, 400, { error: "event_type_required" });
      timeline.unshift({ at: new Date().toISOString(), type, detail: body });
      timeline.splice(80);
      return send(response, 202, { accepted: true });
    }
    if (request.method === "GET" && url.pathname === "/api/timeline") return send(response, 200, { events: timeline });

    if (request.method === "GET" && await serveWeb(url.pathname, response)) return;
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof UpstreamError) return send(response, error.status, error.body);
    return send(response, 502, { error: error instanceof Error ? error.message : "upstream_error" });
  }
});

server.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ level: "info", event: "ops_console_listening", detail: { port, ui: "react", data: "live" } })}\n`);
});
