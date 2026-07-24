import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import {
    countActiveContinuitySessions,
    OpsiaContinuityMetrics,
    readContinuityMetricIdentity,
    runtimeContinuityId,
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
            POD_UID: "pod-uid-runtime-42",
        })).toEqual({
            namespace: "tenant-runtime",
            resourceKind: "Deployment",
            resourceName: "match-runtime",
            podUid: "pod-uid-runtime-42",
        });
    });

    it("derives continuity identity from the authoritative room epoch", () => {
        expect(runtimeContinuityId({
            roomId: "runtime-room-a",
            players: [],
            snapshot: { roomEpoch: 42 } as never,
        })).toBe("runtime-room-a:epoch:42");
        expect(runtimeContinuityId({
            roomId: " ",
            players: [],
            snapshot: { roomEpoch: 42 } as never,
        })).toBeUndefined();
    });

    it("exports a runtime-derived count without embedding RCA conclusions or replica targets", async () => {
        const registry = new Registry();
        const metrics = new OpsiaContinuityMetrics(registry, {
            namespace: "tenant-runtime",
            resourceKind: "Deployment",
            resourceName: "match-runtime",
            podUid: "pod-uid-runtime-42",
        });

        metrics.observe({
            roomId: "runtime-room-a",
            players: [
                { sessionId: "session-live-a", connected: true },
                { sessionId: "session-live-b", connected: true },
                { sessionId: "session-offline", connected: false },
            ] as never,
            snapshot: { roomEpoch: 42 } as never,
        });
        expect(await registry.metrics()).toContain(
            "opsia_continuity_active_sessions{namespace=\"tenant-runtime\",resource_kind=\"Deployment\",resource_name=\"match-runtime\",continuity_id=\"runtime-room-a:epoch:42\",pod_uid=\"pod-uid-runtime-42\"} 2",
        );

        metrics.observe({
            roomId: "runtime-room-a",
            players: [{ sessionId: "session-live-b", connected: true }] as never,
            snapshot: { roomEpoch: 42 } as never,
        });
        const updated = await registry.metrics();
        expect(updated).toContain(
            "opsia_continuity_active_sessions{namespace=\"tenant-runtime\",resource_kind=\"Deployment\",resource_name=\"match-runtime\",continuity_id=\"runtime-room-a:epoch:42\",pod_uid=\"pod-uid-runtime-42\"} 1",
        );
        expect(updated).not.toMatch(/root_cause|conclusion|replicas|desired_replicas/);
    });

    it("marks the previous game session absent when the runtime epoch changes", async () => {
        const registry = new Registry();
        const metrics = new OpsiaContinuityMetrics(registry, {
            namespace: "tenant-runtime",
            resourceKind: "Deployment",
            resourceName: "match-runtime",
            podUid: "pod-uid-runtime-42",
        });
        const players = [{ sessionId: "session-live-a", connected: true }] as never;

        metrics.observe({
            roomId: "runtime-room-a",
            players,
            snapshot: { roomEpoch: 42 } as never,
        });
        metrics.observe({
            roomId: "runtime-room-a",
            players,
            snapshot: { roomEpoch: 43 } as never,
        });
        const updated = await registry.metrics();
        expect(updated).toContain('continuity_id="runtime-room-a:epoch:42",pod_uid="pod-uid-runtime-42"} 0');
        expect(updated).toContain('continuity_id="runtime-room-a:epoch:43",pod_uid="pod-uid-runtime-42"} 1');
    });
});
