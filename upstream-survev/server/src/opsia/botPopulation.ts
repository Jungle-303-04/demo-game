export const MAX_BOTS_PER_ROOM = 500;

export const parseBotTarget = (value: unknown): number => {
    if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_BOTS_PER_ROOM
    ) {
        throw new Error("invalid_bot_target");
    }
    return value;
};

export class RoomBotTargets {
    private readonly targets = new Map<string, number>();

    constructor(readonly defaultTarget: number) {
        parseBotTarget(defaultTarget);
    }

    get(roomId: string): number {
        return this.targets.get(roomId) ?? this.defaultTarget;
    }

    set(roomId: string, value: unknown): number {
        const target = parseBotTarget(value);
        this.targets.set(roomId, target);
        return target;
    }

    hydrate(entries: Iterable<readonly [string, number]>): void {
        for (const [roomId, target] of entries) this.set(roomId, target);
    }

    delete(roomId: string): void {
        this.targets.delete(roomId);
    }

    entries(): Array<[string, number]> {
        return [...this.targets.entries()].sort(([left], [right]) => left.localeCompare(right));
    }
}
