#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const TARGET_RPS = 40;
const TICK_MS = 100;
const REQUESTS_PER_TICK = TARGET_RPS / (1_000 / TICK_MS);

const argument = (name, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? "" : fallback;
};

if (process.argv.includes("--help")) {
  process.stdout.write(
    "usage: check-admission-capacity.mjs --endpoint URL --expect healthy|degraded [--duration 25]\n",
  );
  process.exit(0);
}

const endpoint = new URL(argument("endpoint"));
const expectation = argument("expect");
const durationSeconds = Number(argument("duration", "25"));
if (!["healthy", "degraded"].includes(expectation)) {
  throw new Error("expect_must_be_healthy_or_degraded");
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 21 || durationSeconds > 120) {
  throw new Error("duration_must_be_between_21_and_120_seconds");
}
if (!Number.isInteger(REQUESTS_PER_TICK)) throw new Error("target_rps_tick_mismatch");

endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/api/find-game`;
const pending = new Set();
let requests = 0;
let accepted = 0;
let rejected = 0;

const issue = () => {
  const sequence = ++requests;
  const promise = fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      sessionId: `capacity-smoke-${randomUUID()}-${sequence}`,
      nickname: `CapacitySmoke_${sequence}`,
    }),
  })
    .then((response) => {
      if (response.ok) accepted += 1;
      else rejected += 1;
    })
    .catch(() => {
      rejected += 1;
    })
    .finally(() => {
      pending.delete(promise);
    });
  pending.add(promise);
};

const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1_000;
let nextTickAt = startedAt;
while (Date.now() < deadline) {
  // A delayed loop drops missed ticks. It never catches up with a burst.
  if (Date.now() - nextTickAt > TICK_MS * 2) nextTickAt = Date.now();
  for (let index = 0; index < REQUESTS_PER_TICK; index += 1) issue();
  nextTickAt += TICK_MS;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextTickAt - Date.now())));
}
await Promise.allSettled([...pending]);

const failureRatio = requests === 0 ? 1 : rejected / requests;
const observedRequestRps = requests / durationSeconds;
const rateIsSustained = observedRequestRps >= 36 && observedRequestRps <= 44;
const expectationMet =
  expectation === "healthy"
    ? failureRatio < 0.2
    : failureRatio > 0.2;

process.stdout.write(`${JSON.stringify({
  endpoint: endpoint.toString(),
  expectation,
  durationSeconds,
  targetRps: TARGET_RPS,
  observedRequestRps: Number(observedRequestRps.toFixed(1)),
  requests,
  accepted,
  rejected,
  failureRatio: Number(failureRatio.toFixed(4)),
  expectationMet,
  rateIsSustained,
})}\n`);

if (!expectationMet || !rateIsSustained) process.exit(2);
