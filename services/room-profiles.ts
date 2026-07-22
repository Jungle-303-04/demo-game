export const GAME_MODES = ["Faction 50v50", "Solo FFA"] as const;
export type GameMode = typeof GAME_MODES[number];

export const GAME_MAPS = ["Faction Island", "Desert", "Snow", "Main Island", "Woods"] as const;
export type GameMap = typeof GAME_MAPS[number];

export interface RoomProfile {
  mapKey: "faction" | "desert" | "snow" | "main" | "woods";
  name: string;
  description: string;
  region: "Seoul / ap-northeast-2";
  map: GameMap;
  mode: GameMode;
  maxPlayers: 80 | 100;
}

export const ROOM_PROFILES: readonly RoomProfile[] = [
  {
    mapKey: "faction",
    name: "Faction Front",
    description: "Survev 50:50 faction live room",
    region: "Seoul / ap-northeast-2",
    map: "Faction Island",
    mode: "Faction 50v50",
    maxPlayers: 100,
  },
  {
    mapKey: "desert",
    name: "Desert Run",
    description: "Survev desert solo live room",
    region: "Seoul / ap-northeast-2",
    map: "Desert",
    mode: "Solo FFA",
    maxPlayers: 80,
  },
  {
    mapKey: "snow",
    name: "Snowfield",
    description: "Survev snow solo live room",
    region: "Seoul / ap-northeast-2",
    map: "Snow",
    mode: "Solo FFA",
    maxPlayers: 80,
  },
  {
    mapKey: "main",
    name: "Main Island",
    description: "Survev classic island solo live room",
    region: "Seoul / ap-northeast-2",
    map: "Main Island",
    mode: "Solo FFA",
    maxPlayers: 80,
  },
  {
    mapKey: "woods",
    name: "Woods Patrol",
    description: "Survev woods solo live room",
    region: "Seoul / ap-northeast-2",
    map: "Woods",
    mode: "Solo FFA",
    maxPlayers: 80,
  },
];

export const roomProfileForOrdinal = (ordinal: number): RoomProfile => {
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error("unsupported_room_ordinal");
  const profile = ROOM_PROFILES[ordinal % ROOM_PROFILES.length];
  if (!profile) throw new Error("unsupported_room_ordinal");
  const fleetCycle = Math.floor(ordinal / ROOM_PROFILES.length);
  return fleetCycle === 0
    ? profile
    : {
      ...profile,
      name: `${profile.name} ${fleetCycle + 1}`,
      description: `${profile.description} (auto room ${ordinal})`,
    };
};

export const roomProfileForMapKey = (mapKey: string, fallbackOrdinal: number): RoomProfile =>
  ROOM_PROFILES.find((profile) => profile.mapKey === mapKey)
  ?? roomProfileForOrdinal(fallbackOrdinal);
