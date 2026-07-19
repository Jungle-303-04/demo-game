import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesStatefulSetScaler } from "../../services/room-orchestrator/src/scaler.js";

test("Kubernetes scaler reloads a projected service-account token for every request", async (context) => {
  const originalFetch = globalThis.fetch;
  let token = "projected-token-a";
  const authorizations: string[] = [];
  const signals: AbortSignal[] = [];
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    assert.ok(init?.signal instanceof AbortSignal);
    signals.push(init.signal);
    return new Response(JSON.stringify({ spec: { replicas: 3 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const scaler = new KubernetesStatefulSetScaler(
    "https://kubernetes.default.svc",
    "sandbox",
    "game",
    async () => token,
  );

  assert.equal(await scaler.currentReplicas(), 3);
  token = "projected-token-b";
  await scaler.scale(2);
  token = "projected-token-c";
  await scaler.deletePod("game-1");
  assert.deepEqual(authorizations, [
    "Bearer projected-token-a",
    "Bearer projected-token-b",
    "Bearer projected-token-c",
  ]);
  assert.equal(new Set(signals).size, 3);
});

test("Kubernetes scaler aborts an unresponsive API request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const rejectWithReason = () => reject(init.signal?.reason);
    if (init.signal.aborted) rejectWithReason();
    else init.signal.addEventListener("abort", rejectWithReason, { once: true });
  })) as typeof fetch;
  const scaler = new KubernetesStatefulSetScaler(
    "https://kubernetes.default.svc",
    "sandbox",
    "game",
    "projected-token",
    10,
  );

  await assert.rejects(
    scaler.currentReplicas(),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
});
