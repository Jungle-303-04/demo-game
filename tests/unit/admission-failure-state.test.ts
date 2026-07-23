import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AdmissionFailureState } from "../../services/api-server/src/admission-failure-state.js";

test("admission failure survives a process restart until explicit recovery", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opsia-admission-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "admission-overload.failed");

  const firstProcess = new AdmissionFailureState(marker);
  assert.equal(firstProcess.failed(), false);
  firstProcess.trip();
  assert.equal(firstProcess.failed(), true);

  const restartedProcess = new AdmissionFailureState(marker);
  assert.equal(restartedProcess.failed(), true);
  restartedProcess.recover();
  assert.equal(restartedProcess.failed(), false);
});
