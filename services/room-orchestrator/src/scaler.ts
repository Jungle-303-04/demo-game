export interface ReplicaScaler {
  readonly managed: boolean;
  currentReplicas(): Promise<number | undefined>;
  scale(replicas: number): Promise<void>;
  deletePod(podName: string): Promise<void>;
}

export class NoopScaler implements ReplicaScaler {
  readonly managed = false;
  async currentReplicas(): Promise<number | undefined> { return undefined; }
  async scale(_replicas: number): Promise<void> { throw new Error("room_scaling_requires_kubernetes"); }
  async deletePod(_podName: string): Promise<void> { throw new Error("pod_failure_injection_requires_kubernetes"); }
}

export class KubernetesStatefulSetScaler implements ReplicaScaler {
  readonly managed = true;
  constructor(
    private readonly apiServer: string,
    private readonly namespace: string,
    private readonly statefulSet: string,
    private readonly token: string | (() => Promise<string>),
    private readonly requestTimeoutMs = 5_000,
  ) {}
  private async authorization(): Promise<string> {
    const token = (typeof this.token === "function" ? await this.token() : this.token).trim();
    if (!token) throw new Error("kubernetes_service_account_token_unavailable");
    return `Bearer ${token}`;
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", await this.authorization());
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    }, this.requestTimeoutMs);
    try {
      return await fetch(`${this.apiServer}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  async currentReplicas(): Promise<number> {
    const response = await this.request(`/apis/apps/v1/namespaces/${this.namespace}/statefulsets/${this.statefulSet}`);
    if (!response.ok) throw new Error(`statefulset_read_failed:${response.status}`);
    const body = await response.json() as { spec?: { replicas?: number } };
    const replicas = Number(body.spec?.replicas);
    if (!Number.isInteger(replicas) || replicas < 0) throw new Error("statefulset_invalid_replicas");
    return replicas;
  }
  async scale(replicas: number): Promise<void> {
    const response = await this.request(`/apis/apps/v1/namespaces/${this.namespace}/statefulsets/${this.statefulSet}`, {
      method: "PATCH",
      headers: { "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { replicas } }),
    });
    if (!response.ok) throw new Error(`statefulset_scale_failed:${response.status}`);
  }

  async deletePod(podName: string): Promise<void> {
    if (!new RegExp(`^${this.statefulSet}-\\d+$`).test(podName)) throw new Error("invalid_game_pod");
    const response = await this.request(`/api/v1/namespaces/${this.namespace}/pods/${podName}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`pod_delete_failed:${response.status}`);
  }
}
