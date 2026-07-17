import { Counter, Gauge, Registry } from "prom-client";
import { withControlToken } from "../../control-plane-auth.js";
import type { RoomRegistryRecord } from "../../room-orchestrator/src/registry.js";
type StructuredLog = {
  level: "info" | "warn" | "error";
  event: string;
  sessionId?: string;
  nickname?: string;
  detail?: Record<string, unknown>;
};

export interface RoomDirectory { list(): Promise<RoomRegistryRecord[]>; }

export class HttpRoomDirectory implements RoomDirectory {
  constructor(private readonly orchestratorUrl: string, private readonly controlToken = "") {}
  async list(): Promise<RoomRegistryRecord[]> {
    const response = await fetch(`${this.orchestratorUrl}/rooms`, withControlToken({
      signal: AbortSignal.timeout(1_500),
    }, this.controlToken));
    if (!response.ok) throw new Error(`room_registry_unavailable:${response.status}`);
    const records = (await response.json() as { rooms: RoomRegistryRecord[] }).rooms;
    return Promise.all(records.map(async (room): Promise<RoomRegistryRecord> => {
      if (room.status === "inactive" || room.status === "ended") return room;
      try {
        const summaryResponse = await fetch(`${room.endpoint}/summary`, { signal: AbortSignal.timeout(1_000) });
        if (!summaryResponse.ok) return { ...room, status: "inactive", players: 0, alive: 0 };
        const summary = await summaryResponse.json() as {
          status?: string;
          players?: number;
          alive?: number;
          joinLocked?: boolean;
        };
        return {
          ...room,
          status: summary.status === "running" ? "running" : "waiting",
          players: Number(summary.players ?? 0),
          alive: Number(summary.alive ?? 0),
          joinLocked: room.joinLocked === true || summary.joinLocked === true,
        };
      } catch {
        return { ...room, status: "inactive", players: 0, alive: 0 };
      }
    }));
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

    // Reserve the window slot before the directory probe. Concurrent requests
    // must not all observe the same pre-await count and fan out unbounded probes.
    const attempt = { at: now, failed: false };
    this.attempts.push(attempt);
    this.updateFailureRatio();
    let listed: RoomRegistryRecord[];
    try {
      listed = await this.directory.list();
    } catch {
      return this.reject(sessionId, nickname, "directory_unavailable", attempt);
    }
    const rooms = listed.filter((room) =>
      room.status === "running"
      && room.joinLocked !== true
      && Number(room.players) < Number(room.spec?.maxPlayers ?? 100)
    );
    if (rooms.length === 0) return this.reject(sessionId, nickname, "no_room", attempt);
    const room = [...rooms].sort((a, b) => a.players - b.players || a.ordinal - b.ordinal)[0];
    if (!room) return this.reject(sessionId, nickname, "no_room", attempt);
    this.requests.labels("accepted").inc();
    return room;
  }

  private reject(sessionId: string, nickname: string, reason: string, attempt?: { at: number; failed: boolean }): never {
    if (attempt) {
      attempt.failed = true;
      this.updateFailureRatio();
    }
    this.requests.labels("rejected").inc();
    this.log({ level: "warn", event: "find_game_rejected", sessionId, nickname, detail: { reason } });
    throw new Error(`find_game_rejected:${reason}`);
  }

  private updateFailureRatio(): void {
    const total = this.attempts.length;
    this.failureRatio.set(total ? this.attempts.filter((entry) => entry.failed).length / total : 0);
  }
}
