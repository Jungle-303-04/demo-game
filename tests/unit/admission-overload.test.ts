import assert from "node:assert/strict";
import test from "node:test";
import {
  AdmissionOverloadFuse,
  type AdmissionOverloadStatus,
} from "../../services/api-server/src/admission-overload.js";

test("ordinary admission traffic cannot trip an unarmed overload fuse", () => {
  let trips = 0;
  const fuse = new AdmissionOverloadFuse({
    thresholdRequests: 3,
    onTrip: () => { trips += 1; },
  });

  for (let index = 0; index < 100; index += 1) fuse.observeRequest();

  assert.equal(trips, 0);
  assert.deepEqual(fuse.status(), {
    armed: false,
    tripped: false,
    recentRequests: 0,
    thresholdRequests: 3,
    windowMs: 1_000,
  });
});

test("an armed fuse trips once after real requests cross the rolling threshold", () => {
  let now = Date.parse("2026-07-24T00:00:00.000Z");
  const trips: AdmissionOverloadStatus[] = [];
  const fuse = new AdmissionOverloadFuse({
    thresholdRequests: 3,
    windowMs: 1_000,
    now: () => now,
    onTrip: (status) => trips.push(status),
  });

  assert.equal(fuse.arm().armed, true);
  fuse.observeRequest();
  now += 100;
  fuse.observeRequest();
  now += 100;
  const tripped = fuse.observeRequest();
  fuse.observeRequest();

  assert.equal(tripped.armed, false);
  assert.equal(tripped.tripped, true);
  assert.equal(tripped.recentRequests, 3);
  assert.equal(trips.length, 1);
  assert.equal(trips[0]?.trippedAt, "2026-07-24T00:00:00.200Z");
});

test("requests outside the rolling window and disarmed traffic do not trip the fuse", () => {
  let now = 0;
  let trips = 0;
  const fuse = new AdmissionOverloadFuse({
    thresholdRequests: 3,
    windowMs: 1_000,
    now: () => now,
    onTrip: () => { trips += 1; },
  });

  fuse.arm();
  fuse.observeRequest();
  now += 1_001;
  fuse.observeRequest();
  assert.equal(fuse.status().recentRequests, 1);

  fuse.disarm();
  fuse.observeRequest();
  fuse.observeRequest();
  fuse.observeRequest();
  assert.equal(trips, 0);
  assert.equal(fuse.status().armed, false);
});
