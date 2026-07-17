export type RoomStatus =
  | "running"
  | "provisioning"
  | "stopped"
  | "recovering"
  | "degraded";

export type MatchPhase = "lobby" | "in_match" | "finished";
export type GameMode = "Faction 50v50";
export type EventTone = "info" | "success" | "warning" | "danger";

export interface PlayerTelemetry {
  id: string;
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  health: number;
  armor: number;
  kills: number;
  weapon: string;
  ammo: number;
  ping: number;
  squad: string;
  color: string;
  isBot: boolean;
}

export interface ZoneTelemetry {
  x: number;
  y: number;
  radius: number;
  nextX: number;
  nextY: number;
  nextRadius: number;
}

export interface RoomMetrics {
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number;
  networkInKbps: number | null;
  networkOutKbps: number | null;
  tickP95Ms: number;
  websocketCount: number;
  redisOpsPerSecond: number | null;
  telemetryLagMs: number;
}

export interface GameRoom {
  id: string;
  name: string;
  description: string;
  region: string;
  map: string;
  mode: GameMode;
  maxPlayers: number;
  status: RoomStatus;
  matchPhase: MatchPhase;
  players: PlayerTelemetry[];
  podName: string;
  podIp: string;
  node: string;
  serviceUrl: string;
  imageTag: string;
  redisKey: string;
  snapshotAgeSeconds: number;
  snapshotCapturedAt: number;
  tickRate: number;
  uptimeSeconds: number;
  seed: number;
  podHealthy: boolean;
  desiredReplicas: number;
  readyReplicas: number;
  joinLocked: boolean;
  createdAt: string;
  recoveryStep?: string;
  zone: ZoneTelemetry;
  metrics: RoomMetrics;
}

export interface OpsEvent {
  id: string;
  roomId: string;
  time: string;
  tone: EventTone;
  source: string;
  message: string;
}

export interface CreateRoomInput {
  name: string;
  description: string;
  region: string;
  map: string;
  mode: GameMode;
  maxPlayers: number;
  initialBots: number;
}

export interface AddBotsInput {
  count: number;
  intervalMs: number;
}

export interface AddBotsResult {
  jobId: string;
  accepted: number;
}

export interface ControlPlaneCapabilities {
  scalingAvailable: boolean;
  maxRooms: number;
}

export type RoomCommand =
  | "start"
  | "stop"
  | "delete"
  | "snapshot"
  | "inject-pod-failure";

export interface GameControlPlane {
  getState(): Promise<{
    rooms: GameRoom[];
    capabilities: ControlPlaneCapabilities;
  }>;
  createRoom(input: CreateRoomInput): Promise<GameRoom>;
  updateRoom(roomId: string, input: CreateRoomInput): Promise<GameRoom>;
  commandRoom(roomId: string, command: RoomCommand): Promise<void>;
  addBots(roomId: string, input: AddBotsInput): Promise<AddBotsResult>;
  cancelBotLoad(roomId: string, jobId: string): Promise<void>;
  removeBots(roomId: string): Promise<void>;
  setJoinLocked(roomId: string, locked: boolean): Promise<void>;
}

export const ROOM_STATUS_LABEL: Record<RoomStatus, string> = {
  running: "RUNNING",
  provisioning: "PROVISIONING",
  stopped: "STOPPED",
  recovering: "RECOVERING",
  degraded: "DEGRADED",
};

export const MATCH_PHASE_LABEL: Record<MatchPhase, string> = {
  lobby: "LOBBY",
  in_match: "IN MATCH",
  finished: "FINISHED",
};

export const MAP_OBJECTS = [
  { id: "warehouse", x: 17, y: 23, w: 9, h: 6, kind: "building" },
  { id: "cabins", x: 34, y: 14, w: 6, h: 5, kind: "building" },
  { id: "factory", x: 68, y: 22, w: 12, h: 8, kind: "building" },
  { id: "hangar", x: 79, y: 49, w: 8, h: 12, kind: "building" },
  { id: "village-a", x: 20, y: 69, w: 7, h: 6, kind: "building" },
  { id: "village-b", x: 31, y: 78, w: 5, h: 5, kind: "building" },
  { id: "bunker", x: 57, y: 74, w: 9, h: 7, kind: "building" },
  { id: "port", x: 76, y: 82, w: 11, h: 5, kind: "building" },
  { id: "lake", x: 45, y: 39, w: 13, h: 17, kind: "water" },
] as const;

export const MAP_LABELS = [
  { name: "WAREHOUSE", x: 17, y: 19 },
  { name: "FACTORY", x: 71, y: 18 },
  { name: "CENTRAL LAKE", x: 45, y: 48 },
  { name: "BUNKER", x: 59, y: 82 },
  { name: "SOUTH PORT", x: 79, y: 89 },
] as const;
