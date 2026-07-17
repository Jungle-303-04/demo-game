import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { controlTokenMatches, readControlToken, withControlToken } from "../../control-plane-auth.js";
import {
  createRoomRegistry,
  RoomReconciler,
  type RoomRegistryRecord,
  type RoomSpec,
} from "./registry.js";
import {
  KubernetesStatefulSetScaler,
  NoopScaler,
  type ReplicaScaler,
} from "./scaler.js";

const registry = createRoomRegistry();
const reconciler = new RoomReconciler(registry);
const port = Number(process.env.PORT ?? 8082);
const controlToken = readControlToken();
const maxRooms = Number(process.env.MAX_ROOMS ?? 3);
if (!Number.isInteger(maxRooms) || maxRooms < 1) throw new Error("invalid_max_rooms");
const endpointBase = process.env.GAME_ENDPOINT_BASE ?? "http://game-";
const kubeTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const configuredKubeToken = process.env.KUBE_TOKEN?.trim() ?? "";
const kubeToken = configuredKubeToken || await readFile(kubeTokenPath, "utf8").then((value) => value.trim()).catch(() => "");
const kubeTokenProvider = async (): Promise<string> => configuredKubeToken
  || await readFile(kubeTokenPath, "utf8").then((value) => value.trim());
const scaler: ReplicaScaler = process.env.KUBERNETES_SERVICE_HOST && kubeToken
  ? new KubernetesStatefulSetScaler(
    `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`,
    process.env.NAMESPACE ?? "sandbox",
    process.env.GAME_STATEFULSET ?? "game",
    kubeTokenProvider,
  )
  : new NoopScaler();
const endpointFor = (ordinal: number) =>
  process.env.GAME_ENDPOINT_TEMPLATE?.replace("{ordinal}", String(ordinal)) ?? `${endpointBase}${ordinal}:8080`;

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
const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const activeRooms = (records: RoomRegistryRecord[]) => records.filter((room) => room.status !== "inactive");
const roomIdFrom = (path: string): string | undefined => path.match(/^\/rooms\/(room-\d+)(?:\/|$)/)?.[1];

const parseSpec = (body: Record<string, unknown>, current?: RoomSpec): RoomSpec => {
  if (body.mode !== undefined && body.mode !== "Faction 50v50") throw new Error("unsupported_game_mode");
  if (body.map !== undefined && body.map !== "Faction Island") throw new Error("unsupported_game_map");
  if (body.region !== undefined && body.region !== "Seoul / ap-northeast-2") throw new Error("unsupported_game_region");
  if (body.maxPlayers !== undefined && Number(body.maxPlayers) !== 100) throw new Error("unsupported_max_players");
  const text = (key: keyof Omit<RoomSpec, "mode" | "maxPlayers" | "createdAt">, fallback: string) => {
    const value = String(body[key] ?? fallback).trim();
    if (!value || value.length > 160) throw new Error(`invalid_${key}`);
    return value;
  };
  return {
    name: text("name", current?.name ?? "Survev Faction Room"),
    description: text("description", current?.description ?? "Survev 50:50 faction live room"),
    region: "Seoul / ap-northeast-2",
    map: "Faction Island",
    mode: "Faction 50v50",
    maxPlayers: 100,
    createdAt: current?.createdAt ?? new Date().toISOString(),
  };
};

const scaleAndReconcile = async (replicas: number) => {
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > maxRooms) throw new Error("invalid_replicas");
  await scaler.scale(replicas);
  return reconciler.reconcile(replicas, endpointFor);
};
const postGameCommand = async (endpoint: string, path: string, timeoutMs = 8_000): Promise<Record<string, unknown>> => {
  const response = await fetch(`${endpoint}${path}`, withControlToken({
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  }, controlToken));
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(String(body.error ?? `game_command_failed:${response.status}`));
  return body;
};
const scaleWithSnapshots = async (replicas: number) => {
  const active = activeRooms(await registry.list());
  if (replicas < active.length) {
    const stopping = active.filter((room) => room.ordinal >= replicas).sort((a, b) => b.ordinal - a.ordinal);
    for (const room of stopping) await postGameCommand(room.endpoint, "/ops/snapshot/save");
  }
  return scaleAndReconcile(replicas);
};
let mutationTail: Promise<void> = Promise.resolve();
const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (request.method === "GET" && path === "/healthz") return send(response, 200, { status: "ok", scalingAvailable: scaler.managed });
    if (!controlTokenMatches(request.headers.authorization, controlToken)) {
      response.setHeader("www-authenticate", 'Bearer realm="demo-game-control"');
      return send(response, 401, { error: "unauthorized" });
    }
    if (request.method === "GET" && path === "/rooms") return send(response, 200, { rooms: await registry.list(), maxRooms, scalingAvailable: scaler.managed });

    if (request.method === "POST" && path === "/rooms") {
      const replicas = Number((await readJson(request)).replicas);
      const rooms = await serializeMutation(() => scaleWithSnapshots(replicas));
      return send(response, 200, { rooms, replicas, maxRooms });
    }

    if (request.method === "POST" && path === "/rooms/create") {
      const body = await readJson(request);
      const requestedSpec = parseSpec(body);
      const room = await serializeMutation(async () => {
        const active = activeRooms(await registry.list());
        if (active.length >= maxRooms) throw new Error("room_capacity_reached");
        const rooms = await scaleAndReconcile(active.length + 1);
        const created = rooms.find((candidate) => candidate.ordinal === active.length);
        if (!created) throw new Error("room_reconcile_failed");
        const next = { ...created, spec: requestedSpec };
        await registry.put(next);
        return next;
      });
      return send(response, 201, { room, rooms: await registry.list(), maxRooms });
    }

    const roomId = roomIdFrom(path);
    const room = roomId ? await registry.get(roomId) : null;
    if (roomId && !room) return send(response, 404, { error: "room_not_found" });

    if (request.method === "PATCH" && room && path === `/rooms/${room.roomId}`) {
      const body = await readJson(request);
      const updated = await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current) throw new Error("room_not_found");
        const next = { ...current, spec: parseSpec(body, current.spec) };
        await registry.put(next);
        return next;
      });
      return send(response, 200, { room: updated });
    }

    if (request.method === "PUT" && room && path === `/rooms/${room.roomId}/join-lock`) {
      const locked = (await readJson(request)).locked;
      if (typeof locked !== "boolean") throw new Error("invalid_join_lock");
      const updated = await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current) throw new Error("room_not_found");
        const next = { ...current, joinLocked: locked };
        await registry.put(next);
        return next;
      });
      return send(response, 200, { room: updated });
    }

    if (request.method === "POST" && room && path === `/rooms/${room.roomId}/start`) {
      const updated = await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current) throw new Error("room_not_found");
        if (current.status !== "inactive") return current;
        const active = activeRooms(await registry.list());
        if (current.ordinal !== active.length) throw new Error("room_start_requires_next_ordinal");
        await scaleAndReconcile(active.length + 1);
        return registry.get(current.roomId);
      });
      return send(response, 202, { room: updated });
    }

    if (request.method === "POST" && room && path === `/rooms/${room.roomId}/stop`) {
      const updated = await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current) throw new Error("room_not_found");
        const active = activeRooms(await registry.list());
        const highest = active.at(-1);
        if (highest?.roomId !== current.roomId) throw new Error("room_stop_requires_highest_ordinal");
        await postGameCommand(current.endpoint, "/ops/snapshot/save");
        await scaleAndReconcile(current.ordinal);
        return registry.get(current.roomId);
      });
      return send(response, 202, { room: updated });
    }

    if (request.method === "DELETE" && room && path === `/rooms/${room.roomId}`) {
      await serializeMutation(async () => {
        if (!scaler.managed) throw new Error("room_scaling_requires_kubernetes");
        const current = await registry.get(room.roomId);
        if (!current) throw new Error("room_not_found");
        const active = activeRooms(await registry.list());
        const highest = active.at(-1);
        if (current.status !== "inactive" && highest?.roomId !== current.roomId) throw new Error("room_delete_requires_highest_ordinal");
        if (current.status !== "inactive") {
          // Preserve a recoverable final state until the irreversible scale
          // operation succeeds. registry.remove() clears snapshot/lease only
          // after the Pod has actually been removed.
          await postGameCommand(current.endpoint, "/ops/snapshot/save");
          await scaleAndReconcile(current.ordinal);
        }
        await registry.remove(current.roomId);
      });
      return send(response, 200, { deleted: room.roomId });
    }

    if (request.method === "POST" && room && path === `/rooms/${room.roomId}/failure`) {
      await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current || current.status === "inactive") throw new Error("room_not_running");
        await scaler.deletePod(current.podName);
        await registry.put({ ...current, status: "waiting", statusChangedAt: new Date().toISOString() });
      });
      return send(response, 202, { roomId: room.roomId, podName: room.podName, status: "recovery_requested" });
    }

    return send(response, 404, { error: "not_found" });
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
});

await registry.connect();
const persistedRooms = await registry.list();
const actualReplicas = await scaler.currentReplicas();
if (actualReplicas !== undefined) {
  if (!Number.isInteger(actualReplicas) || actualReplicas < 0 || actualReplicas > maxRooms) {
    throw new Error("actual_replicas_out_of_range");
  }
  await reconciler.reconcile(actualReplicas, endpointFor);
} else if (persistedRooms.length === 0) {
  const initialRooms = Number(process.env.INITIAL_ROOMS ?? 3);
  if (!Number.isInteger(initialRooms) || initialRooms < 0 || initialRooms > maxRooms) {
    throw new Error("invalid_initial_rooms");
  }
  await reconciler.reconcile(initialRooms, endpointFor);
}
server.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ level: "info", event: "room_orchestrator_listening", detail: { port, maxRooms } })}\n`);
});
