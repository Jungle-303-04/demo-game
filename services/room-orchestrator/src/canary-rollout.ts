import { CANARY_ROOM_ID, type CanaryValidationTarget } from "./canary.js";

type FetchLike = typeof fetch;

export interface KubernetesCanaryRolloutOptions {
  apiServer: string;
  namespace: string;
  token: string | (() => Promise<string>);
  gameImageRepository?: string;
  deploymentName?: string;
  endpoint?: string;
  redisKeyPrefix?: string;
  redisDatabase?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: FetchLike;
}

export interface ScheduleCanaryInput {
  canaryId: string;
  revision: string;
  workflowRunId?: string;
  applicationId?: string;
}

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const labelValue = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)$/;
// Promotion approval is keyed by revision, so mutable aliases such as
// "stable" or "latest" would let different image bytes reuse old evidence.
// The release pipeline publishes immutable 40-character Git SHA image tags.
const immutableGitRevision = /^[a-f\d]{40}$/;

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

const boundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("canary_rollout_response_too_large");
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
        await reader.cancel("canary_rollout_response_too_large");
        throw new Error("canary_rollout_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

const responseError = (body: unknown, status: number): string => {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return `canary_rollout_kubernetes_http_${status}`;
};

/**
 * Mutates exactly one isolated Canary Deployment. Callers can select a build
 * revision, but never a namespace, workload, endpoint, Redis database, or
 * image repository. The immutable identity labels are later correlated with
 * the Pod and Kubernetes events by KubernetesApiCanaryObservationSource.
 */
export class KubernetesCanaryRollout {
  private readonly apiServer: string;
  private readonly namespace: string;
  private readonly deploymentName: string;
  private readonly endpoint: string;
  private readonly redisKeyPrefix: string;
  private readonly redisDatabase: number;
  private readonly imageRepository: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: KubernetesCanaryRolloutOptions) {
    const api = new URL(options.apiServer);
    if (!/^https?:$/.test(api.protocol) || !api.hostname || api.username || api.password || api.pathname !== "/") {
      throw new Error("kubernetes_api_server_invalid");
    }
    this.apiServer = api.origin;
    this.namespace = options.namespace;
    this.deploymentName = options.deploymentName ?? CANARY_ROOM_ID;
    this.endpoint = new URL(options.endpoint ?? `http://${CANARY_ROOM_ID}:8001`).origin;
    this.redisKeyPrefix = options.redisKeyPrefix ?? `room:${CANARY_ROOM_ID}:`;
    this.redisDatabase = options.redisDatabase ?? 1;
    this.imageRepository = trimSlash(options.gameImageRepository
      ?? "ghcr.io/jungle-303-04/demo-game/game-server");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!dnsLabel.test(this.namespace) || !dnsLabel.test(this.deploymentName)) {
      throw new Error("canary_rollout_kubernetes_name_invalid");
    }
    if (new URL(this.endpoint).hostname !== CANARY_ROOM_ID || this.redisKeyPrefix !== `room:${CANARY_ROOM_ID}:`
      || this.redisDatabase !== 1 || !this.imageRepository) {
      throw new Error("canary_rollout_isolation_invalid");
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 30_000
      || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024
      || this.maxResponseBytes > 8_388_608) {
      throw new Error("canary_rollout_options_invalid");
    }
  }

  private imageFor(revision: string): string {
    if (!immutableGitRevision.test(revision) || !labelValue.test(revision)) {
      throw new Error("invalid_canary_revision");
    }
    return `${this.imageRepository}:${revision}`;
  }

  private async authorization(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("canary_rollout_aborted");
    const token = (typeof this.options.token === "function" ? await this.options.token() : this.options.token).trim();
    if (!token) throw new Error("kubernetes_service_account_token_unavailable");
    if (signal.aborted) throw new Error("canary_rollout_aborted");
    return `Bearer ${token}`;
  }

  async schedule(input: ScheduleCanaryInput): Promise<CanaryValidationTarget> {
    if (!labelValue.test(input.canaryId)) throw new Error("invalid_canary_id");
    const image = this.imageFor(input.revision);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(
        `${this.apiServer}/apis/apps/v1/namespaces/${this.namespace}/deployments/${this.deploymentName}`,
        {
          method: "PATCH",
          headers: {
            authorization: await this.authorization(controller.signal),
            "content-type": "application/strategic-merge-patch+json",
            accept: "application/json",
          },
          redirect: "error",
          signal: controller.signal,
          body: JSON.stringify({
            metadata: {
              labels: {
                "opsia.dev/canary-id": input.canaryId,
                "opsia.dev/revision": input.revision,
              },
            },
            spec: {
              template: {
                metadata: {
                  labels: {
                    "opsia.dev/canary-id": input.canaryId,
                    "opsia.dev/revision": input.revision,
                  },
                  annotations: {
                    "opsia.dev/canary-scheduled-at": new Date().toISOString(),
                  },
                },
                spec: {
                  containers: [{
                    name: "game-server",
                    image,
                    env: [{ name: "OPSIA_GAME_BUILD_REVISION", value: input.revision }],
                  }],
                },
              },
            },
          }),
        },
      );
      const text = await boundedText(response, this.maxResponseBytes);
      let body: unknown = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      if (!response.ok || response.redirected) throw new Error(responseError(body, response.status));
      return {
        canaryId: input.canaryId,
        roomId: CANARY_ROOM_ID,
        endpoint: this.endpoint,
        revision: input.revision,
        redisKeyPrefix: this.redisKeyPrefix,
        redisDatabase: this.redisDatabase,
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        ...(input.applicationId ? { applicationId: input.applicationId } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
