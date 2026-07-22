import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesRoomDeploymentScaler } from "../../services/room-orchestrator/src/scaler.js";

const deploymentInventory = (replicas: number[]) => ({
  items: replicas.map((count, ordinal) => ({
    metadata: {
      name: `game-server-live-${ordinal}-7f8c9d`,
      labels: {
        "opsia.dev/fleet": "live",
        "game.opsia.dev/room-id": `room-${ordinal}`,
      },
    },
    spec: { replicas: count },
  })),
});

const serviceInventory = (ordinals: number[]) => ({
  items: ordinals.map((ordinal) => ({
    metadata: {
      name: `game-room-${ordinal}`,
      labels: {
        app: "game-server",
        "game.opsia.dev/room-id": `room-${ordinal}`,
      },
    },
  })),
});

test("Kubernetes room scaler reconciles per-room Deployments and resolves the active Pod", async (context) => {
  const originalFetch = globalThis.fetch;
  let token = "projected-token-a";
  const authorizations: string[] = [];
  const signals: AbortSignal[] = [];
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    assert.ok(init?.signal instanceof AbortSignal);
    signals.push(init.signal);
    requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/deployments?")) {
      return new Response(JSON.stringify(deploymentInventory([1, 1, 1, 0, 0])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/services?")) {
      return new Response(JSON.stringify(serviceInventory([0, 1, 2, 3, 4])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/pods?")) {
      return new Response(JSON.stringify({
        items: [
          { metadata: { name: "game-room-1-candidate", creationTimestamp: "2026-07-20T00:01:00Z" }, status: { phase: "Running" } },
          { metadata: { name: "game-room-1-active", creationTimestamp: "2026-07-20T00:00:00Z" }, status: { phase: "Running" } },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const scaler = new KubernetesRoomDeploymentScaler(
    "https://kubernetes.default.svc",
    "sandbox",
    "game-room",
    5,
    async () => token,
  );

  assert.equal(await scaler.currentReplicas(), 3);
  token = "projected-token-b";
  await scaler.scale(2);
  token = "projected-token-c";
  const deletedPodName = await scaler.deletePod("room-1");
  assert.equal(deletedPodName, "game-room-1-active");

  assert.deepEqual(authorizations, [
    "Bearer projected-token-a",
    "Bearer projected-token-a",
    "Bearer projected-token-b",
    "Bearer projected-token-b",
    "Bearer projected-token-b",
    "Bearer projected-token-c",
    "Bearer projected-token-c",
  ]);
  assert.equal(new Set(signals).size, 7);
  assert.ok(requests.some((request) => request.url.endsWith("/deployments/game-server-live-2-7f8c9d")
    && request.method === "PATCH"
    && request.body === JSON.stringify({ spec: { replicas: 0 } })));
  assert.ok(requests.some((request) => request.url.endsWith("/pods/game-room-1-active")
    && request.method === "DELETE"));
  const podListRequest = requests.find((request) => request.url.includes("/pods?"));
  assert.ok(podListRequest?.url.includes("game.opsia.dev%2Froom-id%3Droom-1"));
});

test("Kubernetes room scaler discovers a new room by stable roomId label instead of workload name", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const body = url.includes("/deployments?")
      ? {
        items: [{
          metadata: {
            name: "suroi-unstable-name-abc123",
            labels: { "opsia.dev/fleet": "live", "game.opsia.dev/room-id": "room-6" },
          },
          spec: { replicas: 1 },
        }],
      }
      : serviceInventory([6]);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const scaler = new KubernetesRoomDeploymentScaler(
    "https://kubernetes.default.svc",
    "sandbox",
    "game-room",
    20,
    "projected-token",
  );
  assert.deepEqual(await scaler.currentWorkloads(), [{
    roomId: "room-6",
    ordinal: 6,
    deploymentName: "suroi-unstable-name-abc123",
    serviceName: "game-room-6",
    endpoint: "http://game-room-6:8001",
    replicas: 1,
  }]);
});

test("Kubernetes room scaler aborts an unresponsive API request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const rejectWithReason = () => reject(init.signal?.reason);
    if (init.signal.aborted) rejectWithReason();
    else init.signal.addEventListener("abort", rejectWithReason, { once: true });
  })) as typeof fetch;
  const scaler = new KubernetesRoomDeploymentScaler(
    "https://kubernetes.default.svc",
    "sandbox",
    "game-room",
    5,
    "projected-token",
    10,
  );

  await assert.rejects(
    scaler.currentReplicas(),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
});
