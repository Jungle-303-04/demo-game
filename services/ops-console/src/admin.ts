import { readControlToken, withControlToken } from "../../control-plane-auth.js";

const controlToken = readControlToken();

interface RoomSpec {
  name: string;
  description: string;
  region: string;
  map: string;
  mode: "Faction 50v50";
  maxPlayers: number;
  createdAt: string;
}

export interface RegistryRoom {
  roomId: string;
  ordinal: number;
  podName: string;
  endpoint: string;
  status: "waiting" | "running" | "ended" | "inactive";
  players: number;
  alive: number;
  strictMode: boolean;
  joinLocked?: boolean;
  statusChangedAt?: string;
  spec?: RoomSpec;
}

export interface RegistryState {
  rooms: RegistryRoom[];
  maxRooms: number;
  scalingAvailable: boolean;
}

interface GameSummary {
  roomId: string;
  status: string;
  players: number;
  alive: number;
  podName: string;
  strictMode: boolean;
  joinLocked?: boolean;
  capturedAt?: number;
  tickP95Ms?: number;
  cpuPercent?: number;
  memoryMb?: number;
  uptimeSeconds?: number;
}

interface SnapshotPlayer {
  sessionId: string;
  nickname: string;
  team: "red" | "blue";
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  alive: boolean;
  score: number;
  rotation?: number;
  health?: number;
  armor?: number;
  weapon?: string;
  ammo?: number;
  isBot?: boolean;
  connected?: boolean;
}

interface SnapshotMap {
  name: string;
  seed?: number;
  width: number;
  height: number;
  shoreInset?: number;
  grassInset?: number;
  rivers?: Array<{
    width: number;
    looped: boolean;
    points: Array<{ x: number; y: number }>;
  }>;
  places?: Array<{ name: string; x: number; y: number }>;
  objects?: Array<{
    id: number;
    type: string;
    kind: AdminMapObject["kind"];
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

interface GameSnapshot {
  roomId: string;
  capturedAt?: number;
  map?: SnapshotMap;
  zone?: { x: number; y: number; radius: number; nextX?: number; nextY?: number; nextRadius: number };
  players: SnapshotPlayer[];
  tickP95Ms: number;
  tickRate?: number;
  cpuPercent?: number;
  memoryMb?: number;
  uptimeSeconds?: number;
  strictMode: boolean;
  inputAccepted: number;
  inputRejected: number;
}

interface BotSummary {
  id: string;
  sessionId: string;
  roomId: string;
  mode: "normal" | "hack";
  connected: boolean;
}

export interface AdminPlayer {
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

export interface AdminMapObject {
  id: number;
  type: string;
  kind: "building" | "structure" | "tree" | "rock" | "wall" | "obstacle";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AdminMapLayout {
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
  objects: AdminMapObject[];
}

export interface AdminRoom {
  id: string;
  name: string;
  description: string;
  region: string;
  map: string;
  mode: "Faction 50v50";
  maxPlayers: number;
  status: "running" | "provisioning" | "stopped" | "recovering" | "degraded";
  matchPhase: "lobby" | "in_match" | "finished";
  players: AdminPlayer[];
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
  mapLayout: AdminMapLayout;
  podHealthy: boolean;
  desiredReplicas: number;
  readyReplicas: number;
  joinLocked: boolean;
  createdAt: string;
  recoveryStep?: string;
  zone: { x: number; y: number; radius: number; nextX: number; nextY: number; nextRadius: number };
  metrics: {
    cpuPercent: number;
    memoryMb: number;
    memoryLimitMb: number;
    networkInKbps: number | null;
    networkOutKbps: number | null;
    tickP95Ms: number;
    websocketCount: number;
    redisOpsPerSecond: number | null;
    telemetryLagMs: number;
  };
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 1_500,
): Promise<T> {
  const response = await fetch(url, withControlToken({
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  }, controlToken));
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { error: text }; }
  }
  if (!response.ok) throw new UpstreamError(response.status, body, `${url}:${response.status}`);
  return body as T;
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const screenY = (worldY: number, mapHeight: number): number =>
  clamp(mapHeight - worldY, 0, mapHeight);
const screenRotation = (worldRotation?: number): number => {
  const rotation = typeof worldRotation === "number" && Number.isFinite(worldRotation)
    ? worldRotation
    : 0;
  const projected = Math.PI / 2 - rotation;
  return Math.atan2(Math.sin(projected), Math.cos(projected));
};
const publicRoomUrls = (): Map<string, string> => new Map(
  (process.env.PUBLIC_ROOM_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0
        ? [entry.slice(0, separator), entry.slice(separator + 1)]
        : [entry, ""];
    })
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
);
const publicRoomUrl = (room: RegistryRoom): string => {
  const configured = publicRoomUrls().get(room.roomId);
  if (configured) return configured;
  const template = process.env.PUBLIC_ROOM_URL_TEMPLATE ?? "/play/{roomId}/";
  return template
    .replaceAll("{roomId}", room.roomId)
    .replaceAll("{ordinal}", String(room.ordinal));
};
const roomDefaults = (room: RegistryRoom): RoomSpec => ({
  name: `Faction Room ${room.ordinal + 1}`,
  description: "Survev 50:50 faction live room",
  region: "Seoul / ap-northeast-2",
  map: "Faction Island",
  mode: "Faction 50v50",
  maxPlayers: 100,
  createdAt: new Date(0).toISOString(),
});

async function optionalJson<T>(url: string): Promise<T | undefined> {
  try { return await fetchJson<T>(url); }
  catch { return undefined; }
}

export async function getRegistryState(orchestrator: string): Promise<RegistryState> {
  const state = await fetchJson<Partial<RegistryState> & { rooms: RegistryRoom[] }>(`${orchestrator}/rooms`);
  return {
    rooms: state.rooms,
    maxRooms: Number(state.maxRooms ?? 3),
    scalingAvailable: state.scalingAvailable === true,
  };
}

export async function listRegistryRooms(orchestrator: string): Promise<RegistryRoom[]> {
  return (await getRegistryState(orchestrator)).rooms;
}

export async function buildAdminRooms(
  orchestrator: string,
  botRunner: string,
  records?: RegistryRoom[],
): Promise<AdminRoom[]> {
  const registryRooms = records ?? await listRegistryRooms(orchestrator);
  const botResponse = await optionalJson<{ bots: BotSummary[] }>(`${botRunner}/bots`);
  const connectedBots = new Set((botResponse?.bots ?? []).filter((bot) => bot.connected).map((bot) => `${bot.roomId}:${bot.sessionId}`));

  return Promise.all(registryRooms.map(async (record): Promise<AdminRoom> => {
    const spec = record.spec ?? roomDefaults(record);
    const active = record.status !== "inactive";
    const [summary, snapshot] = active
      ? await Promise.all([
        optionalJson<GameSummary>(`${record.endpoint}/summary`),
        optionalJson<GameSnapshot>(`${record.endpoint}/ops/snapshot`),
      ])
      : [undefined, undefined];
    const capturedAt = snapshot?.capturedAt ?? summary?.capturedAt ?? 0;
    const telemetryLagMs = capturedAt ? Math.max(0, Date.now() - capturedAt) : 0;
    const mapWidth = Math.max(1, snapshot?.map?.width ?? 880);
    const mapHeight = Math.max(1, snapshot?.map?.height ?? 880);
    const mapScale = Math.max(mapWidth, mapHeight);
    const players = (snapshot?.players ?? []).filter((player) => player.connected !== false).map((player): AdminPlayer => {
      const isBot = player.isBot === true || (
        player.nickname.startsWith("OPSIA_") ||
        connectedBots.has(`${record.roomId}:${player.sessionId}`)
      );
      return {
        id: player.sessionId,
        name: player.nickname,
        x: clamp(player.x / mapWidth * 100),
        y: clamp(screenY(player.y, mapHeight) / mapHeight * 100),
        vx: (player.vx ?? 0) / mapWidth * 100,
        vy: -(player.vy ?? 0) / mapHeight * 100,
        rotation: screenRotation(player.rotation),
        health: clamp(player.health ?? (player.alive ? 100 : 0)),
        armor: clamp(player.armor ?? 0),
        kills: player.score,
        weapon: player.weapon ?? "unknown",
        ammo: player.ammo ?? 0,
        ping: 0,
        squad: player.team === "red" ? "RED" : "BLUE",
        color: player.team === "red" ? "#ff7c72" : "#75a8ff",
        isBot,
      };
    });
    const reachable = Boolean(summary && snapshot);
    const stale = telemetryLagMs > 3_000;
    const transitionStartedAt = Date.parse(record.statusChangedAt ?? spec.createdAt);
    const transitionAgeMs = Number.isFinite(transitionStartedAt) ? Date.now() - transitionStartedAt : Number.POSITIVE_INFINITY;
    const status: AdminRoom["status"] = !active
      ? "stopped"
      : reachable && !stale
        ? "running"
        : record.status === "waiting" && !snapshot && transitionAgeMs < 30_000
          ? "provisioning"
          : snapshot
            ? "recovering"
            : "degraded";
    const zone = snapshot?.zone;
    return {
      id: record.roomId,
      name: spec.name,
      description: spec.description,
      region: spec.region,
      map: "Faction Island",
      mode: "Faction 50v50",
      maxPlayers: 100,
      status,
      matchPhase: players.length > 0 ? "in_match" : status === "stopped" ? "finished" : "lobby",
      players,
      podName: summary?.podName ?? record.podName,
      podIp: "not exposed",
      node: "cluster managed",
      serviceUrl: publicRoomUrl(record),
      imageTag: process.env.GAME_IMAGE_TAG ?? "survev-game:runtime",
      redisKey: `room:${record.roomId}:snapshot`,
      snapshotAgeSeconds: telemetryLagMs / 1_000,
      snapshotCapturedAt: capturedAt,
      tickRate: snapshot?.tickRate ?? (reachable ? 40 : 0),
      uptimeSeconds: snapshot?.uptimeSeconds ?? summary?.uptimeSeconds ?? 0,
      seed: snapshot?.map?.seed ?? record.ordinal + 1,
      mapLayout: {
        width: mapWidth,
        height: mapHeight,
        shoreInset: Math.max(0, snapshot?.map?.shoreInset ?? 0),
        grassInset: Math.max(0, snapshot?.map?.grassInset ?? 0),
        rivers: (snapshot?.map?.rivers ?? []).map((river) => ({
          ...river,
          points: river.points.map((point) => ({
            x: clamp(point.x, 0, mapWidth),
            y: screenY(point.y, mapHeight),
          })),
        })),
        places: (snapshot?.map?.places ?? []).map((place) => ({
          x: clamp(place.x * mapWidth, 0, mapWidth),
          y: clamp(place.y * mapHeight, 0, mapHeight),
          name: place.name,
        })),
        objects: (snapshot?.map?.objects ?? []).map((object) => ({
          ...object,
          x: clamp(object.x, 0, mapWidth),
          y: screenY(object.y, mapHeight),
        })),
      },
      podHealthy: reachable && !stale,
      desiredReplicas: active ? 1 : 0,
      readyReplicas: reachable ? 1 : 0,
      joinLocked: summary?.joinLocked ?? record.joinLocked ?? false,
      createdAt: spec.createdAt,
      recoveryStep: status === "recovering" ? "새 게임 Pod와 Redis snapshot 연결 대기" : undefined,
      zone: zone
        ? {
          x: clamp(zone.x / mapWidth * 100),
          y: clamp(screenY(zone.y, mapHeight) / mapHeight * 100),
          radius: clamp(zone.radius / mapScale * 100),
          nextX: clamp((zone.nextX ?? zone.x) / mapWidth * 100),
          nextY: clamp(screenY(zone.nextY ?? zone.y, mapHeight) / mapHeight * 100),
          nextRadius: clamp(zone.nextRadius / mapScale * 100),
        }
        : { x: 50, y: 50, radius: 45, nextX: 50, nextY: 50, nextRadius: 35 },
      metrics: {
        cpuPercent: snapshot?.cpuPercent ?? summary?.cpuPercent ?? 0,
        memoryMb: snapshot?.memoryMb ?? summary?.memoryMb ?? 0,
        memoryLimitMb: Number(process.env.GAME_MEMORY_LIMIT_MB ?? 2_048),
        networkInKbps: null,
        networkOutKbps: null,
        tickP95Ms: snapshot?.tickP95Ms ?? summary?.tickP95Ms ?? 0,
        websocketCount: players.length,
        redisOpsPerSecond: null,
        telemetryLagMs,
      },
    };
  }));
}
