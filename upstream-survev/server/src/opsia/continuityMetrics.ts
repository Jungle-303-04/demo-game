import { Gauge, type Registry } from "prom-client";
import type { OpsiaSnapshotData } from "../game/ipcTypes.ts";

export interface ContinuityMetricIdentity {
    namespace: string;
    resourceKind: string;
    resourceName: string;
    podUid: string;
}

type ContinuitySnapshot = Pick<OpsiaSnapshotData, "roomId" | "players" | "snapshot">;

const nonEmpty = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

export const readContinuityMetricIdentity = (
    env: Readonly<Record<string, string | undefined>> = process.env,
): ContinuityMetricIdentity => {
    const resourceName = nonEmpty(env.OPSIA_WORKLOAD_NAME, "unknown");
    return {
        namespace: nonEmpty(env.POD_NAMESPACE, "unknown"),
        resourceKind: nonEmpty(env.OPSIA_RESOURCE_KIND, "unknown"),
        resourceName,
        podUid: nonEmpty(env.POD_UID, nonEmpty(env.POD_NAME, "unknown")),
    };
};

export const countActiveContinuitySessions = (
    sessions: readonly Pick<OpsiaSnapshotData["players"][number], "connected" | "sessionId">[],
): number =>
    new Set(
        sessions
            .filter((session) => session.connected)
            .map((session) => session.sessionId.trim())
            .filter(Boolean),
    ).size;

export const runtimeContinuityId = (snapshot: ContinuitySnapshot): string | undefined => {
    const roomId = snapshot.roomId.trim();
    const roomEpoch = snapshot.snapshot.roomEpoch;
    return roomId && Number.isSafeInteger(roomEpoch) && roomEpoch >= 0
        ? `${roomId}:epoch:${roomEpoch}`
        : undefined;
};

export class OpsiaContinuityMetrics {
    private readonly activeSessions: Gauge<
        "namespace" | "resource_kind" | "resource_name" | "continuity_id" | "pod_uid"
    >;
    private previousContinuityId: string | undefined;

    constructor(
        registry: Registry,
        private readonly identity: ContinuityMetricIdentity = readContinuityMetricIdentity(),
    ) {
        this.activeSessions = new Gauge({
            name: "opsia_continuity_active_sessions",
            help: "Connected stable sessions currently hosted by this continuity-protected runtime",
            labelNames: ["namespace", "resource_kind", "resource_name", "continuity_id", "pod_uid"] as const,
            registers: [registry],
        });
    }

    observe(snapshot: ContinuitySnapshot): void {
        const continuityId = runtimeContinuityId(snapshot);
        if (this.previousContinuityId && this.previousContinuityId !== continuityId) {
            this.set(this.previousContinuityId, 0);
        }
        if (!continuityId) {
            this.previousContinuityId = undefined;
            return;
        }
        this.previousContinuityId = continuityId;
        this.set(continuityId, countActiveContinuitySessions(snapshot.players));
    }

    private set(continuityId: string, value: number): void {
        this.activeSessions.labels(
            this.identity.namespace,
            this.identity.resourceKind,
            this.identity.resourceName,
            continuityId,
            this.identity.podUid,
        ).set(value);
    }
}
