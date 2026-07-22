export interface ReplicaScaler {
  readonly managed: boolean;
  currentReplicas(): Promise<number | undefined>;
  currentWorkloads(): Promise<RoomWorkload[] | undefined>;
  scale(replicas: number): Promise<void>;
  deletePod(roomId: string): Promise<string>;
}

export interface RoomWorkload {
  roomId: string;
  ordinal: number;
  deploymentName: string;
  serviceName: string;
  endpoint: string;
  replicas: number;
}

export class NoopScaler implements ReplicaScaler {
  readonly managed = false;
  async currentReplicas(): Promise<number | undefined> { return undefined; }
  async currentWorkloads(): Promise<RoomWorkload[] | undefined> { return undefined; }
  async scale(_replicas: number): Promise<void> { throw new Error("room_scaling_requires_kubernetes"); }
  async deletePod(_roomId: string): Promise<string> { throw new Error("pod_failure_injection_requires_kubernetes"); }
}

interface KubernetesDeployment {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { replicas?: number };
}

interface KubernetesService {
  metadata?: { name?: string; labels?: Record<string, string> };
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
  private parseRoomId(labels: Record<string, string> | undefined): { roomId: string; ordinal: number } | undefined {
    const roomId = labels?.["game.opsia.dev/room-id"];
    const match = roomId?.match(/^room-(\d+)$/);
    const ordinal = Number(match?.[1]);
    if (!match || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.roomCount) return undefined;
    return { roomId: roomId!, ordinal };
  }

  private async roomWorkloads(): Promise<RoomWorkload[]> {
    const [deploymentResponse, serviceResponse] = await Promise.all([
      this.request(`/apis/apps/v1/namespaces/${this.namespace}/deployments?labelSelector=${encodeURIComponent("opsia.dev/fleet=live")}`),
      this.request(`/api/v1/namespaces/${this.namespace}/services?labelSelector=${encodeURIComponent("app=game-server")}`),
    ]);
    if (!deploymentResponse.ok) throw new Error(`room_deployments_read_failed:${deploymentResponse.status}`);
    if (!serviceResponse.ok) throw new Error(`room_services_read_failed:${serviceResponse.status}`);
    const deployments = await deploymentResponse.json() as { items?: KubernetesDeployment[] };
    const services = await serviceResponse.json() as { items?: KubernetesService[] };
    const servicesByRoomId = new Map<string, string>();
    for (const service of services.items ?? []) {
      const room = this.parseRoomId(service.metadata?.labels);
      const name = service.metadata?.name?.trim();
      if (!room || !name) continue;
      if (servicesByRoomId.has(room.roomId)) throw new Error("room_service_duplicate");
      servicesByRoomId.set(room.roomId, name);
    }
    const workloads: RoomWorkload[] = [];
    const discovered = new Set<string>();
    for (const deployment of deployments.items ?? []) {
      const room = this.parseRoomId(deployment.metadata?.labels);
      if (!room) continue;
      const deploymentName = deployment.metadata?.name?.trim();
      const replicas = Number(deployment.spec?.replicas);
      if (!deploymentName || !Number.isInteger(replicas) || replicas < 0 || replicas > 1) {
        throw new Error("room_deployment_invalid_replicas");
      }
      if (discovered.has(room.roomId)) throw new Error("room_deployment_duplicate");
      const serviceName = servicesByRoomId.get(room.roomId);
      if (!serviceName) throw new Error("room_service_not_found");
      discovered.add(room.roomId);
      workloads.push({
        roomId: room.roomId,
        ordinal: room.ordinal,
        deploymentName,
        serviceName,
        endpoint: `http://${serviceName}:8001`,
        replicas,
      });
    }
    return workloads.sort((left, right) => left.ordinal - right.ordinal);
  }

  async currentWorkloads(): Promise<RoomWorkload[]> { return this.roomWorkloads(); }

  async currentReplicas(): Promise<number> {
    return (await this.roomWorkloads()).filter((workload) => workload.replicas === 1).length;
  }

  async scale(replicas: number): Promise<void> {
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > this.roomCount) {
      throw new Error("invalid_replicas");
    }
    const deployments = await this.roomWorkloads();
    await Promise.all(deployments.map(async (workload) => {
      const desired = workload.ordinal < replicas ? 1 : 0;
      if (workload.replicas === desired) return;
      const response = await this.request(`/apis/apps/v1/namespaces/${this.namespace}/deployments/${workload.deploymentName}`, {
        method: "PATCH",
        headers: { "content-type": "application/merge-patch+json" },
        body: JSON.stringify({ spec: { replicas: desired } }),
      });
      if (!response.ok) throw new Error(`room_deployment_scale_failed:${workload.deploymentName}:${response.status}`);
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
