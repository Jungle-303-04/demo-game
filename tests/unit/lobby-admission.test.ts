import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_LOBBY_ADMISSION_STATUS,
  normalizeLobbyAdmissionStatus,
} from "../../services/ops-console/src/lobby-admission.js";

test("mixed-version room responses without admission data normalize to a safe lobby status", () => {
  assert.deepEqual(
    normalizeLobbyAdmissionStatus(undefined),
    EMPTY_LOBBY_ADMISSION_STATUS,
  );
  assert.deepEqual(
    normalizeLobbyAdmissionStatus({ failureRatePercent: "invalid" }),
    EMPTY_LOBBY_ADMISSION_STATUS,
  );
});

test("lobby admission normalization preserves finite bounded telemetry", () => {
  assert.deepEqual(
    normalizeLobbyAdmissionStatus({
      active: true,
      failureRatePercent: 27.5,
      targetRps: 40,
      requestRps: 39.8,
      incidentTriggered: true,
    }),
    {
      active: true,
      failureRatePercent: 27.5,
      targetRps: 40,
      requestRps: 39.8,
      incidentTriggered: true,
    },
  );
});
