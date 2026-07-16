import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { DemoRoom } from "./room.js";

export class GameMetrics {
  readonly registry = new Registry();
  private readonly tickDuration = new Histogram({ name: "tick_duration_ms", help: "Game tick duration in milliseconds", labelNames: ["room"] as const, registers: [this.registry] });
  private readonly inputRate = new Counter({ name: "player_input_rate", help: "Player input packets", labelNames: ["room", "outcome"] as const, registers: [this.registry] });
  private readonly playersOnline = new Gauge({ name: "players_online", help: "Connected players", labelNames: ["room"] as const, registers: [this.registry] });
  private readonly playersAlive = new Gauge({ name: "players_alive", help: "Alive players", labelNames: ["room"] as const, registers: [this.registry] });
  private readonly wsOutBytes = new Counter({ name: "ws_out_bytes", help: "Outbound state bytes", labelNames: ["room"] as const, registers: [this.registry] });
  private readonly authorityCorrections = new Counter({ name: "authority_corrections_total", help: "Rejected movement authority updates", labelNames: ["room"] as const, registers: [this.registry] });
  private readonly entityCount = new Gauge({ name: "entity_count", help: "Persistent room entities", labelNames: ["room"] as const, registers: [this.registry] });
  private readonly decodeErrors = new Counter({ name: "decode_errors_total", help: "Malformed inputs", labelNames: ["room"] as const, registers: [this.registry] });

  observeTick(room: DemoRoom, elapsedMs: number): void {
    const snapshot = room.snapshot();
    const players = snapshot.players.filter((player) => !player.kicked);
    this.tickDuration.labels(snapshot.roomId).observe(elapsedMs);
    this.playersOnline.labels(snapshot.roomId).set(players.filter((player) => player.connected).length);
    this.playersAlive.labels(snapshot.roomId).set(players.filter((player) => player.alive).length);
    this.entityCount.labels(snapshot.roomId).set(snapshot.groundLoot.length);
    this.wsOutBytes.labels(snapshot.roomId).inc(Buffer.byteLength(JSON.stringify(room.opsSnapshot())));
  }

  observeInput(roomId: string, accepted: boolean, reason?: string): void {
    this.inputRate.labels(roomId, accepted ? "accepted" : "rejected").inc();
    if (reason === "movement") this.authorityCorrections.labels(roomId).inc();
    if (reason === "malformed") this.decodeErrors.labels(roomId).inc();
  }
}
