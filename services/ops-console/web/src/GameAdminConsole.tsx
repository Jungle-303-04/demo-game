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
import { QRCodeSVG } from "qrcode.react";
import { createPortal } from "react-dom";
import {
  type GameRoom,
  type MapLayoutTelemetry,
  type PlayerTelemetry,
} from "./control-plane.js";
import {
  ControlPlaneError,
  controlPlaneClient,
} from "./control-plane-client.js";
import { FailureScenarioPage } from "./FailureScenarioPage.js";

type StyleWithVariables = CSSProperties & Record<`--${string}`, string | number>;
type ConnectionState = "connecting" | "connected" | "degraded";
type ConsolePage = "spectate" | "scenarios";

interface DocumentPictureInPictureController {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

interface PictureInPictureSession {
  container: HTMLDivElement;
  pipWindow: Window;
}

type SpectatorViewCount = 1 | 4 | 16;
type SpectatorFrameWindow = Window & {
  __opsiaDriveSpectatorFrame?: () => void;
  __opsiaSetSpectatorFps?: (fps: number) => void;
  __opsiaSetSpectatorVisible?: (visible: boolean) => void;
};

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
    return "운영 서버 인증 설정을 확인해야 합니다.";
  }
  if (error instanceof ControlPlaneError) return error.message;
  if (error instanceof Error) return error.message;
  return "게임 서버 연결에 실패했습니다.";
}

function consolePageFromLocation(): ConsolePage {
  return window.location.pathname.replace(/\/+$/, "") === "/scenarios"
    ? "scenarios"
    : "spectate";
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
  const url = new URL(room.serviceUrl, configuredOrigin || window.location.origin);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    !configuredOrigin &&
    loopbackHosts.has(url.hostname) &&
    !loopbackHosts.has(window.location.hostname)
  ) {
    url.hostname = window.location.hostname;
  }
  return url;
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
  onJoin,
  onOpen,
}: {
  room: GameRoom;
  ordinal: number;
  onJoin: () => void;
  onOpen: () => void;
}) {
  const { bots, humans } = playerCounts(room);
  return (
    <article
      className="room-card"
      onClick={onOpen}
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
      <div className="room-card-actions">
        <button
          className="room-card-spectate"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          type="button"
        >
          관전하기
        </button>
        <button
          aria-haspopup="dialog"
          aria-label={`${room.name} 참여하기`}
          className="room-card-join"
          onClick={(event) => {
            event.stopPropagation();
            onJoin();
          }}
          type="button"
        >
          참여하기
        </button>
      </div>
    </article>
  );
}

function JoinRoomDialog({
  room,
  onDismiss,
}: {
  room: GameRoom;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const joinUrl = roomServiceUrl(room).toString();
  const titleId = `join-room-title-${room.id}`;
  const descriptionId = `join-room-description-${room.id}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="join-room-dialog"
      onCancel={(event) => {
        event.preventDefault();
        event.currentTarget.close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      onClose={onDismiss}
      ref={dialogRef}
    >
      <div className="join-dialog-panel">
        <button
          aria-label="참여 창 닫기"
          autoFocus
          className="join-dialog-close"
          onClick={() => dialogRef.current?.close()}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
        <span className="join-dialog-eyebrow">게임 참여</span>
        <h2 id={titleId}>{room.name}</h2>
        <p id={descriptionId}>QR 코드를 스캔하면 이 방의 게임 화면으로 이동합니다.</p>
        <div className="join-dialog-qr">
          <QRCodeSVG
            bgColor="#ffffff"
            fgColor="#111318"
            level="M"
            marginSize={4}
            size={220}
            title={`${room.name} 참여 QR 코드`}
            value={joinUrl}
          />
        </div>
        <a
          className="join-dialog-new-tab"
          href={joinUrl}
          onClick={() => dialogRef.current?.close()}
          rel="noopener noreferrer"
          target="_blank"
        >
          새 탭에서 접속 <span aria-hidden="true">↗</span>
        </a>
      </div>
    </dialog>
  );
}

function RoomDirectory({
  rooms,
  connection,
  onJoinRoom,
  onOpenRoom,
}: {
  rooms: GameRoom[];
  connection: ConnectionState;
  onJoinRoom: (roomId: string) => void;
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
            onJoin={() => onJoinRoom(room.id)}
            onOpen={() => onOpenRoom(room.id)}
            ordinal={index + 1}
            room={room}
          />
        ))}
      </div>
    </section>
  );
}

function roomWatchUrl(
  room: GameRoom,
  player: PlayerTelemetry,
  wallFps?: number,
  forceCanvas = false,
) {
  const url = roomServiceUrl(room);
  url.pathname = url.pathname.replace(/\/play\/(room-\d+)\/?$/, "/watch/$1/");
  url.search = "";
  url.searchParams.set("view", "player");
  url.searchParams.set("target", player.id);
  url.searchParams.set("controllerOrigin", window.location.origin);
  if (wallFps) {
    url.searchParams.set("wallFps", String(wallFps));
    if (forceCanvas) url.searchParams.set("wallCanvas", "1");
  }
  return url.toString();
}

function PlayerSpectatorView({
  room,
  player,
  managed = false,
  selfDriven = false,
  loadDelayMs = 0,
  visible = true,
  wallFps,
  forceCanvas = false,
  targetFps,
  registerFrame,
}: {
  room: GameRoom;
  player: PlayerTelemetry;
  managed?: boolean;
  selfDriven?: boolean;
  loadDelayMs?: number;
  visible?: boolean;
  wallFps?: number;
  forceCanvas?: boolean;
  targetFps?: number;
  registerFrame?: (playerId: string, frame: HTMLIFrameElement | null) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const tileRef = useRef<HTMLDivElement | null>(null);
  const initialUrlRef = useRef(roomWatchUrl(room, player, wallFps, forceCanvas));
  const frameOriginRef = useRef(new URL(initialUrlRef.current).origin);
  const debugStatsEnabled = new URLSearchParams(window.location.search).get("spectatorDebug") === "1";
  const [frameHostWindow, setFrameHostWindow] = useState<Window>(() => window);
  const [shouldLoad, setShouldLoad] = useState(loadDelayMs <= 0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [frameReady, setFrameReady] = useState(false);

  const attachIframe = useCallback((frame: HTMLIFrameElement | null) => {
    iframeRef.current = frame;
    if (frame?.ownerDocument.defaultView) setFrameHostWindow(frame.ownerDocument.defaultView);
  }, []);

  const syncSpectatorFrame = useCallback((drawNow = false) => {
    const frameWindow = iframeRef.current?.contentWindow as SpectatorFrameWindow | null;
    if (!frameWindow) return;
    const fps = visible ? (targetFps ?? wallFps ?? 60) : 5;
    let controlledDirectly = false;

    try {
      controlledDirectly = typeof frameWindow.__opsiaSetSpectatorFps === "function";
      frameWindow.__opsiaSetSpectatorFps?.(fps);
      frameWindow.__opsiaSetSpectatorVisible?.(true);
      if (visible) {
        frameWindow.dispatchEvent(new Event("resize"));
        if (drawNow) frameWindow.__opsiaDriveSpectatorFrame?.();
        frameWindow.__opsiaSetSpectatorVisible?.(true);
      }
    } catch {
      // Local Compose serves the console and games on different ports. The
      // origin-bound control message below applies the same policy there.
    }

    frameWindow.postMessage({
      type: "opsia-spectator-control",
      version: 1,
      fps,
      running: true,
      resize: visible,
      drawNow: drawNow && visible && !controlledDirectly,
    }, frameOriginRef.current);
  }, [targetFps, visible, wallFps]);

  useEffect(() => {
    if (loadDelayMs <= 0) {
      setShouldLoad(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setShouldLoad(true), loadDelayMs);
    return () => window.clearTimeout(timer);
  }, [loadDelayMs]);

  useEffect(() => {
    if (!shouldLoad || loadAttempt >= 2) return undefined;
    const timer = window.setTimeout(() => {
      try {
        const root = iframeRef.current?.contentDocument?.documentElement;
        if (root && !root.classList.contains("opsia-in-game")) {
          setLoadAttempt((attempt) => attempt + 1);
        }
      } catch {
        // Cross-origin development clients cannot be inspected or retried here.
      }
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [loadAttempt, shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return undefined;
    setFrameReady(false);
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== frameOriginRef.current) return;
      const data = event.data as {
        type?: unknown;
        version?: unknown;
        frames?: unknown;
        fps?: unknown;
        at?: unknown;
        playing?: unknown;
      } | null;
      if (
        data?.type === "opsia-spectator-status"
        && data.version === 1
      ) {
        const tile = tileRef.current;
        if (tile) {
          if (typeof data.frames === "number") tile.dataset.wallFrames = String(data.frames);
          if (typeof data.fps === "number") tile.dataset.wallFps = String(data.fps);
          if (typeof data.at === "number") tile.dataset.wallFrameAt = String(data.at);
          tile.dataset.wallPlaying = String(data.playing === true);
        }
        if (data.playing === true) setFrameReady(true);
      }
    };
    const targets = new Set([window, frameHostWindow]);
    targets.forEach((target) => target.addEventListener("message", handleMessage));
    return () => targets.forEach((target) => target.removeEventListener("message", handleMessage));
  }, [frameHostWindow, loadAttempt, shouldLoad]);

  useEffect(() => {
    if (!shouldLoad || frameReady) return undefined;
    const probe = () => {
      try {
        const root = iframeRef.current?.contentDocument?.documentElement;
        if (root?.classList.contains("opsia-in-game")) setFrameReady(true);
      } catch {
        // Cross-origin readiness is acknowledged by opsia-spectator-status.
      }
      syncSpectatorFrame(true);
    };
    probe();
    const timer = window.setInterval(probe, 250);
    return () => window.clearInterval(timer);
  }, [frameReady, shouldLoad, syncSpectatorFrame]);

  useEffect(() => {
    if (!frameReady) return;
    // Hidden frames stay warm at 5fps so Tab reveals a real frame immediately;
    // visible four-up frames are raised to 60fps on every supported origin.
    syncSpectatorFrame(true);
  }, [frameReady, syncSpectatorFrame]);

  useEffect(() => {
    if (!debugStatsEnabled || !frameReady) return undefined;
    const requestStats = () => {
      iframeRef.current?.contentWindow?.postMessage({
        type: "opsia-spectator-stats-request",
        version: 1,
        requestId: `wall-${player.id.slice(-32)}`,
      }, frameOriginRef.current);
    };
    requestStats();
    const timer = window.setInterval(requestStats, visible ? 250 : 2_000);
    return () => window.clearInterval(timer);
  }, [debugStatsEnabled, frameReady, player.id, visible]);

  useEffect(() => {
    if (managed || selfDriven) return undefined;
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
  }, [managed, selfDriven]);

  useEffect(() => {
    if (!managed || !registerFrame) return undefined;
    registerFrame(player.id, iframeRef.current);
    return () => registerFrame(player.id, null);
  }, [managed, player.id, registerFrame]);

  return (
    <div
      className={`player-spectator${visible ? "" : " is-hidden"}`}
      aria-hidden={!visible}
      ref={tileRef}
    >
      {shouldLoad && (
        <iframe
          allow="fullscreen"
          className={frameReady ? "is-ready" : ""}
          key={loadAttempt}
          onLoad={() => syncSpectatorFrame(true)}
          ref={attachIframe}
          src={`${initialUrlRef.current}&frameAttempt=${loadAttempt}`}
          tabIndex={-1}
          title={`${player.name} 실시간 관전`}
        />
      )}
      <div className="spectator-label">
        <i style={{ background: player.color }} />
        <strong>{player.name}</strong>
        <span>{player.isBot ? "BOT" : "PLAYER"}</span>
      </div>
    </div>
  );
}

function SpectatorWall({
  room,
  players,
  visiblePlayers,
  layout,
}: {
  room: GameRoom;
  players: PlayerTelemetry[];
  visiblePlayers: PlayerTelemetry[];
  layout: 4 | 16;
}) {
  const visibleIds = useMemo(
    () => new Set(visiblePlayers.map((player) => player.id)),
    [visiblePlayers],
  );
  const orderedPlayers = useMemo(() => {
    // Keep a fixed, name-sorted pool while guaranteeing that a selected page is
    // never outside the 20-frame prewarm budget.
    const sorted = players
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    const base = sorted.slice(0, layout === 4 ? 12 : 20);
    const baseIds = new Set(base.map((player) => player.id));
    const selectedOutsideBase = sorted.filter(
      (player) => visibleIds.has(player.id) && !baseIds.has(player.id),
    );
    return [...base, ...selectedOutsideBase];
  }, [players, visibleIds]);

  return (
    <div className="spectator-wall" data-layout={layout}>
      {orderedPlayers.map((player, index) => {
        const visibleIndex = visiblePlayers.findIndex((candidate) => candidate.id === player.id);
        return (
          <PlayerSpectatorView
            forceCanvas={layout === 16}
            key={`${layout}:${player.id}`}
            loadDelayMs={visibleIndex >= 0 ? visibleIndex * (layout === 4 ? 80 : 100) : 1_200 + index * 250}
            player={player}
            room={room}
            selfDriven
            targetFps={layout === 4 ? 60 : 30}
            visible={visibleIndex >= 0}
            wallFps={30}
          />
        );
      })}
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
  const pipWindowRef = useRef<Window | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipSession, setPipSession] = useState<PictureInPictureSession | null>(null);
  const [isInlinePip, setIsInlinePip] = useState(false);
  const [spectatorViewCount, setSpectatorViewCount] = useState<SpectatorViewCount>(4);
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
    const currentIndex = alivePlayers.findIndex(
      (player) => player.id === selectedPlayer?.id,
    );
    if (spectatorViewCount === 1 && selectedPlayer && spectatorFrame?.contentWindow) {
      spectatorFrame.contentWindow.postMessage({
        type: "opsia-spectator-command",
        version: 1,
        action: reverse ? "prev" : "next",
      }, roomServiceUrl(room).origin);
      return;
    }
    const direction = reverse ? -1 : 1;
    const startIndex = currentIndex < 0 ? (reverse ? 0 : -1) : currentIndex;
    const stride = Math.min(spectatorViewCount, alivePlayers.length);
    const unwrappedIndex = startIndex + direction * stride;
    const nextIndex = ((unwrappedIndex % alivePlayers.length) + alivePlayers.length)
      % alivePlayers.length;
    const nextPlayer = alivePlayers[nextIndex];
    if (nextPlayer) onSelectPlayer(nextPlayer.id);
  }, [alivePlayers, onSelectPlayer, room, selectedPlayer, spectatorViewCount]);

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
    const targets = [window, pipSession?.pipWindow].filter(
      (target): target is Window => Boolean(target),
    );
    targets.forEach((target) => target.addEventListener("keydown", handleKeys));
    return () => {
      targets.forEach((target) => target.removeEventListener("keydown", handleKeys));
    };
  }, [onClearPlayer, pipSession, selectAdjacentPlayer]);

  useEffect(() => {
    const expectedOrigin = roomServiceUrl(room).origin;
    const handleSpectatorMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const fromSpectatorFrame = Array.from(
        stageRef.current?.querySelectorAll<HTMLIFrameElement>(".player-spectator iframe") ?? [],
      ).some((frame) => frame.contentWindow === event.source);
      if (!fromSpectatorFrame) return;
      const data = event.data as {
        type?: unknown;
        version?: unknown;
        key?: unknown;
        shiftKey?: unknown;
        name?: unknown;
      } | null;
      if (!data || data.version !== 1) return;
      if (data.type === "opsia-spectator-target" && typeof data.name === "string") {
        if (spectatorViewCount !== 1) return;
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
    const targets = [window, pipSession?.pipWindow].filter(
      (target): target is Window => Boolean(target),
    );
    targets.forEach((target) => target.addEventListener("message", handleSpectatorMessage));
    return () => {
      targets.forEach((target) => target.removeEventListener("message", handleSpectatorMessage));
    };
  }, [alivePlayers, onClearPlayer, onSelectPlayer, pipSession, room, selectAdjacentPlayer, spectatorViewCount]);

  useEffect(() => {
    const documents = [document, pipSession?.pipWindow.document].filter(
      (target): target is Document => Boolean(target),
    );
    const syncFullscreen = () => {
      const ownerDocument = stageRef.current?.ownerDocument ?? document;
      setIsFullscreen(ownerDocument.fullscreenElement === stageRef.current);
    };
    documents.forEach((target) => target.addEventListener("fullscreenchange", syncFullscreen));
    return () => {
      documents.forEach((target) => target.removeEventListener("fullscreenchange", syncFullscreen));
    };
  }, [pipSession]);

  useEffect(() => () => {
    pipWindowRef.current?.close();
  }, []);

  async function toggleFullscreen() {
    try {
      const ownerDocument = stageRef.current?.ownerDocument ?? document;
      if (ownerDocument.fullscreenElement === stageRef.current) {
        await ownerDocument.exitFullscreen();
      } else {
        await stageRef.current?.requestFullscreen();
      }
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  async function togglePictureInPicture() {
    if (pipSession) {
      pipSession.pipWindow.close();
      pipWindowRef.current = null;
      setPipSession(null);
      return;
    }
    if (isInlinePip) {
      setIsInlinePip(false);
      return;
    }

    const controller = (
      window as Window & { documentPictureInPicture?: DocumentPictureInPictureController }
    ).documentPictureInPicture;
    if (!controller) {
      setIsInlinePip(true);
      return;
    }

    try {
      const pipWindow = await controller.requestWindow({ width: 560, height: 420 });
      pipWindow.document.title = `${room.name} PIP`;
      document.head
        .querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')
        .forEach((node) => pipWindow.document.head.append(node.cloneNode(true)));
      pipWindow.document.body.className = "opsia-pip-body";
      const container = pipWindow.document.createElement("div");
      container.className = "pip-root";
      pipWindow.document.body.append(container);
      pipWindowRef.current = pipWindow;
      const handleClose = () => {
        pipWindowRef.current = null;
        setPipSession(null);
      };
      pipWindow.addEventListener("pagehide", handleClose, { once: true });
      setPipSession({ container, pipWindow });
    } catch {
      setIsInlinePip(true);
    }
  }

  const isPictureInPicture = Boolean(pipSession) || isInlinePip;
  const selectedPlayerIndex = alivePlayers.findIndex((player) => player.id === selectedPlayer?.id);
  const spectatorStartIndex = selectedPlayerIndex >= 0 ? selectedPlayerIndex : 0;
  const visibleSpectators = selectedPlayer
    ? Array.from(
        { length: Math.min(spectatorViewCount, alivePlayers.length) },
        (_, offset) => alivePlayers[(spectatorStartIndex + offset) % alivePlayers.length],
      ).filter((player): player is PlayerTelemetry => Boolean(player))
    : [];
  const liveStage = (
    <div className={`world-stage${isInlinePip ? " is-inline-pip" : ""}`} ref={stageRef}>
      {selectedPlayer ? (
        spectatorViewCount === 1 ? (
          <PlayerSpectatorView player={selectedPlayer} room={room} />
        ) : (
          <SpectatorWall
            layout={spectatorViewCount}
            players={alivePlayers}
            room={room}
            visiblePlayers={visibleSpectators}
          />
        )
      ) : (
        <TacticalMap
          onSelectPlayer={onSelectPlayer}
          room={room}
        />
      )}
    </div>
  );

  return (
    <section className="room-viewer">
      <div className="room-toolbar">
        <button className="back-button" onClick={onBack} type="button" aria-label="방 목록">
          ←
        </button>
        <div className="room-title">
          <span>{room.map}</span>
          <strong>{selectedPlayer ? `${visibleSpectators.length}명 관전` : room.name}</strong>
        </div>
        <div className="room-actions">
          <span>사용자 <strong>{humans}</strong></span>
          <span>봇 <strong>{bots}</strong></span>
          <button disabled={botPending} onClick={onAddBots} type="button">
            {botPending ? "투입 중" : `봇 +${BOT_BATCH_SIZE}`}
          </button>
          <div className="spectator-count-switch" aria-label="동시 관전 화면 수">
            {([1, 4, 16] as const).map((count) => (
              <button
                aria-label={`${count}명 동시 관전`}
                aria-pressed={spectatorViewCount === count}
                key={count}
                onClick={() => setSpectatorViewCount(count)}
                type="button"
              >
                {count}
              </button>
            ))}
          </div>
          <button
            aria-pressed={isPictureInPicture}
            className={`pip-button${isPictureInPicture ? " is-active" : ""}`}
            onClick={() => void togglePictureInPicture()}
            type="button"
          >
            {isPictureInPicture ? "PIP 닫기" : "PIP"}
          </button>
          <button onClick={() => void toggleFullscreen()} type="button">
            {isFullscreen ? "축소" : "전체화면"}
          </button>
          <kbd>Tab 관전</kbd>
          <kbd>M 맵</kbd>
        </div>
      </div>
      {pipSession ? (
        <>
          <div className="pip-detached-placeholder" role="status">PIP에서 실시간 관전 중</div>
          {createPortal(liveStage, pipSession.container)}
        </>
      ) : liveStage}
    </section>
  );
}

/** The UI renders only authoritative control-plane snapshots and live players. */
export function GameAdminConsole() {
  const [rooms, setRooms] = useState<GameRoom[]>([]);
  const [activePage, setActivePage] = useState<ConsolePage>(consolePageFromLocation);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [botPending, setBotPending] = useState(false);
  const requestPendingRef = useRef(false);
  const hasMapLayoutsRef = useRef(false);

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const joiningRoom = rooms.find((room) => room.id === joiningRoomId);
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
    const handlePopState = () => {
      setActivePage(consolePageFromLocation());
      setSelectedRoomId(null);
      setJoiningRoomId(null);
      setSelectedPlayerId("");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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
      setError(errorMessage(addError));
    } finally {
      setBotPending(false);
    }
  }

  function navigateTo(page: ConsolePage) {
    const pathname = page === "scenarios" ? "/scenarios" : "/";
    if (window.location.pathname !== pathname) {
      window.history.pushState({ consolePage: page }, "", pathname);
    }
    setActivePage(page);
    setSelectedRoomId(null);
    setJoiningRoomId(null);
    setSelectedPlayerId("");
  }

  return (
    <main className={`console-shell ${activePage === "spectate" && selectedRoom ? "is-room-open" : ""} ${activePage === "scenarios" ? "is-scenario-page" : ""}`}>
      <header className="console-topbar">
        <button
          aria-label="실시간 게임 방 목록"
          className="console-brand"
          onClick={() => navigateTo("spectate")}
          type="button"
        >
          <span className="brand-mark">O</span>
          <strong>jungle-303</strong>
        </button>
        <span className="server-chip">게임 서버</span>
        <nav className="console-nav" aria-label="운영 콘솔 화면">
          <a
            aria-current={activePage === "spectate" ? "page" : undefined}
            href="/"
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigateTo("spectate");
            }}
          >
            관전
          </a>
          <a
            aria-current={activePage === "scenarios" ? "page" : undefined}
            href="/scenarios"
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigateTo("scenarios");
            }}
          >
            장애 시나리오
          </a>
        </nav>
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

      {activePage === "scenarios" ? (
        <FailureScenarioPage
          connection={connection}
          onError={setError}
          rooms={rooms}
        />
      ) : selectedRoom ? (
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
          onJoinRoom={setJoiningRoomId}
          onOpenRoom={(roomId) => {
            setSelectedRoomId(roomId);
            setSelectedPlayerId("");
          }}
          rooms={rooms}
        />
      )}

      {joiningRoom && (
        <JoinRoomDialog
          onDismiss={() => setJoiningRoomId(null)}
          room={joiningRoom}
        />
      )}
    </main>
  );
}
