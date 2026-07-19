"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type GameRoom,
  type PlayerTelemetry,
} from "./control-plane.js";
import {
  ControlPlaneError,
  controlPlaneClient,
  setControlPlaneAdminToken,
} from "./control-plane-client.js";

type StyleWithVariables = CSSProperties & Record<`--${string}`, string | number>;
type ConnectionState = "connecting" | "connected" | "degraded";

const POLL_INTERVAL_MS = 1_000;
const BOT_BATCH_SIZE = 10;

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

function roomMapUrl(room: GameRoom) {
  const url = roomServiceUrl(room);
  url.pathname = url.pathname.replace(/\/play\/(room-\d+)\/?$/, "/watch/$1/");
  url.search = "";
  url.searchParams.set("view", "map");
  return url.toString();
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
      <iframe
        aria-hidden="true"
        key={room.id}
        src={roomMapUrl(room)}
        tabIndex={-1}
        title={`${room.name} 실제 게임 맵`}
      />
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
  }, [player.id, room.id]);

  return (
    <div className="player-spectator">
      <iframe
        allow="fullscreen"
        key={`${room.id}:${player.id}`}
        ref={iframeRef}
        src={roomWatchUrl(room, player)}
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
    const currentIndex = alivePlayers.findIndex(
      (player) => player.id === selectedPlayer?.id,
    );
    const direction = reverse ? -1 : 1;
    const startIndex = currentIndex < 0 && reverse ? 0 : currentIndex;
    const nextIndex =
      (startIndex + direction + alivePlayers.length) % alivePlayers.length;
    const nextPlayer = alivePlayers[nextIndex];
    if (nextPlayer) onSelectPlayer(nextPlayer.id);
  }, [alivePlayers, onSelectPlayer, selectedPlayer?.id]);

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
      } | null;
      if (!data || data.type !== "opsia-spectator-key") return;
      if (data.key === "Tab") {
        selectAdjacentPlayer(data.shiftKey === true);
      } else if (data.key === "m") {
        onClearPlayer();
      }
    };
    window.addEventListener("message", handleSpectatorMessage);
    return () => window.removeEventListener("message", handleSpectatorMessage);
  }, [onClearPlayer, room, selectAdjacentPlayer]);

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

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const selectedPlayer = selectedRoom?.players.find(
    (player) => player.id === selectedPlayerId,
  );
  const totalPlayers = rooms.reduce((total, room) => total + room.players.length, 0);

  const refresh = useCallback(async (quiet = false) => {
    if (requestPendingRef.current) return;
    requestPendingRef.current = true;
    try {
      const state = await controlPlaneClient.getState();
      setRooms(state.rooms.slice().sort((left, right) => left.id.localeCompare(right.id)));
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
