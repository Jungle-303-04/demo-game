import { GameConfig } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import { v2 } from "../../../shared/utils/v2.ts";
import type { BotIntent } from "./botBrain.ts";

export const createBotInput = (intent: BotIntent, random: () => number = Math.random): net.InputMsg => {
    const input = new net.InputMsg();
    const moveX = Math.cos(intent.moveAngle);
    const moveY = Math.sin(intent.moveAngle);
    input.moveUp = intent.moving && moveY > 0.25;
    input.moveDown = intent.moving && moveY < -0.25;
    input.moveRight = intent.moving && moveX > 0.25;
    input.moveLeft = intent.moving && moveX < -0.25;
    input.shootHold = intent.shoot;
    input.shootStart = intent.shoot && random() < 0.22;
    input.toMouseDir = v2.create(Math.cos(intent.aimAngle), Math.sin(intent.aimAngle));
    input.toMouseLen = Math.min(64, Math.max(0, intent.aimDistance));
    if (intent.interact) input.addInput(GameConfig.Input.Interact);
    if (intent.reload) input.addInput(GameConfig.Input.Reload);
    if (intent.equip === "otherGun") input.addInput(GameConfig.Input.EquipOtherGun);
    if (intent.useItem) input.useItem = intent.useItem;
    return input;
};
