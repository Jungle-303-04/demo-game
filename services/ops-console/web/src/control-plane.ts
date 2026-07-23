export type RoomStatus =
  | "running"
  | "provisioning"
  | "stopped"
  | "recovering"
  | "degraded";

export type MatchPhase = "lobby" | "in_match" | "finished";
export type GameMode = "Faction 50v50" | "Solo FFA";
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

export interface MapObjectTelemetry {
  id: number;
  type: string;
  kind: "building" | "structure" | "tree" | "rock" | "wall" | "obstacle";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapLayoutTelemetry {
  width: number;
  height: number;
  shoreInset: number;
  grassInset: number;
  rivers: Array<{
    width: number;
    looped: boolean;
    points: Array<{ x: number; y: number }>;
  }>;
  places: Array<{ name: string; x: number; y: number }>;
  objects: MapObjectTelemetry[];
}

export interface RoomMetrics {
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number;
  networkInKbps: number | null;
  networkOutKbps: number | null;
  tickP95Ms: number;
  inputAccepted: number;
  inputRejected: number;
  websocketCount: number;
  redisOpsPerSecond: number | null;
  telemetryLagMs: number;
  admissionFailureRatePercent?: number;
  resourceSampleCount?: number;
}

export interface GameRoom {
  id: string;
  roomId: string;
  name: string;
  roomName: string;
  description: string;
  region: string;
  map: string;
  mode: GameMode;
  maxPlayers: number;
  status: RoomStatus;
  matchPhase: MatchPhase;
  players: PlayerTelemetry[];
  currentPodName: string;
  podRoomLabel: string;
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
  mapLayout: MapLayoutTelemetry;
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

export type FailureScenarioId =
  | "admission-lock"
  | "bot-surge"
  | "malicious-input"
  | "admission-storm"
  | "process-crash"
  | "pod-failure";

export interface FailureScenarioEvidence {
  [key: string]: unknown;
}

export interface ActiveFailureScenario {
  scenarioId: FailureScenarioId;
  status: string;
  startedAt: string;
  jobId?: string;
  autoRecoverAt?: string;
  evidence?: FailureScenarioEvidence;
}

export interface FailureScenarioResult {
  at: string;
  message: string;
  evidence?: FailureScenarioEvidence;
}

export interface FailureScenarioRoomState {
  roomId: string;
  minimumBotsPerRoom: number;
  normalBots: number;
  hackBots: number;
  active?: ActiveFailureScenario;
  lastResults: Partial<Record<FailureScenarioId, FailureScenarioResult>>;
}

export interface FailureScenarioState {
  rooms: FailureScenarioRoomState[];
  capabilities: {
    podFailure: boolean;
  };
}

export interface AddBotsResult {
  jobId: string;
  accepted: number;
}

export interface RemoveBotsResult {
  killed: number;
  remaining: number;
  minimumBotsPerRoom: number;
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
  resetRoom(roomId: string): Promise<void>;
  addBots(roomId: string, input: AddBotsInput): Promise<AddBotsResult>;
  cancelBotLoad(roomId: string, jobId: string): Promise<void>;
  removeBots(roomId: string, count: number): Promise<RemoveBotsResult>;
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
