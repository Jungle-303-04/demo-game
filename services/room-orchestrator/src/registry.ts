import { createClient, type RedisClientType } from "redis";
import {
  type GameMap,
  type GameMode,
  roomProfileForOrdinal,
} from "../../room-profiles.js";
import type { RoomWorkload } from "./scaler.js";

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

export const recordForOrdinal = (ordinal: number, endpoint?: string, workloadName?: string): RoomRegistryRecord => {
  const createdAt = new Date().toISOString();
  return {
    roomId: `room-${ordinal}`,
    ordinal,
    podName: workloadName ?? `game-room-${ordinal}`,
    endpoint: endpoint ?? `http://game-room-${ordinal}:8001`,
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
  async reconcile(
    replicas: number,
    endpointForOrdinal: (ordinal: number) => string = (ordinal) => `http://game-room-${ordinal}:8001`,
    workloadNameForOrdinal: (ordinal: number) => string = (ordinal) => `game-room-${ordinal}`,
  ): Promise<RoomRegistryRecord[]> {
    if (!Number.isInteger(replicas) || replicas < 0) throw new Error("invalid_replicas");
    const existing = await this.registry.list();
    const changedAt = new Date().toISOString();
    for (let ordinal = 0; ordinal < replicas; ordinal += 1) {
      const record = existing.find((entry) => entry.ordinal === ordinal)
        ?? recordForOrdinal(ordinal, endpointForOrdinal(ordinal), workloadNameForOrdinal(ordinal));
      const status = record.status === "inactive" ? "waiting" : record.status;
      await this.registry.put({
        ...record,
        podName: workloadNameForOrdinal(ordinal),
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

  /**
   * Kubernetes is the source of truth for fleet membership. A room is joined
   * to its workload by the stable game.opsia.dev/room-id label; names only
   * describe the currently serving deployment and Service.
   */
  async reconcileWorkloads(workloads: readonly RoomWorkload[]): Promise<RoomRegistryRecord[]> {
    const existing = await this.registry.list();
    const existingById = new Map(existing.map((record) => [record.roomId, record]));
    const discovered = new Set<string>();
    const changedAt = new Date().toISOString();
    for (const workload of workloads) {
      if (!/^room-\d+$/.test(workload.roomId)
        || !Number.isInteger(workload.ordinal)
        || workload.ordinal < 0
        || workload.roomId !== `room-${workload.ordinal}`
        || !Number.isInteger(workload.replicas)
        || (workload.replicas !== 0 && workload.replicas !== 1)
        || !workload.deploymentName
        || !workload.serviceName
        || !workload.endpoint) {
        throw new Error("invalid_room_workload");
      }
      if (discovered.has(workload.roomId)) throw new Error("duplicate_room_workload");
      discovered.add(workload.roomId);
      const record = existingById.get(workload.roomId)
        ?? recordForOrdinal(workload.ordinal, workload.endpoint, workload.deploymentName);
      const status = workload.replicas === 1
        ? (record.status === "inactive" ? "waiting" : record.status)
        : "inactive";
      await this.registry.put({
        ...record,
        ordinal: workload.ordinal,
        podName: workload.deploymentName,
        endpoint: workload.endpoint,
        status,
        players: status === "inactive" ? 0 : record.players,
        alive: status === "inactive" ? 0 : record.alive,
        spec: specForOrdinal(workload.ordinal, record.spec),
        joinLocked: record.joinLocked ?? false,
        statusChangedAt: status === record.status
          ? record.statusChangedAt ?? record.spec?.createdAt ?? changedAt
          : changedAt,
      });
    }
    for (const record of existing.filter((entry) => !discovered.has(entry.roomId))) {
      if (record.status === "inactive") continue;
      await this.registry.put({
        ...record,
        status: "inactive",
        players: 0,
        alive: 0,
        statusChangedAt: changedAt,
      });
    }
    return this.registry.list();
  }
}
