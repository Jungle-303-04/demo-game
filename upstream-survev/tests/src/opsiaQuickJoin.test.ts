import { describe, expect, test } from "vitest";
import {
    createOpsiaGuestName,
    isOpsiaPlayPath,
} from "../../client/src/opsiaQuickJoin.ts";

describe("Opsia QR quick join", () => {
    test("recognizes only direct room play routes", () => {
        expect(isOpsiaPlayPath("/play/room-0/")).toBe(true);
        expect(isOpsiaPlayPath("/play/room-12")).toBe(true);
        expect(isOpsiaPlayPath("/watch/room-0/")).toBe(false);
        expect(isOpsiaPlayPath("/")).toBe(false);
    });

    test("creates a compact word-combination guest name", () => {
        const values = [9, 5, 7];
        const name = createOpsiaGuestName(() => values.shift() ?? 0);
        expect(name).toBe("SwiftPanda07");
        expect(name.length).toBeLessThanOrEqual(16);
    });
});
