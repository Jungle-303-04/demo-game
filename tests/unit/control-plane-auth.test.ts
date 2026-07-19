import assert from "node:assert/strict";
import test from "node:test";
import {
  controlTokenMatches,
  readControlToken,
  withControlToken,
} from "../../services/control-plane-auth.js";

test("control token startup guard rejects a required empty token", () => {
  assert.throws(
    () => readControlToken({ REQUIRE_CONTROL_TOKEN: "true" }),
    /OPS_CONTROL_TOKEN is required/,
  );
  assert.equal(readControlToken({ REQUIRE_CONTROL_TOKEN: "true", OPS_CONTROL_TOKEN: "  secret  " }), "secret");
});

test("control token comparison accepts only the exact bearer credential", () => {
  assert.equal(controlTokenMatches("Bearer service-secret", "service-secret"), true);
  assert.equal(controlTokenMatches("bearer service-secret", "service-secret"), true);
  assert.equal(controlTokenMatches("Bearer wrong", "service-secret"), false);
  assert.equal(controlTokenMatches(undefined, "service-secret"), false);
  assert.equal(controlTokenMatches("Basic service-secret", "service-secret"), false);
});

test("control client helper preserves headers and attaches the bearer credential", () => {
  const init = withControlToken({ headers: { "content-type": "application/json" } }, "service-secret");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer service-secret");
});
