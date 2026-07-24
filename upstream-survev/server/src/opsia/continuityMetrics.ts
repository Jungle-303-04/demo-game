import { Gauge, type Registry } from "prom-client";
import type { OpsiaSnapshotData } from "../game/ipcTypes.ts";

export interface ContinuityMetricIdentity {
    namespace: string;
    resourceKind: string;
    resourceName: string;
    continuityId: string;
    podUid: string;
}

type ContinuitySession = Pick<OpsiaSnapshotData["players"][number], "connected" | "sessionId">;

const nonEmpty = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

export const readContinuityMetricIdentity = (
    env: Readonly<Record<string, string | undefined>> = process.env,
): ContinuityMetricIdentity => {
    const resourceName = nonEmpty(env.OPSIA_WORKLOAD_NAME, "unknown");
    return {
        namespace: nonEmpty(env.POD_NAMESPACE, "unknown"),
        resourceKind: nonEmpty(env.OPSIA_RESOURCE_KIND, "unknown"),
        resourceName,
        continuityId: nonEmpty(env.OPSIA_CONTINUITY_ID, nonEmpty(env.ROOM_ID, resourceName)),
        podUid: nonEmpty(env.POD_UID, nonEmpty(env.POD_NAME, "unknown")),
    };
};

export const countActiveContinuitySessions = (sessions: readonly ContinuitySession[]): number =>
    new Set(
        sessions
            .filter((session) => session.connected)
            .map((session) => session.sessionId.trim())
            .filter(Boolean),
    ).size;

export class OpsiaContinuityMetrics {
    private readonly activeSessions: Gauge<
        "namespace" | "resource_kind" | "resource_name" | "continuity_id" | "pod_uid"
    >;

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
        this.set(0);
    }

    observe(sessions: readonly ContinuitySession[]): void {
        this.set(countActiveContinuitySessions(sessions));
    }

    private set(value: number): void {
        this.activeSessions.labels(
            this.identity.namespace,
            this.identity.resourceKind,
            this.identity.resourceName,
            this.identity.continuityId,
            this.identity.podUid,
        ).set(value);
    }
}
