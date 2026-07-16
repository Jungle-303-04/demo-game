import { randomUUID } from "node:crypto";
import type { RoomRegistryRecord } from "../../room-orchestrator/src/registry.js";

export type BotMode = "normal" | "hack";
export interface BotRecord { sessionId: string; nickname: string; roomId: string; mode: BotMode; sequence: number; timer: NodeJS.Timeout; }

export class BotRunner {
  private readonly bots = new Map<string, BotRecord>();
  constructor(private readonly registryUrl: string) {}

  async spawn(count: number, roomId?: string, mode: BotMode = "normal", nickname?: string): Promise<BotRecord[]> {
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("invalid_bot_count");
    const rooms = await this.rooms();
    const targets = roomId ? rooms.filter((room) => room.roomId === roomId) : rooms;
    if (targets.length === 0) throw new Error("room_not_found");
    const created: BotRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      const room = targets[index % targets.length];
      if (!room) continue;
      const sessionId = `bot-${randomUUID()}`;
      const record: BotRecord = { sessionId, nickname: nickname && count === 1 ? nickname : `${mode}-bot-${this.bots.size + 1}`, roomId: room.roomId, mode, sequence: 0, timer: setInterval(() => { void this.act(room, sessionId); }, mode === "hack" ? 100 : 500) };
      const joined = await fetch(`${room.endpoint}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, nickname: record.nickname, isBot: true }) });
      if (!joined.ok) { clearInterval(record.timer); throw new Error(`bot_join_failed:${room.roomId}`); }
      this.bots.set(sessionId, record); created.push(record);
    }
    return created;
  }

  async kill(sessionId?: string): Promise<number> {
    const targets = sessionId ? [...this.bots.values()].filter((bot) => bot.sessionId === sessionId || bot.nickname === sessionId) : [...this.bots.values()];
    for (const bot of targets) { clearInterval(bot.timer); this.bots.delete(bot.sessionId); }
    return targets.length;
  }
  list(): Omit<BotRecord, "timer">[] { return [...this.bots.values()].map(({ timer: _timer, ...bot }) => bot); }

  private async rooms(): Promise<RoomRegistryRecord[]> {
    const response = await fetch(`${this.registryUrl}/rooms`);
    if (!response.ok) throw new Error("registry_unavailable");
    return (await response.json() as { rooms: RoomRegistryRecord[] }).rooms.filter((room) => room.status !== "inactive");
  }
  private async act(room: RoomRegistryRecord, sessionId: string): Promise<void> {
    const bot = this.bots.get(sessionId); if (!bot) return;
    const count = bot.mode === "hack" ? 50 : 1;
    const inputs = Array.from({ length: count }, (_, index) => ({ sessionId, sequence: ++bot.sequence, dx: bot.mode === "hack" && index === 0 ? 8 : 0.25, dy: bot.mode === "hack" ? 0 : -0.1 }));
    await Promise.all(inputs.map((input) => fetch(`${room.endpoint}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).catch(() => undefined)));
  }
}
