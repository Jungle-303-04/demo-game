import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MemoryRoomRegistry, RoomReconciler } from "./registry.js";
import { KubernetesStatefulSetScaler, NoopScaler, type ReplicaScaler } from "./scaler.js";

const registry = new MemoryRoomRegistry();
const reconciler = new RoomReconciler(registry);
const port = Number(process.env.PORT ?? 8082);
const endpointBase = process.env.GAME_ENDPOINT_BASE ?? "http://game-";
const scaler: ReplicaScaler = process.env.KUBERNETES_SERVICE_HOST && process.env.KUBE_TOKEN
  ? new KubernetesStatefulSetScaler(`https://${process.env.KUBERNETES_SERVICE_HOST}`, process.env.NAMESPACE ?? "sandbox", process.env.GAME_STATEFULSET ?? "game", process.env.KUBE_TOKEN)
  : new NoopScaler();
const endpointFor = (ordinal: number) => process.env.GAME_ENDPOINT_TEMPLATE?.replace("{ordinal}", String(ordinal)) ?? `${endpointBase}${ordinal}:8080`;

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};
const send = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && path === "/healthz") return send(response, 200, { status: "ok" });
  if (request.method === "GET" && path === "/rooms") return send(response, 200, { rooms: await registry.list() });
  if (request.method === "POST" && path === "/rooms") {
    try {
      const replicas = Number((await readJson(request)).replicas);
      await scaler.scale(replicas);
      return send(response, 200, { rooms: await reconciler.reconcile(replicas, endpointFor), replicas });
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : "invalid_request" }); }
  }
  return send(response, 404, { error: "not_found" });
});
await reconciler.reconcile(Number(process.env.INITIAL_ROOMS ?? 3), endpointFor);
server.listen(port, () => process.stdout.write(`${JSON.stringify({ level: "info", event: "room_orchestrator_listening", detail: { port } })}\n`));
