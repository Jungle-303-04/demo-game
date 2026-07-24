import { describe, expect, test } from "vitest";
import {
    DEFAULT_OPSIA_BOT_STARTER_GUNS,
    opsiaBotStarterGunCandidates,
    selectOpsiaBotStarterGun,
} from "../../server/src/opsia/botStarterWeapon.ts";

describe("Opsia bot starter weapons", () => {
    test("uses a varied default gun pool", () => {
        expect(opsiaBotStarterGunCandidates()).toEqual([...DEFAULT_OPSIA_BOT_STARTER_GUNS]);
        expect(new Set(DEFAULT_OPSIA_BOT_STARTER_GUNS).size).toBeGreaterThanOrEqual(8);
        expect(DEFAULT_OPSIA_BOT_STARTER_GUNS).toEqual(
            expect.arrayContaining(["m870", "mp220", "saiga", "spas12"]),
        );
    });

    test("deduplicates configured guns and selects across the whole pool", () => {
        const candidates = opsiaBotStarterGunCandidates("mp5, ak47, mp5, m870");
        expect(candidates).toEqual(["mp5", "ak47", "m870"]);
        expect(selectOpsiaBotStarterGun(candidates, () => 0)).toBe("mp5");
        expect(selectOpsiaBotStarterGun(candidates, () => 0.5)).toBe("ak47");
        expect(selectOpsiaBotStarterGun(candidates, () => 0.999)).toBe("m870");
    });
});
