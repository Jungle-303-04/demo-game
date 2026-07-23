import { describe, expect, test } from "vitest";
import type { BotIntent } from "../../server/src/opsia/botBrain.ts";
import { createBotInput, smoothBotAngle } from "../../server/src/opsia/botInput.ts";
import { GameConfig } from "../../shared/gameConfig.ts";

const intent = (overrides: Partial<BotIntent> = {}): BotIntent => ({
    mode: "combat",
    moving: true,
    moveAngle: Math.PI / 4,
    aimAngle: Math.PI / 2,
    aimDistance: 48,
    shoot: true,
    interact: false,
    reload: false,
    ...overrides,
});

describe("Opsia protocol bot input", () => {
    test("eases sharp steering changes across the shortest turn", () => {
        expect(smoothBotAngle(undefined, 1.2, 0.4)).toBeCloseTo(1.2);
        expect(smoothBotAngle(0, Math.PI / 2, 0.4)).toBeCloseTo(0.4);
        expect(smoothBotAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.15)).toBeCloseTo(Math.PI + 0.05);
        expect(smoothBotAngle(1, 1.2, 0.4)).toBeCloseTo(1.2);
    });

    test("gates every movement key while resting without dropping aim or fire", () => {
        const input = createBotInput(intent({ moving: false }), () => 0.1);

        expect(input.moveUp).toBe(false);
        expect(input.moveDown).toBe(false);
        expect(input.moveLeft).toBe(false);
        expect(input.moveRight).toBe(false);
        expect(input.shootHold).toBe(true);
        expect(input.shootStart).toBe(true);
        expect(input.toMouseDir.x).toBeCloseTo(0);
        expect(input.toMouseDir.y).toBeCloseTo(1);
    });

    test("maps tactical actions to protocol-valid one-shot inputs", () => {
        const input = createBotInput(
            intent({
                interact: true,
                reload: true,
                equip: "otherGun",
                useItem: "bandage",
            }),
            () => 1,
        );

        expect(input.moveUp).toBe(true);
        expect(input.moveRight).toBe(true);
        expect(input.inputs).toContain(GameConfig.Input.Interact);
        expect(input.inputs).toContain(GameConfig.Input.Reload);
        expect(input.inputs).toContain(GameConfig.Input.EquipOtherGun);
        expect(input.useItem).toBe("bandage");
    });

    test("maps exact weapon slots and guarantees grenade cook start", () => {
        const mappings = [
            ["primary", GameConfig.Input.EquipPrimary],
            ["secondary", GameConfig.Input.EquipSecondary],
            ["melee", GameConfig.Input.EquipMelee],
            ["throwable", GameConfig.Input.EquipThrowable],
            ["lastWeapon", GameConfig.Input.EquipLastWeap],
        ] as const;
        for (const [equip, expectedInput] of mappings) {
            expect(createBotInput(intent({ equip }), () => 1).inputs).toContain(expectedInput);
        }
        const grenade = createBotInput(intent({ forceShootStart: true }), () => 1);
        expect(grenade.shootHold).toBe(true);
        expect(grenade.shootStart).toBe(true);
    });
});
