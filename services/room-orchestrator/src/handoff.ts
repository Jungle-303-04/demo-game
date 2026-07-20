import { randomUUID } from "node:crypto";
import { type OperationEventContext, OperationEventPublisher } from "./events.js";

export interface RoomResourceRef {
  kind: "Pod";
  name: string;
  uid: string;
  resourceVersion?: string;
}

export interface RoomHandoffTarget {
  roomId: string;
  activeEndpoint: string;
  activePod: RoomResourceRef;
  currentEpoch: number;
  revision: string;
  /** Runtime digest approved by the sealed Canary evidence bundle. */
  imageDigest?: string;
  workflowRunId?: string;
  applicationId?: string;
}

export interface RoomCandidate extends RoomResourceRef {
  endpoint: string;
  revision: string;
  imageDigest?: string;
}

export interface SnapshotSeedResult {
  checksum: string;
  snapshotTick: number;
  payloadBytes: number;
}

export interface JournalCatchUpResult {
  activeTick: number;
  candidateTick: number;
  lagTicks: number;
  checksum?: string;
}

export interface PostVerificationResult {
  healthy: boolean;
  sessionContinuity: boolean;
  stateChecksum: string;
}

export interface RoomHandoffDriver {
  scheduleCandidate(target: RoomHandoffTarget, operationId: string): Promise<RoomCandidate>;
  waitUntilReady(candidate: RoomCandidate): Promise<void>;
  freezeGateway(input: {
    operationId: string;
    roomId: string;
    expectedEpoch: number;
  }): Promise<{ sessions: number; unackedInputs: number }>;
  abortGatewayPreparation(input: {
    operationId: string;
    roomId: string;
  }): Promise<void>;
  seedSnapshot(target: RoomHandoffTarget, candidate: RoomCandidate): Promise<SnapshotSeedResult>;
  catchUpJournal(target: RoomHandoffTarget, candidate: RoomCandidate, snapshotTick: number): Promise<JournalCatchUpResult>;
  candidateChecksum(candidate: RoomCandidate): Promise<string>;
  cutoverGateway(input: {
    operationId: string;
    roomId: string;
    endpoint: string;
    expectedEpoch: number;
    nextEpoch: number;
    revision: string;
    checksum: string;
  }): Promise<{ sessions: number; replayedInputs: number }>;
  rollbackGateway(input: {
    operationId: string;
    roomId: string;
    endpoint: string;
    expectedEpoch: number;
    nextEpoch: number;
    revision: string;
  }): Promise<{ sessions: number; replayedInputs: number; roomEpoch: number }>;
  verify(candidate: RoomCandidate, expectedChecksum: string): Promise<PostVerificationResult>;
  activateCandidate(input: {
    target: RoomHandoffTarget;
    candidate: RoomCandidate;
    roomEpoch: number;
    checksum: string;
  }): Promise<{ checksum: string }>;
  finalizeGateway(input: { operationId: string; roomId: string; roomEpoch: number }): Promise<void>;
  drainOldPod(target: RoomHandoffTarget): Promise<void>;
  discardCandidate(candidate: RoomCandidate, reason: string): Promise<void>;
}

export interface RoomHandoffResult {
  operationId: string;
  roomId: string;
  oldEpoch: number;
  newEpoch: number;
  checksum: string;
  sessions: number;
  replayedInputs: number;
  candidate: RoomCandidate;
}

/**
 * Drivers must use this error when the Gateway epoch changed but a later
 * authority/promote step failed. The coordinator then follows the post-cutover
 * rollback path and never deletes the serving Candidate as if it were unused.
 */
export class RoomCutoverCommittedError extends Error {
  constructor(
    message: string,
    readonly committedEpoch: number,
  ) {
    super(message);
    this.name = "RoomCutoverCommittedError";
  }
}

type HandoffStage =
  | "schedule"
  | "ready"
  | "freeze"
  | "snapshot"
  | "journal"
  | "checksum"
  | "cutover"
  | "verify"
  | "activate"
  | "drain";

export class RoomHandoffCoordinator {
  private activeOperation?: string;

  constructor(
    private readonly driver: RoomHandoffDriver,
    private readonly events: OperationEventPublisher,
    private readonly workspaceId = "demo-game",
    private readonly clusterId = "game-server",
    private readonly namespace = "sandbox",
    private readonly totalWaves = 5,
  ) {
    if (!Number.isSafeInteger(totalWaves) || totalWaves < 1) throw new Error("invalid_handoff_total_waves");
  }

  async handoff(target: RoomHandoffTarget, requestedOperationId?: string): Promise<RoomHandoffResult> {
    if (this.activeOperation) throw new Error("handoff_wave_already_running");
    const roomOrdinal = Number(target.roomId.match(/^room-(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(roomOrdinal) || roomOrdinal < 0 || roomOrdinal >= this.totalWaves) {
      throw new Error("invalid_handoff_wave_room");
    }
    const operationId = requestedOperationId ?? `op_${randomUUID()}`;
    this.activeOperation = operationId;
    const context: OperationEventContext = {
      operationId,
      workspaceId: this.workspaceId,
      workflowRunId: target.workflowRunId ?? operationId,
      applicationId: target.applicationId ?? "demo-game",
    };
    let stage: HandoffStage = "schedule";
    let candidate: RoomCandidate | undefined;
    let gatewayFrozen = false;
    let authorityTransferStarted = false;
    let authorityCommitted = false;
    let cutoverCommitted = false;
    let committedEpoch = target.currentEpoch;
    const common = {
      operation_id: operationId,
      workflow_run_id: context.workflowRunId,
      application_id: context.applicationId,
      cluster_id: this.clusterId,
      namespace: this.namespace,
      room_id: target.roomId,
      git_revision: target.revision,
    };
    const wave = { wave_number: roomOrdinal + 1, total_waves: this.totalWaves };

    try {
      await this.events.publish(context, "RolloutWaveStarted", {
        ...common,
        ...wave,
        room_epoch: target.currentEpoch,
        status: "running",
      });
      candidate = await this.driver.scheduleCandidate(target, operationId);
      if (candidate.revision !== target.revision) {
        throw new Error("candidate_revision_mismatch");
      }
      if (target.imageDigest && candidate.imageDigest !== target.imageDigest) {
        throw new Error("candidate_image_digest_mismatch");
      }
      await this.events.publish(context, "RoomCandidateScheduled", {
        ...common,
        resource_ref: candidate,
        ...(candidate.imageDigest ? { image_digest: candidate.imageDigest } : {}),
        room_epoch: target.currentEpoch,
        status: "running",
      });

      stage = "ready";
      await this.driver.waitUntilReady(candidate);
      await this.events.publish(context, "RoomCandidateReady", {
        ...common,
        resource_ref: candidate,
        status: "completed",
      });

      stage = "freeze";
      const frozen = await this.driver.freezeGateway({
        operationId,
        roomId: target.roomId,
        expectedEpoch: target.currentEpoch,
      });
      gatewayFrozen = true;

      stage = "snapshot";
      const seeded = await this.driver.seedSnapshot(target, candidate);
      let expectedChecksum = seeded.checksum;
      await this.events.publish(context, "RoomSnapshotSeeded", {
        ...common,
        resource_ref: candidate,
        server_tick: seeded.snapshotTick,
        state_checksum: seeded.checksum,
        payload_bytes: seeded.payloadBytes,
        frozen_sessions: frozen.sessions,
        buffered_inputs: frozen.unackedInputs,
        status: "completed",
      });

      stage = "journal";
      const caughtUp = await this.driver.catchUpJournal(target, candidate, seeded.snapshotTick);
      if (caughtUp.lagTicks !== 0 || caughtUp.candidateTick !== caughtUp.activeTick) {
        throw new Error(`candidate_tick_lag:${caughtUp.lagTicks}`);
      }
      await this.events.publish(context, "RoomJournalCaughtUp", {
        ...common,
        resource_ref: candidate,
        server_tick: caughtUp.candidateTick,
        lag_ticks: caughtUp.lagTicks,
        state_checksum: caughtUp.checksum ?? expectedChecksum,
        status: "completed",
      });
      expectedChecksum = caughtUp.checksum ?? expectedChecksum;

      stage = "checksum";
      let candidateChecksum = await this.driver.candidateChecksum(candidate);
      if (candidateChecksum !== expectedChecksum) {
        await this.events.publish(context, "RoomChecksumMismatched", {
          ...common,
          resource_ref: candidate,
          expected_checksum: expectedChecksum,
          actual_checksum: candidateChecksum,
          status: "blocked",
          reason_code: "state_checksum_mismatch",
        });
        throw new Error("state_checksum_mismatch");
      }
      await this.events.publish(context, "RoomChecksumMatched", {
        ...common,
        resource_ref: candidate,
        state_checksum: candidateChecksum,
        status: "completed",
      });

      const newEpoch = target.currentEpoch + 1;
      // The Candidate must own the lease at the new fencing epoch before the
      // stable Gateway route can point at it. The final release checkpoint may
      // be newer than the preflight checksum, so the driver returns the exact
      // promoted checksum used for both the route and post-cutover proof.
      stage = "activate";
      authorityTransferStarted = true;
      const authority = await this.driver.activateCandidate({
        target,
        candidate,
        roomEpoch: newEpoch,
        checksum: candidateChecksum,
      });
      authorityCommitted = true;
      committedEpoch = newEpoch;
      candidateChecksum = authority.checksum;
      await this.events.publish(context, "RoomEpochFenced", {
        ...common,
        resource_ref: candidate,
        old_epoch: target.currentEpoch,
        room_epoch: newEpoch,
        state_checksum: candidateChecksum,
        status: "completed",
      });

      stage = "cutover";
      const cutover = await this.driver.cutoverGateway({
        operationId,
        roomId: target.roomId,
        endpoint: candidate.endpoint,
        expectedEpoch: target.currentEpoch,
        nextEpoch: newEpoch,
        revision: target.revision,
        checksum: candidateChecksum,
      });
      cutoverCommitted = true;
      gatewayFrozen = false;
      await this.events.publish(context, "RoomGatewayCutover", {
        ...common,
        resource_ref: candidate,
        room_epoch: newEpoch,
        sessions: cutover.sessions,
        status: "completed",
      });
      await this.events.publish(context, "RoomInputReplayCompleted", {
        ...common,
        resource_ref: candidate,
        room_epoch: newEpoch,
        replayed_inputs: cutover.replayedInputs,
        status: "completed",
      });

      stage = "verify";
      const verification = await this.driver.verify(candidate, candidateChecksum);
      if (!verification.healthy || !verification.sessionContinuity || verification.stateChecksum !== candidateChecksum) {
        throw new Error("post_cutover_verification_failed");
      }
      await this.events.publish(context, "RoomPostVerificationCompleted", {
        ...common,
        resource_ref: candidate,
        room_epoch: newEpoch,
        session_continuity: verification.sessionContinuity,
        state_checksum: verification.stateChecksum,
        status: "completed",
      });
      await this.driver.finalizeGateway({ operationId, roomId: target.roomId, roomEpoch: newEpoch });

      stage = "drain";
      await this.driver.drainOldPod(target);
      await this.events.publish(context, "RoomOldPodDrained", {
        ...common,
        resource_ref: target.activePod,
        room_epoch: newEpoch,
        status: "completed",
      });
      await this.events.publish(context, "RolloutWaveCompleted", {
        ...common,
        ...wave,
        room_epoch: newEpoch,
        status: "completed",
      });

      return {
        operationId,
        roomId: target.roomId,
        oldEpoch: target.currentEpoch,
        newEpoch,
        checksum: candidateChecksum,
        sessions: cutover.sessions,
        replayedInputs: cutover.replayedInputs,
        candidate,
      };
    } catch (error) {
      if (error instanceof RoomCutoverCommittedError) {
        cutoverCommitted = true;
        gatewayFrozen = false;
        committedEpoch = error.committedEpoch;
      }
      let reason = error instanceof Error ? error.message : "room_handoff_failed";
      let rollback = "active_preserved";
      let reportedEpoch = committedEpoch;
      let mayDiscardCandidate = !authorityTransferStarted && !cutoverCommitted;

      if (gatewayFrozen && !authorityTransferStarted && !cutoverCommitted) {
        try {
          await this.driver.abortGatewayPreparation({
            operationId,
            roomId: target.roomId,
          });
          gatewayFrozen = false;
          rollback = "active_resumed";
        } catch (abortError) {
          const abortReason = abortError instanceof Error ? abortError.message : "gateway_abort_failed";
          reason = `${reason};abort:${abortReason}`;
          rollback = "gateway_abort_failed";
          mayDiscardCandidate = false;
        }
      }

      // Once authority transfer starts, an RPC failure is ambiguous: the old
      // lease may have been released or the Candidate may already own the new
      // epoch even when the caller missed the response. Reconcile observed
      // authority and Gateway state, fencing a strictly newer rollback epoch
      // when needed, before the Candidate can ever be deleted.
      if ((authorityTransferStarted || cutoverCommitted || authorityCommitted) && stage !== "drain") {
        try {
          const rollbackEpoch = committedEpoch + 1;
          const recovered = await this.driver.rollbackGateway({
            operationId,
            roomId: target.roomId,
            endpoint: target.activeEndpoint,
            expectedEpoch: committedEpoch,
            nextEpoch: rollbackEpoch,
            revision: target.revision,
          });
          reportedEpoch = recovered.roomEpoch;
          rollback = "gateway_rolled_back";
          mayDiscardCandidate = true;
        } catch (rollbackError) {
          const rollbackReason = rollbackError instanceof Error
            ? rollbackError.message
            : "gateway_rollback_failed";
          reason = `${reason};rollback:${rollbackReason}`;
          rollback = "rollback_failed_candidate_retained";
          mayDiscardCandidate = false;
        }
      } else if (cutoverCommitted || authorityCommitted) {
        rollback = "candidate_retained_after_drain_failure";
      }

      if (candidate && mayDiscardCandidate && stage !== "drain") {
        await this.driver.discardCandidate(candidate, reason).catch(() => undefined);
      }
      await this.events.publish(context, "RoomHandoffFailed", {
        ...common,
        resource_ref: candidate,
        room_epoch: reportedEpoch,
        failed_stage: stage,
        status: "failed",
        reason_code: reason,
        rollback,
      });
      await this.events.publish(context, "RolloutWaveBlocked", {
        ...common,
        ...wave,
        room_epoch: reportedEpoch,
        failed_stage: stage,
        status: "blocked",
        reason_code: reason,
      });
      throw error;
    } finally {
      this.activeOperation = undefined;
    }
  }
}
