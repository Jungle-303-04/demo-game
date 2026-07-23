import { withControlToken } from "../../control-plane-auth.js";
import {
  RoomCutoverCommittedError,
  type JournalCatchUpResult,
  type PostVerificationResult,
  type RoomCandidate,
  type RoomHandoffDriver,
  type RoomHandoffTarget,
  type SnapshotSeedResult,
} from "./handoff.js";

interface KubernetesDeployment {
  metadata?: { name?: string };
  spec?: {
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec?: {
        containers?: Array<{
          name?: string;
          image?: string;
          env?: Array<{ name?: string; value?: string }>;
        }>;
      };
    };
  };
}

interface KubernetesPod {
  metadata?: {
    name?: string;
    uid?: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: { containers?: Array<{ name?: string; image?: string }> };
  status?: {
    phase?: string;
    podIP?: string;
    containerStatuses?: Array<{ name?: string; imageID?: string }>;
  };
}

interface HandoffStatus {
  role: "active" | "candidate";
  roomId: string;
  ready: boolean;
  phase: "active" | "waiting_snapshot" | "seeded" | "blocked";
  roomEpoch?: number;
  serverTick?: number;
  snapshotTick?: number;
  checksum?: string;
  caughtUp?: boolean;
  reason?: string;
}

interface GatewayVerificationStatus {
  operationId?: string;
  roomId?: string;
  epoch?: number;
  expectedSessions?: number;
  liveSessions?: number;
  upstreamSessions?: number;
  continuous?: boolean;
  reason?: string;
}

interface GatewayRoomStatus {
  rooms?: Array<{ roomId?: string; endpoint?: string; epoch?: number; revision?: string }>;
  preparations?: Array<{ operationId?: string; roomId?: string; expectedEpoch?: number }>;
  verifications?: GatewayVerificationStatus[];
  operations?: GatewayOperationStatus[];
}

interface GatewayOperationStatus {
  operationId?: string;
  roomId?: string;
  expectedEpoch?: number;
  nextEpoch?: number;
  endpoint?: string;
  status?: "preparing" | "registry_committed" | "committed" | "failed";
  sessions?: number;
  replayedInputs?: number;
  failure?: string;
  route?: { roomId?: string; endpoint?: string; epoch?: number };
  verification?: GatewayVerificationStatus;
  error?: string;
}

interface DriverContext {
  operationId: string;
  target: RoomHandoffTarget;
  candidate?: RoomCandidate;
  deploymentName: string;
  originalImage: string;
  originalRevision: string;
  originalBuildRevision: string;
  originalTemplateAnnotations: Record<string, string | undefined>;
  desiredImage: string;
  checksum?: string;
  committedEpoch?: number;
}

export interface KubernetesRoomHandoffDriverOptions {
  apiServer: string;
  namespace: string;
  deploymentPrefix: string;
  roomCount: number;
  token: string | (() => Promise<string>);
  controlToken?: string;
  gatewayEndpoint?: string;
  gameImageRepository?: string;
  gamePort?: number;
  requestTimeoutMs?: number;
  postVerificationTimeoutMs?: number;
  candidateTimeoutMs?: number;
  catchUpTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ResolveRoomHandoffTargetInput {
  roomId: string;
  revision: string;
  imageDigest?: string;
  workflowRunId?: string;
  applicationId?: string;
}

const checksumPattern = /^[a-f\d]{64}$/;
const kubernetesNamePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const imageTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const imageDigestPattern = /^sha256:[a-f\d]{64}$/;

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

const imageRevision = (image: string): string => {
  const digest = image.match(/@sha256:([a-f\d]{64})$/)?.[1];
  if (digest) return `sha256:${digest}`;
  const tail = image.slice(image.lastIndexOf("/") + 1);
  const separator = tail.lastIndexOf(":");
  return separator >= 0 ? tail.slice(separator + 1) : "unavailable";
};

const runtimeImageDigest = (imageId: string | undefined): string | undefined => {
  const digest = imageId?.match(/sha256:([a-f\d]{64})$/i)?.[1];
  return digest ? `sha256:${digest.toLowerCase()}` : undefined;
};

const endpointForPodIp = (podIp: string, port: number): string =>
  `http://${podIp.includes(":") ? `[${podIp}]` : podIp}:${port}`;

const errorMessage = (body: unknown, fallback: string): string => {
  if (body && typeof body === "object" && "error" in body) return String((body as { error?: unknown }).error ?? fallback);
  return fallback;
};

/**
 * Drives one maxSurge Deployment rollout without ever addressing the mutable
 * room Service. The Service keeps selecting only the old Ready Active while
 * the orchestrator talks to both revisions by immutable Pod IP.
 */
export class KubernetesRoomHandoffDriver implements RoomHandoffDriver {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly gatewayEndpoint: string;
  private readonly gameImageRepository: string;
  private readonly gamePort: number;
  private readonly requestTimeoutMs: number;
  private readonly postVerificationTimeoutMs: number;
  private readonly candidateTimeoutMs: number;
  private readonly catchUpTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly contextByRoom = new Map<string, DriverContext>();
  private readonly contextByCandidateUid = new Map<string, DriverContext>();

  constructor(private readonly options: KubernetesRoomHandoffDriverOptions) {
    if (!options.apiServer) throw new Error("kubernetes_api_server_required");
    if (!kubernetesNamePattern.test(options.namespace)) throw new Error("invalid_kubernetes_namespace");
    if (!kubernetesNamePattern.test(options.deploymentPrefix)) throw new Error("invalid_game_deployment_prefix");
    if (!Number.isInteger(options.roomCount) || options.roomCount < 1 || options.roomCount > 100) {
      throw new Error("invalid_game_deployment_count");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.gatewayEndpoint = trimSlash(options.gatewayEndpoint ?? "http://session-gateway:8083");
    this.gameImageRepository = trimSlash(options.gameImageRepository
      ?? "ghcr.io/jungle-303-04/demo-game/game-server");
    this.gamePort = options.gamePort ?? 8001;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.postVerificationTimeoutMs = options.postVerificationTimeoutMs ?? 12_000;
    this.candidateTimeoutMs = options.candidateTimeoutMs ?? 120_000;
    this.catchUpTimeoutMs = options.catchUpTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  async resolveTarget(input: ResolveRoomHandoffTargetInput): Promise<RoomHandoffTarget> {
    const ordinal = this.ordinalForRoom(input.roomId);
    this.imageForRevision(input.revision);
    if (input.imageDigest !== undefined && !imageDigestPattern.test(input.imageDigest)) {
      throw new Error("invalid_game_image_digest");
    }
    const pods = await this.listRoomPods(input.roomId);
    const running = pods.filter((pod) => pod.status?.phase === "Running"
      && pod.status.podIP
      && pod.metadata?.name
      && pod.metadata.uid
      && !pod.metadata.deletionTimestamp);
    const observed = await Promise.all(running.map(async (pod) => {
      const endpoint = endpointForPodIp(pod.status!.podIP!, this.gamePort);
      try {
        return { pod, endpoint, status: await this.handoffStatus(endpoint) };
      } catch {
        return undefined;
      }
    }));
    const active = observed.filter((entry): entry is NonNullable<typeof entry> =>
      Boolean(entry?.status.role === "active" && entry.status.ready));
    if (active.length > 1) throw new Error("room_split_brain_detected");
    const selected = active[0];
    if (!selected) throw new Error("active_room_pod_not_found");
    const livePods = pods.filter((pod) => !pod.metadata?.deletionTimestamp
      && !["Failed", "Succeeded"].includes(pod.status?.phase ?? ""));
    if (livePods.length !== 1 || livePods[0]?.metadata?.uid !== selected.pod.metadata?.uid) {
      throw new Error("room_rollout_already_in_progress");
    }
    const epoch = selected.status.roomEpoch;
    if (!Number.isSafeInteger(epoch) || Number(epoch) < 0) throw new Error("active_room_epoch_unavailable");
    const expectedDeployment = `${this.options.deploymentPrefix}-${ordinal}`;
    const labels = selected.pod.metadata?.labels ?? {};
    if ((labels["game.opsia.dev/room-id"] ?? labels["opsia.dev/room-id"]) !== input.roomId) {
      throw new Error("active_room_pod_label_mismatch");
    }
    // A rollout target is derived from the room id rather than a caller-owned
    // Kubernetes name, so the API cannot patch an arbitrary Deployment.
    if (!kubernetesNamePattern.test(expectedDeployment)) throw new Error("invalid_game_deployment");
    return {
      roomId: input.roomId,
      activeEndpoint: selected.endpoint,
      activePod: {
        kind: "Pod",
        name: selected.pod.metadata!.name!,
        uid: selected.pod.metadata!.uid!,
        resourceVersion: selected.pod.metadata?.resourceVersion,
      },
      currentEpoch: Number(epoch),
      revision: input.revision,
      ...(input.imageDigest ? { imageDigest: input.imageDigest } : {}),
      workflowRunId: input.workflowRunId,
      applicationId: input.applicationId,
    };
  }

  async scheduleCandidate(target: RoomHandoffTarget, operationId: string): Promise<RoomCandidate> {
    const ordinal = this.ordinalForRoom(target.roomId);
    if (!operationId || this.contextByRoom.has(target.roomId)) throw new Error("room_handoff_already_scheduled");
    const deploymentName = `${this.options.deploymentPrefix}-${ordinal}`;
    const deployment = await this.kubeJson<KubernetesDeployment>(
      `/apis/apps/v1/namespaces/${this.options.namespace}/deployments/${deploymentName}`,
    );
    const container = deployment.spec?.template?.spec?.containers?.find((entry) => entry.name === "game-server");
    if (!container?.image) throw new Error("game_deployment_image_unavailable");
    const desiredImage = this.imageForRevision(target.imageDigest ?? target.revision);
    const context: DriverContext = {
      operationId,
      target,
      deploymentName,
      originalImage: container.image,
      originalRevision: imageRevision(container.image),
      originalBuildRevision: container.env?.find((entry) => entry.name === "OPSIA_GAME_BUILD_REVISION")?.value
        ?? imageRevision(container.image),
      originalTemplateAnnotations: {
        "opsia.dev/handoff-operation": deployment.spec?.template?.metadata?.annotations?.["opsia.dev/handoff-operation"],
        "opsia.dev/handoff-revision": deployment.spec?.template?.metadata?.annotations?.["opsia.dev/handoff-revision"],
        "opsia.dev/handoff-rollback": deployment.spec?.template?.metadata?.annotations?.["opsia.dev/handoff-rollback"],
      },
      desiredImage,
    };
    this.contextByRoom.set(target.roomId, context);
    try {
      await this.patchDeployment(context, {
        image: desiredImage,
        revision: target.revision,
        annotations: {
          "opsia.dev/handoff-operation": operationId,
          "opsia.dev/handoff-revision": target.revision,
        },
      });
      const deadline = Date.now() + this.candidateTimeoutMs;
      while (Date.now() < deadline) {
        const candidatePod = (await this.listRoomPods(target.roomId))
          .filter((pod) => pod.metadata?.uid !== target.activePod.uid
            && pod.metadata?.annotations?.["opsia.dev/handoff-operation"] === operationId
            && !pod.metadata?.deletionTimestamp)
          .sort((left, right) => String(right.metadata?.creationTimestamp ?? "")
            .localeCompare(String(left.metadata?.creationTimestamp ?? "")))[0];
        if (candidatePod?.metadata?.name && candidatePod.metadata.uid
          && candidatePod.status?.phase === "Running" && candidatePod.status.podIP) {
          const observedImage = candidatePod.spec?.containers
            ?.find((entry) => entry.name === "game-server")?.image;
          if (!observedImage || observedImage !== desiredImage) {
            throw new Error("candidate_pod_image_mismatch");
          }
          const observedRevision = imageRevision(observedImage);
          if (observedRevision !== (target.imageDigest ?? target.revision)) {
            throw new Error("candidate_pod_revision_mismatch");
          }
          const observedDigest = runtimeImageDigest(candidatePod.status.containerStatuses
            ?.find((entry) => entry.name === "game-server")?.imageID);
          if (target.imageDigest && observedDigest !== target.imageDigest) {
            throw new Error("candidate_pod_image_digest_mismatch");
          }
          const candidate: RoomCandidate = {
            kind: "Pod",
            name: candidatePod.metadata.name,
            uid: candidatePod.metadata.uid,
            resourceVersion: candidatePod.metadata.resourceVersion,
            endpoint: endpointForPodIp(candidatePod.status.podIP, this.gamePort),
            revision: target.revision,
            ...(observedDigest ? { imageDigest: observedDigest } : {}),
          };
          context.candidate = candidate;
          this.contextByCandidateUid.set(candidate.uid, context);
          await Promise.all([
            this.patchPodRole(target.activePod, "active", target.currentEpoch),
            this.patchPodRole(candidate, "candidate", target.currentEpoch),
          ]);
          return candidate;
        }
        await this.sleep(this.pollIntervalMs);
      }
      throw new Error("candidate_pod_schedule_timeout");
    } catch (error) {
      // The Deployment was already mutated even when no Candidate Pod became
      // observable before the deadline. Always restore the original template;
      // otherwise Kubernetes can create the timed-out revision after this
      // operation has forgotten its context.
      await this.patchDeployment(context, {
        image: context.originalImage,
        revision: context.originalBuildRevision,
        annotations: {
          "opsia.dev/handoff-operation": context.originalTemplateAnnotations["opsia.dev/handoff-operation"] ?? null,
          "opsia.dev/handoff-revision": context.originalTemplateAnnotations["opsia.dev/handoff-revision"] ?? null,
          "opsia.dev/handoff-rollback": context.originalTemplateAnnotations["opsia.dev/handoff-rollback"] ?? null,
        },
      }).catch(() => undefined);
      if (context.candidate) {
        await this.deletePod(context.candidate.name, context.candidate.uid).catch(() => undefined);
      }
      this.clearContext(context);
      throw error;
    }
  }

  async waitUntilReady(candidate: RoomCandidate): Promise<void> {
    const deadline = Date.now() + this.candidateTimeoutMs;
    let lastReason = "candidate_status_unavailable";
    while (Date.now() < deadline) {
      try {
        const status = await this.handoffStatus(candidate.endpoint);
        if (status.role === "active") throw new Error("candidate_acquired_authority_before_handoff");
        if (status.roomId !== this.contextFor(candidate).target.roomId) throw new Error("candidate_room_mismatch");
        // Candidate /healthz intentionally remains 503. Reaching this protected
        // status endpoint in candidate role is its pre-seed readiness contract.
        return;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : "candidate_status_unavailable";
        if (lastReason === "candidate_acquired_authority_before_handoff" || lastReason === "candidate_room_mismatch") {
          throw error;
        }
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`candidate_ready_timeout:${lastReason}`);
  }

  freezeGateway(input: { operationId: string; roomId: string; expectedEpoch: number }): Promise<{ sessions: number; unackedInputs: number }> {
    return this.controlJson(`${this.gatewayEndpoint}/internal/rooms/${input.roomId}/freeze`, {
      method: "POST",
      body: input,
    }) as Promise<{ sessions: number; unackedInputs: number }>;
  }

  async abortGatewayPreparation(input: { operationId: string; roomId: string }): Promise<void> {
    await this.controlJson(`${this.gatewayEndpoint}/internal/rooms/${input.roomId}/abort`, {
      method: "POST",
      body: { operationId: input.operationId },
    });
  }

  async seedSnapshot(target: RoomHandoffTarget, candidate: RoomCandidate): Promise<SnapshotSeedResult> {
    const context = this.contextFor(candidate);
    await this.controlJson(`${target.activeEndpoint}/ops/snapshot/save`, { method: "POST" });
    const active = await this.pollActiveSnapshot(target.activeEndpoint, target.currentEpoch);
    const status = await this.seed(candidate.endpoint, {
      expectedEpoch: target.currentEpoch,
      targetTick: active.serverTick!,
      expectedChecksum: active.checksum!,
      maxEntries: 512,
    });
    if (status.role !== "candidate") throw new Error("candidate_role_required");
    context.checksum = active.checksum;
    let payloadBytes = 0;
    try {
      const metrics = await this.controlText(`${target.activeEndpoint}/metrics`, { method: "GET" }, false);
      payloadBytes = Number(metrics.match(/(?:^|\n)game_snapshot_payload_bytes(?:\{[^\n]*\})?\s+([\d.eE+-]+)/)?.[1] ?? 0);
      if (!Number.isFinite(payloadBytes) || payloadBytes < 0) payloadBytes = 0;
    } catch {
      // Payload size is evidence metadata; its absence cannot invalidate an
      // otherwise checksummed state transfer.
    }
    return {
      checksum: active.checksum!,
      snapshotTick: status.snapshotTick ?? active.serverTick!,
      payloadBytes,
    };
  }

  async catchUpJournal(
    target: RoomHandoffTarget,
    candidate: RoomCandidate,
    _snapshotTick: number,
  ): Promise<JournalCatchUpResult> {
    const context = this.contextFor(candidate);
    const deadline = Date.now() + this.catchUpTimeoutMs;
    let lastLag = Number.POSITIVE_INFINITY;
    let lastReason = "candidate_not_caught_up";
    while (Date.now() < deadline) {
      const active = await this.pollActiveSnapshot(target.activeEndpoint, target.currentEpoch);
      const candidateStatus = await this.seed(candidate.endpoint, {
        expectedEpoch: target.currentEpoch,
        targetTick: active.serverTick!,
        expectedChecksum: active.checksum!,
        maxEntries: 512,
      });
      const activeTick = active.serverTick!;
      const candidateTick = candidateStatus.serverTick ?? 0;
      lastLag = Math.max(0, activeTick - candidateTick);
      lastReason = candidateStatus.reason ?? "candidate_not_caught_up";
      if (candidateStatus.ready && candidateStatus.caughtUp
        && candidateTick === activeTick && candidateStatus.checksum === active.checksum) {
        context.checksum = active.checksum;
        return { activeTick, candidateTick, lagTicks: 0, checksum: active.checksum };
      }
      if (candidateStatus.reason && ![
        "candidate_not_caught_up",
        "candidate_snapshot_missing",
        "candidate_checksum_mismatch",
      ].includes(candidateStatus.reason)) {
        throw new Error(candidateStatus.reason);
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`candidate_catch_up_timeout:${lastReason}:lag=${lastLag}`);
  }

  async candidateChecksum(candidate: RoomCandidate): Promise<string> {
    const status = await this.handoffStatus(candidate.endpoint);
    if (!status.ready || !status.caughtUp || !status.checksum || !checksumPattern.test(status.checksum)) {
      throw new Error(status.reason ?? "candidate_checksum_unavailable");
    }
    return status.checksum;
  }

  async cutoverGateway(input: {
    operationId: string;
    roomId: string;
    endpoint: string;
    expectedEpoch: number;
    nextEpoch: number;
    revision: string;
    checksum: string;
  }): Promise<{ sessions: number; replayedInputs: number }> {
    const context = this.contextByRoom.get(input.roomId);
    if (!context || context.operationId !== input.operationId) throw new Error("handoff_context_not_found");
    const authority = await this.handoffStatus(input.endpoint);
    const checksumMatched = authority.role === "active"
      && authority.ready
      && authority.roomEpoch === input.nextEpoch
      && authority.checksum === input.checksum;
    const caughtUp = checksumMatched && authority.caughtUp === true;
    if (!checksumMatched || !caughtUp) throw new Error("cutover_authority_proof_failed");
    const result = await this.gatewayCutover({ ...input, checksumMatched, caughtUp });
    context.checksum = input.checksum;
    context.committedEpoch = input.nextEpoch;
    return result;
  }

  async rollbackGateway(input: {
    operationId: string;
    roomId: string;
    endpoint: string;
    expectedEpoch: number;
    nextEpoch: number;
    revision: string;
  }): Promise<{ sessions: number; replayedInputs: number; roomEpoch: number }> {
    const context = this.contextByRoom.get(input.roomId);
    if (!context || context.operationId !== input.operationId || !context.candidate) {
      throw new Error("handoff_context_not_found");
    }
    const [oldStatus, candidateStatus, gateway] = await Promise.all([
      this.handoffStatus(context.target.activeEndpoint),
      this.handoffStatus(context.candidate.endpoint),
      this.gatewayRooms(),
    ]);
    const route = gateway.rooms?.find((entry) => entry.roomId === input.roomId);
    if (!route?.endpoint || !Number.isSafeInteger(route.epoch)) throw new Error("rollback_gateway_route_unavailable");
    const authorities = [
      { endpoint: context.target.activeEndpoint, status: oldStatus },
      { endpoint: context.candidate.endpoint, status: candidateStatus },
    ].filter((entry) => entry.status.role === "active");
    if (authorities.length > 1) throw new Error("rollback_split_brain_detected");

    // If the old authority and stable route never changed, the failed transfer
    // is already reconciled. Resume the frozen sessions without consuming an
    // unnecessary epoch.
    if (authorities[0]?.endpoint === context.target.activeEndpoint
      && oldStatus.roomEpoch === route.epoch
      && trimSlash(route.endpoint) === trimSlash(context.target.activeEndpoint)) {
      if (gateway.preparations?.some((entry) => entry.roomId === input.roomId
        && entry.operationId === input.operationId)) {
        await this.abortGatewayPreparation({ operationId: input.operationId, roomId: input.roomId });
      }
      context.committedEpoch = Number(route.epoch);
      return { sessions: 0, replayedInputs: 0, roomEpoch: Number(route.epoch) };
    }

    const authority = authorities[0];
    if (!authority) throw new Error("rollback_authority_unavailable");
    const authorityEpoch = authority.status.roomEpoch;
    if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch !== route.epoch
      || trimSlash(authority.endpoint) !== trimSlash(route.endpoint)) {
      throw new Error("rollback_authority_route_mismatch");
    }
    const currentEpoch = Number(authorityEpoch);
    if (!authority.status.checksum || !checksumPattern.test(authority.status.checksum)) {
      throw new Error("rollback_authority_checksum_unavailable");
    }

    // Capture a current full checkpoint from the serving Candidate. The old
    // Pod's retained pre-cutover memory is never considered rollback proof.
    await this.controlJson(`${authority.endpoint}/ops/snapshot/save`, { method: "POST" });
    const checkpoint = await this.pollActiveSnapshot(authority.endpoint, currentEpoch);
    const released = await this.controlJson<HandoffStatus>(`${authority.endpoint}/ops/handoff/release`, {
      method: "POST",
      body: { expectedEpoch: currentEpoch, expectedChecksum: checkpoint.checksum },
    });
    if (released.role !== "candidate"
      || released.roomEpoch !== currentEpoch
      || !Number.isSafeInteger(released.serverTick)
      || !released.checksum
      || !checksumPattern.test(released.checksum)) {
      throw new Error("rollback_authority_release_invalid");
    }
    const releasedPod = authority.endpoint === context.candidate.endpoint
      ? context.candidate
      : context.target.activePod;
    await this.patchPodRole(releasedPod, "candidate", currentEpoch);
    const releasedTick = Number(released.serverTick);

    const reseeded = await this.seed(context.target.activeEndpoint, {
      expectedEpoch: currentEpoch,
      targetTick: releasedTick,
      expectedChecksum: released.checksum,
      maxEntries: 512,
    });
    const rollbackChecksum = released.checksum;
    const checksumMatched = reseeded.checksum === rollbackChecksum;
    const caughtUp = reseeded.role === "candidate"
      && reseeded.ready
      && reseeded.caughtUp === true
      && reseeded.roomEpoch === currentEpoch
      && reseeded.serverTick === releasedTick;
    if (!checksumMatched || !caughtUp) {
      throw new Error(reseeded.reason ?? "rollback_reseed_proof_failed");
    }

    const observedEpochs = [
      route.epoch,
      oldStatus.roomEpoch,
      candidateStatus.roomEpoch,
      input.expectedEpoch,
      input.nextEpoch - 1,
    ].filter((epoch): epoch is number => Number.isSafeInteger(epoch));
    const rollbackEpoch = Math.max(...observedEpochs) + 1;

    // The old Pod is retained until this entire recovery succeeds. Always use
    // an epoch strictly newer than every observed authority or route, including
    // a Candidate promotion whose HTTP response may have been lost.
    const promoted = await this.controlJson<HandoffStatus>(
      `${context.target.activeEndpoint}/ops/handoff/promote`,
      {
        method: "POST",
        body: {
          expectedEpoch: currentEpoch,
          nextEpoch: rollbackEpoch,
          expectedChecksum: rollbackChecksum,
        },
      },
    );
    if (promoted.role !== "active" || !promoted.ready || promoted.roomEpoch !== rollbackEpoch
      || promoted.checksum !== rollbackChecksum) {
      throw new Error("rollback_old_authority_not_promoted");
    }
    await Promise.all([
      this.patchPodRole(context.target.activePod, "active", rollbackEpoch),
      this.patchPodRole(
        context.candidate,
        "candidate",
        candidateStatus.roomEpoch ?? input.expectedEpoch,
      ),
    ]);

    // A rollback is a distinct idempotency key. Superseding a failed
    // verification retains its shadow inputs until they have been replayed to
    // the restored old authority.
    if (gateway.preparations?.some((entry) => entry.roomId === input.roomId
      && entry.operationId === input.operationId)) {
      await this.abortGatewayPreparation({ operationId: input.operationId, roomId: input.roomId });
    }
    const rollbackOperationId = `${input.operationId}-rollback-${rollbackEpoch}`;
    await this.controlJson(`${this.gatewayEndpoint}/internal/rooms/${input.roomId}/freeze`, {
      method: "POST",
      body: {
        operationId: rollbackOperationId,
        expectedEpoch: route.epoch,
        supersedesOperationId: input.operationId,
      },
    });
    const cutover = await this.gatewayCutover({
      ...input,
      operationId: rollbackOperationId,
      endpoint: context.target.activeEndpoint,
      expectedEpoch: route.epoch,
      nextEpoch: rollbackEpoch,
      revision: context.originalRevision,
      checksum: rollbackChecksum,
      checksumMatched,
      caughtUp,
    });
    const proof = await this.gatewayRooms();
    const proofRoute = proof.rooms?.find((entry) => entry.roomId === input.roomId);
    const proofVerification = proof.verifications?.find((entry) => entry.roomId === input.roomId
      && entry.operationId === rollbackOperationId);
    const proofOperation = proof.operations?.find((entry) => entry.roomId === input.roomId
      && entry.operationId === rollbackOperationId);
    const expectedSessions = proofVerification?.expectedSessions ?? -1;
    if (trimSlash(proofRoute?.endpoint ?? "") !== trimSlash(context.target.activeEndpoint)
      || proofRoute?.epoch !== rollbackEpoch
      || proofOperation?.status !== "committed"
      || proofOperation.nextEpoch !== rollbackEpoch
      || trimSlash(proofOperation.endpoint ?? "") !== trimSlash(context.target.activeEndpoint)
      || proofVerification?.epoch !== rollbackEpoch
      || proofVerification.continuous !== true
      || expectedSessions < 0
      || proofVerification.liveSessions !== expectedSessions
      || proofVerification.upstreamSessions !== expectedSessions) {
      throw new Error("rollback_session_continuity_failed");
    }
    await this.finalizeGateway({
      operationId: rollbackOperationId,
      roomId: input.roomId,
      roomEpoch: rollbackEpoch,
    });
    context.committedEpoch = rollbackEpoch;
    context.checksum = rollbackChecksum;
    return { ...cutover, roomEpoch: rollbackEpoch };
  }

  async verify(candidate: RoomCandidate, expectedChecksum: string): Promise<PostVerificationResult> {
    const context = this.contextFor(candidate);
    const expectedEpoch = context.committedEpoch ?? context.target.currentEpoch + 1;
    const deadline = Date.now() + this.postVerificationTimeoutMs;
    let result: PostVerificationResult = {
      healthy: false,
      sessionContinuity: false,
      stateChecksum: "unavailable",
    };
    do {
      const [status, gateway] = await Promise.all([
        this.handoffStatus(candidate.endpoint),
        this.gatewayRooms(),
      ]);
      const route = gateway.rooms?.find((entry) => entry.roomId === context.target.roomId);
      const verification = gateway.verifications?.find((entry) =>
        entry.roomId === context.target.roomId && entry.operationId === context.operationId);
      const operation = gateway.operations?.find((entry) =>
        entry.roomId === context.target.roomId && entry.operationId === context.operationId);
      const expectedSessions = verification?.expectedSessions ?? -1;
      const sessionContinuity = trimSlash(route?.endpoint ?? "") === trimSlash(candidate.endpoint)
        && route?.epoch === expectedEpoch
        && operation?.status === "committed"
        && operation.nextEpoch === expectedEpoch
        && trimSlash(operation.endpoint ?? "") === trimSlash(candidate.endpoint)
        && verification?.epoch === expectedEpoch
        && verification.continuous === true
        && expectedSessions >= 0
        && verification.liveSessions === expectedSessions
        && verification.upstreamSessions === expectedSessions;
      result = {
        healthy: status.role === "active"
          && status.ready
          && status.roomEpoch === expectedEpoch
          && status.checksum === expectedChecksum,
        sessionContinuity,
        stateChecksum: status.checksum ?? "unavailable",
      };
      if (result.healthy && result.sessionContinuity && result.stateChecksum === expectedChecksum) return result;
      if (Date.now() < deadline) await this.sleep(Math.min(this.pollIntervalMs, 100));
    } while (Date.now() < deadline);
    return result;
  }

  async activateCandidate(input: {
    target: RoomHandoffTarget;
    candidate: RoomCandidate;
    roomEpoch: number;
    checksum: string;
  }): Promise<{ checksum: string }> {
    const context = this.contextFor(input.candidate);
    const [oldStatus, initialCandidateStatus] = await Promise.all([
      this.handoffStatus(input.target.activeEndpoint),
      this.handoffStatus(input.candidate.endpoint),
    ]);
    if (oldStatus.role === "active" && initialCandidateStatus.role === "active") {
      throw new Error("authority_transfer_split_brain_detected");
    }

    // A lost HTTP response is reconciled idempotently from the observed lease
    // owner. Never release an already-promoted Candidate a second time.
    if (initialCandidateStatus.role === "active") {
      if (initialCandidateStatus.roomEpoch !== input.roomEpoch
        || !initialCandidateStatus.checksum
        || !checksumPattern.test(initialCandidateStatus.checksum)) {
        throw new Error("candidate_authority_state_conflict");
      }
      context.checksum = initialCandidateStatus.checksum;
      context.committedEpoch = input.roomEpoch;
      await Promise.all([
        this.patchPodRole(input.target.activePod, "candidate", input.target.currentEpoch),
        this.patchPodRole(input.candidate, "active", input.roomEpoch),
      ]);
      return { checksum: initialCandidateStatus.checksum };
    }

    let promotionChecksum = input.checksum;
    let candidateStatus = initialCandidateStatus;
    if (oldStatus.role === "active") {
      if (oldStatus.roomEpoch !== input.target.currentEpoch) {
        throw new Error("active_epoch_changed_before_authority_transfer");
      }
      const released = await this.controlJson<HandoffStatus>(`${input.target.activeEndpoint}/ops/handoff/release`, {
        method: "POST",
        body: { expectedEpoch: input.target.currentEpoch, expectedChecksum: input.checksum },
      });
      if (released.role !== "candidate"
        || !released.checksum
        || !checksumPattern.test(released.checksum)
        || !Number.isSafeInteger(released.serverTick)) {
        throw new Error("active_final_checkpoint_unavailable");
      }
      await this.patchPodRole(input.target.activePod, "candidate", input.target.currentEpoch);

      // The simulation can advance between the earlier checksum comparison and
      // lease release. Seed that final, lease-fenced checkpoint before granting
      // authority so the promoted state is exactly the state that was released.
      candidateStatus = await this.seed(input.candidate.endpoint, {
        expectedEpoch: input.target.currentEpoch,
        targetTick: released.serverTick,
        expectedChecksum: released.checksum,
        maxEntries: 512,
      });
      promotionChecksum = released.checksum;
    }
    if (candidateStatus.role !== "candidate"
      || !candidateStatus.ready
      || candidateStatus.caughtUp !== true
      || candidateStatus.checksum !== promotionChecksum) {
      throw new Error(candidateStatus.reason ?? "candidate_final_checkpoint_mismatch");
    }

    const promoted = await this.controlJson<HandoffStatus>(`${input.candidate.endpoint}/ops/handoff/promote`, {
      method: "POST",
      body: {
        expectedEpoch: input.target.currentEpoch,
        nextEpoch: input.roomEpoch,
        expectedChecksum: promotionChecksum,
      },
    });
    if (promoted.role !== "active" || promoted.roomEpoch !== input.roomEpoch
      || promoted.checksum !== promotionChecksum) {
      throw new Error("candidate_promote_not_authoritative");
    }
    context.checksum = promotionChecksum;
    context.committedEpoch = input.roomEpoch;
    await this.patchPodRole(input.candidate, "active", input.roomEpoch);
    return { checksum: promotionChecksum };
  }

  async finalizeGateway(input: { operationId: string; roomId: string; roomEpoch: number }): Promise<void> {
    await this.controlJson(`${this.gatewayEndpoint}/internal/rooms/${input.roomId}/finalize`, {
      method: "POST",
      body: { operationId: input.operationId, roomEpoch: input.roomEpoch },
    });
  }

  async drainOldPod(target: RoomHandoffTarget): Promise<void> {
    await this.deletePod(target.activePod.name, target.activePod.uid);
    const context = this.contextByRoom.get(target.roomId);
    if (context) this.clearContext(context);
  }

  async discardCandidate(candidate: RoomCandidate, _reason: string): Promise<void> {
    const context = this.contextFor(candidate);
    await this.patchDeployment(context, {
      image: context.originalImage,
      revision: context.originalBuildRevision,
      annotations: {
        "opsia.dev/handoff-operation": context.originalTemplateAnnotations["opsia.dev/handoff-operation"] ?? null,
        "opsia.dev/handoff-revision": context.originalTemplateAnnotations["opsia.dev/handoff-revision"] ?? null,
        "opsia.dev/handoff-rollback": context.originalTemplateAnnotations["opsia.dev/handoff-rollback"] ?? null,
      },
    });
    await this.deletePod(candidate.name, candidate.uid);
    this.clearContext(context);
  }

  private ordinalForRoom(roomId: string): number {
    const match = roomId.match(/^room-(\d+)$/);
    const ordinal = Number(match?.[1]);
    if (!match || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.options.roomCount) {
      throw new Error("invalid_room_id");
    }
    return ordinal;
  }

  private imageForRevision(revision: string): string {
    if (/^sha256:[a-f\d]{64}$/.test(revision)) return `${this.gameImageRepository}@${revision}`;
    if (!imageTagPattern.test(revision)) throw new Error("invalid_game_revision");
    return `${this.gameImageRepository}:${revision}`;
  }

  private contextFor(candidate: RoomCandidate): DriverContext {
    const context = this.contextByCandidateUid.get(candidate.uid);
    if (!context) throw new Error("handoff_context_not_found");
    return context;
  }

  private clearContext(context: DriverContext): void {
    this.contextByRoom.delete(context.target.roomId);
    if (context.candidate) this.contextByCandidateUid.delete(context.candidate.uid);
  }

  private async authorization(): Promise<string> {
    const token = (typeof this.options.token === "function" ? await this.options.token() : this.options.token).trim();
    if (!token) throw new Error("kubernetes_service_account_token_unavailable");
    return `Bearer ${token}`;
  }

  private async kubeResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", await this.authorization());
    const response = await this.fetchImpl(`${trimSlash(this.options.apiServer)}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    return response;
  }

  private async kubeJson<T>(path: string, init: RequestInit = {}, allowNotFound = false): Promise<T> {
    const response = await this.kubeResponse(path, init);
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : {};
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      throw new Error(errorMessage(body, `kubernetes_request_failed:${response.status}`));
    }
    return body as T;
  }

  private async listRoomPods(roomId: string): Promise<KubernetesPod[]> {
    const selector = encodeURIComponent("opsia.dev/fleet=live");
    const body = await this.kubeJson<{ items?: KubernetesPod[] }>(
      `/api/v1/namespaces/${this.options.namespace}/pods?labelSelector=${selector}`,
    );
    return (body.items ?? []).filter((pod) => {
      const labels = pod.metadata?.labels;
      return (labels?.["game.opsia.dev/room-id"] ?? labels?.["opsia.dev/room-id"]) === roomId;
    });
  }

  private async patchDeployment(
    context: DriverContext,
    input: { image: string; revision: string; annotations: Record<string, string | null> },
  ): Promise<void> {
    await this.kubeJson(
      `/apis/apps/v1/namespaces/${this.options.namespace}/deployments/${context.deploymentName}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/strategic-merge-patch+json" },
        body: JSON.stringify({
          spec: {
            template: {
              metadata: { annotations: input.annotations },
              spec: {
                containers: [{
                  name: "game-server",
                  image: input.image,
                  env: [
                    { name: "OPSIA_ROLE", value: "auto" },
                    { name: "OPSIA_GAME_BUILD_REVISION", value: input.revision },
                  ],
                }],
              },
            },
          },
        }),
      },
    );
  }

  private async deletePod(name: string, uid: string): Promise<void> {
    const response = await this.kubeResponse(
      `/api/v1/namespaces/${this.options.namespace}/pods/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid } }),
      },
    );
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      let body: unknown = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      throw new Error(errorMessage(body, `pod_delete_failed:${response.status}`));
    }
  }

  private async patchPodRole(
    pod: { name: string; uid: string },
    role: "active" | "candidate",
    roomEpoch: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(roomEpoch) || roomEpoch < 0) throw new Error("invalid_room_epoch");
    await this.kubeJson(
      `/api/v1/namespaces/${this.options.namespace}/pods/${encodeURIComponent(pod.name)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/merge-patch+json" },
        body: JSON.stringify({
          metadata: {
            labels: { "opsia.dev/game-role": role },
            annotations: { "opsia.dev/room-epoch": String(roomEpoch) },
          },
        }),
      },
    );
  }

  private async handoffStatus(endpoint: string): Promise<HandoffStatus> {
    const status = await this.controlJson<HandoffStatus>(`${trimSlash(endpoint)}/ops/handoff/status`, { method: "GET" });
    if (!status || !["active", "candidate"].includes(status.role)
      || typeof status.roomId !== "string" || typeof status.ready !== "boolean") {
      throw new Error("invalid_handoff_status");
    }
    return status;
  }

  private async pollActiveSnapshot(endpoint: string, expectedEpoch: number): Promise<HandoffStatus> {
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      const status = await this.handoffStatus(endpoint);
      if (status.role !== "active") throw new Error("active_authority_lost_before_cutover");
      if (status.roomEpoch !== expectedEpoch) throw new Error("active_epoch_changed_before_cutover");
      if (Number.isSafeInteger(status.serverTick) && status.serverTick! >= 0
        && status.checksum && checksumPattern.test(status.checksum)) return status;
      await this.sleep(Math.min(this.pollIntervalMs, 100));
    }
    throw new Error("active_snapshot_status_timeout");
  }

  private seed(endpoint: string, body: Record<string, unknown>): Promise<HandoffStatus> {
    return this.controlJson<HandoffStatus>(`${trimSlash(endpoint)}/ops/handoff/seed`, {
      method: "POST",
      body,
      acceptedStatuses: [200, 409],
    });
  }

  private gatewayRooms(): Promise<GatewayRoomStatus> {
    return this.controlJson<GatewayRoomStatus>(`${this.gatewayEndpoint}/internal/rooms`, { method: "GET" });
  }

  private async gatewayCutover(
    body: Record<string, unknown> & { roomId: string; operationId?: unknown; endpoint?: unknown; nextEpoch?: unknown },
  ): Promise<{ sessions: number; replayedInputs: number }> {
    try {
      return await this.controlJson(`${this.gatewayEndpoint}/internal/rooms/${body.roomId}/cutover`, {
        method: "POST",
        body,
      }) as { sessions: number; replayedInputs: number };
    } catch (error) {
      // The response can be lost after the registry CAS. Re-read the durable
      // operation record before deciding whether retry/rollback is required;
      // never infer "not committed" from a transport exception.
      const operationId = String(body.operationId ?? "");
      if (!operationId) throw error;
      const status = await this.controlJson<GatewayOperationStatus>(
        `${this.gatewayEndpoint}/internal/rooms/${body.roomId}/operations/${encodeURIComponent(operationId)}`,
        { method: "GET", acceptedStatuses: [404] },
      ).catch(() => undefined);
      const exactRoute = status?.nextEpoch === Number(body.nextEpoch)
        && trimSlash(status.endpoint ?? "") === trimSlash(String(body.endpoint ?? ""));
      if (status?.status === "committed" && exactRoute) {
        return {
          sessions: Number(status.sessions ?? 0),
          replayedInputs: Number(status.replayedInputs ?? 0),
        };
      }
      if (status?.status === "registry_committed" && exactRoute) {
        throw new RoomCutoverCommittedError(
          status.failure ?? "gateway_cutover_incomplete_after_registry_commit",
          Number(status.nextEpoch),
        );
      }
      throw error;
    }
  }

  private async controlJson<T = Record<string, unknown>>(
    url: string,
    input: { method: string; body?: unknown; acceptedStatuses?: number[] },
  ): Promise<T> {
    const headers: Record<string, string> = input.body === undefined ? {} : { "content-type": "application/json" };
    const response = await this.fetchImpl(url, withControlToken({
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }, this.options.controlToken ?? ""));
    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    const accepted = input.acceptedStatuses ?? [];
    if (!response.ok && !accepted.includes(response.status)) {
      throw new Error(errorMessage(body, `control_request_failed:${response.status}`));
    }
    return body as T;
  }

  private async controlText(url: string, init: RequestInit, authenticated = true): Promise<string> {
    const request = authenticated ? withControlToken(init, this.options.controlToken ?? "") : init;
    const response = await this.fetchImpl(url, { ...request, signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) throw new Error(`control_request_failed:${response.status}`);
    return response.text();
  }
}
