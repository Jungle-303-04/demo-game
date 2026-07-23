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
  ROOM_STATUS_LABEL,
} from "./control-plane.js";
import {
  ControlPlaneError,
  controlPlaneClient,
} from "./control-plane-client.js";
import { compactPodName } from "./room-display.js";

type StyleWithVariables = CSSProperties & Record<`--${string}`, string | number>;
type ConnectionState = "connecting" | "connected" | "degraded";
type BorderMetricKey = "admission" | "tick" | "resources" | "latency";
type HealthTone = "unknown" | "healthy" | "warning" | "danger";

interface DocumentPictureInPictureController {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

interface PictureInPictureSession {
  container: HTMLDivElement;
  pipWindow: Window;
}

type SpectatorViewCount = 1 | 4;
type SpectatorFrameWindow = Window & {
  __opsiaSetSpectatorFps?: (fps: number) => void;
  __opsiaSetSpectatorVisible?: (visible: boolean) => void;
};

const POLL_INTERVAL_MS = 400;
const BOT_BATCH_SIZE = 10;
const MINIMUM_VISIBLE_BOTS = 1;
const MAP_BACKGROUND_OPACITY_KEY = "opsia.map-background-opacity";
const MAP_BACKGROUND_BLUR_KEY = "opsia.map-background-blur";

const BORDER_METRIC_OPTIONS: ReadonlyArray<{
  key: BorderMetricKey;
  label: string;
  threshold: string;
}> = [
  { key: "admission", label: "입장 실패율", threshold: "경고 5% · 장애 20%" },
  { key: "tick", label: "틱 P95", threshold: "경고 8ms · 장애 16ms" },
  { key: "resources", label: "CPU / 메모리", threshold: "CPU 70/90% · 메모리 75/90%" },
  { key: "latency", label: "지연 P95", threshold: "경고 100ms · 장애 200ms" },
];

const OBJECT_COLORS: Record<MapLayoutTelemetry["objects"][number]["kind"], string> = {
  building: "#73563f",
  structure: "#96775d",
  tree: "#42663e",
  rock: "#747b7d",
  wall: "#574a41",
  obstacle: "#916b3e",
};

function roomDisplayName(room: GameRoom) {
  return room.roomName || room.name;
}

function roomStableId(room: GameRoom) {
  return room.roomId || room.id;
}

function roomCurrentPodName(room: GameRoom) {
  return room.currentPodName || room.podName;
}

function roomPodDisplayName(room: GameRoom) {
  return compactPodName(roomCurrentPodName(room));
}

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

function drawLiveMap(
  canvas: HTMLCanvasElement,
  map: MapLayoutTelemetry,
  theme: string,
  { showLabels = true, fit = "stretch" }: { showLabels?: boolean; fit?: "stretch" | "contain" } = {},
) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  const palette = mapPalette(theme);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  const scale = fit === "contain" ? Math.min(width / map.width, height / map.height) : 1;
  const scaleX = fit === "contain" ? scale : width / map.width;
  const scaleY = fit === "contain" ? scale : height / map.height;
  const offsetX = fit === "contain" ? (width - map.width * scale) / 2 : 0;
  const offsetY = fit === "contain" ? (height - map.height * scale) / 2 : 0;
  context.setTransform(scaleX, 0, 0, scaleY, offsetX, offsetY);
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

  if (showLabels) {
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
}

const LiveMapCanvas = memo(function LiveMapCanvas({ map, seed, theme, showLabels = true, fit = "stretch" }: {
  map: MapLayoutTelemetry;
  seed: number;
  theme: string;
  showLabels?: boolean;
  fit?: "stretch" | "contain";
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutKey = mapLayoutKey(map, seed);
  const latestRef = useRef({ map, theme, showLabels, fit });
  latestRef.current = { map, theme, showLabels, fit };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const redraw = () => drawLiveMap(canvas, latestRef.current.map, latestRef.current.theme, {
      showLabels: latestRef.current.showLabels,
      fit: latestRef.current.fit,
    });
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [layoutKey, theme, showLabels, fit]);
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

function playerCounts(room: GameRoom) {
  const bots = room.players.filter((player) => player.isBot).length;
  return { bots, humans: room.players.length - bots };
}

function firstAlivePlayer(room?: GameRoom) {
  return room?.players
    .filter((player) => player.health > 0)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "ko"))[0];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const ADMISSION_WARNING_PERCENT = 5;
const ADMISSION_INCIDENT_PERCENT = 20;
const TICK_WARNING_MS = 8;
const TICK_INCIDENT_MS = 16;
const CPU_WARNING_PERCENT = 70;
const CPU_INCIDENT_PERCENT = 90;
const MEMORY_WARNING_PERCENT = 75;
const MEMORY_INCIDENT_PERCENT = 90;
const RESOURCE_STABLE_SAMPLE_COUNT = 9;
const LATENCY_WARNING_MS = 100;
const LATENCY_INCIDENT_MS = 200;
const HEALTHY_HUE = 145;
const WARNING_HUE = 45;
const DANGER_HUE = 6;
const UNKNOWN_HUE = 215;

function smoothStep(progress: number) {
  const clamped = clamp(progress, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

interface MetricSample {
  hue: number;
  label: string;
  risk: number;
  saturation: number;
  tone: HealthTone;
  unit: string;
  valueText: string;
}

interface RoomBorderProfile {
  ariaValue: string;
  dominant: MetricSample;
  label: string;
  primary: MetricSample;
  secondary?: MetricSample;
  stateLabel: string;
  tone: HealthTone;
}

function statusSurfaceStyleVars(profile: RoomBorderProfile): StyleWithVariables {
  const right = profile.secondary ?? profile.primary;
  return {
    "--status-left-hue": profile.primary.hue,
    "--status-left-saturation": `${profile.primary.saturation}%`,
    "--status-right-hue": right.hue,
    "--status-right-saturation": `${right.saturation}%`,
    "--tick-border-alpha": (0.2 + profile.dominant.risk * 0.0032).toFixed(2),
    "--tick-glow-alpha": (0.08 + profile.dominant.risk * 0.0027).toFixed(2),
    "--tick-hue": profile.dominant.hue,
    "--tick-risk": profile.dominant.risk,
    "--tick-saturation": `${profile.dominant.saturation}%`,
    "--tick-soft-alpha": (0.08 + profile.dominant.risk * 0.0021).toFixed(2),
  };
}

function healthTone(value: number, warning: number, incident: number): HealthTone {
  if (value >= incident) return "danger";
  if (value >= warning) return "warning";
  return "healthy";
}

function healthHue(value: number, warning: number, incident: number) {
  if (value < warning) return HEALTHY_HUE;
  const progress = smoothStep((value - warning) / (incident - warning));
  return Math.round(WARNING_HUE - progress * (WARNING_HUE - DANGER_HUE));
}

function metricSample(
  label: string,
  value: number,
  warning: number,
  incident: number,
  unit: string,
  precision: number,
): MetricSample {
  const tone = healthTone(value, warning, incident);
  return {
    hue: healthHue(value, warning, incident),
    label,
    risk: Math.round(smoothStep(value / incident) * 100),
    saturation: 76,
    tone,
    unit,
    valueText: value.toFixed(precision),
  };
}

function unknownMetricSample(label: string, unit: string): MetricSample {
  return {
    hue: UNKNOWN_HUE,
    label,
    risk: 0,
    saturation: 5,
    tone: "unknown",
    unit,
    valueText: "—",
  };
}

const TONE_RANK: Record<HealthTone, number> = {
  unknown: -1,
  healthy: 0,
  warning: 1,
  danger: 2,
};

function borderProfile(
  label: string,
  primary: MetricSample,
  secondary?: MetricSample,
): RoomBorderProfile {
  const dominant = secondary && TONE_RANK[secondary.tone] > TONE_RANK[primary.tone]
    ? secondary
    : primary;
  const tone = dominant.tone;
  const stateLabel = tone === "danger"
    ? "장애"
    : tone === "warning"
      ? "주의"
      : tone === "unknown"
        ? "데이터 없음"
        : "정상";
  const ariaValue = secondary
    ? `${primary.label} ${primary.valueText}${primary.unit} / ${secondary.label} ${secondary.valueText}${secondary.unit}`
    : `${primary.label} ${primary.valueText}${primary.unit}`;
  return { ariaValue, dominant, label, primary, secondary, stateLabel, tone };
}

function percentile95(values: number[]) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function roomBorderProfile(room: GameRoom, metric: BorderMetricKey): RoomBorderProfile {
  switch (metric) {
    case "tick":
      return borderProfile("틱 P95", metricSample(
        "틱 P95",
        clamp(Number(room.metrics.tickP95Ms ?? 0), 0, 999),
        TICK_WARNING_MS,
        TICK_INCIDENT_MS,
        "ms",
        1,
      ));
    case "resources": {
      if ((room.metrics.resourceSampleCount ?? RESOURCE_STABLE_SAMPLE_COUNT) < RESOURCE_STABLE_SAMPLE_COUNT) {
        return {
          ...borderProfile(
            "CPU / 메모리",
            unknownMetricSample("CPU", "%"),
            unknownMetricSample("메모리", "%"),
          ),
          stateLabel: "수집 중",
        };
      }
      const memoryLimitMb = Math.max(1, Number(room.metrics.memoryLimitMb ?? 0));
      return borderProfile(
        "CPU / 메모리",
        metricSample(
          "CPU",
          clamp(Number(room.metrics.cpuPercent ?? 0), 0, 100),
          CPU_WARNING_PERCENT,
          CPU_INCIDENT_PERCENT,
          "%",
          0,
        ),
        metricSample(
          "메모리",
          clamp((Number(room.metrics.memoryMb ?? 0) / memoryLimitMb) * 100, 0, 100),
          MEMORY_WARNING_PERCENT,
          MEMORY_INCIDENT_PERCENT,
          "%",
          0,
        ),
      );
    }
    case "latency": {
      const latencyPings = room.players
        .filter((player) => Number.isFinite(player.ping) && player.ping >= 0)
        .map((player) => player.ping);
      const latencyLabel = "전체 접속 지연 P95";
      const sample = latencyPings.length > 0
        ? metricSample(
            latencyLabel,
            clamp(percentile95(latencyPings), 0, 999),
            LATENCY_WARNING_MS,
            LATENCY_INCIDENT_MS,
            "ms",
            0,
          )
        : unknownMetricSample(latencyLabel, "ms");
      return borderProfile(latencyLabel, sample);
    }
    default:
      return borderProfile("입장 실패율", metricSample(
        "입장 실패율",
        clamp(Number(room.metrics.admissionFailureRatePercent ?? 0), 0, 100),
        ADMISSION_WARNING_PERCENT,
        ADMISSION_INCIDENT_PERCENT,
        "%",
        1,
      ));
  }
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
  const isPrivateIpv4 = (hostname: string) => (
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    /^192\.168\./.test(hostname)
  );
  if (
    !configuredOrigin &&
    loopbackHosts.has(url.hostname) &&
    !loopbackHosts.has(window.location.hostname)
  ) {
    url.hostname = window.location.hostname;
  }
  if (
    !configuredOrigin &&
    isPrivateIpv4(url.hostname) &&
    url.hostname !== window.location.hostname
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
    <div className="room-live-map" aria-label={`${roomDisplayName(room)} 실시간 미니맵`}>
      <ActualGameMap room={room} />
    </div>
  );
}

function ServerBlock({
  borderMetric,
  room,
  onJoin,
  onSpectate,
  onScenario,
  scenarioActionLabel,
  scenarioDisabled,
  scenarioPending,
}: {
  borderMetric: BorderMetricKey;
  room: GameRoom;
  onJoin: () => void;
  onSpectate: () => void;
  onScenario: () => void;
  scenarioActionLabel: string;
  scenarioDisabled: boolean;
  scenarioPending: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const profile = roomBorderProfile(room, borderMetric);
  const displayName = roomDisplayName(room);
  const stableRoomId = roomStableId(room);
  const currentPodName = roomCurrentPodName(room);
  const podDisplayName = roomPodDisplayName(room);
  const menuId = `server-block-menu-${room.id}`;
  const style = {
    ...statusSurfaceStyleVars(profile),
  } as StyleWithVariables;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const runAndClose = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <article
      aria-label={`${displayName}, ${podDisplayName}, ${profile.ariaValue}`}
      className={`server-block is-${profile.tone}`}
      style={style}
    >
      <div className="server-block-tick">
        <span>{profile.stateLabel} · {profile.label}</span>
      </div>
      <div className="server-block-menu" ref={menuRef}>
        <button
          aria-controls={menuId}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={`${displayName} 메뉴 열기`}
          className="server-block-menu-toggle"
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {menuOpen ? (
          <div className="server-block-menu-popover" id={menuId} role="menu">
            <button onClick={() => runAndClose(onSpectate)} role="menuitem" type="button">
              관전하기
            </button>
            <button onClick={() => runAndClose(onJoin)} role="menuitem" type="button">
              참가하기
            </button>
            <button
              className="is-scenario"
              disabled={scenarioPending || scenarioDisabled}
              onClick={() => runAndClose(onScenario)}
              role="menuitem"
              type="button"
            >
              {scenarioPending ? "요청 처리 중…" : scenarioActionLabel}
            </button>
          </div>
        ) : null}
      </div>
      <div className="server-block-primary">
        <div className="server-block-name" title={currentPodName}>
          {podDisplayName}
        </div>
        <strong className={`server-block-tick-value${profile.secondary ? " is-paired" : ""}`}>
          {profile.secondary ? (
            <>
              <span>{profile.primary.valueText}<small>{profile.primary.unit}</small></span>
              <em>/</em>
              <span>{profile.secondary.valueText}<small>{profile.secondary.unit}</small></span>
            </>
          ) : (
            <>{profile.primary.valueText}<small>{profile.primary.unit}</small></>
          )}
        </strong>
      </div>
      <div className="server-block-meta">
        <span className="server-block-identity">
          <b>{displayName}</b>
          <small>{stableRoomId}</small>
        </span>
        <strong className="server-block-connections">
          {room.players.length}<small>접속</small>
        </strong>
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
  const displayName = roomDisplayName(room);

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
      onClose={onDismiss}
      ref={dialogRef}
    >
      <div className="join-dialog-panel">
        <button
          aria-label="참가 화면에서 뒤로가기"
          autoFocus
          className="join-dialog-back"
          onClick={() => dialogRef.current?.close()}
          type="button"
        >
          <span aria-hidden="true">←</span> 뒤로
        </button>
        <h2 id={titleId}>{displayName}</h2>
        <p className="join-dialog-description" id={descriptionId}>
          QR 코드를 스캔하면 이 방의 게임 화면으로 이동합니다.
        </p>
        <div className="join-dialog-qr">
          <QRCodeSVG
            bgColor="#ffffff"
            fgColor="#080a0d"
            level="M"
            marginSize={4}
            size={1024}
            title={`${displayName} 참가 QR 코드`}
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
  borderMetric,
  onJoinRoom,
  onOpenRoom,
  onRunAdmissionStorm,
  onStopAdmissionStorm,
  admissionActiveRoomId,
  scenarioPendingRoomId,
}: {
  rooms: GameRoom[];
  connection: ConnectionState;
  borderMetric: BorderMetricKey;
  onJoinRoom: (roomId: string) => void;
  onOpenRoom: (roomId: string) => void;
  onRunAdmissionStorm: (roomId: string) => void;
  onStopAdmissionStorm: (roomId: string) => void;
  admissionActiveRoomId: string | null;
  scenarioPendingRoomId: string | null;
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
      <div
        className="server-grid"
        data-room-count={Math.min(rooms.length, 6)}
        aria-label="실시간 게임 서버"
      >
        {rooms.map((room) => {
          const admissionActive = admissionActiveRoomId === room.id;
          const admissionRunningElsewhere = Boolean(
            admissionActiveRoomId && admissionActiveRoomId !== room.id,
          );
          return (
            <ServerBlock
              borderMetric={borderMetric}
              key={room.id}
              onJoin={() => onJoinRoom(room.id)}
              onSpectate={() => onOpenRoom(room.id)}
              onScenario={() => admissionActive
                ? onStopAdmissionStorm(room.id)
                : onRunAdmissionStorm(room.id)}
              room={room}
              scenarioActionLabel={admissionActive
                ? "장애 부하 중단"
                : admissionRunningElsewhere
                  ? "입장 서버 장애 중"
                  : "입장 서버 장애"}
              scenarioDisabled={admissionRunningElsewhere}
              scenarioPending={scenarioPendingRoomId === room.id}
            />
          );
        })}
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
  loadDelayMs = 0,
  wallFps,
  forceCanvas = false,
  targetFps,
}: {
  room: GameRoom;
  player: PlayerTelemetry;
  loadDelayMs?: number;
  wallFps?: number;
  forceCanvas?: boolean;
  targetFps?: number;
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

  const syncSpectatorFrame = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow as SpectatorFrameWindow | null;
    if (!frameWindow) return;
    const fps = targetFps ?? wallFps ?? 60;

    try {
      frameWindow.__opsiaSetSpectatorFps?.(fps);
      frameWindow.__opsiaSetSpectatorVisible?.(true);
      frameWindow.dispatchEvent(new Event("resize"));
    } catch {
      // Local Compose serves the console and games on different ports. The
      // origin-bound control message below applies the same policy there.
    }

    frameWindow.postMessage({
      type: "opsia-spectator-control",
      version: 1,
      fps,
      running: true,
      resize: true,
      drawNow: false,
    }, frameOriginRef.current);
  }, [targetFps, wallFps]);

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
      syncSpectatorFrame();
    };
    probe();
    const timer = window.setInterval(probe, 250);
    return () => window.clearInterval(timer);
  }, [frameReady, shouldLoad, syncSpectatorFrame]);

  useEffect(() => {
    if (!frameReady) return;
    // Keep the active spectator frame in sync on every supported origin.
    syncSpectatorFrame();
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
    const timer = window.setInterval(requestStats, 250);
    return () => window.clearInterval(timer);
  }, [debugStatsEnabled, frameReady, player.id]);

  return (
    <div className="player-spectator" ref={tileRef}>
      {shouldLoad && (
        <iframe
          allow="fullscreen"
          className={frameReady ? "is-ready" : ""}
          key={loadAttempt}
          onLoad={syncSpectatorFrame}
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
  visiblePlayers,
}: {
  room: GameRoom;
  visiblePlayers: PlayerTelemetry[];
}) {
  return (
    <div className="spectator-wall" data-layout="4">
      {visiblePlayers.map((player, index) => (
        <PlayerSpectatorView
          key={player.id}
          loadDelayMs={index * 40}
          player={player}
          room={room}
          targetFps={60}
          wallFps={30}
        />
      ))}
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
    <div className="tactical-map" aria-label={`${roomDisplayName(room)} 실시간 미니맵`}>
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
  resetPending,
  onBack,
  onAddBots,
  onRemoveBots,
  onResetRoom,
  onSelectPlayer,
  onClearPlayer,
  onError,
}: {
  room: GameRoom;
  selectedPlayer?: PlayerTelemetry;
  botPending: boolean;
  resetPending: boolean;
  onBack: () => void;
  onAddBots: () => void;
  onRemoveBots: () => void;
  onResetRoom: () => void;
  onSelectPlayer: (playerId: string) => void;
  onClearPlayer: () => void;
  onError: (message: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipSession, setPipSession] = useState<PictureInPictureSession | null>(null);
  const [isInlinePip, setIsInlinePip] = useState(false);
  const [spectatorViewCount, setSpectatorViewCount] = useState<SpectatorViewCount>(1);
  const { bots, humans } = playerCounts(room);
  const connectedPlayers = bots + humans;
  const displayName = roomDisplayName(room);
  const currentPodName = roomCurrentPodName(room);
  const podDisplayName = roomPodDisplayName(room);
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
      pipWindow.document.title = `${displayName} PIP`;
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
      <div
        aria-label={`${podDisplayName}, 접속 인원 ${connectedPlayers}명`}
        className="room-view-overlay"
      >
        <strong title={currentPodName}>{podDisplayName}</strong>
        <span>{connectedPlayers}명 접속</span>
      </div>
      {selectedPlayer ? (
        spectatorViewCount === 1 ? (
          <PlayerSpectatorView player={selectedPlayer} room={room} />
        ) : (
          <SpectatorWall
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
          <strong>{selectedPlayer ? `${visibleSpectators.length}명 관전` : displayName}</strong>
        </div>
        <div className="room-actions">
          <span>사용자 <strong>{humans}</strong></span>
          <span>봇 <strong>{bots}</strong></span>
          <button disabled={botPending || resetPending} onClick={onAddBots} type="button">
            {botPending ? "투입 중" : `봇 +${BOT_BATCH_SIZE}`}
          </button>
          <button
            className="remove-bots-button"
            disabled={botPending || resetPending || bots <= MINIMUM_VISIBLE_BOTS}
            onClick={onRemoveBots}
            type="button"
          >
            {botPending ? "조정 중" : `봇 -${BOT_BATCH_SIZE}`}
          </button>
          <button
            className="reset-map-button"
            disabled={botPending || resetPending}
            onClick={onResetRoom}
            title="상자와 맵 상태를 처음부터 다시 생성합니다"
            type="button"
          >
            {resetPending ? "리셋 중…" : "맵 리셋"}
          </button>
          <div className="spectator-count-switch" aria-label="동시 관전 화면 수">
            {([1, 4] as const).map((count) => (
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
  const [borderMetric, setBorderMetric] = useState<BorderMetricKey>("admission");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [playerSpectating, setPlayerSpectating] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [botPending, setBotPending] = useState(false);
  const [resetPendingRoomId, setResetPendingRoomId] = useState<string | null>(null);
  const [scenarioPendingRoomId, setScenarioPendingRoomId] = useState<string | null>(null);
  const [admissionActiveRoomId, setAdmissionActiveRoomId] = useState<string | null>(null);
  const requestPendingRef = useRef(false);
  const hasMapLayoutsRef = useRef(false);
  const scenarioTrackingRef = useRef(true);

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
      if (scenarioTrackingRef.current) {
        const scenarioState = await controlPlaneClient.getFailureScenarios();
        const activeAdmissionRoom = scenarioState.rooms.find(
          (room) => room.active?.scenarioId === "admission-storm",
        );
        scenarioTrackingRef.current = Boolean(activeAdmissionRoom);
        setAdmissionActiveRoomId(activeAdmissionRoom?.roomId ?? null);
      }
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
      setSelectedRoomId(null);
      setJoiningRoomId(null);
      setSelectedPlayerId("");
      setPlayerSpectating(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedRoom || selectedPlayer) return;
    if (playerSpectating) {
      setSelectedPlayerId(firstAlivePlayer(selectedRoom)?.id ?? "");
    } else if (selectedPlayerId) {
      setSelectedPlayerId("");
    }
  }, [playerSpectating, selectedPlayer, selectedPlayerId, selectedRoom]);

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

  async function removeBots() {
    if (!selectedRoom || botPending) return;
    const removableBots = Math.min(
      BOT_BATCH_SIZE,
      Math.max(0, playerCounts(selectedRoom).bots - MINIMUM_VISIBLE_BOTS),
    );
    if (removableBots < 1) return;
    setBotPending(true);
    setError("");
    try {
      await controlPlaneClient.removeBots(selectedRoom.id, removableBots);
      await refresh(true);
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setBotPending(false);
    }
  }

  async function resetMap() {
    if (!selectedRoom || resetPendingRoomId || botPending) return;
    if (!window.confirm("이 방의 상자와 맵 상태를 초기화할까요? 현재 봇 수는 자동으로 복구됩니다.")) return;
    const roomId = selectedRoom.id;
    setResetPendingRoomId(roomId);
    setError("");
    try {
      await controlPlaneClient.resetRoom(roomId);
      setSelectedPlayerId("");
      await refresh(true);
    } catch (resetError) {
      setError(errorMessage(resetError));
    } finally {
      setResetPendingRoomId(null);
    }
  }

  async function startAdmissionStorm(roomId: string) {
    if (scenarioPendingRoomId) return;
    setScenarioPendingRoomId(roomId);
    setError("");
    try {
      await controlPlaneClient.startFailureScenario(roomId, "admission-storm");
      scenarioTrackingRef.current = true;
      setAdmissionActiveRoomId(roomId);
      await refresh(true);
    } catch (scenarioError) {
      setError(errorMessage(scenarioError));
    } finally {
      setScenarioPendingRoomId(null);
    }
  }

  async function stopAdmissionStorm(roomId: string) {
    if (scenarioPendingRoomId) return;
    setScenarioPendingRoomId(roomId);
    setError("");
    try {
      await controlPlaneClient.recoverFailureScenario(roomId, "admission-storm");
      setAdmissionActiveRoomId(null);
      await refresh(true);
    } catch (scenarioError) {
      setError(errorMessage(scenarioError));
    } finally {
      setScenarioPendingRoomId(null);
    }
  }

  function showRoomDirectory() {
    if (`${window.location.pathname}${window.location.search}` !== "/") {
      window.history.pushState({}, "", "/");
    }
    setSelectedRoomId(null);
    setJoiningRoomId(null);
    setSelectedPlayerId("");
    setPlayerSpectating(false);
  }

  function openRoomForSpectating(roomId: string) {
    const room = rooms.find((candidate) => candidate.id === roomId);
    setSelectedRoomId(roomId);
    setPlayerSpectating(true);
    setSelectedPlayerId(firstAlivePlayer(room)?.id ?? "");
  }

  return (
    <main className={`console-shell ${selectedRoom ? "is-room-open" : "is-room-directory"}`}>
      <header className="console-topbar">
        <button
          aria-label="실시간 게임 방 목록"
          className="console-brand"
          onClick={showRoomDirectory}
          type="button"
        >
          <span className="brand-mark">O</span>
          <strong>jungle-303</strong>
        </button>
        <span className="server-chip" aria-label={`게임 서버 ${rooms.length}개`}>
          <span>게임 서버</span>
          <strong>{rooms.length} ROOMS</strong>
        </span>
        <div className="border-metric-tabs" role="tablist" aria-label="방 테두리 상태 기준">
          {BORDER_METRIC_OPTIONS.map((option) => (
            <button
              aria-selected={borderMetric === option.key}
              key={option.key}
              onClick={() => setBorderMetric(option.key)}
              role="tab"
              title={option.threshold}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
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
          resetPending={resetPendingRoomId === selectedRoom.id}
          onAddBots={() => void addBots()}
          onRemoveBots={() => void removeBots()}
          onResetRoom={() => void resetMap()}
          onBack={() => {
            setSelectedRoomId(null);
            setSelectedPlayerId("");
            setPlayerSpectating(false);
          }}
          onClearPlayer={() => {
            setPlayerSpectating(false);
            setSelectedPlayerId("");
          }}
          onError={setError}
          onSelectPlayer={(playerId) => {
            setPlayerSpectating(true);
            setSelectedPlayerId(playerId);
          }}
          room={selectedRoom}
          selectedPlayer={selectedPlayer}
        />
      ) : (
        <RoomDirectory
          admissionActiveRoomId={admissionActiveRoomId}
          borderMetric={borderMetric}
          connection={connection}
          onJoinRoom={setJoiningRoomId}
          onOpenRoom={openRoomForSpectating}
          onRunAdmissionStorm={(roomId) => void startAdmissionStorm(roomId)}
          onStopAdmissionStorm={(roomId) => void stopAdmissionStorm(roomId)}
          rooms={rooms}
          scenarioPendingRoomId={scenarioPendingRoomId}
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
