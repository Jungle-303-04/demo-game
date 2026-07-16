import { randomUUID } from "node:crypto";
import { DemoRoom, type DemoRoomOptions } from "./room.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { InputPacket, InputResult, OpsSnapshot, RoomSummary, StructuredLog } from "./types.js";

export interface GameRuntimeOptions extends DemoRoomOptions {
  store: SnapshotStore;
  owner?: string;
  snapshotIntervalMs?: number;
  leaseTtlMs?: number;
  baseUrl?: string;
}

export class GameRuntime {
  private room!: DemoRoom;
  private readonly owner: string;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private readonly snapshotIntervalMs: number;
  private readonly leaseTtlMs: number;

  constructor(private readonly options: GameRuntimeOptions) {
    this.owner = options.owner ?? randomUUID();
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 1_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 5_000;
  }

  async start(): Promise<void> {
    await this.options.store.connect();
    if (!await this.options.store.acquireLease(this.options.roomId, this.owner, this.leaseTtlMs)) throw new Error("room_lease_held");
    const snapshot = await this.options.store.load(this.options.roomId);
    this.room = snapshot ? DemoRoom.restore(snapshot, this.roomOptions()) : new DemoRoom(this.roomOptions());
    this.room.start();
    if (snapshot) this.log({ level: "info", event: "snapshot_restored", roomId: this.options.roomId, server: this.options.podName });
    await this.persist();
    this.snapshotTimer = setInterval(() => { void this.persist(); }, this.snapshotIntervalMs);
    this.leaseTimer = setInterval(() => { void this.renewLease(); }, Math.max(250, Math.floor(this.leaseTtlMs / 2)));
  }

  async stop(releaseLease = true): Promise<void> {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    await this.persist();
    if (releaseLease) await this.options.store.releaseLease(this.options.roomId, this.owner);
    await this.options.store.close();
  }

  join(sessionId: string, nickname: string, isBot = false) { return this.room.join(sessionId, nickname, isBot); }
  input(sessionId: string, input: InputPacket): InputResult { return this.room.applyInput(sessionId, input); }
  disconnect(sessionId: string): void { this.room.disconnect(sessionId); }
  eliminate(sessionId: string): void { this.room.eliminate(sessionId); }
  award(sessionId: string, points = 1): void { this.room.award(sessionId, points); }
  tick(): void { this.room.tick(); }
  player(sessionId: string) { return this.room.getPlayer(sessionId); }
  opsSnapshot(): OpsSnapshot { return this.room.opsSnapshot(); }
  summary(): RoomSummary { return this.room.summary(this.options.baseUrl) as RoomSummary; }
  async reset(): Promise<void> { this.room.endAndReset(); await this.options.store.clear(this.options.roomId); await this.persist(); }
  async persist(): Promise<void> { if (this.room) { await this.options.store.save(this.room.snapshot()); this.log({ level: "info", event: "snapshot_saved", roomId: this.options.roomId, server: this.options.podName }); } }

  private roomOptions(): DemoRoomOptions { return { roomId: this.options.roomId, podName: this.options.podName, strictMode: this.options.strictMode, now: this.options.now, log: (event) => this.log(event) }; }
  private log(event: StructuredLog): void { (this.options.log ?? (() => undefined))(event); }
  private async renewLease(): Promise<void> {
    if (!await this.options.store.renewLease(this.options.roomId, this.owner, this.leaseTtlMs)) this.log({ level: "error", event: "lease_lost", roomId: this.options.roomId, server: this.options.podName });
  }
}
