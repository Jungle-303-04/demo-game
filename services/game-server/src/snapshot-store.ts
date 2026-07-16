import { createClient, type RedisClientType } from "redis";
import type { RoomSnapshot } from "./types.js";

export interface SnapshotStore {
  connect(): Promise<void>;
  close(): Promise<void>;
  save(snapshot: RoomSnapshot): Promise<void>;
  load(roomId: string): Promise<RoomSnapshot | null>;
  clear(roomId: string): Promise<void>;
  acquireLease(roomId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(roomId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(roomId: string, owner: string): Promise<void>;
}

const snapshotKey = (roomId: string) => `room:${roomId}:snapshot`;
const leaseKey = (roomId: string) => `room:${roomId}:lease`;

export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, string>();
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async save(snapshot: RoomSnapshot): Promise<void> { this.snapshots.set(snapshotKey(snapshot.roomId), JSON.stringify(snapshot)); }
  async load(roomId: string): Promise<RoomSnapshot | null> {
    const raw = this.snapshots.get(snapshotKey(roomId));
    return raw ? JSON.parse(raw) as RoomSnapshot : null;
  }
  async clear(roomId: string): Promise<void> { this.snapshots.delete(snapshotKey(roomId)); }
  async acquireLease(roomId: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = leaseKey(roomId);
    const existing = this.leases.get(key);
    if (existing && existing.owner !== owner && existing.expiresAt > Date.now()) return false;
    this.leases.set(key, { owner, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async renewLease(roomId: string, owner: string, ttlMs: number): Promise<boolean> {
    const lease = this.leases.get(leaseKey(roomId));
    if (!lease || lease.owner !== owner || lease.expiresAt <= Date.now()) return false;
    lease.expiresAt = Date.now() + ttlMs;
    return true;
  }
  async releaseLease(roomId: string, owner: string): Promise<void> {
    const key = leaseKey(roomId);
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }
}

export class RedisSnapshotStore implements SnapshotStore {
  private readonly client: RedisClientType;
  constructor(redisUrl: string) { this.client = createClient({ url: redisUrl }); }
  async connect(): Promise<void> { if (!this.client.isOpen) await this.client.connect(); }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
  async save(snapshot: RoomSnapshot): Promise<void> { await this.client.set(snapshotKey(snapshot.roomId), JSON.stringify(snapshot)); }
  async load(roomId: string): Promise<RoomSnapshot | null> {
    const raw = await this.client.get(snapshotKey(roomId));
    return raw ? JSON.parse(raw) as RoomSnapshot : null;
  }
  async clear(roomId: string): Promise<void> { await this.client.del(snapshotKey(roomId)); }
  async acquireLease(roomId: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.client.set(leaseKey(roomId), owner, { NX: true, PX: ttlMs })) === "OK";
  }
  async renewLease(roomId: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      { keys: [leaseKey(roomId)], arguments: [owner, String(ttlMs)] },
    );
    return Number(result) === 1;
  }
  async releaseLease(roomId: string, owner: string): Promise<void> {
    await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [leaseKey(roomId)], arguments: [owner] },
    );
  }
}

export const createSnapshotStore = (redisUrl = process.env.REDIS_URL): SnapshotStore => redisUrl ? new RedisSnapshotStore(redisUrl) : new MemorySnapshotStore();
