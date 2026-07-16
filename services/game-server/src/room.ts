import { applyDelta, InputValidator, LENIENT_POLICY, STRICT_POLICY } from "./input-validator.js";
import type { InputPacket, InputResult, OpsSnapshot, PlayerState, RoomSnapshot, RoomStatus, StructuredLog, Team } from "./types.js";

export interface DemoRoomOptions {
  roomId: string;
  podName: string;
  strictMode?: boolean;
  now?: () => number;
  log?: (entry: StructuredLog) => void;
}

const copyPlayer = (player: PlayerState): PlayerState => ({ ...player, position: { ...player.position } });

export class DemoRoom {
  readonly roomId: string;
  readonly podName: string;
  readonly strictMode: boolean;
  private readonly now: () => number;
  private readonly log: (entry: StructuredLog) => void;
  private readonly inputValidator: InputValidator;
  private players = new Map<string, PlayerState>();
  private terrainDestroyed = new Set<string>();
  private groundLoot: RoomSnapshot["groundLoot"] = [];
  private status: RoomStatus = "waiting";
  private sequence = 0;

  constructor(options: DemoRoomOptions) {
    this.roomId = options.roomId;
    this.podName = options.podName;
    this.strictMode = options.strictMode ?? false;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.inputValidator = new InputValidator(this.strictMode ? STRICT_POLICY : LENIENT_POLICY, this.strictMode);
  }

  static restore(snapshot: RoomSnapshot, options: DemoRoomOptions): DemoRoom {
    if (snapshot.schemaVersion !== 1) throw new Error(`unsupported snapshot schema ${snapshot.schemaVersion}`);
    const room = new DemoRoom(options);
    if (snapshot.roomId !== room.roomId) throw new Error("snapshot room mismatch");
    room.status = snapshot.status === "ended" ? "waiting" : snapshot.status;
    room.sequence = snapshot.sequence;
    room.players = new Map(snapshot.players.map((player) => [player.sessionId, { ...copyPlayer(player), connected: false }]));
    room.terrainDestroyed = new Set(snapshot.terrainDestroyed);
    room.groundLoot = snapshot.groundLoot.map((loot) => ({ ...loot, position: { ...loot.position } }));
    return room;
  }

  start(): void {
    if (this.status === "ended") throw new Error("ended rooms must be reset before starting");
    this.status = "running";
    this.bump();
    this.event("info", "room_started");
  }

  join(sessionId: string, nickname: string, isBot = false): { player: PlayerState; reconnected: boolean } {
    const previous = this.players.get(sessionId);
    if (previous?.kicked) throw new Error("session_kicked");
    if (previous) {
      previous.connected = true;
      previous.nickname = nickname || previous.nickname;
      this.bump();
      this.event("info", "player_reconnected", previous, { team: previous.team, score: previous.score });
      return { player: copyPlayer(previous), reconnected: true };
    }

    const team = this.pickTeam();
    const player: PlayerState = {
      sessionId,
      nickname: nickname.slice(0, 24) || `guest-${this.players.size + 1}`,
      team,
      position: this.spawnFor(team),
      score: 0,
      deaths: 0,
      alive: true,
      connected: true,
      isBot,
      kicked: false,
      respawnAt: null,
    };
    this.players.set(sessionId, player);
    this.bump();
    this.event("info", isBot ? "bot_spawned" : "player_joined", player);
    return { player: copyPlayer(player), reconnected: false };
  }

  disconnect(sessionId: string): void {
    const player = this.players.get(sessionId);
    if (!player) return;
    player.connected = false;
    this.bump();
  }

  applyInput(sessionId: string, input: InputPacket): InputResult {
    const player = this.players.get(sessionId);
    if (!player || player.kicked) return { accepted: false, reason: "kicked", kick: true };
    const result = this.inputValidator.validate(sessionId, input, this.now());
    if (!result.accepted) {
      const event = result.reason === "movement" ? "movement_anomaly" : "input_rate_exceeded";
      this.event("warn", event, player, { reason: result.reason, strictMode: this.strictMode });
      if (result.kick) {
        player.kicked = true;
        player.connected = false;
        this.event("warn", "session_kicked", player, { reason: result.reason, enforcement: "strict_mode" });
      }
      this.bump();
      return result;
    }
    if (player.alive && this.status === "running") {
      player.position = applyDelta(player.position, input);
      this.bump();
    }
    return result;
  }

  eliminate(sessionId: string): void {
    const player = this.requirePlayer(sessionId);
    if (!player.alive || this.status !== "running") return;
    player.alive = false;
    player.deaths += 1;
    player.respawnAt = this.now() + 1_000;
    this.bump();
  }

  award(sessionId: string, points = 1): void {
    const player = this.requirePlayer(sessionId);
    player.score += points;
    this.bump();
  }

  tick(): void {
    if (this.status !== "running") return;
    const now = this.now();
    for (const player of this.players.values()) {
      if (!player.alive && !player.kicked && player.respawnAt !== null && player.respawnAt <= now) {
        player.alive = true;
        player.position = this.spawnFor(player.team);
        player.respawnAt = null;
        this.event("info", "player_respawned", player);
        this.bump();
      }
    }
  }

  endAndReset(): void {
    this.status = "ended";
    this.event("info", "room_ended");
    this.players.clear();
    this.terrainDestroyed.clear();
    this.groundLoot = [];
    this.status = "waiting";
    this.bump();
  }

  snapshot(): RoomSnapshot {
    return {
      schemaVersion: 1,
      roomId: this.roomId,
      status: this.status,
      sequence: this.sequence,
      savedAt: this.now(),
      players: [...this.players.values()].map(copyPlayer),
      terrainDestroyed: [...this.terrainDestroyed].sort(),
      groundLoot: this.groundLoot.map((loot) => ({ ...loot, position: { ...loot.position } })),
    };
  }

  opsSnapshot(): OpsSnapshot {
    return {
      roomId: this.roomId,
      sequence: this.sequence,
      players: [...this.players.values()].filter((player) => !player.kicked).map((player) => ({
        sessionId: player.sessionId,
        nickname: player.nickname,
        team: player.team,
        x: player.position.x,
        y: player.position.y,
        alive: player.alive,
        score: player.score,
      })),
    };
  }

  getPlayer(sessionId: string): PlayerState | undefined {
    const player = this.players.get(sessionId);
    return player ? copyPlayer(player) : undefined;
  }

  summary(baseUrl = "http://localhost:8080"): { roomId: string; status: RoomStatus; players: number; alive: number; podName: string; strictMode: boolean; qrUrl: string } {
    const active = [...this.players.values()].filter((player) => !player.kicked);
    return {
      roomId: this.roomId,
      status: this.status,
      players: active.length,
      alive: active.filter((player) => player.alive).length,
      podName: this.podName,
      strictMode: this.strictMode,
      qrUrl: `${baseUrl}/play/${this.roomId}`,
    };
  }

  private event(level: StructuredLog["level"], event: string, player?: PlayerState, detail?: Record<string, unknown>): void {
    this.log({ level, event, roomId: this.roomId, sessionId: player?.sessionId, nickname: player?.nickname, server: this.podName, detail });
  }

  private requirePlayer(sessionId: string): PlayerState {
    const player = this.players.get(sessionId);
    if (!player) throw new Error("unknown_session");
    return player;
  }

  private pickTeam(): Team {
    const players = [...this.players.values()].filter((player) => !player.kicked);
    const red = players.filter((player) => player.team === "red").length;
    const blue = players.length - red;
    return red <= blue ? "red" : "blue";
  }

  private spawnFor(team: Team): { x: number; y: number } {
    const index = [...this.players.values()].filter((player) => player.team === team).length;
    return { x: team === "red" ? 15 + (index % 5) : 85 - (index % 5), y: 15 + ((index * 13) % 70) };
  }

  private bump(): void { this.sequence += 1; }
}
