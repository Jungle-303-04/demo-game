export type Team = "red" | "blue";
export type RoomStatus = "waiting" | "running" | "ended";

export interface Vec2 {
  x: number;
  y: number;
}

export interface PlayerState {
  sessionId: string;
  nickname: string;
  team: Team;
  position: Vec2;
  score: number;
  deaths: number;
  alive: boolean;
  connected: boolean;
  isBot: boolean;
  kicked: boolean;
  respawnAt: number | null;
}

export interface GroundLoot {
  id: string;
  kind: string;
  position: Vec2;
}

export interface RoomSnapshot {
  schemaVersion: 1;
  roomId: string;
  status: RoomStatus;
  sequence: number;
  savedAt: number;
  players: PlayerState[];
  terrainDestroyed: string[];
  groundLoot: GroundLoot[];
}

export interface InputPacket {
  sequence: number;
  dx: number;
  dy: number;
}

export interface InputResult {
  accepted: boolean;
  reason?: "malformed" | "rate" | "movement" | "kicked";
  kick: boolean;
}

export interface RoomSummary {
  roomId: string;
  status: RoomStatus;
  players: number;
  alive: number;
  podName: string;
  strictMode: boolean;
  qrUrl: string;
}

export interface OpsPlayer {
  sessionId: string;
  nickname: string;
  team: Team;
  x: number;
  y: number;
  alive: boolean;
  score: number;
}

export interface OpsSnapshot {
  roomId: string;
  sequence: number;
  players: OpsPlayer[];
}

export interface StructuredLog {
  level: "info" | "warn" | "error";
  event: string;
  roomId?: string;
  sessionId?: string;
  nickname?: string;
  server?: string;
  detail?: Record<string, unknown>;
}
