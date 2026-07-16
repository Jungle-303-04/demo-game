export type RegistryStatus = "waiting" | "running" | "ended" | "inactive";

export interface RoomRegistryRecord {
  roomId: string;
  ordinal: number;
  podName: string;
  endpoint: string;
  status: RegistryStatus;
  players: number;
  alive: number;
  strictMode: boolean;
}

export interface RoomRegistry {
  list(): Promise<RoomRegistryRecord[]>;
  get(roomId: string): Promise<RoomRegistryRecord | null>;
  put(record: RoomRegistryRecord): Promise<void>;
  remove(roomId: string): Promise<void>;
}

const clone = (record: RoomRegistryRecord): RoomRegistryRecord => ({ ...record });

export class MemoryRoomRegistry implements RoomRegistry {
  private readonly records = new Map<string, RoomRegistryRecord>();
  async list(): Promise<RoomRegistryRecord[]> { return [...this.records.values()].map(clone).sort((a, b) => a.ordinal - b.ordinal); }
  async get(roomId: string): Promise<RoomRegistryRecord | null> { const record = this.records.get(roomId); return record ? clone(record) : null; }
  async put(record: RoomRegistryRecord): Promise<void> { this.records.set(record.roomId, clone(record)); }
  async remove(roomId: string): Promise<void> { this.records.delete(roomId); }
}

export const recordForOrdinal = (ordinal: number, endpoint?: string): RoomRegistryRecord => ({
  roomId: `room-${ordinal}`,
  ordinal,
  podName: `game-${ordinal}`,
  endpoint: endpoint ?? `http://game-${ordinal}:8080`,
  status: "waiting",
  players: 0,
  alive: 0,
  strictMode: false,
});

export class RoomReconciler {
  constructor(private readonly registry: RoomRegistry) {}
  async reconcile(replicas: number, endpointForOrdinal: (ordinal: number) => string = (ordinal) => `http://game-${ordinal}:8080`): Promise<RoomRegistryRecord[]> {
    if (!Number.isInteger(replicas) || replicas < 0) throw new Error("invalid_replicas");
    const existing = await this.registry.list();
    for (let ordinal = 0; ordinal < replicas; ordinal += 1) {
      const record = existing.find((entry) => entry.ordinal === ordinal) ?? recordForOrdinal(ordinal, endpointForOrdinal(ordinal));
      await this.registry.put({ ...record, endpoint: endpointForOrdinal(ordinal), status: record.status === "inactive" ? "waiting" : record.status });
    }
    for (const record of existing.filter((entry) => entry.ordinal >= replicas)) await this.registry.put({ ...record, status: "inactive", players: 0, alive: 0 });
    return this.registry.list();
  }
}
