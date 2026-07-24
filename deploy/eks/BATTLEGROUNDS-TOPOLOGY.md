# Battlegrounds production topology

The `game-server` EKS cluster is presented in Kyro as `battlegrounds-prod`.
Its application workload contract is exactly five worker nodes:

| node role | count | application workloads |
| --- | ---: | --- |
| `kyro.io/workload-role=infra` | 1 | Kyro target agent, gateway, Redis, session gateway, management API/orchestrator/bot/console |
| `kyro.io/workload-role=game` | 4 | `game-room-*` and `canary-room` only |

EKS networking, kube-proxy, CSI, and other required system DaemonSets are
expected on all five nodes and are not application-workload violations.

The rendered application requests are 3 vCPU / 6 GiB across the game pool and
1.3 vCPU / 1.4 GiB on the infra node (plus Kubernetes system overhead). The
four fixed `c6i.2xlarge` game nodes and one `m6i.2xlarge` infra node leave
capacity for concurrent rolling-surge game rooms without changing the
five-node contract.

The game node is tainted `kyro.io/workload-role=game:NoSchedule`. Only the
game room templates have the matching toleration. Every other sandbox
Deployment and StatefulSet is pinned to the infra node by the game-server
Kustomize overlay. The generated Kyro target-agent manifest already prefers
`workload-tier=demo-fast`; the infra node carries that label, while the game
node taint makes the placement strict.

## Safe migration order

1. Create `battlegrounds-infra` and `battlegrounds-game` from
   `game-server-high-capacity.yaml`; wait for both nodes to be Ready.
2. Apply `deploy/k8s/overlays/game-server` and wait for Redis, gateways,
   management, and every game room rollout to be Ready.
3. Verify Redis stays in `ap-northeast-2c`, and verify application placement
   with the commands below.
4. Only after verification, drain and delete the legacy
   `game-server-private` and `game-server-spot-xl-v2` node groups.

Do not scale the two legacy groups down first: the existing Redis EBS volume
is bound to `ap-northeast-2c`, so an arbitrary scale-in can make Redis
unschedulable.

Before any mutation, review the fully resolved node-group request and the
rendered Kubernetes objects:

```sh
eksctl create nodegroup \
  --config-file deploy/eks/game-server-high-capacity.yaml \
  --dry-run
kubectl kustomize deploy/k8s/overlays/game-server \
  | kubectl apply --dry-run=client --validate=false -f -
```

```sh
kubectl --context game-server get nodes \
  -L kyro.io/workload-role,topology.kubernetes.io/zone
kubectl --context game-server get pods -A -o wide --sort-by=.spec.nodeName
kubectl --context game-server -n sandbox get deploy,statefulset -o yaml \
  | grep -E 'name:|kyro.io/workload-role|tolerations' -A3
```
