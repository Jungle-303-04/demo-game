export interface ReplicaScaler {
  readonly managed: boolean;
  currentReplicas(): Promise<number | undefined>;
  scale(replicas: number): Promise<void>;
  deletePod(roomId: string): Promise<string>;
}

export class NoopScaler implements ReplicaScaler {
  readonly managed = false;
  async currentReplicas(): Promise<number | undefined> { return undefined; }
  async scale(_replicas: number): Promise<void> { throw new Error("room_scaling_requires_kubernetes"); }
  async deletePod(_roomId: string): Promise<string> { throw new Error("pod_failure_injection_requires_kubernetes"); }
}

interface KubernetesDeployment {
  metadata?: { name?: string };
  spec?: { replicas?: number };
}

interface KubernetesPod {
  metadata?: { name?: string; creationTimestamp?: string; deletionTimestamp?: string };
  status?: { phase?: string };
}

export class KubernetesRoomDeploymentScaler implements ReplicaScaler {
  readonly managed = true;
  constructor(
    private readonly apiServer: string,
    private readonly namespace: string,
    private readonly deploymentPrefix: string,
    private readonly roomCount: number,
    private readonly token: string | (() => Promise<string>),
    private readonly requestTimeoutMs = 5_000,
  ) {
    if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(deploymentPrefix)) {
      throw new Error("invalid_game_deployment_prefix");
    }
    if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > 100) {
      throw new Error("invalid_game_deployment_count");
    }
  }
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
  private deploymentName(ordinal: number): string {
    return `${this.deploymentPrefix}-${ordinal}`;
  }

  private async roomDeployments(): Promise<Map<number, number>> {
    const selector = encodeURIComponent("opsia.dev/fleet=live");
    const response = await this.request(
      `/apis/apps/v1/namespaces/${this.namespace}/deployments?labelSelector=${selector}`,
    );
    if (!response.ok) throw new Error(`room_deployments_read_failed:${response.status}`);
    const body = await response.json() as { items?: KubernetesDeployment[] };
    const deployments = new Map<number, number>();
    for (const item of body.items ?? []) {
      const name = item.metadata?.name ?? "";
      const match = name.match(new RegExp(`^${this.deploymentPrefix}-(\\d+)$`));
      if (!match) continue;
      const ordinal = Number(match[1]);
      const replicas = Number(item.spec?.replicas);
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.roomCount
        || !Number.isInteger(replicas) || replicas < 0 || replicas > 1) {
        throw new Error("room_deployment_invalid_replicas");
      }
      deployments.set(ordinal, replicas);
    }
    if (deployments.size !== this.roomCount) throw new Error("room_deployment_inventory_incomplete");
    return deployments;
  }

  async currentReplicas(): Promise<number> {
    const deployments = await this.roomDeployments();
    let activeRooms = 0;
    let foundInactive = false;
    for (let ordinal = 0; ordinal < this.roomCount; ordinal += 1) {
      const replicas = deployments.get(ordinal);
      if (replicas === 1) {
        if (foundInactive) throw new Error("room_deployments_not_contiguous");
        activeRooms += 1;
      } else {
        foundInactive = true;
      }
    }
    return activeRooms;
  }

  async scale(replicas: number): Promise<void> {
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > this.roomCount) {
      throw new Error("invalid_replicas");
    }
    const deployments = await this.roomDeployments();
    await Promise.all([...deployments].map(async ([ordinal, current]) => {
      const desired = ordinal < replicas ? 1 : 0;
      if (current === desired) return;
      const name = this.deploymentName(ordinal);
      const response = await this.request(`/apis/apps/v1/namespaces/${this.namespace}/deployments/${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/merge-patch+json" },
        body: JSON.stringify({ spec: { replicas: desired } }),
      });
      if (!response.ok) throw new Error(`room_deployment_scale_failed:${name}:${response.status}`);
    }));
  }

  async deletePod(roomId: string): Promise<string> {
    const match = roomId.match(/^room-(\d+)$/);
    const ordinal = Number(match?.[1]);
    if (!match || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.roomCount) {
      throw new Error("invalid_room_id");
    }
    const selector = encodeURIComponent(`opsia.dev/fleet=live,game.opsia.dev/room-id=${roomId}`);
    const listResponse = await this.request(
      `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${selector}`,
    );
    if (!listResponse.ok) throw new Error(`room_pods_read_failed:${listResponse.status}`);
    const body = await listResponse.json() as { items?: KubernetesPod[] };
    const selected = (body.items ?? [])
      .filter((pod) => pod.metadata?.name && !pod.metadata.deletionTimestamp && pod.status?.phase === "Running")
      .sort((left, right) => String(left.metadata?.creationTimestamp ?? "")
        .localeCompare(String(right.metadata?.creationTimestamp ?? "")))[0];
    const podName = selected?.metadata?.name;
    if (!podName) throw new Error("active_room_pod_not_found");
    const response = await this.request(`/api/v1/namespaces/${this.namespace}/pods/${podName}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`pod_delete_failed:${response.status}`);
    return podName;
  }
}
