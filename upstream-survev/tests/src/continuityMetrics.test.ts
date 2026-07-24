import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import {
    countActiveContinuitySessions,
    OpsiaContinuityMetrics,
    readContinuityMetricIdentity,
} from "../../server/src/opsia/continuityMetrics.ts";

describe("Opsia continuity Prometheus metric", () => {
    it("counts unique connected stable sessions from the live player state", () => {
        expect(countActiveContinuitySessions([
            { sessionId: "session-live-a", connected: true },
            { sessionId: "session-live-a", connected: true },
            { sessionId: "session-live-b", connected: true },
            { sessionId: "session-offline", connected: false },
            { sessionId: "  ", connected: true },
        ])).toBe(2);
    });

    it("derives the complete resource identity from runtime environment values", () => {
        expect(readContinuityMetricIdentity({
            POD_NAMESPACE: "tenant-runtime",
            OPSIA_RESOURCE_KIND: "Deployment",
            OPSIA_WORKLOAD_NAME: "match-runtime",
            OPSIA_CONTINUITY_ID: "continuity-fleet-a",
            POD_UID: "pod-uid-runtime-42",
        })).toEqual({
            namespace: "tenant-runtime",
            resourceKind: "Deployment",
            resourceName: "match-runtime",
            continuityId: "continuity-fleet-a",
            podUid: "pod-uid-runtime-42",
        });
    });

    it("exports a runtime-derived count without embedding RCA conclusions or replica targets", async () => {
        const registry = new Registry();
        const metrics = new OpsiaContinuityMetrics(registry, {
            namespace: "tenant-runtime",
            resourceKind: "Deployment",
            resourceName: "match-runtime",
            continuityId: "continuity-fleet-a",
            podUid: "pod-uid-runtime-42",
        });

        metrics.observe([
            { sessionId: "session-live-a", connected: true },
            { sessionId: "session-live-b", connected: true },
            { sessionId: "session-offline", connected: false },
        ]);
        expect(await registry.metrics()).toContain(
            "opsia_continuity_active_sessions{namespace=\"tenant-runtime\",resource_kind=\"Deployment\",resource_name=\"match-runtime\",continuity_id=\"continuity-fleet-a\",pod_uid=\"pod-uid-runtime-42\"} 2",
        );

        metrics.observe([{ sessionId: "session-live-b", connected: true }]);
        const updated = await registry.metrics();
        expect(updated).toContain(
            "opsia_continuity_active_sessions{namespace=\"tenant-runtime\",resource_kind=\"Deployment\",resource_name=\"match-runtime\",continuity_id=\"continuity-fleet-a\",pod_uid=\"pod-uid-runtime-42\"} 1",
        );
        expect(updated).not.toMatch(/root_cause|conclusion|replicas|desired_replicas/);
    });
});
