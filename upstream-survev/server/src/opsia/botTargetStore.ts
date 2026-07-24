import { createClient } from "redis";
import { parseBotTarget } from "./botPopulation.ts";

const DEFAULT_REDIS_KEY = "opsia:bot-targets:v1";

export interface BotTargetStore {
    connect(): Promise<void>;
    load(): Promise<Array<[string, number]>>;
    set(roomId: string, target: number): Promise<void>;
    delete(roomId: string): Promise<void>;
    close(): Promise<void>;
}

export const parsePersistedBotTarget = (value: string): number => {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error("invalid_persisted_bot_target");
    return parseBotTarget(Number(value));
};

export class MemoryBotTargetStore implements BotTargetStore {
    private readonly targets = new Map<string, number>();

    async connect(): Promise<void> {}

    async load(): Promise<Array<[string, number]>> {
        return [...this.targets.entries()].sort(([left], [right]) => left.localeCompare(right));
    }

    async set(roomId: string, target: number): Promise<void> {
        this.targets.set(roomId, parseBotTarget(target));
    }

    async delete(roomId: string): Promise<void> {
        this.targets.delete(roomId);
    }

    async close(): Promise<void> {}
}

export class RedisBotTargetStore implements BotTargetStore {
    private readonly client;

    constructor(
        redisUrl: string,
        private readonly key = DEFAULT_REDIS_KEY,
    ) {
        this.client = createClient({ url: redisUrl });
        this.client.on("error", (error) => {
            console.error(JSON.stringify({
                level: "error",
                event: "bot_target_store_error",
                detail: { message: String(error) },
            }));
        });
    }

    async connect(): Promise<void> {
        if (!this.client.isOpen) await this.client.connect();
    }

    async load(): Promise<Array<[string, number]>> {
        const persisted = await this.client.hGetAll(this.key);
        return Object.entries(persisted)
            .map(([roomId, target]): [string, number] => [roomId, parsePersistedBotTarget(target)])
            .sort(([left], [right]) => left.localeCompare(right));
    }

    async set(roomId: string, target: number): Promise<void> {
        await this.client.hSet(this.key, roomId, String(parseBotTarget(target)));
    }

    async delete(roomId: string): Promise<void> {
        await this.client.hDel(this.key, roomId);
    }

    async close(): Promise<void> {
        if (this.client.isOpen) await this.client.quit();
    }
}

export const createBotTargetStore = (
    redisUrl = process.env.REDIS_URL,
    redisKey = process.env.OPSIA_BOT_TARGET_REDIS_KEY,
): BotTargetStore => redisUrl
    ? new RedisBotTargetStore(redisUrl, redisKey || DEFAULT_REDIS_KEY)
    : new MemoryBotTargetStore();
