import { Counter, Gauge, Registry } from "prom-client";
import type { RoomRegistryRecord } from "../../room-orchestrator/src/registry.js";
import type { StructuredLog } from "../../game-server/src/types.js";

export interface RoomDirectory { list(): Promise<RoomRegistryRecord[]>; }

export class HttpRoomDirectory implements RoomDirectory {
  constructor(private readonly orchestratorUrl: string) {}
  async list(): Promise<RoomRegistryRecord[]> {
    const response = await fetch(`${this.orchestratorUrl}/rooms`);
    if (!response.ok) throw new Error(`room_registry_unavailable:${response.status}`);
    return (await response.json() as { rooms: RoomRegistryRecord[] }).rooms;
  }
}

export class Matchmaker {
  readonly registry = new Registry();
  private readonly attempts: Array<{ at: number; failed: boolean }> = [];
  private readonly requests = new Counter({ name: "find_game_requests_total", help: "Matchmaking requests", labelNames: ["outcome"] as const, registers: [this.registry] });
  private readonly failureRatio = new Gauge({ name: "find_game_fail_ratio", help: "Recent matchmaking failure ratio", registers: [this.registry] });

  constructor(private readonly directory: RoomDirectory, private readonly maxPerSecond = 25, private readonly now: () => number = Date.now, private readonly log: (entry: StructuredLog) => void = () => undefined) {}

  async findGame(sessionId: string, nickname: string): Promise<RoomRegistryRecord> {
    const now = this.now();
    const recent = this.attempts.filter((entry) => entry.at > now - 1_000);
    this.attempts.splice(0, this.attempts.length, ...recent);
    if (recent.length >= this.maxPerSecond) return this.reject(sessionId, nickname, "rate_limited");
    const rooms = (await this.directory.list()).filter((room) => room.status !== "inactive" && room.status !== "ended");
    if (rooms.length === 0) return this.reject(sessionId, nickname, "no_room");
    const room = [...rooms].sort((a, b) => a.players - b.players || a.ordinal - b.ordinal)[0];
    if (!room) return this.reject(sessionId, nickname, "no_room");
    this.record(false);
    this.requests.labels("accepted").inc();
    return room;
  }

  private reject(sessionId: string, nickname: string, reason: string): never {
    this.record(true);
    this.requests.labels("rejected").inc();
    this.log({ level: "warn", event: "find_game_rejected", sessionId, nickname, detail: { reason } });
    throw new Error(`find_game_rejected:${reason}`);
  }

  private record(failed: boolean): void {
    this.attempts.push({ at: this.now(), failed });
    const total = this.attempts.length;
    this.failureRatio.set(total ? this.attempts.filter((entry) => entry.failed).length / total : 0);
  }
}
