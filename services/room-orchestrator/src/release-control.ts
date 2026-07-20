import type { GameOperationEvent } from "./events.js";

export type ReleaseOperationKind = "canary" | "handoff";

export interface ReleaseOperationReservation {
  readonly kind: ReleaseOperationKind;
  readonly operationId: string;
  /** Finish a successfully-created operation. Its id stays reserved. */
  release(): void;
  /** Roll back a failed preflight before the operation became durable. */
  abort(): void;
}

interface ActiveReservation {
  kind: ReleaseOperationKind;
  operationId: string;
  token: symbol;
}

/**
 * Serializes the async "check then reserve" boundary shared by Canary and
 * live handoff HTTP requests. JavaScript's single thread is not sufficient
 * here because durable operation-id checks yield to the event loop.
 */
export class ReleaseOperationGate {
  private tail: Promise<void> = Promise.resolve();
  private active?: ActiveReservation;
  private readonly knownOperationIds = new Set<string>();

  async reserve(
    kind: ReleaseOperationKind,
    operationId: string,
    persistedOperationExists: () => Promise<boolean>,
  ): Promise<ReleaseOperationReservation> {
    return this.serialize(async () => {
      if (this.active) {
        const prefix = this.active.kind === "canary"
          ? "canary_validation_already_running"
          : "handoff_wave_already_running";
        throw new Error(`${prefix}:${this.active.operationId}`);
      }
      if (this.knownOperationIds.has(operationId) || await persistedOperationExists()) {
        throw new Error("operation_id_already_exists");
      }

      const token = Symbol(operationId);
      this.active = { kind, operationId, token };
      this.knownOperationIds.add(operationId);
      let settled = false;
      const finish = (abort: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.active?.token === token) this.active = undefined;
        if (abort) this.knownOperationIds.delete(operationId);
      };
      return {
        kind,
        operationId,
        release: () => finish(false),
        abort: () => finish(true),
      };
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const imageDigestPattern = /^sha256:[a-f\d]{64}$/;

export interface SealedCanaryApproval {
  operationId: string;
  revision: string;
  imageDigest: string;
  bundleId: string;
  approvalEventId: string;
  bundleEventId: string;
}

/**
 * Projects a promotion capability from the durable event stream. An approval
 * decision alone is deliberately insufficient: the same operation must end
 * with a complete evidence bundle that contains that decision and binds the
 * exact runtime image digest observed by Kubernetes.
 */
export const sealedCanaryApprovalForRevision = (
  events: readonly GameOperationEvent[],
  revision: string,
): SealedCanaryApproval | undefined => {
  const byOperation = new Map<string, GameOperationEvent[]>();
  for (const event of events) {
    const operation = byOperation.get(event.correlation_id) ?? [];
    operation.push(event);
    byOperation.set(event.correlation_id, operation);
  }

  const approvals: Array<SealedCanaryApproval & { sealedAt: number }> = [];
  for (const [operationId, unsorted] of byOperation) {
    const operation = [...unsorted].sort((left, right) => left.sequence - right.sequence);
    if (!operation.some((event) => event.payload.room_id === "canary-room"
      && event.payload.git_revision === revision)) continue;
    const terminal = operation.at(-1);
    if (terminal?.subject !== "EvidenceBundleSealed" || terminal.payload.status !== "completed"
      || terminal.payload.room_id !== "canary-room" || terminal.payload.git_revision !== revision) continue;
    const details = terminal.payload.details;
    if (!details || typeof details !== "object"
      || (details as Record<string, unknown>).completeness !== "complete") continue;

    const approval = [...operation].reverse().find((event) => event.subject === "PromotionApproved"
      && event.payload.room_id === "canary-room" && event.payload.git_revision === revision);
    if (!approval || approval.sequence >= terminal.sequence) continue;
    if (operation.some((event) => event.subject === "PromotionBlocked" && event.sequence > approval.sequence)) continue;

    const imageDigest = String(terminal.payload.image_digest ?? "");
    if (!imageDigestPattern.test(imageDigest) || approval.payload.image_digest !== imageDigest) continue;
    const evidenceIds = terminal.payload.evidence_ids;
    if (!Array.isArray(evidenceIds) || !evidenceIds.includes(approval.event_id)) continue;
    const bundleId = String(terminal.payload.bundle_id ?? "");
    if (!bundleId) continue;

    approvals.push({
      operationId,
      revision,
      imageDigest,
      bundleId,
      approvalEventId: approval.event_id,
      bundleEventId: terminal.event_id,
      sealedAt: Date.parse(terminal.created_at),
    });
  }

  const latest = approvals.sort((left, right) => right.sealedAt - left.sealedAt)[0];
  if (!latest) return undefined;
  const { sealedAt: _sealedAt, ...approval } = latest;
  return approval;
};
