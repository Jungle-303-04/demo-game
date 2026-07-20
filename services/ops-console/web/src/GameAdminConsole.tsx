"use client";

import {
  memo,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type GameRoom,
  type MapLayoutTelemetry,
  type PlayerTelemetry,
} from "./control-plane.js";
import {
  ControlPlaneError,
  controlPlaneClient,
  setControlPlaneAdminToken,
} from "./control-plane-client.js";

type StyleWithVariables = CSSProperties & Record<`--${string}`, string | number>;
type ConnectionState = "connecting" | "connected" | "degraded";

const POLL_INTERVAL_MS = 400;
const BOT_BATCH_SIZE = 10;

const OBJECT_COLORS: Record<MapLayoutTelemetry["objects"][number]["kind"], string> = {
  building: "#73563f",
  structure: "#96775d",
  tree: "#42663e",
  rock: "#747b7d",
  wall: "#574a41",
  obstacle: "#916b3e",
};

function mapLayoutKey(map: MapLayoutTelemetry, seed: number) {
  return `${seed}:${map.width}:${map.height}:${map.rivers.length}:${map.places.length}:${map.objects.length}`;
}

function mapPalette(theme: string) {
  const normalized = theme.toLowerCase();
  if (normalized.includes("desert")) {
    return { water: "#317e9f", shore: "#c88e48", ground: "#dca653", grid: "rgba(87,58,33,.18)" };
  }
  if (normalized.includes("snow")) {
    return { water: "#0c515a", shore: "#d6bb61", ground: "#c7c9c8", grid: "rgba(55,64,67,.16)" };
  }
  return { water: "#2f789a", shore: "#c79a5f", ground: "#6f9d43", grid: "rgba(40,74,35,.16)" };
}

function drawLiveMap(canvas: HTMLCanvasElement, map: MapLayoutTelemetry, theme: string) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  const palette = mapPalette(theme);
  context.setTransform(width / map.width, 0, 0, height / map.height, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = palette.water;
  context.fillRect(0, 0, map.width, map.height);
  const shore = Math.max(0, map.shoreInset);
  context.fillStyle = palette.shore;
  context.fillRect(shore, shore, Math.max(0, map.width - shore * 2), Math.max(0, map.height - shore * 2));
  const grass = shore + Math.max(0, map.grassInset);
  context.fillStyle = palette.ground;
  context.fillRect(grass, grass, Math.max(0, map.width - grass * 2), Math.max(0, map.height - grass * 2));

  context.strokeStyle = palette.grid;
  context.lineWidth = 0.6;
  for (let x = grass; x <= map.width - grass; x += 32) {
    context.beginPath(); context.moveTo(x, grass); context.lineTo(x, map.height - grass); context.stroke();
  }
  for (let y = grass; y <= map.height - grass; y += 32) {
    context.beginPath(); context.moveTo(grass, y); context.lineTo(map.width - grass, y); context.stroke();
  }

  context.lineCap = "round";
  context.lineJoin = "round";
  for (const river of map.rivers) {
    if (river.points.length < 2) continue;
    context.beginPath();
    context.moveTo(river.points[0]!.x, river.points[0]!.y);
    for (const point of river.points.slice(1)) context.lineTo(point.x, point.y);
    if (river.looped) context.closePath();
    context.strokeStyle = palette.shore;
    context.lineWidth = Math.max(4, river.width * 2 + 9);
    context.stroke();
    context.strokeStyle = palette.water;
    context.lineWidth = Math.max(2, river.width * 2);
    context.stroke();
  }

  for (const object of map.objects) {
    const objectWidth = Math.max(1, object.width);
    const objectHeight = Math.max(1, object.height);
    context.fillStyle = OBJECT_COLORS[object.kind];
    if (object.kind === "tree" || object.kind === "rock") {
      context.beginPath();
      context.ellipse(object.x, object.y, Math.max(1.5, objectWidth / 2), Math.max(1.5, objectHeight / 2), 0, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillRect(object.x - objectWidth / 2, object.y - objectHeight / 2, objectWidth, objectHeight);
    }
  }

  const fontSize = Math.max(12, Math.min(24, map.width / 42));
  context.font = `700 ${fontSize}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  for (const place of map.places) {
    context.strokeStyle = "rgba(0,0,0,.48)";
    context.lineWidth = Math.max(2, fontSize / 5);
    context.strokeText(place.name, place.x, place.y);
    context.fillStyle = "rgba(255,255,255,.9)";
    context.fillText(place.name, place.x, place.y);
  }
}

const LiveMapCanvas = memo(function LiveMapCanvas({ map, seed, theme }: {
  map: MapLayoutTelemetry;
  seed: number;
  theme: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutKey = mapLayoutKey(map, seed);
  const latestRef = useRef({ map, theme });
  latestRef.current = { map, theme };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const redraw = () => drawLiveMap(canvas, latestRef.current.map, latestRef.current.theme);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [layoutKey, theme]);
  return <canvas aria-hidden="true" className="live-map-canvas" ref={canvasRef} />;
});

function errorMessage(error: unknown) {
  if (error instanceof ControlPlaneError && error.status === 401) {
    return "봇 투입에는 관리자 토큰이 필요합니다.";
  }
  if (error instanceof ControlPlaneError) return error.message;
  if (error instanceof Error) return error.message;
  return "게임 서버 연결에 실패했습니다.";
}

function playerCounts(room: GameRoom) {
  const bots = room.players.filter((player) => player.isBot).length;
  return { bots, humans: room.players.length - bots };
}

function isSnapshotReady(room: GameRoom) {
  return (
    room.snapshotCapturedAt > 0 &&
    room.mapLayout.width > 0 &&
    room.mapLayout.height > 0
  );
}

function PlayerMarkers({
  players,
  selectedPlayerId,
  interactive = false,
  onSelectPlayer,
}: {
  players: PlayerTelemetry[];
  selectedPlayerId?: string;
  interactive?: boolean;
  onSelectPlayer?: (playerId: string) => void;
}) {
  return (
    <div className="map-player-layer">
      {players.map((player) => {
        const className = [
          "map-player",
          player.isBot ? "is-bot" : "is-human",
          player.health <= 0 ? "is-dead" : "",
          selectedPlayerId === player.id ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const style = {
          "--player-x": player.x,
          "--player-y": player.y,
          "--player-color": player.color,
          "--player-rotation": `${player.rotation}rad`,
        } as StyleWithVariables;

        if (!interactive) {
          return (
            <i
              aria-hidden="true"
              className={className}
              key={player.id}
              style={style}
            />
          );
        }

        return (
          <button
            aria-label={`${player.name} 관전`}
            className={className}
            key={player.id}
            onClick={() => onSelectPlayer?.(player.id)}
            style={style}
            title={`${player.name} · HP ${Math.round(player.health)} · ${player.kills}K`}
            type="button"
          >
            <span />
            <b>{player.name}</b>
          </button>
        );
      })}
    </div>
  );
}

function roomServiceUrl(room: GameRoom) {
  const configuredOrigin = import.meta.env.VITE_GAME_ORIGIN?.trim();
  return new URL(room.serviceUrl, configuredOrigin || window.location.origin);
}

function ActualGameMap({
  room,
  interactive = false,
  selectedPlayerId,
  onSelectPlayer,
}: {
  room: GameRoom;
  interactive?: boolean;
  selectedPlayerId?: string;
  onSelectPlayer?: (playerId: string) => void;
}) {
  return (
    <div className="actual-game-map">
      <LiveMapCanvas map={room.mapLayout} seed={room.seed} theme={room.map} />
      <PlayerMarkers
        interactive={interactive}
        onSelectPlayer={onSelectPlayer}
        players={room.players}
        selectedPlayerId={selectedPlayerId}
      />
    </div>
  );
}

function LiveRoomMiniMap({ room }: { room: GameRoom }) {
  if (!isSnapshotReady(room)) {
    return (
      <div className="map-awaiting" role="status">
        <i />
        <span>실시간 맵 연결 중</span>
      </div>
    );
  }

  return (
    <div className="room-live-map" aria-label={`${room.name} 실시간 미니맵`}>
      <ActualGameMap room={room} />
    </div>
  );
}

function RoomCard({
  room,
  ordinal,
  onOpen,
}: {
  room: GameRoom;
  ordinal: number;
  onOpen: () => void;
}) {
  const { bots, humans } = playerCounts(room);
  return (
    <article
      className="room-card"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      role="button"
      tabIndex={0}
    >
      <span className="room-number">{String(ordinal).padStart(2, "0")}</span>
      <div className="room-preview">
        <LiveRoomMiniMap room={room} />
        {isSnapshotReady(room) && (
          <span className="live-badge"><i />LIVE</span>
        )}
      </div>
      <div className="room-card-copy">
        <div>
          <span>{room.map}</span>
          <h2>{room.name}</h2>
        </div>
        <strong>{room.players.length}</strong>
      </div>
      <div className="room-card-counts">
        <span>사용자 <strong>{humans}</strong></span>
        <span>봇 <strong>{bots}</strong></span>
      </div>
    </article>
  );
}

function RoomDirectory({
  rooms,
  connection,
  onOpenRoom,
}: {
  rooms: GameRoom[];
  connection: ConnectionState;
  onOpenRoom: (roomId: string) => void;
}) {
  if (rooms.length === 0) {
    return (
      <section className="empty-state" role="status">
        <i />
        <strong>{connection === "connecting" ? "게임 서버 연결 중" : "활성 게임 방 없음"}</strong>
      </section>
    );
  }

  return (
    <section className="room-directory">
      <div className="directory-heading">
        <h1>실시간 게임</h1>
        <span>{rooms.length}개 방</span>
      </div>
      <div className="room-grid" aria-label="실시간 게임 방">
        {rooms.map((room, index) => (
          <RoomCard
            key={room.id}
            onOpen={() => onOpenRoom(room.id)}
            ordinal={index + 1}
            room={room}
          />
        ))}
      </div>
    </section>
  );
}

function roomWatchUrl(room: GameRoom, player: PlayerTelemetry) {
  const url = roomServiceUrl(room);
  url.pathname = url.pathname.replace(/\/play\/(room-\d+)\/?$/, "/watch/$1/");
  url.search = "";
  url.searchParams.set("view", "player");
  url.searchParams.set("target", player.id);
  return url.toString();
}

function PlayerSpectatorView({
  room,
  player,
}: {
  room: GameRoom;
  player: PlayerTelemetry;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initialUrlRef = useRef(roomWatchUrl(room, player));

  useEffect(() => {
    let animationFrame = 0;
    const driveSpectatorFrame = () => {
      try {
        const frameWindow = iframeRef.current?.contentWindow as
          | (Window & { __opsiaDriveSpectatorFrame?: () => void })
          | null;
        frameWindow?.__opsiaDriveSpectatorFrame?.();
      } catch {
        // A separately hosted development game client keeps its own ticker.
      }
      animationFrame = window.requestAnimationFrame(driveSpectatorFrame);
    };
    animationFrame = window.requestAnimationFrame(driveSpectatorFrame);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  return (
    <div className="player-spectator">
      <iframe
        allow="fullscreen"
        ref={iframeRef}
        src={initialUrlRef.current}
        tabIndex={-1}
        title={`${player.name} 실시간 관전`}
      />
      <div className="spectator-label">
        <i style={{ background: player.color }} />
        <strong>{player.name}</strong>
        <span>{player.isBot ? "BOT" : "PLAYER"}</span>
      </div>
    </div>
  );
}

function TacticalMap({
  room,
  selectedPlayerId,
  onSelectPlayer,
}: {
  room: GameRoom;
  selectedPlayerId?: string;
  onSelectPlayer: (playerId: string) => void;
}) {
  if (!isSnapshotReady(room)) {
    return (
      <div className="map-awaiting is-large" role="status">
        <i />
        <span>게임 프로세스의 실제 맵 스냅샷을 기다리는 중</span>
      </div>
    );
  }

  return (
    <div className="tactical-map" aria-label={`${room.name} 실시간 미니맵`}>
      <div
        className="map-viewport"
        style={{ aspectRatio: `${room.mapLayout.width} / ${room.mapLayout.height}` }}
      >
        <ActualGameMap
          interactive
          onSelectPlayer={onSelectPlayer}
          room={room}
          selectedPlayerId={selectedPlayerId}
        />
      </div>
    </div>
  );
}

function RoomViewer({
  room,
  selectedPlayer,
  botPending,
  onBack,
  onAddBots,
  onSelectPlayer,
  onClearPlayer,
  onError,
}: {
  room: GameRoom;
  selectedPlayer?: PlayerTelemetry;
  botPending: boolean;
  onBack: () => void;
  onAddBots: () => void;
  onSelectPlayer: (playerId: string) => void;
  onClearPlayer: () => void;
  onError: (message: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { bots, humans } = playerCounts(room);
  const alivePlayers = useMemo(
    () =>
      room.players
        .filter((player) => player.health > 0)
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name, "ko")),
    [room.players],
  );

  const selectAdjacentPlayer = useCallback((reverse = false) => {
    if (alivePlayers.length === 0) return;
    const spectatorFrame = stageRef.current?.querySelector<HTMLIFrameElement>(
      ".player-spectator iframe",
    );
    if (selectedPlayer && spectatorFrame?.contentWindow) {
      spectatorFrame.contentWindow.postMessage({
        type: "opsia-spectator-command",
        action: reverse ? "prev" : "next",
      }, roomServiceUrl(room).origin);
      return;
    }
    const currentIndex = alivePlayers.findIndex(
      (player) => player.id === selectedPlayer?.id,
    );
    const direction = reverse ? -1 : 1;
    const startIndex = currentIndex < 0 ? (reverse ? 0 : -1) : currentIndex;
    const nextIndex =
      (startIndex + direction + alivePlayers.length) % alivePlayers.length;
    const nextPlayer = alivePlayers[nextIndex];
    if (nextPlayer) onSelectPlayer(nextPlayer.id);
  }, [alivePlayers, onSelectPlayer, room, selectedPlayer]);

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        selectAdjacentPlayer(event.shiftKey);
        return;
      }
      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        onClearPlayer();
      }
    };
    window.addEventListener("keydown", handleKeys);
    return () => window.removeEventListener("keydown", handleKeys);
  }, [onClearPlayer, selectAdjacentPlayer]);

  useEffect(() => {
    const expectedOrigin = roomServiceUrl(room).origin;
    const handleSpectatorMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const data = event.data as {
        type?: unknown;
        key?: unknown;
        shiftKey?: unknown;
        name?: unknown;
      } | null;
      if (!data) return;
      if (data.type === "opsia-spectator-target" && typeof data.name === "string") {
        const player = alivePlayers.find((candidate) => candidate.name === data.name);
        if (player) onSelectPlayer(player.id);
        return;
      }
      if (data.type !== "opsia-spectator-key") return;
      if (data.key === "Tab") {
        selectAdjacentPlayer(data.shiftKey === true);
      } else if (data.key === "m") {
        onClearPlayer();
      }
    };
    window.addEventListener("message", handleSpectatorMessage);
    return () => window.removeEventListener("message", handleSpectatorMessage);
  }, [alivePlayers, onClearPlayer, onSelectPlayer, room, selectAdjacentPlayer]);

  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === stageRef.current) {
        await document.exitFullscreen();
      } else {
        await stageRef.current?.requestFullscreen();
      }
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  return (
    <section className="room-viewer">
      <div className="room-toolbar">
        <button className="back-button" onClick={onBack} type="button" aria-label="방 목록">
          ←
        </button>
        <div className="room-title">
          <span>{room.map}</span>
          <strong>{selectedPlayer?.name ?? room.name}</strong>
        </div>
        <div className="room-actions">
          <span>사용자 <strong>{humans}</strong></span>
          <span>봇 <strong>{bots}</strong></span>
          <button disabled={botPending} onClick={onAddBots} type="button">
            {botPending ? "투입 중" : `봇 +${BOT_BATCH_SIZE}`}
          </button>
          <button onClick={() => void toggleFullscreen()} type="button">
            {isFullscreen ? "축소" : "전체화면"}
          </button>
          <kbd>Tab 관전</kbd>
          <kbd>M 맵</kbd>
        </div>
      </div>
      <div className="world-stage" ref={stageRef}>
        {selectedPlayer ? (
          <PlayerSpectatorView player={selectedPlayer} room={room} />
        ) : (
          <TacticalMap
            onSelectPlayer={onSelectPlayer}
            room={room}
          />
        )}
      </div>
    </section>
  );
}

/** The UI renders only authoritative control-plane snapshots and live players. */
export function GameAdminConsole() {
  const [rooms, setRooms] = useState<GameRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [botPending, setBotPending] = useState(false);
  const requestPendingRef = useRef(false);
  const hasMapLayoutsRef = useRef(false);

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const selectedPlayer = selectedRoom?.players.find(
    (player) => player.id === selectedPlayerId,
  );
  const totalPlayers = rooms.reduce((total, room) => total + room.players.length, 0);

  const refresh = useCallback(async (quiet = false) => {
    if (requestPendingRef.current) return;
    requestPendingRef.current = true;
    try {
      const state = await controlPlaneClient.getState(hasMapLayoutsRef.current);
      setRooms((currentRooms) => {
        const currentById = new Map(currentRooms.map((room) => [room.id, room]));
        const merged = state.rooms.flatMap((room) => {
          if (room.mapLayout) return [room];
          const current = currentById.get(room.id);
          return current ? [{ ...room, mapLayout: current.mapLayout }] : [];
        });
        if (merged.length === state.rooms.length && merged.every(isSnapshotReady)) {
          hasMapLayoutsRef.current = true;
        }
        return merged.sort((left, right) => left.id.localeCompare(right.id));
      });
      setConnection("connected");
      if (!quiet) setError("");
    } catch (refreshError) {
      setConnection("degraded");
      if (!quiet) setError(errorMessage(refreshError));
    } finally {
      requestPendingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (selectedPlayerId && !selectedPlayer) setSelectedPlayerId("");
  }, [selectedPlayer, selectedPlayerId]);

  async function addBots() {
    if (!selectedRoom || botPending) return;
    setBotPending(true);
    setError("");
    try {
      await controlPlaneClient.addBots(selectedRoom.id, {
        count: BOT_BATCH_SIZE,
        intervalMs: 100,
      });
      await refresh(true);
    } catch (addError) {
      if (addError instanceof ControlPlaneError && addError.status === 401) {
        const token = window.prompt("관리자 토큰을 입력하세요");
        if (token?.trim()) {
          setControlPlaneAdminToken(token);
          try {
            await controlPlaneClient.addBots(selectedRoom.id, {
              count: BOT_BATCH_SIZE,
              intervalMs: 100,
            });
            await refresh(true);
            return;
          } catch (retryError) {
            setError(errorMessage(retryError));
          }
        } else {
          setError(errorMessage(addError));
        }
      } else {
        setError(errorMessage(addError));
      }
    } finally {
      setBotPending(false);
    }
  }

  return (
    <main className={`console-shell ${selectedRoom ? "is-room-open" : ""}`}>
      <header className="console-topbar">
        <button
          aria-label="실시간 게임 방 목록"
          className="console-brand"
          onClick={() => {
            setSelectedRoomId(null);
            setSelectedPlayerId("");
          }}
          type="button"
        >
          <span className="brand-mark">O</span>
          <strong>jungle-303</strong>
        </button>
        <span className="server-chip">게임 서버</span>
        <div className={`live-status is-${connection}`}>
          <i />
          <span>{connection === "connected" ? "LIVE" : connection === "connecting" ? "연결 중" : "연결 오류"}</span>
          <strong>{totalPlayers}</strong>
        </div>
      </header>

      {error && (
        <div className="error-notice" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} type="button">닫기</button>
        </div>
      )}

      {selectedRoom ? (
        <RoomViewer
          botPending={botPending}
          onAddBots={() => void addBots()}
          onBack={() => {
            setSelectedRoomId(null);
            setSelectedPlayerId("");
          }}
          onClearPlayer={() => setSelectedPlayerId("")}
          onError={setError}
          onSelectPlayer={setSelectedPlayerId}
          room={selectedRoom}
          selectedPlayer={selectedPlayer}
        />
      ) : (
        <RoomDirectory
          connection={connection}
          onOpenRoom={(roomId) => {
            setSelectedRoomId(roomId);
            setSelectedPlayerId("");
          }}
          rooms={rooms}
        />
      )}
    </main>
  );
}
