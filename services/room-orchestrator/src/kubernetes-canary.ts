import { readFile } from "node:fs/promises";
import {
  CANARY_ROOM_ID,
  type CanaryPodObservation,
  type KubernetesCanaryObservationSource,
  type KubernetesContainerStatus,
  type KubernetesEventObservation,
  type KubernetesTerminationStatus,
} from "./canary.js";

type FetchLike = typeof fetch;

interface KubernetesMetadata {
  name?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  ownerReferences?: Array<{ uid?: string; controller?: boolean }>;
}

interface KubernetesDeployment {
  metadata?: KubernetesMetadata;
  spec?: { replicas?: number };
  status?: { readyReplicas?: number };
}

interface KubernetesReplicaSet {
  metadata?: KubernetesMetadata;
}

interface KubernetesContainerSpec {
  name?: string;
  env?: Array<{ name?: string; value?: string }>;
  resources?: { limits?: { memory?: string | number } };
}

interface KubernetesTerminatedState {
  reason?: string;
  exitCode?: number;
  finishedAt?: string;
}

interface KubernetesPod {
  metadata?: KubernetesMetadata;
  spec?: { containers?: KubernetesContainerSpec[] };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      imageID?: string;
      ready?: boolean;
      restartCount?: number;
      state?: { terminated?: KubernetesTerminatedState };
      lastState?: { terminated?: KubernetesTerminatedState };
    }>;
  };
}

interface KubernetesEvent {
  metadata?: KubernetesMetadata;
  reason?: string;
  type?: string;
  message?: string;
  eventTime?: string;
  lastTimestamp?: string;
  series?: { lastObservedTime?: string };
  involvedObject?: { uid?: string };
}

interface KubernetesList<T> {
  items?: T[];
}

export interface KubernetesApiCanarySourceOptions {
  fetch?: FetchLike;
  maxResponseBytes?: number;
  canaryIdLabel?: string;
  revisionLabel?: string;
  now?: () => number;
}

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const labelKey = /^(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

const boundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("kubernetes_canary_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("kubernetes_canary_response_too_large");
        throw new Error("kubernetes_canary_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

const envValue = (container: KubernetesContainerSpec, name: string): string | undefined =>
  container.env?.find((entry) => entry.name === name)?.value;

const redisDatabase = (value: string | undefined): number => {
  if (!value) return -1;
  try {
    const path = new URL(value).pathname.replace(/^\//, "");
    const database = Number(path || "0");
    return Number.isSafeInteger(database) && database >= 0 ? database : -1;
  } catch {
    return -1;
  }
};

const memoryQuantityBytes = (value: string | number | undefined): number | undefined => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|K|M|G|T|P)?$/.exec(value);
  if (!match) return undefined;
  const multipliers: Record<string, number> = {
    "": 1,
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
    P: 1_000_000_000_000_000,
    Ki: 1_024,
    Mi: 1_048_576,
    Gi: 1_073_741_824,
    Ti: 1_099_511_627_776,
    Pi: 1_125_899_906_842_624,
  };
  const bytes = Number(match[1]) * multipliers[match[2] ?? ""]!;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
};

const termination = (value: KubernetesTerminatedState | undefined): KubernetesTerminationStatus | undefined => {
  if (!value?.reason || !Number.isSafeInteger(value.exitCode) || Number(value.exitCode) < 0) return undefined;
  return {
    reason: value.reason,
    exitCode: Number(value.exitCode),
    ...(value.finishedAt ? { finishedAt: value.finishedAt } : {}),
  };
};

/** Kubernetes imageID formats vary by runtime; the terminal OCI digest does not. */
export const runtimeImageDigest = (imageId: string | undefined): string | undefined => {
  const digest = imageId?.match(/sha256:([a-f\d]{64})$/i)?.[1];
  return digest ? `sha256:${digest.toLowerCase()}` : undefined;
};

const containerStatuses = (pod: KubernetesPod): KubernetesContainerStatus[] =>
  (pod.status?.containerStatuses ?? []).map((status) => ({
    name: status.name ?? "",
    ready: status.ready === true,
    restartCount: Number(status.restartCount ?? -1),
    ...(termination(status.state?.terminated) ? { terminated: termination(status.state?.terminated) } : {}),
    ...(termination(status.lastState?.terminated) ? { lastTerminated: termination(status.lastState?.terminated) } : {}),
  }));

const eventObservation = (event: KubernetesEvent): KubernetesEventObservation | undefined => {
  const uid = event.metadata?.uid;
  const rawReason = event.reason;
  if (!uid || !rawReason) return undefined;
  const message = event.message ?? "";
  const reason = rawReason === "OOMKilled" || /\bOOMKilled\b/.test(message) ? "OOMKilled" : rawReason;
  const observedAt = event.eventTime ?? event.series?.lastObservedTime ?? event.lastTimestamp ??
    event.metadata?.creationTimestamp;
  return {
    uid,
    reason,
    ...(event.type ? { type: event.type } : {}),
    ...(message ? { message } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(event.involvedObject?.uid ? { involvedObjectUid: event.involvedObject.uid } : {}),
  };
};

export const readKubernetesServiceAccountToken = async (
  path = "/var/run/secrets/kubernetes.io/serviceaccount/token",
): Promise<string> => (await readFile(path, "utf8")).trim();

export const inClusterKubernetesApiServer = (environment: NodeJS.ProcessEnv = process.env): string => {
  const host = environment.KUBERNETES_SERVICE_HOST;
  const port = environment.KUBERNETES_SERVICE_PORT_HTTPS ?? environment.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host || !/^\d+$/.test(port)) throw new Error("kubernetes_api_environment_unavailable");
  return `https://${host}:${port}`;
};

/**
 * Read-only in-cluster adapter. It uses the caller's AbortSignal for every API
 * request, preserves Kubernetes UIDs, and only returns a Pod whose deployment,
 * room, Canary identity, and revision labels all match the requested target.
 */
export class KubernetesApiCanaryObservationSource implements KubernetesCanaryObservationSource {
  private readonly apiServer: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxResponseBytes: number;
  private readonly canaryIdLabel: string;
  private readonly revisionLabel: string;
  private readonly now: () => number;

  constructor(
    apiServer: string,
    private readonly token: string | (() => Promise<string>),
    options: KubernetesApiCanarySourceOptions = {},
  ) {
    const url = new URL(apiServer);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/") {
      throw new Error("kubernetes_api_server_invalid");
    }
    this.apiServer = url.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_097_152;
    this.canaryIdLabel = options.canaryIdLabel ?? "opsia.dev/canary-id";
    this.revisionLabel = options.revisionLabel ?? "opsia.dev/revision";
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 8_388_608 || !labelKey.test(this.canaryIdLabel) ||
      !labelKey.test(this.revisionLabel)
    ) {
      throw new Error("kubernetes_canary_source_options_invalid");
    }
  }

  private async authorization(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("kubernetes_canary_observation_aborted");
    const value = (typeof this.token === "function" ? await this.token() : this.token).trim();
    if (signal.aborted) throw new Error("kubernetes_canary_observation_aborted");
    if (!value) throw new Error("kubernetes_service_account_token_unavailable");
    return `Bearer ${value}`;
  }

  private async requestJson<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.apiServer}${path}`, {
      method: "GET",
      headers: {
        authorization: await this.authorization(signal),
        accept: "application/json",
      },
      redirect: "error",
      signal,
    });
    if (!response.ok || response.redirected) throw new Error(`kubernetes_canary_read_failed:${response.status}`);
    const text = await boundedText(response, this.maxResponseBytes);
    return JSON.parse(text) as T;
  }

  async observe(input: {
    namespace: string;
    canaryId: string;
    roomId: typeof CANARY_ROOM_ID;
    signal: AbortSignal;
  }): Promise<CanaryPodObservation> {
    if (!dnsLabel.test(input.namespace) || input.roomId !== CANARY_ROOM_ID || !input.canaryId) {
      throw new Error("kubernetes_canary_observation_target_invalid");
    }
    const selector = encodeURIComponent(`opsia.dev/fleet=canary,opsia.dev/room-id=${CANARY_ROOM_ID}`);
    const deployments = await this.requestJson<KubernetesList<KubernetesDeployment>>(
      `/apis/apps/v1/namespaces/${input.namespace}/deployments?labelSelector=${selector}`,
      input.signal,
    );
    const matchingDeployments = (deployments.items ?? []).filter((deployment) => {
      const labels = deployment.metadata?.labels ?? {};
      return labels["opsia.dev/fleet"] === "canary" && labels["opsia.dev/room-id"] === CANARY_ROOM_ID &&
        labels[this.canaryIdLabel] === input.canaryId && Boolean(labels[this.revisionLabel]);
    });
    if (matchingDeployments.length !== 1) {
      throw new Error(matchingDeployments.length ? "canary_deployment_ambiguous" : "canary_deployment_not_found");
    }
    const deployment = matchingDeployments[0]!;
    const deploymentUid = deployment.metadata?.uid;
    const revision = deployment.metadata?.labels?.[this.revisionLabel];
    const desiredReplicas = Number(deployment.spec?.replicas ?? 0);
    const readyReplicas = Number(deployment.status?.readyReplicas ?? 0);
    if (
      !deploymentUid || !revision || !Number.isSafeInteger(desiredReplicas) || desiredReplicas < 0 ||
      !Number.isSafeInteger(readyReplicas) || readyReplicas < 0 || readyReplicas > desiredReplicas
    ) {
      throw new Error("canary_deployment_status_invalid");
    }

    // Pods are owned by a ReplicaSet, not directly by a Deployment. Resolve
    // that ownership edge explicitly so a same-label foreign Pod can never be
    // accepted as Canary evidence.
    const replicaSets = await this.requestJson<KubernetesList<KubernetesReplicaSet>>(
      `/apis/apps/v1/namespaces/${input.namespace}/replicasets?labelSelector=${selector}`,
      input.signal,
    );
    const replicaSetUids = new Set((replicaSets.items ?? [])
      .filter((replicaSet) => !replicaSet.metadata?.deletionTimestamp
        && replicaSet.metadata?.ownerReferences?.some((owner) => owner.uid === deploymentUid && owner.controller !== false)
        && replicaSet.metadata?.labels?.[this.canaryIdLabel] === input.canaryId
        && replicaSet.metadata?.labels?.[this.revisionLabel] === revision)
      .map((replicaSet) => replicaSet.metadata?.uid)
      .filter((uid): uid is string => Boolean(uid)));
    if (replicaSetUids.size === 0) throw new Error("canary_replicaset_not_found");

    const pods = await this.requestJson<KubernetesList<KubernetesPod>>(
      `/api/v1/namespaces/${input.namespace}/pods?labelSelector=${selector}`,
      input.signal,
    );
    const matchingPods = (pods.items ?? []).filter((pod) => {
      const labels = pod.metadata?.labels ?? {};
      const owned = pod.metadata?.ownerReferences?.some((owner) => Boolean(owner.uid)
        && replicaSetUids.has(owner.uid!) && owner.controller !== false);
      return !pod.metadata?.deletionTimestamp && owned && labels["opsia.dev/fleet"] === "canary" &&
        labels["opsia.dev/room-id"] === CANARY_ROOM_ID && labels[this.canaryIdLabel] === input.canaryId &&
        labels[this.revisionLabel] === revision;
    });
    if (matchingPods.length !== 1) {
      throw new Error(matchingPods.length ? "canary_pod_ambiguous" : "canary_pod_not_found");
    }
    const pod = matchingPods[0]!;
    const podName = pod.metadata?.name;
    const podUid = pod.metadata?.uid;
    if (!podName || !podUid || !pod.metadata?.resourceVersion || !pod.status?.phase) {
      throw new Error("canary_pod_identity_invalid");
    }

    const fieldSelector = encodeURIComponent(`involvedObject.uid=${podUid}`);
    const events = await this.requestJson<KubernetesList<KubernetesEvent>>(
      `/api/v1/namespaces/${input.namespace}/events?fieldSelector=${fieldSelector}`,
      input.signal,
    );
    const gameContainer = pod.spec?.containers?.find((container) => container.name === "game-server");
    if (!gameContainer) throw new Error("canary_game_container_not_found");
    const gameContainerStatus = pod.status?.containerStatuses?.find((container) => container.name === "game-server");
    const imageDigest = runtimeImageDigest(gameContainerStatus?.imageID);
    if (!imageDigest) throw new Error("canary_game_image_digest_unavailable");
    const labels = pod.metadata.labels ?? {};
    const observedEvents = (events.items ?? [])
      .map(eventObservation)
      .filter((event): event is KubernetesEventObservation => Boolean(event));

    return {
      observedAt: new Date(this.now()).toISOString(),
      pod: {
        kind: "Pod",
        name: podName,
        uid: podUid,
        resourceVersion: pod.metadata.resourceVersion,
        phase: pod.status.phase,
        canaryId: labels[this.canaryIdLabel] ?? "",
        revision: labels[this.revisionLabel] ?? "",
        imageDigest,
      },
      readyReplicas,
      desiredReplicas,
      containers: containerStatuses(pod),
      events: observedEvents,
      isolation: {
        roomId: labels["opsia.dev/room-id"] ?? "",
        fleet: labels["opsia.dev/fleet"] ?? "",
        publicEnabled: labels["opsia.dev/public"] !== "disabled",
        matchmakingEnabled: labels["opsia.dev/matchmaking"] !== "disabled",
        redisKeyPrefix: envValue(gameContainer, "OPSIA_REDIS_KEY_PREFIX") ?? "",
        redisDatabase: redisDatabase(envValue(gameContainer, "REDIS_URL")),
      },
      ...(memoryQuantityBytes(gameContainer.resources?.limits?.memory) !== undefined
        ? { memoryLimitBytes: memoryQuantityBytes(gameContainer.resources?.limits?.memory) }
        : {}),
    };
  }
}
