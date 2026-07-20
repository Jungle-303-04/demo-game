import assert from "node:assert/strict";
import test from "node:test";
import { isPublicControlPlaneRead } from "../../services/ops-console/src/public-api.js";

test("read-only room telemetry is public while mutations remain protected", () => {
  assert.equal(isPublicControlPlaneRead("GET", "/api/admin/rooms"), true);
  assert.equal(isPublicControlPlaneRead("GET", "/api/admin/events"), true);
  assert.equal(isPublicControlPlaneRead("GET", "/api/admin/scenarios"), false);
  assert.equal(isPublicControlPlaneRead("POST", "/api/admin/rooms"), false);
  assert.equal(
    isPublicControlPlaneRead("POST", "/api/admin/rooms/room-0/scenarios/process-crash/start"),
    false,
  );
  assert.equal(isPublicControlPlaneRead("PUT", "/api/admin/rooms/room-0/join-lock"), false);
  assert.equal(isPublicControlPlaneRead("GET", "/api/admin/rooms/room-0/bot-jobs/job-1"), false);
});
