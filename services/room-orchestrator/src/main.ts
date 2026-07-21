import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { controlTokenMatches, readControlToken, withControlToken } from "../../control-plane-auth.js";
import { GAME_MAPS, GAME_MODES, ROOM_PROFILES } from "../../room-profiles.js";
import {
  HttpOperationEventTransport,
  MemoryOperationEventTransport,
  OperationEventPublisher,
  OutboxOperationEventTransport,
  RedisOperationEventTransport,
  type GameOperationEvent,
  type ReadableOperationEventTransport,
} from "./events.js";
import {
  CANARY_ROOM_ID,
  CanaryValidationCoordinator,
  HttpBotValidationStarter,
  HttpCanaryMetricsSource,
  type CanaryValidationResult,
} from "./canary.js";
import { KubernetesCanaryRollout } from "./canary-rollout.js";
import { KubernetesApiCanaryObservationSource } from "./kubernetes-canary.js";
import { KubernetesRoomHandoffDriver } from "./handoff-driver.js";
import { RoomHandoffCoordinator, type RoomHandoffResult } from "./handoff.js";
import {
  ReleaseOperationGate,
  sealedCanaryApprovalForRevision,
  type SealedCanaryApproval,
} from "./release-control.js";
import {
  createRoomRegistry,
  RoomReconciler,
  specForOrdinal,
  type RoomRegistryRecord,
  type RoomSpec,
} from "./registry.js";
import {
  KubernetesRoomDeploymentScaler,
  NoopScaler,
  type ReplicaScaler,
} from "./scaler.js";

const registry = createRoomRegistry();
const reconciler = new RoomReconciler(registry);
const port = Number(process.env.PORT ?? 8082);
const controlToken = readControlToken();
const maxRooms = Number(process.env.MAX_ROOMS ?? ROOM_PROFILES.length);
if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > ROOM_PROFILES.length) throw new Error("invalid_max_rooms");
const desiredRoomIds = (process.env.DESIRED_ROOM_PROFILES
  ?? ROOM_PROFILES.map((_, ordinal) => `room-${ordinal}`).join(","))
  .split(",")
  .map((roomId) => roomId.trim())
  .filter(Boolean);
if (desiredRoomIds.length !== maxRooms
  || desiredRoomIds.some((roomId, ordinal) => roomId !== `room-${ordinal}`)) {
  throw new Error("invalid_desired_room_profiles");
}
const endpointBase = process.env.GAME_ENDPOINT_BASE ?? "http://game-room-";
const kubeTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const configuredKubeToken = process.env.KUBE_TOKEN?.trim() ?? "";
const kubeToken = configuredKubeToken || await readFile(kubeTokenPath, "utf8").then((value) => value.trim()).catch(() => "");
const kubeTokenProvider = async (): Promise<string> => configuredKubeToken
  || await readFile(kubeTokenPath, "utf8").then((value) => value.trim());
const kubernetesApiServer = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`
  : "";
const scaler: ReplicaScaler = kubernetesApiServer && kubeToken
  ? new KubernetesRoomDeploymentScaler(
    kubernetesApiServer,
    process.env.NAMESPACE ?? "sandbox",
    process.env.GAME_DEPLOYMENT_PREFIX ?? "game-room",
    maxRooms,
    kubeTokenProvider,
  )
  : new NoopScaler();
const eventAuthority: ReadableOperationEventTransport = process.env.REDIS_URL
  ? new RedisOperationEventTransport(process.env.REDIS_URL)
  : new MemoryOperationEventTransport();
const opsiaWorkspaceId = process.env.OPSIA_WORKSPACE_ID?.trim() || "demo-game";
const opsiaClusterId = process.env.OPSIA_CLUSTER_ID?.trim() || "game-server";
const opsiaApplicationId = process.env.OPSIA_APPLICATION_ID?.trim() || "demo-game";
const opsiaEventEndpoint = process.env.OPSIA_EVENT_ENDPOINT?.trim() ?? "";
const opsiaEventRelay = opsiaEventEndpoint
  ? new HttpOperationEventTransport(opsiaEventEndpoint, process.env.OPSIA_AGENT_TOKEN?.trim())
  : undefined;
const eventOutbox = opsiaEventRelay
  ? new OutboxOperationEventTransport(eventAuthority, opsiaEventRelay)
  : undefined;
const handoffEvents = new OperationEventPublisher(eventOutbox ?? eventAuthority);
const handoffDriver = kubernetesApiServer && kubeToken
  ? new KubernetesRoomHandoffDriver({
    apiServer: kubernetesApiServer,
    namespace: process.env.NAMESPACE ?? "sandbox",
    deploymentPrefix: process.env.GAME_DEPLOYMENT_PREFIX ?? "game-room",
    roomCount: maxRooms,
    token: kubeTokenProvider,
    controlToken,
    gatewayEndpoint: process.env.SESSION_GATEWAY_INTERNAL_URL ?? "http://session-gateway:8083",
    gameImageRepository: process.env.GAME_IMAGE_REPOSITORY,
  })
  : undefined;
const handoffCoordinator = handoffDriver
  ? new RoomHandoffCoordinator(
    handoffDriver,
    handoffEvents,
    opsiaWorkspaceId,
    opsiaClusterId,
    process.env.NAMESPACE ?? "sandbox",
    maxRooms,
  )
  : undefined;
const canaryRollout = kubernetesApiServer && kubeToken
  ? new KubernetesCanaryRollout({
    apiServer: kubernetesApiServer,
    namespace: process.env.NAMESPACE ?? "sandbox",
    token: kubeTokenProvider,
    gameImageRepository: process.env.GAME_IMAGE_REPOSITORY,
    endpoint: process.env.CANARY_GAME_ENDPOINT ?? "http://canary-room:8001",
  })
  : undefined;
const canaryCoordinator = canaryRollout && kubernetesApiServer && controlToken
  ? new CanaryValidationCoordinator({
    events: handoffEvents,
    metrics: new HttpCanaryMetricsSource(),
    kubernetes: new KubernetesApiCanaryObservationSource(kubernetesApiServer, kubeTokenProvider),
    bots: new HttpBotValidationStarter(
      process.env.CANARY_BOT_RUNNER_URL ?? "http://canary-validation-bot:8084",
      controlToken,
    ),
  }, {}, undefined, opsiaWorkspaceId, opsiaClusterId, process.env.NAMESPACE ?? "sandbox")
  : undefined;

type HandoffOperationStatus = "queued" | "running" | "completed" | "failed";
interface HandoffOperationState {
  operationId: string;
  roomId: string;
  revision: string;
  status: HandoffOperationStatus;
  startedAt: string;
  updatedAt: string;
  lastEvent?: string;
  error?: string;
  result?: RoomHandoffResult;
}
interface FleetRolloutOperationState {
  operationId: string;
  revision: string;
  status: HandoffOperationStatus;
  startedAt: string;
  updatedAt: string;
  currentRoomId?: string;
  completedRooms: string[];
  results: RoomHandoffResult[];
  lastEvent?: string;
  error?: string;
}
const handoffOperations = new Map<string, HandoffOperationState>();
const fleetRolloutOperations = new Map<string, FleetRolloutOperationState>();
const latestHandoffByRoom = new Map<string, string>();
let activeHandoffOperation: string | undefined;
type CanaryOperationStatus = "queued" | "running" | "approved" | "blocked" | "failed";
interface CanaryOperationState {
  operationId: string;
  canaryId: string;
  revision: string;
  status: CanaryOperationStatus;
  startedAt: string;
  updatedAt: string;
  lastEvent?: string;
  error?: string;
  result?: CanaryValidationResult;
}
const canaryOperations = new Map<string, CanaryOperationState>();
const releaseOperationGate = new ReleaseOperationGate();
let activeCanaryOperation: string | undefined;
handoffEvents.subscribe((event: GameOperationEvent) => {
  const state = handoffOperations.get(event.correlation_id);
  if (state) {
    state.lastEvent = event.subject;
    state.updatedAt = event.created_at;
    if (event.subject === "RolloutWaveStarted") state.status = "running";
    if (event.subject === "RolloutWaveCompleted") state.status = "completed";
    if (event.subject === "RolloutWaveBlocked" || event.subject === "RoomHandoffFailed") state.status = "failed";
  }
  const rollout = fleetRolloutOperations.get(event.correlation_id);
  if (rollout) {
    rollout.lastEvent = event.subject;
    rollout.updatedAt = event.created_at;
    if (event.subject === "RolloutWaveStarted") rollout.status = "running";
    if (event.subject === "RolloutWaveBlocked" || event.subject === "RoomHandoffFailed") {
      rollout.status = "failed";
    }
    if (event.subject === "PostVerificationCompleted" && event.payload.passed === true) {
      rollout.status = "completed";
    }
  }
  const canary = canaryOperations.get(event.correlation_id);
  if (canary) {
    canary.lastEvent = event.subject;
    canary.updatedAt = event.created_at;
    if (event.subject === "CanaryScheduled") canary.status = "running";
    // A promotion decision is not terminal. The async validation promise only
    // updates status after EvidenceBundleSealed has persisted successfully.
  }
});
const endpointFor = (ordinal: number) =>
  process.env.GAME_ENDPOINT_TEMPLATE?.replace("{ordinal}", String(ordinal)) ?? `${endpointBase}${ordinal}:8001`;
const workloadNameFor = (ordinal: number) =>
  process.env.GAME_WORKLOAD_NAME_TEMPLATE?.replace("{ordinal}", String(ordinal)) ?? `game-room-${ordinal}`;

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
const latestPersistedHandoffForRoom = async (roomId: string): Promise<string | undefined> => {
  const events = await eventAuthority.readRetained();
  return events.filter((event) => event.payload.room_id === roomId).at(-1)?.correlation_id;
};
const latestPersistedCanaryOperation = async (): Promise<string | undefined> => {
  const events = await eventAuthority.readRetained();
  return events.filter((event) => event.payload.room_id === CANARY_ROOM_ID).at(-1)?.correlation_id;
};
const latestPersistedFleetRollout = async (): Promise<string | undefined> => {
  const events = await eventAuthority.readRetained();
  return events.filter((event) => event.subject === "PostVerificationCompleted"
    || (event.subject.startsWith("RolloutWave") && typeof event.payload.room_id === "string"))
    .at(-1)?.correlation_id;
};
const canaryRevisionApproval = async (revision: string): Promise<SealedCanaryApproval | undefined> =>
  sealedCanaryApprovalForRevision(await eventAuthority.readRetained(), revision);

const validateSpecFields = (body: Record<string, unknown>): void => {
  if (body.mode !== undefined && !GAME_MODES.some((mode) => mode === body.mode)) throw new Error("unsupported_game_mode");
  if (body.map !== undefined && !GAME_MAPS.some((map) => map === body.map)) throw new Error("unsupported_game_map");
  if (body.region !== undefined && body.region !== "Seoul / ap-northeast-2") throw new Error("unsupported_game_region");
  if (body.maxPlayers !== undefined && ![80, 100].includes(Number(body.maxPlayers))) throw new Error("unsupported_max_players");
};

const parseSpec = (body: Record<string, unknown>, ordinal: number, current?: RoomSpec): RoomSpec => {
  validateSpecFields(body);
  const canonical = specForOrdinal(ordinal, current);
  if (body.mode !== undefined && body.mode !== canonical.mode) throw new Error("unsupported_game_mode");
  if (body.map !== undefined && body.map !== canonical.map) throw new Error("unsupported_game_map");
  if (body.maxPlayers !== undefined && Number(body.maxPlayers) !== canonical.maxPlayers) {
    throw new Error("unsupported_max_players");
  }
  const text = (key: "name" | "description", fallback: string) => {
    const value = String(body[key] ?? fallback).trim();
    if (!value || value.length > 160) throw new Error(`invalid_${key}`);
    return value;
  };
  return {
    ...canonical,
    name: text("name", canonical.name),
    description: text("description", canonical.description),
  };
};

const scaleAndReconcile = async (replicas: number) => {
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > maxRooms) throw new Error("invalid_replicas");
  await scaler.scale(replicas);
  return reconciler.reconcile(replicas, endpointFor, workloadNameFor);
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

    if (request.method === "POST" && path === "/canary/validate") {
      if (!canaryRollout || !canaryCoordinator) throw new Error("canary_validation_requires_kubernetes");
      const body = await readJson(request);
      const revision = String(body.revision ?? "").trim();
      if (!revision) throw new Error("game_revision_required");
      const operationId = String(body.operationId ?? `op_${randomUUID()}`).trim();
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(operationId)) throw new Error("invalid_operation_id");
      const optionalId = (key: "workflowRunId" | "applicationId"): string | undefined => {
        if (body[key] === undefined) return undefined;
        const value = String(body[key]).trim();
        if (!value || value.length > 160) throw new Error(`invalid_${key}`);
        return value;
      };
      const reservation = await releaseOperationGate.reserve("canary", operationId, async () =>
        canaryOperations.has(operationId)
        || fleetRolloutOperations.has(operationId)
        || handoffOperations.has(operationId)
        || (await eventAuthority.read({ operationId, limit: 1 })).length > 0);
      activeCanaryOperation = operationId;
      const canaryId = `canary-${randomUUID()}`;
      let target;
      try {
        target = await canaryRollout.schedule({
          canaryId,
          revision,
          workflowRunId: optionalId("workflowRunId"),
          applicationId: optionalId("applicationId"),
        });
      } catch (error) {
        activeCanaryOperation = undefined;
        reservation.abort();
        throw error;
      }
      const now = new Date().toISOString();
      const operation: CanaryOperationState = {
        operationId,
        canaryId,
        revision,
        status: "queued",
        startedAt: now,
        updatedAt: now,
      };
      canaryOperations.set(operationId, operation);
      try {
        await handoffEvents.publish({
          operationId,
          workspaceId: opsiaWorkspaceId,
          workflowRunId: target.workflowRunId ?? operationId,
          applicationId: target.applicationId ?? opsiaApplicationId,
        }, "ReleasePolicyEvaluated", {
          workflow_run_id: target.workflowRunId ?? operationId,
          application_id: target.applicationId ?? opsiaApplicationId,
          cluster_id: opsiaClusterId,
          namespace: process.env.NAMESPACE ?? "sandbox",
          git_revision: revision,
          room_id: CANARY_ROOM_ID,
          policy_name: "isolated_canary_before_live",
          decision: "allowed",
          status: "completed",
          details: {
            public_matchmaking: false,
            redis_database: 1,
            redis_key_prefix: `room:${CANARY_ROOM_ID}:`,
          },
        });
      } catch (error) {
        canaryOperations.delete(operationId);
        activeCanaryOperation = undefined;
        reservation.abort();
        throw error;
      }
      void canaryCoordinator.validate(target, operationId).then((result) => {
        operation.result = result;
        operation.status = result.approved ? "approved" : "blocked";
        operation.updatedAt = new Date().toISOString();
      }).catch((error) => {
        operation.status = "failed";
        operation.error = error instanceof Error ? error.message : "canary_validation_failed";
        operation.updatedAt = new Date().toISOString();
      }).finally(() => {
        if (activeCanaryOperation === operationId) activeCanaryOperation = undefined;
        reservation.release();
      });
      return send(response, 202, { operation });
    }

    if (request.method === "GET" && path === "/canary/status") {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const operationId = query.get("operationId") ?? activeCanaryOperation ?? await latestPersistedCanaryOperation();
      if (!operationId) return send(response, 404, { error: "canary_operation_not_found" });
      const operation = canaryOperations.get(operationId);
      const events = await eventAuthority.read({ operationId, limit: 500 });
      if (!operation && events.length === 0) return send(response, 404, { error: "canary_operation_not_found" });
      const last = events.at(-1);
      const persistedRevision = events.find((event) => typeof event.payload.git_revision === "string")
        ?.payload.git_revision;
      const persistedStatus: CanaryOperationStatus = typeof persistedRevision === "string"
        && sealedCanaryApprovalForRevision(events, persistedRevision)
        ? "approved"
        : events.some((event) => event.subject === "PromotionBlocked") ? "blocked" : "running";
      return send(response, 200, {
        operation: operation ?? {
          operationId,
          revision: persistedRevision,
          status: persistedStatus,
          lastEvent: last?.subject,
          updatedAt: last?.created_at,
        },
        eventRelay: eventOutbox?.status() ?? { configured: false },
      });
    }

    if (request.method === "GET" && path === "/canary/events") {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const operationId = query.get("operationId") ?? activeCanaryOperation ?? await latestPersistedCanaryOperation();
      if (!operationId) return send(response, 404, { error: "canary_operation_not_found" });
      const afterSequence = Number(query.get("after") ?? 0);
      const limit = Number(query.get("limit") ?? 200);
      const events = (await eventAuthority.read({ operationId, afterSequence, limit }))
        .filter((event) => event.payload.room_id === CANARY_ROOM_ID);
      return send(response, 200, {
        operationId,
        roomId: CANARY_ROOM_ID,
        events,
        nextCursor: events.at(-1)?.sequence ?? afterSequence,
      });
    }

    if (request.method === "POST" && path === "/rollouts/handoff") {
      if (!handoffDriver || !handoffCoordinator) throw new Error("room_handoff_requires_kubernetes");
      const body = await readJson(request);
      const revision = String(body.revision ?? "").trim();
      if (!revision) throw new Error("game_revision_required");
      const operationId = String(body.operationId ?? `op_${randomUUID()}`).trim();
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(operationId)) throw new Error("invalid_operation_id");
      const optionalId = (key: "workflowRunId" | "applicationId"): string | undefined => {
        if (body[key] === undefined) return undefined;
        const value = String(body[key]).trim();
        if (!value || value.length > 160) throw new Error(`invalid_${key}`);
        return value;
      };
      const workflowRunId = optionalId("workflowRunId") ?? operationId;
      const applicationId = optionalId("applicationId") ?? opsiaApplicationId;
      const reservation = await releaseOperationGate.reserve("handoff", operationId, async () =>
        canaryOperations.has(operationId)
        || fleetRolloutOperations.has(operationId)
        || handoffOperations.has(operationId)
        || (await eventAuthority.read({ operationId, limit: 1 })).length > 0);
      activeHandoffOperation = operationId;
      let approval: SealedCanaryApproval | undefined;
      let rooms: RoomRegistryRecord[];
      try {
        approval = process.env.REQUIRE_CANARY_APPROVAL !== "false"
          ? await canaryRevisionApproval(revision)
          : undefined;
        if (process.env.REQUIRE_CANARY_APPROVAL !== "false" && !approval) {
          throw new Error("canary_approval_required_for_revision");
        }
        rooms = activeRooms(await registry.list()).sort((left, right) => left.ordinal - right.ordinal);
        if (rooms.length !== maxRooms || rooms.some((room, index) => room.roomId !== `room-${index}`)) {
          throw new Error("all_game_rooms_must_be_active_for_rollout");
        }
      } catch (error) {
        activeHandoffOperation = undefined;
        reservation.abort();
        throw error;
      }
      const now = new Date().toISOString();
      const operation: FleetRolloutOperationState = {
        operationId,
        revision,
        status: "queued",
        startedAt: now,
        updatedAt: now,
        completedRooms: [],
        results: [],
      };
      fleetRolloutOperations.set(operationId, operation);
      void (async () => {
        try {
          for (const roomRecord of rooms) {
            operation.currentRoomId = roomRecord.roomId;
            operation.updatedAt = new Date().toISOString();
            const target = await handoffDriver.resolveTarget({
              roomId: roomRecord.roomId,
              revision,
              ...(approval ? { imageDigest: approval.imageDigest } : {}),
              workflowRunId,
              applicationId,
            });
            const result = await handoffCoordinator.handoff(target, operationId);
            operation.results.push(result);
            operation.completedRooms.push(roomRecord.roomId);
          }
          operation.currentRoomId = undefined;
          await handoffEvents.publish({
            operationId,
            workspaceId: opsiaWorkspaceId,
            workflowRunId,
            applicationId,
          }, "PostVerificationCompleted", {
            workflow_run_id: workflowRunId,
            application_id: applicationId,
            cluster_id: opsiaClusterId,
            namespace: process.env.NAMESPACE ?? "sandbox",
            git_revision: revision,
            status: "completed",
            passed: true,
            checks: [
              "five_room_wave_completed",
              "room_state_checksums_matched",
              "session_gateway_continuity_verified",
              "old_pods_drained",
            ],
            details: {
              ...(approval ? {
                canary_operation_id: approval.operationId,
                canary_evidence_bundle_id: approval.bundleId,
                image_digest: approval.imageDigest,
              } : {}),
              completed_rooms: [...operation.completedRooms],
              room_results: operation.results.map((result) => ({
                room_id: result.roomId,
                room_epoch: result.newEpoch,
                state_checksum: result.checksum,
                sessions: result.sessions,
                replayed_inputs: result.replayedInputs,
                candidate_uid: result.candidate.uid,
              })),
            },
          });
          operation.status = "completed";
          operation.updatedAt = new Date().toISOString();
        } catch (error) {
          operation.status = "failed";
          operation.error = error instanceof Error ? error.message : "fleet_handoff_failed";
          operation.updatedAt = new Date().toISOString();
        } finally {
          if (activeHandoffOperation === operationId) activeHandoffOperation = undefined;
          reservation.release();
        }
      })();
      return send(response, 202, { operation });
    }

    if (request.method === "GET" && path === "/rollouts/handoff/status") {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const operationId = query.get("operationId") ?? activeHandoffOperation ?? await latestPersistedFleetRollout();
      if (!operationId) return send(response, 404, { error: "rollout_operation_not_found" });
      const operation = fleetRolloutOperations.get(operationId);
      const events = await eventAuthority.read({ operationId, limit: 500 });
      if (!operation && events.length === 0) return send(response, 404, { error: "rollout_operation_not_found" });
      const last = events.at(-1);
      return send(response, 200, {
        operation: operation ?? {
          operationId,
          revision: events.find((event) => typeof event.payload.git_revision === "string")?.payload.git_revision,
          status: last?.subject === "PostVerificationCompleted" && last.payload.passed === true
            ? "completed"
            : events.some((event) => event.subject === "RolloutWaveBlocked") ? "failed" : "running",
          lastEvent: last?.subject,
          updatedAt: last?.created_at,
        },
      });
    }

    if (request.method === "GET" && path === "/rollouts/handoff/events") {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const operationId = query.get("operationId") ?? activeHandoffOperation ?? await latestPersistedFleetRollout();
      if (!operationId) return send(response, 404, { error: "rollout_operation_not_found" });
      const afterSequence = Number(query.get("after") ?? 0);
      const limit = Number(query.get("limit") ?? 200);
      const events = await eventAuthority.read({ operationId, afterSequence, limit });
      return send(response, 200, {
        operationId,
        events,
        nextCursor: events.at(-1)?.sequence ?? afterSequence,
      });
    }

    if (request.method === "GET" && path === "/rooms") return send(response, 200, {
      rooms: await registry.list(),
      maxRooms,
      desiredRoomIds,
      scalingAvailable: scaler.managed,
    });

    if (request.method === "POST" && path === "/rooms") {
      const replicas = Number((await readJson(request)).replicas);
      const rooms = await serializeMutation(() => scaleWithSnapshots(replicas));
      return send(response, 200, { rooms, replicas, maxRooms });
    }

    if (request.method === "POST" && path === "/rooms/create") {
      const body = await readJson(request);
      validateSpecFields(body);
      const room = await serializeMutation(async () => {
        const active = activeRooms(await registry.list());
        if (active.length >= maxRooms) throw new Error("room_capacity_reached");
        const requestedSpec = parseSpec(body, active.length);
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

    if (request.method === "POST" && room && path === `/rooms/${room.roomId}/handoff`) {
      if (!handoffDriver || !handoffCoordinator) throw new Error("room_handoff_requires_kubernetes");
      if (room.status === "inactive") throw new Error("room_not_running");
      const body = await readJson(request);
      const revision = String(body.revision ?? "").trim();
      if (!revision) throw new Error("game_revision_required");
      const operationId = String(body.operationId ?? `op_${randomUUID()}`).trim();
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(operationId)) throw new Error("invalid_operation_id");
      const optionalId = (key: "workflowRunId" | "applicationId"): string | undefined => {
        if (body[key] === undefined) return undefined;
        const value = String(body[key]).trim();
        if (!value || value.length > 160) throw new Error(`invalid_${key}`);
        return value;
      };
      const reservation = await releaseOperationGate.reserve("handoff", operationId, async () =>
        canaryOperations.has(operationId)
        || fleetRolloutOperations.has(operationId)
        || handoffOperations.has(operationId)
        || (await eventAuthority.read({ operationId, limit: 1 })).length > 0);
      activeHandoffOperation = operationId;
      let approval: SealedCanaryApproval | undefined;
      let target;
      try {
        approval = process.env.REQUIRE_CANARY_APPROVAL !== "false"
          ? await canaryRevisionApproval(revision)
          : undefined;
        if (process.env.REQUIRE_CANARY_APPROVAL !== "false" && !approval) {
          throw new Error("canary_approval_required_for_revision");
        }
        target = await handoffDriver.resolveTarget({
          roomId: room.roomId,
          revision,
          ...(approval ? { imageDigest: approval.imageDigest } : {}),
          workflowRunId: optionalId("workflowRunId"),
          applicationId: optionalId("applicationId"),
        });
      } catch (error) {
        activeHandoffOperation = undefined;
        reservation.abort();
        throw error;
      }
      const now = new Date().toISOString();
      const operation: HandoffOperationState = {
        operationId,
        roomId: room.roomId,
        revision,
        status: "queued",
        startedAt: now,
        updatedAt: now,
      };
      handoffOperations.set(operationId, operation);
      latestHandoffByRoom.set(room.roomId, operationId);
      void handoffCoordinator.handoff(target, operationId).then((result) => {
        operation.status = "completed";
        operation.result = result;
        operation.updatedAt = new Date().toISOString();
      }).catch((error) => {
        operation.status = "failed";
        operation.error = error instanceof Error ? error.message : "room_handoff_failed";
        operation.updatedAt = new Date().toISOString();
      }).finally(() => {
        if (activeHandoffOperation === operationId) activeHandoffOperation = undefined;
        reservation.release();
      });
      return send(response, 202, { operation });
    }

    if (request.method === "GET" && room && path === `/rooms/${room.roomId}/handoff/status`) {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const operationId = query.get("operationId")
        ?? latestHandoffByRoom.get(room.roomId)
        ?? await latestPersistedHandoffForRoom(room.roomId);
      if (!operationId) return send(response, 404, { error: "handoff_operation_not_found" });
      const operation = handoffOperations.get(operationId);
      if (operation && operation.roomId !== room.roomId) return send(response, 404, { error: "handoff_operation_not_found" });
      const events = await eventAuthority.read({ operationId, limit: 1 });
      if (!operation && events.length === 0) return send(response, 404, { error: "handoff_operation_not_found" });
      return send(response, 200, {
        operation: operation ?? {
          operationId,
          roomId: room.roomId,
          status: events.at(-1)?.subject === "RolloutWaveCompleted" ? "completed"
            : events.at(-1)?.subject === "RolloutWaveBlocked" ? "failed" : "running",
          lastEvent: events.at(-1)?.subject,
          updatedAt: events.at(-1)?.created_at,
        },
      });
    }

    if (request.method === "GET" && room && path === `/rooms/${room.roomId}/handoff/events`) {
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const operationId = query.get("operationId")
        ?? latestHandoffByRoom.get(room.roomId)
        ?? await latestPersistedHandoffForRoom(room.roomId);
      if (!operationId) return send(response, 404, { error: "handoff_operation_not_found" });
      const afterSequence = Number(query.get("after") ?? 0);
      const limit = Number(query.get("limit") ?? 200);
      const events = (await eventAuthority.read({ operationId, afterSequence, limit }))
        .filter((event) => event.payload.room_id === room.roomId);
      return send(response, 200, {
        operationId,
        roomId: room.roomId,
        events,
        nextCursor: events.at(-1)?.sequence ?? afterSequence,
      });
    }

    if (request.method === "PATCH" && room && path === `/rooms/${room.roomId}`) {
      const body = await readJson(request);
      const updated = await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current) throw new Error("room_not_found");
        const next = { ...current, spec: parseSpec(body, current.ordinal, current.spec) };
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
        if (!scaler.managed) throw new Error("room_scaling_requires_kubernetes");
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
      const currentPodName = await serializeMutation(async () => {
        const current = await registry.get(room.roomId);
        if (!current || current.status === "inactive") throw new Error("room_not_running");
        const deletedPodName = await scaler.deletePod(current.roomId);
        await registry.put({ ...current, status: "waiting", statusChangedAt: new Date().toISOString() });
        return deletedPodName;
      });
      return send(response, 202, { roomId: room.roomId, currentPodName, status: "recovery_requested" });
    }

    return send(response, 404, { error: "not_found" });
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
});

await registry.connect();
if (eventOutbox) {
  // Re-deliver the complete bounded Redis retention window after restart.
  // The remote endpoint deduplicates by event_id, so an ACK lost before
  // shutdown is harmless and an outage longer than 500 events has no gap.
  eventOutbox.replay(await eventAuthority.readRetained());
}
const persistedRooms = await registry.list();
const actualReplicas = await scaler.currentReplicas();
if (actualReplicas !== undefined) {
  if (!Number.isInteger(actualReplicas) || actualReplicas < 0 || actualReplicas > maxRooms) {
    throw new Error("actual_replicas_out_of_range");
  }
  await reconciler.reconcile(actualReplicas, endpointFor, workloadNameFor);
} else if (persistedRooms.length === 0) {
  const initialRooms = Number(process.env.INITIAL_ROOMS ?? maxRooms);
  if (!Number.isInteger(initialRooms) || initialRooms < 0 || initialRooms > maxRooms) {
    throw new Error("invalid_initial_rooms");
  }
  await reconciler.reconcile(initialRooms, endpointFor, workloadNameFor);
}
server.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ level: "info", event: "room_orchestrator_listening", detail: { port, maxRooms } })}\n`);
});
