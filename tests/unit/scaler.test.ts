import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesRoomDeploymentScaler } from "../../services/room-orchestrator/src/scaler.js";

const deploymentInventory = (replicas: number[]) => ({
  items: replicas.map((count, ordinal) => ({
    metadata: { name: `game-room-${ordinal}` },
    spec: { replicas: count },
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
  await scaler.deletePod("game-room-1");

  assert.deepEqual(authorizations, [
    "Bearer projected-token-a",
    "Bearer projected-token-b",
    "Bearer projected-token-b",
    "Bearer projected-token-c",
    "Bearer projected-token-c",
  ]);
  assert.equal(new Set(signals).size, 5);
  assert.ok(requests.some((request) => request.url.endsWith("/deployments/game-room-2")
    && request.method === "PATCH"
    && request.body === JSON.stringify({ spec: { replicas: 0 } })));
  assert.ok(requests.some((request) => request.url.endsWith("/pods/game-room-1-active")
    && request.method === "DELETE"));
});

test("Kubernetes room scaler rejects non-contiguous active Deployments", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => new Response(JSON.stringify(deploymentInventory([1, 0, 1, 0, 0])), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const scaler = new KubernetesRoomDeploymentScaler(
    "https://kubernetes.default.svc",
    "sandbox",
    "game-room",
    5,
    "projected-token",
  );
  await assert.rejects(scaler.currentReplicas(), /room_deployments_not_contiguous/);
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
