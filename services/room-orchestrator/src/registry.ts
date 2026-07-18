import { createClient, type RedisClientType } from "redis";
import {
  type GameMap,
  type GameMode,
  roomProfileForOrdinal,
} from "../../room-profiles.js";

export type RegistryStatus = "waiting" | "running" | "ended" | "inactive";

export interface RoomSpec {
  name: string;
  description: string;
  region: string;
  map: GameMap;
  mode: GameMode;
  maxPlayers: number;
  createdAt: string;
}

export interface RoomRegistryRecord {
  roomId: string;
  ordinal: number;
  podName: string;
  endpoint: string;
  status: RegistryStatus;
  players: number;
  alive: number;
  strictMode: boolean;
  joinLocked?: boolean;
  statusChangedAt?: string;
  spec?: RoomSpec;
}

export interface RoomRegistry {
  connect(): Promise<void>;
  close(): Promise<void>;
  list(): Promise<RoomRegistryRecord[]>;
  get(roomId: string): Promise<RoomRegistryRecord | null>;
  put(record: RoomRegistryRecord): Promise<void>;
  remove(roomId: string): Promise<void>;
}

const clone = (record: RoomRegistryRecord): RoomRegistryRecord => ({
  ...record,
  spec: record.spec ? { ...record.spec } : undefined,
});

export class MemoryRoomRegistry implements RoomRegistry {
  private readonly records = new Map<string, RoomRegistryRecord>();
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async list(): Promise<RoomRegistryRecord[]> { return [...this.records.values()].map(clone).sort((a, b) => a.ordinal - b.ordinal); }
  async get(roomId: string): Promise<RoomRegistryRecord | null> { const record = this.records.get(roomId); return record ? clone(record) : null; }
  async put(record: RoomRegistryRecord): Promise<void> { this.records.set(record.roomId, clone(record)); }
  async remove(roomId: string): Promise<void> { this.records.delete(roomId); }
}

export class RedisRoomRegistry implements RoomRegistry {
  private readonly client: RedisClientType;
  private readonly idsKey = "room-registry:ids";
  constructor(url: string) { this.client = createClient({ url }); }
  async connect(): Promise<void> { if (!this.client.isOpen) await this.client.connect(); }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit(); }
  async list(): Promise<RoomRegistryRecord[]> {
    const ids = await this.client.sMembers(this.idsKey);
    const raw = ids.length ? await this.client.mGet(ids.map((roomId) => `room-registry:${roomId}`)) : [];
    return raw.filter((entry): entry is string => Boolean(entry)).map((entry) => JSON.parse(entry) as RoomRegistryRecord).sort((a, b) => a.ordinal - b.ordinal);
  }
  async get(roomId: string): Promise<RoomRegistryRecord | null> {
    const raw = await this.client.get(`room-registry:${roomId}`);
    return raw ? JSON.parse(raw) as RoomRegistryRecord : null;
  }
  async put(record: RoomRegistryRecord): Promise<void> {
    const transaction = this.client
      .multi()
      .set(`room-registry:${record.roomId}`, JSON.stringify(record))
      .sAdd(this.idsKey, record.roomId);
    if (record.joinLocked !== undefined) {
      transaction.set(`room:${record.roomId}:join-lock`, record.joinLocked ? "1" : "0");
    }
    await transaction.exec();
  }
  async remove(roomId: string): Promise<void> {
    await this.client
      .multi()
      .del(`room-registry:${roomId}`)
      .del(`room:${roomId}:join-lock`)
      .del(`room:${roomId}:snapshot`)
      .del(`room:${roomId}:lease`)
      .sRem(this.idsKey, roomId)
      .exec();
  }
}

export const createRoomRegistry = (redisUrl = process.env.REDIS_URL): RoomRegistry => redisUrl ? new RedisRoomRegistry(redisUrl) : new MemoryRoomRegistry();

const legacyRoomName = (name: string, ordinal: number): boolean =>
  name === `Faction Room ${ordinal + 1}` || name === "Survev Faction Room";

export const specForOrdinal = (ordinal: number, current?: RoomSpec): RoomSpec => {
  const { mapKey: _mapKey, ...profile } = roomProfileForOrdinal(ordinal);
  return {
    ...profile,
    name: current && !legacyRoomName(current.name, ordinal) ? current.name : profile.name,
    description: current && current.description !== "Survev 50:50 faction live room"
      ? current.description
      : profile.description,
    createdAt: current?.createdAt ?? new Date().toISOString(),
  };
};

export const recordForOrdinal = (ordinal: number, endpoint?: string): RoomRegistryRecord => {
  const createdAt = new Date().toISOString();
  return {
    roomId: `room-${ordinal}`,
    ordinal,
    podName: `game-${ordinal}`,
    endpoint: endpoint ?? `http://game-${ordinal}:8080`,
    status: "waiting",
    players: 0,
    alive: 0,
    strictMode: false,
    joinLocked: false,
    statusChangedAt: createdAt,
    spec: { ...specForOrdinal(ordinal), createdAt },
  };
};

export class RoomReconciler {
  constructor(private readonly registry: RoomRegistry) {}
  async reconcile(replicas: number, endpointForOrdinal: (ordinal: number) => string = (ordinal) => `http://game-${ordinal}:8080`): Promise<RoomRegistryRecord[]> {
    if (!Number.isInteger(replicas) || replicas < 0) throw new Error("invalid_replicas");
    const existing = await this.registry.list();
    const changedAt = new Date().toISOString();
    for (let ordinal = 0; ordinal < replicas; ordinal += 1) {
      const record = existing.find((entry) => entry.ordinal === ordinal) ?? recordForOrdinal(ordinal, endpointForOrdinal(ordinal));
      const status = record.status === "inactive" ? "waiting" : record.status;
      await this.registry.put({
        ...record,
        endpoint: endpointForOrdinal(ordinal),
        status,
        spec: specForOrdinal(ordinal, record.spec),
        joinLocked: record.joinLocked ?? false,
        statusChangedAt: status === record.status
          ? record.statusChangedAt ?? record.spec?.createdAt ?? changedAt
          : changedAt,
      });
    }
    for (const record of existing.filter((entry) => entry.ordinal >= replicas)) {
      await this.registry.put({
        ...record,
        status: "inactive",
        players: 0,
        alive: 0,
        statusChangedAt: record.status === "inactive" ? record.statusChangedAt : changedAt,
      });
    }
    return this.registry.list();
  }
}
