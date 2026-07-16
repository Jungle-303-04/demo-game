export interface ReplicaScaler { scale(replicas: number): Promise<void>; }

export class NoopScaler implements ReplicaScaler { async scale(_replicas: number): Promise<void> {} }

export class KubernetesStatefulSetScaler implements ReplicaScaler {
  constructor(private readonly apiServer: string, private readonly namespace: string, private readonly statefulSet: string, private readonly token: string) {}
  async scale(replicas: number): Promise<void> {
    const response = await fetch(`${this.apiServer}/apis/apps/v1/namespaces/${this.namespace}/statefulsets/${this.statefulSet}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { replicas } }),
    });
    if (!response.ok) throw new Error(`statefulset_scale_failed:${response.status}`);
  }
}
