"use client";

import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MATCH_PHASE_LABEL,
  type CreateRoomInput,
  type ControlPlaneCapabilities,
  type EventTone,
  type GameRoom,
  type OpsEvent,
  type PlayerTelemetry,
  ROOM_STATUS_LABEL,
  type RoomCommand,
  type RoomStatus,
} from "./control-plane.js";
import {
  ControlPlaneError,
  controlPlaneClient,
  setControlPlaneAdminToken,
} from "./control-plane-client.js";

type StyleWithVariables = CSSProperties & Record<`--${string}`, string | number>;
type DetailTab = "world" | "manage";
type ModalState =
  | { type: "create" }
  | { type: "edit"; roomId: string }
  | { type: "delete"; roomId: string }
  | null;

interface BotLoadRun {
  jobId: string;
  roomId: string;
  total: number;
  completed: number;
  intervalMs: number;
}

const EMPTY_FORM: CreateRoomInput = {
  name: "New Demo Room",
  description: "서비스 배포 시연을 위한 게임 방",
  region: "Seoul / ap-northeast-2",
  map: "Faction Island",
  mode: "Faction 50v50",
  maxPlayers: 100,
  initialBots: 8,
};

const STATUS_DESCRIPTION: Record<RoomStatus, string> = {
  running: "서비스 중",
  provisioning: "Pod 배포 중",
  stopped: "배포 중지",
  recovering: "Room Recovery 중",
  degraded: "성능 저하",
};

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }

  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds
    .toString()
    .padStart(2, "0")}`;
}

function formatSnapshotAge(seconds: number) {
  if (seconds < 1) return "방금 전";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}초 전`;
  return `${Math.floor(seconds / 60)}분 전`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRoomActive(status: RoomStatus) {
  return status === "running" || status === "degraded";
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;

  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");

  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (
    event.shiftKey &&
    (active === first || !event.currentTarget.contains(active))
  ) {
    event.preventDefault();
    last!.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first!.focus();
  }
}

function playerCounts(room: GameRoom) {
  const bots = room.players.filter((player) => player.isBot).length;
  return {
    bots,
    humans: room.players.length - bots,
  };
}

function roomHealth(room: GameRoom) {
  if (room.status === "recovering" || room.status === "provisioning") {
    return { label: "변경 중", tone: "warning" as const };
  }
  if (room.status === "stopped") {
    return { label: "중지", tone: "muted" as const };
  }
  if (
    room.status === "degraded" ||
    room.metrics.cpuPercent >= 88 ||
    room.tickRate < 70
  ) {
    return { label: "위험", tone: "danger" as const };
  }
  if (room.metrics.cpuPercent >= 72 || room.tickRate < 90) {
    return { label: "주의", tone: "warning" as const };
  }
  return { label: "안정", tone: "good" as const };
}

function StatusBadge({ status }: { status: RoomStatus }) {
  return (
    <span className={`status-badge status-badge-${status}`}>
      <i />
      {ROOM_STATUS_LABEL[status]}
    </span>
  );
}

function RoomMiniMap({ room }: { room: GameRoom }) {
  return (
    <div className="room-mini-map" aria-hidden="true">
      <span className="mini-map-source">LIVE COORDINATES</span>
      <div
        className="mini-map-zone"
        style={{
          left: `${room.zone.x}%`,
          top: `${room.zone.y}%`,
          width: `${room.zone.radius * 1.35}%`,
        }}
      />
      {room.players.slice(0, 32).map((player) => (
        <i
          className={player.isBot ? "is-bot" : ""}
          key={player.id}
          style={
            {
              left: `${player.x}%`,
              top: `${player.y}%`,
              "--player-color": player.color,
            } as StyleWithVariables
          }
        />
      ))}
      {room.status === "stopped" && (
        <div className="mini-map-offline">
          <span />
          SCALE TO ZERO
        </div>
      )}
    </div>
  );
}

function RoomCard({
  room,
  canScale,
  onOpen,
  onEdit,
  onDelete,
}: {
  room: GameRoom;
  canScale: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { bots, humans } = playerCounts(room);
  const occupancy = (room.players.length / room.maxPlayers) * 100;
  const memoryPercent =
    room.metrics.memoryLimitMb > 0
      ? (room.metrics.memoryMb / room.metrics.memoryLimitMb) * 100
      : 0;
  const health = roomHealth(room);

  return (
    <article className="room-card">
      <div className="room-card-actions">
        <button onClick={onEdit} type="button" aria-label={`${room.name} 수정`}>
          수정
        </button>
        <button
          className="danger-link"
          disabled={!canScale}
          onClick={onDelete}
          title={canScale ? undefined : "Kubernetes 배포에서만 삭제할 수 있습니다"}
          type="button"
          aria-label={`${room.name} 삭제`}
        >
          삭제
        </button>
      </div>
      <button className="room-card-open" onClick={onOpen} type="button">
        <div className="room-card-preview">
          <RoomMiniMap room={room} />
          <div className="room-card-preview-top">
            <StatusBadge status={room.status} />
            <span className={`health-chip health-${health.tone}`}>
              {health.label}
            </span>
          </div>
          <div className="room-card-preview-bottom">
            <span>{room.map}</span>
            <span>{MATCH_PHASE_LABEL[room.matchPhase]}</span>
          </div>
        </div>
        <div className="room-card-body">
          <div className="room-card-title">
            <div>
              <h2>{room.name}</h2>
              <p>{room.description}</p>
            </div>
            <span className="room-open-arrow">↗</span>
          </div>
          <div className="room-card-tags">
            <span>{room.mode}</span>
            <span>{room.region.split(" / ")[0]}</span>
            <span>{room.imageTag.split(":")[1]}</span>
          </div>
          <div className="room-capacity-summary">
            <span>
              <strong>{room.players.length}</strong> / {room.maxPlayers} players
            </span>
            <span>
              사람 {humans} · 봇 {bots}
            </span>
          </div>
          <div className="room-capacity-bar">
            <i style={{ width: `${clamp(occupancy, 0, 100)}%` }} />
          </div>
          <div className="room-card-metrics">
            <div>
              <span>MEASURED TICK</span>
              <strong>{room.tickRate.toFixed(1)} Hz</strong>
            </div>
            <div>
              <span>GAME CPU</span>
              <strong>{room.metrics.cpuPercent.toFixed(0)}%</strong>
            </div>
            <div>
              <span>GAME RSS</span>
              <strong>{room.metrics.memoryMb.toFixed(0)} MB</strong>
            </div>
            <div>
              <span>SNAPSHOT</span>
              <strong>{formatSnapshotAge(room.snapshotAgeSeconds)}</strong>
            </div>
          </div>
          <div className="room-card-pod">
            <span
              className={`pod-ready-dot ${
                room.readyReplicas === room.desiredReplicas &&
                room.desiredReplicas > 0
                  ? "is-ready"
                  : ""
              }`}
            />
            <span>{room.podName}</span>
            <b>
              {room.readyReplicas}/{room.desiredReplicas}
            </b>
          </div>
        </div>
      </button>
    </article>
  );
}

function RoomDirectory({
  rooms,
  capabilities,
  onOpenRoom,
  onCreate,
  onEdit,
  onDelete,
}: {
  rooms: GameRoom[];
  capabilities: ControlPlaneCapabilities;
  onOpenRoom: (roomId: string) => void;
  onCreate: () => void;
  onEdit: (roomId: string) => void;
  onDelete: (roomId: string) => void;
}) {
  const runningRooms = rooms.filter((room) =>
    isRoomActive(room.status),
  ).length;
  const totalPlayers = rooms.reduce(
    (total, room) => total + room.players.length,
    0,
  );
  const totalBots = rooms.reduce(
    (total, room) => total + playerCounts(room).bots,
    0,
  );
  const averageCpu =
    runningRooms > 0
      ? rooms
          .filter((room) => isRoomActive(room.status))
          .reduce((total, room) => total + room.metrics.cpuPercent, 0) /
        runningRooms
      : 0;
  const activeRoomCount = rooms.filter((room) => room.status !== "stopped").length;
  const canCreate = capabilities.scalingAvailable && activeRoomCount < capabilities.maxRooms;

  return (
    <section className="room-directory">
      <div className="directory-hero">
        <div className="directory-copy">
          <span className="eyebrow">DEPLOYED GAME ROOMS</span>
          <h1>관리할 게임 방을 선택하세요</h1>
          <p>
            각 카드는 우리 서비스가 배포한 Survev 전용 Pod 하나를 나타냅니다.
            방을 선택하면 전체 게임 상황과 운영 상태를 크게 확인할 수 있습니다.
          </p>
        </div>
        <div className="directory-summary">
          <div>
            <span>ACTIVE ROOMS</span>
            <strong>
              {runningRooms}
              <small> / {rooms.length}</small>
            </strong>
          </div>
          <div>
            <span>CONNECTED</span>
            <strong>{totalPlayers}</strong>
          </div>
          <div>
            <span>LOAD BOTS</span>
            <strong>{totalBots}</strong>
          </div>
          <div>
            <span>AVG CPU</span>
            <strong>{averageCpu.toFixed(0)}%</strong>
          </div>
        </div>
      </div>

      <div className="room-grid" aria-label="게임 방 목록">
        {rooms.map((room) => (
          <RoomCard
            canScale={capabilities.scalingAvailable}
            key={room.id}
            room={room}
            onOpen={() => onOpenRoom(room.id)}
            onEdit={() => onEdit(room.id)}
            onDelete={() => onDelete(room.id)}
          />
        ))}
        <button
          className="add-room-card"
          disabled={!canCreate}
          onClick={onCreate}
          title={
            capabilities.scalingAvailable
              ? `최대 ${capabilities.maxRooms}개 방을 배포할 수 있습니다`
              : "Kubernetes 배포에서만 방을 추가할 수 있습니다"
          }
          type="button"
        >
          <span className="add-room-icon">+</span>
          <strong>{canCreate ? "새 게임 방 배포" : "방 배포 사용 불가"}</strong>
          <p>
            {capabilities.scalingAvailable
              ? `Room 설정을 만들고 ordinal Pod를 할당합니다. (${activeRoomCount}/${capabilities.maxRooms})`
              : "현재 런타임은 Kubernetes StatefulSet을 관리하지 않습니다."}
          </p>
          <span className="add-room-flow">
            Room record <i>→</i> StatefulSet ordinal <i>→</i> Pod
          </span>
        </button>
      </div>

      <div className="presentation-flow">
        <div>
          <span>01</span>
          <strong>방 선택</strong>
          <p>배포·인원·부하 상태를 카드에서 빠르게 확인</p>
        </div>
        <i>→</i>
        <div>
          <span>02</span>
          <strong>관리자 전술 맵</strong>
          <p>실제 맵 좌표 위에서 모든 플레이어를 동시에 추적</p>
        </div>
        <i>→</i>
        <div>
          <span>03</span>
          <strong>게임 관리</strong>
          <p>Pod, Redis, 실시간 지표와 봇 부하를 한 화면에서 제어</p>
        </div>
      </div>
    </section>
  );
}

function AdminTacticalMap({
  room,
  selectedPlayer,
  onSelectPlayer,
  onClearPlayer,
}: {
  room: GameRoom;
  selectedPlayer?: PlayerTelemetry;
  onSelectPlayer: (playerId: string) => void;
  onClearPlayer: () => void;
}) {
  const map = room.mapLayout;
  if (map.width <= 0 || map.height <= 0) {
    return (
      <div className="admin-tactical-map is-unavailable">
        <span className="map-empty-signal" />
        <strong>게임 맵 스냅샷 대기 중</strong>
        <p>Survev 게임 프로세스가 생성한 GameMap 데이터를 기다리고 있습니다.</p>
      </div>
    );
  }

  const coastInset = Math.max(0, map.shoreInset);
  const grassInset = coastInset + Math.max(0, map.grassInset);
  const mapAspect = map.width / map.height;

  return (
    <div
      className="admin-tactical-map"
      aria-label={`${room.name} 실시간 관리자 전술 맵`}
      data-map-seed={room.seed}
    >
      <div
        className="admin-map-viewport"
        data-map-native-size={`${map.width}x${map.height}`}
        style={
          {
            "--map-aspect": `${map.width} / ${map.height}`,
            "--map-width-by-height": `${mapAspect * 100}cqh`,
            "--map-height-by-width": `${(1 / mapAspect) * 100}cqw`,
          } as StyleWithVariables
        }
      >
      <svg
        aria-hidden="true"
        className="admin-map-surface"
        preserveAspectRatio="xMidYMid meet"
        viewBox={`0 0 ${map.width} ${map.height}`}
      >
        <rect className="admin-map-water" width={map.width} height={map.height} />
        <rect
          className="admin-map-shore"
          height={Math.max(0, map.height - coastInset * 2)}
          width={Math.max(0, map.width - coastInset * 2)}
          x={coastInset}
          y={coastInset}
        />
        <rect
          className="admin-map-grass"
          height={Math.max(0, map.height - grassInset * 2)}
          width={Math.max(0, map.width - grassInset * 2)}
          x={grassInset}
          y={grassInset}
        />
        <g className="admin-map-rivers">
          {map.rivers.map((river, index) => {
            const points = river.points.map((point) => `${point.x},${point.y}`).join(" ");
            const closedPoints = river.looped && river.points[0]
              ? `${points} ${river.points[0].x},${river.points[0].y}`
              : points;
            return (
              <g key={`${index}:${river.width}:${river.points.length}`}>
                <polyline
                  className="admin-map-river-shore"
                  fill="none"
                  points={closedPoints}
                  strokeWidth={Math.max(4, river.width * 2 + 9)}
                />
                <polyline
                  className="admin-map-river-water"
                  fill="none"
                  points={closedPoints}
                  strokeWidth={Math.max(2, river.width * 2)}
                />
              </g>
            );
          })}
        </g>
        <g className="admin-map-objects">
          {map.objects.map((object) => {
            const className = `admin-map-object admin-map-object-${object.kind}`;
            if (object.kind === "tree" || object.kind === "rock") {
              return (
                <ellipse
                  className={className}
                  cx={object.x}
                  cy={object.y}
                  key={`${object.kind}:${object.id}`}
                  rx={Math.max(1.5, object.width / 2)}
                  ry={Math.max(1.5, object.height / 2)}
                />
              );
            }
            return (
              <rect
                className={className}
                height={Math.max(1, object.height)}
                key={`${object.kind}:${object.id}`}
                width={Math.max(1, object.width)}
                x={object.x - object.width / 2}
                y={object.y - object.height / 2}
              />
            );
          })}
        </g>
        <g className="admin-map-places">
          {map.places.map((place) => (
            <text
              key={place.name}
              x={place.x * map.width}
              y={place.y * map.height}
            >
              {place.name}
            </text>
          ))}
        </g>
      </svg>
      <div
        className="zone-ring zone-ring-current"
        style={
          {
            "--zone-size": `${room.zone.radius * 2}%`,
            "--zone-x": `${room.zone.x}%`,
            "--zone-y": `${room.zone.y}%`,
          } as StyleWithVariables
        }
      />
      <div
        className="zone-ring zone-ring-next"
        style={
          {
            "--zone-size": `${room.zone.nextRadius * 2}%`,
            "--zone-x": `${room.zone.nextX}%`,
            "--zone-y": `${room.zone.nextY}%`,
          } as StyleWithVariables
        }
      />
      {room.players.map((player) => (
        <button
          aria-label={`${player.name} ${player.squad} 플레이어 위치`}
          className={`player-marker ${player.isBot ? "player-marker-bot" : ""} ${
            selectedPlayer?.id === player.id ? "is-selected" : ""
          }`}
          key={player.id}
          onClick={() => onSelectPlayer(player.id)}
          style={
            {
              left: `${player.x}%`,
              top: `${player.y}%`,
              "--player-color": player.color,
              "--player-rotation": `${player.rotation}rad`,
            } as StyleWithVariables
          }
          title={`${player.name} · ${player.squad} · HP ${Math.round(player.health)}`}
          type="button"
        >
          <span className="player-marker-core" />
          <span className="player-marker-direction" />
          <span className="player-marker-label">{player.name}</span>
        </button>
      ))}
      <div className="admin-map-source">
        <span>
          <i />
          GAME PROCESS · LIVE
        </span>
        <strong>ADMIN TACTICAL VIEW</strong>
        <small>실제 GameMap · 플레이어 좌표 · 가스존</small>
      </div>
      {selectedPlayer && (
        <div className="admin-map-selection">
          <div>
            <i style={{ background: selectedPlayer.color }} />
            <span>SELECTED PLAYER</span>
          </div>
          <strong>{selectedPlayer.name}</strong>
          <small>
            {selectedPlayer.squad} · HP {Math.round(selectedPlayer.health)} · {selectedPlayer.weapon}
          </small>
          <button onClick={onClearPlayer} type="button">선택 해제</button>
        </div>
      )}
      {room.players.length === 0 && (
        <div className="admin-map-no-players">연결된 플레이어 없음</div>
      )}
      <div className="map-compass"><i />N</div>
      <div className="map-scale">MAP {Math.round(map.width)} × {Math.round(map.height)}</div>
      <div className="map-legend">
        <span><i className="legend-red" />RED</span>
        <span><i className="legend-blue" />BLUE</span>
        <span><i className="legend-zone" />GAS</span>
      </div>
      </div>
    </div>
  );
}

function PlayerRoster({
  room,
  selectedPlayerId,
  onSelectPlayer,
}: {
  room: GameRoom;
  selectedPlayerId?: string;
  onSelectPlayer: (playerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "human" | "bot">("all");
  const { bots, humans } = playerCounts(room);
  const filteredPlayers = room.players.filter((player) => {
    const matchesQuery = player.name
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "bot" && player.isBot) ||
      (filter === "human" && !player.isBot);
    return matchesQuery && matchesFilter;
  });

  return (
    <aside className="player-roster-panel" id="player-roster">
      <div className="player-roster-heading">
        <div>
          <span>
            {isRoomActive(room.status)
              ? "LIVE PLAYERS"
              : "LAST PLAYER TELEMETRY"}
          </span>
          <strong>플레이어 목록</strong>
        </div>
        <b>{room.players.length}</b>
      </div>
      <label className="player-search">
        <span>⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="이름으로 찾기"
          aria-label="플레이어 검색"
        />
      </label>
      <div className="player-filter" aria-label="플레이어 유형 필터">
        <button
          className={filter === "all" ? "is-active" : ""}
          onClick={() => setFilter("all")}
          type="button"
        >
          전체 {room.players.length}
        </button>
        <button
          className={filter === "human" ? "is-active" : ""}
          onClick={() => setFilter("human")}
          type="button"
        >
          사람 {humans}
        </button>
        <button
          className={filter === "bot" ? "is-active" : ""}
          onClick={() => setFilter("bot")}
          type="button"
        >
          봇 {bots}
        </button>
      </div>
      <div className="player-list">
        {filteredPlayers.map((player) => (
          <button
            className={`player-list-row ${
              player.id === selectedPlayerId ? "is-active" : ""
            }`}
            key={player.id}
            onClick={() => onSelectPlayer(player.id)}
            type="button"
          >
            <span
              className="player-list-avatar"
              style={
                {
                  "--player-color": player.color,
                } as StyleWithVariables
              }
            >
              {player.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="player-list-name">
              <strong>{player.name}</strong>
              <small>
                {player.isBot ? "LOAD BOT" : player.squad} ·{" "}
                {player.ping > 0 ? `${player.ping}ms` : "PING N/A"}
              </small>
            </span>
            <span className="player-list-health">
              <i style={{ width: `${player.health}%` }} />
            </span>
            <span className="player-list-kills">{player.kills}K</span>
            <span className="player-watch-label">찾기</span>
          </button>
        ))}
        {filteredPlayers.length === 0 && (
          <div className="player-list-empty">
            <span>검색 결과가 없습니다.</span>
          </div>
        )}
      </div>
      <div className="roster-hint">
        맵 마커나 목록을 누르면 관리자 전술 맵에서 해당 플레이어를 강조합니다.
      </div>
    </aside>
  );
}

function WorldTab({
  room,
  selectedPlayer,
  onSelectPlayer,
  onClearPlayer,
  onOpenManagement,
}: {
  room: GameRoom;
  selectedPlayer?: PlayerTelemetry;
  onSelectPlayer: (playerId: string) => void;
  onClearPlayer: () => void;
  onOpenManagement: () => void;
}) {
  const { bots, humans } = playerCounts(room);
  const [isRosterOpen, setIsRosterOpen] = useState(false);

  function selectPlayerFromRoster(playerId: string) {
    onSelectPlayer(playerId);
  }

  return (
    <section
      aria-labelledby="world-tab"
      className="detail-tab-panel world-tab-panel"
      id="world-panel"
      role="tabpanel"
      tabIndex={0}
    >
      <div className="world-toolbar">
        <div>
          <span className="eyebrow">LIVE ADMIN TACTICAL MAP</span>
          <h2>실시간 관리자 전술 맵</h2>
          <p>게임 프로세스의 실제 GameMap과 모든 플레이어 좌표를 한 화면에서 동시에 추적합니다.</p>
        </div>
        <div className="world-toolbar-actions">
          <a
            className="button button-primary"
            href={room.serviceUrl}
            rel="noreferrer"
            target="_blank"
          >
            실제 게임 열기 ↗
          </a>
          {selectedPlayer && (
            <button
              className="button button-secondary"
              onClick={onClearPlayer}
              type="button"
            >
              선택 해제
            </button>
          )}
          <span>
            사람 <strong>{humans}</strong>
          </span>
          <span>
            봇 <strong>{bots}</strong>
          </span>
          <span>
            추적 <strong>{room.players.length}</strong>
          </span>
          <button
            aria-controls="player-roster"
            aria-expanded={isRosterOpen}
            className={`button roster-toggle ${
              isRosterOpen ? "button-primary" : "button-secondary"
            }`}
            onClick={() => setIsRosterOpen((current) => !current)}
            type="button"
          >
            {isRosterOpen ? "목록 닫기" : `플레이어 목록 ${room.players.length}`}
          </button>
        </div>
      </div>
      <div
        className={`world-layout ${
          isRosterOpen ? "is-roster-open" : "is-roster-hidden"
        }`}
      >
        <div className="world-stage-card">
          <div className="world-stage-meta">
            <span>
              <i className={`status-dot status-${room.status}`} />
              {STATUS_DESCRIPTION[room.status]}
            </span>
            <span>{room.map}</span>
            <span>Seed {room.seed}</span>
            <span>{room.tickRate.toFixed(1)}Hz measured</span>
          </div>
          <AdminTacticalMap
            room={room}
            selectedPlayer={selectedPlayer}
            onSelectPlayer={onSelectPlayer}
            onClearPlayer={onClearPlayer}
          />
          {room.status === "stopped" && (
            <button
              className="map-management-cta"
              onClick={onOpenManagement}
              type="button"
            >
              게임 관리 탭에서 서버 시작 →
            </button>
          )}
        </div>
        {isRosterOpen && (
          <PlayerRoster
            key={room.id}
            room={room}
            selectedPlayerId={selectedPlayer?.id}
            onSelectPlayer={selectPlayerFromRoster}
          />
        )}
      </div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "good" | "warning" | "danger";
}) {
  return (
    <div className={`metric-card metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ResourceGauge({
  label,
  value,
  percent,
  tone = "green",
}: {
  label: string;
  value: string;
  percent: number;
  tone?: "green" | "cyan" | "amber" | "red";
}) {
  return (
    <div className="resource-gauge">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className={`resource-track resource-${tone}`}>
        <i style={{ width: `${clamp(percent, 0, 100)}%` }} />
      </div>
    </div>
  );
}

function ManagementTab({
  room,
  scalingAvailable,
  events,
  botRequest,
  botRamp,
  loadRun,
  onBotRequestChange,
  onBotRampChange,
  onAddBots,
  onCancelBots,
  onRemoveBots,
  onStart,
  onStop,
  onSnapshot,
  onFailure,
  onToggleJoin,
  onEdit,
  onDelete,
}: {
  room: GameRoom;
  scalingAvailable: boolean;
  events: OpsEvent[];
  botRequest: number;
  botRamp: "fast" | "normal" | "slow";
  loadRun: BotLoadRun | null;
  onBotRequestChange: (value: number) => void;
  onBotRampChange: (value: "fast" | "normal" | "slow") => void;
  onAddBots: () => void;
  onCancelBots: () => void;
  onRemoveBots: () => void;
  onStart: () => void;
  onStop: () => void;
  onSnapshot: () => void;
  onFailure: () => void;
  onToggleJoin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { bots, humans } = playerCounts(room);
  const capacity = Math.max(0, room.maxPlayers - room.players.length);
  const memoryPercent =
    room.metrics.memoryLimitMb > 0
      ? (room.metrics.memoryMb / room.metrics.memoryLimitMb) * 100
      : 0;
  const health = roomHealth(room);
  const loadForThisRoom = loadRun?.roomId === room.id ? loadRun : null;
  const loadRunningElsewhere = Boolean(
    loadRun && loadRun.roomId !== room.id,
  );
  const loadProgress = loadForThisRoom
    ? (loadForThisRoom.completed / loadForThisRoom.total) * 100
    : 0;
  return (
    <section
      aria-labelledby="manage-tab"
      className="detail-tab-panel management-tab-panel"
      id="manage-panel"
      role="tabpanel"
      tabIndex={0}
    >
      <div className="management-intro">
        <div>
          <span className="eyebrow">ROOM OPERATIONS</span>
          <h2>게임 배포·운영 관리</h2>
          <p>
            발표에서 배포 구조, 서버 상태, Redis 복구와 봇 부하 결과를 이
            화면 하나로 설명할 수 있습니다.
          </p>
        </div>
        <div className={`overall-health overall-${health.tone}`}>
          <span>ROOM HEALTH</span>
          <strong>{health.label}</strong>
          <small>
            CPU {room.metrics.cpuPercent.toFixed(0)}% · Tick{" "}
            {room.tickRate.toFixed(1)}Hz
          </small>
        </div>
      </div>

      <div className="deployment-flow-card">
        <div className="deployment-flow-heading">
          <div>
            <span>DEPLOYMENT PATH</span>
            <strong>우리 서비스가 방 하나를 운영하는 흐름</strong>
          </div>
          <span className="room-id-chip">{room.id}</span>
        </div>
        <div className="deployment-flow">
          <div className="deployment-node node-control">
            <span>01</span>
            <i className="deployment-node-icon">C</i>
            <strong>Control Plane</strong>
            <small>desired state · commands</small>
            <b className="node-state node-ready">CONNECTED</b>
          </div>
          <i className="flow-arrow">→</i>
          <div className="deployment-node node-k8s">
            <span>02</span>
            <i className="deployment-node-icon">K</i>
            <strong>StatefulSet</strong>
            <small>
              replicas {room.readyReplicas}/{room.desiredReplicas}
            </small>
            <b
              className={`node-state ${
                room.readyReplicas === room.desiredReplicas &&
                room.desiredReplicas > 0
                  ? "node-ready"
                  : "node-warn"
              }`}
            >
              {room.desiredReplicas === 0
                ? "SCALED DOWN"
                : room.readyReplicas === room.desiredReplicas
                  ? "READY"
                  : "RECONCILING"}
            </b>
          </div>
          <i className="flow-arrow">→</i>
          <div className="deployment-node node-pod">
            <span>03</span>
            <i className="deployment-node-icon">P</i>
            <strong>Survev Pod</strong>
            <small>{room.podName}</small>
            <b
              className={`node-state ${
                room.podHealthy ? "node-ready" : "node-warn"
              }`}
            >
              {room.podHealthy ? "READY" : ROOM_STATUS_LABEL[room.status]}
            </b>
          </div>
          <i className="flow-arrow flow-arrow-bidirectional">⇄</i>
          <div className="deployment-node node-redis">
            <span>04</span>
            <i className="deployment-node-icon">R</i>
            <strong>Redis</strong>
            <small>
              {room.snapshotCapturedAt
                ? new Date(room.snapshotCapturedAt).toLocaleTimeString("ko-KR")
                : "snapshot pending"}
            </small>
            <b className="node-state node-ready">
              {formatSnapshotAge(room.snapshotAgeSeconds)}
            </b>
          </div>
        </div>
        {room.recoveryStep && (
          <div className="recovery-progress">
            <i />
            <strong>RECOVERY STEP</strong>
            <span>{room.recoveryStep}</span>
          </div>
        )}
        <p className="recovery-scope-note">
          DEMO 범위: Redis에서 방 설정·desired state와 마지막 관리자
          telemetry를 불러옵니다. 진행 중 경기 세션 자체를 정확히 재개하는
          checkpoint 데모는 아닙니다.
        </p>
      </div>

      <div className="management-metrics-grid">
        <MetricCard
          label="MEASURED TICK"
          value={`${room.tickRate.toFixed(1)} Hz`}
          detail="actual 500ms sample · target 100Hz"
          tone={
            room.tickRate >= 90
              ? "good"
              : room.tickRate >= 70
                ? "warning"
                : "danger"
          }
        />
        <MetricCard
          label="GAME PROCESS CPU"
          value={`${room.metrics.cpuPercent.toFixed(0)}%`}
          detail="child Game process only · not Pod total"
          tone={
            room.metrics.cpuPercent < 72
              ? "good"
              : room.metrics.cpuPercent < 88
                ? "warning"
                : "danger"
          }
        />
        <MetricCard
          label="GAME PROCESS RSS"
          value={`${room.metrics.memoryMb.toFixed(0)} MB`}
          detail={`Pod limit ${room.metrics.memoryLimitMb} MB is reference only`}
          tone={memoryPercent < 75 ? "good" : "warning"}
        />
        <MetricCard
          label="TICK P95"
          value={`${room.metrics.tickP95Ms.toFixed(1)} ms`}
          detail="measured Game.update p95 · 500ms window"
          tone={
            room.metrics.tickP95Ms < 10
              ? "good"
              : room.metrics.tickP95Ms < 15
                ? "warning"
                : "danger"
          }
        />
        <MetricCard
          label="PLAYERS / BOTS"
          value={`${humans} / ${bots}`}
          detail={`${room.players.length} websocket sessions`}
        />
        <MetricCard
          label="TELEMETRY LAG"
          value={`${room.metrics.telemetryLagMs.toFixed(0)} ms`}
          detail="500ms snapshot stream"
          tone={
            room.metrics.telemetryLagMs < 750
              ? "good"
              : room.metrics.telemetryLagMs < 1_500
                ? "warning"
                : "danger"
          }
        />
      </div>

      <div className="management-main-grid">
        <div className="load-test-card">
          <div className="section-heading">
            <div>
              <span>LOAD GENERATOR</span>
              <strong>봇을 추가해 부하 걸기</strong>
              <p>
                봇이 단계적으로 접속하면서 CPU, 메모리, Tick 지표가 함께
                변합니다.
              </p>
            </div>
            <span className="capacity-chip">남은 자리 {capacity}</span>
          </div>
          <div className="load-visual">
            <div className="load-visual-copy">
              <span>CURRENT LOAD</span>
              <strong>
                {room.players.length}
                <small> / {room.maxPlayers}</small>
              </strong>
              <p>
                실제 {humans} · LoadBot {bots}
              </p>
            </div>
            <div className="load-ring">
              <span
                style={
                  {
                    "--load-angle": `${clamp(
                      (room.players.length / room.maxPlayers) * 360,
                      0,
                      360,
                    )}deg`,
                  } as StyleWithVariables
                }
              />
              <strong>
                {Math.round((room.players.length / room.maxPlayers) * 100)}%
              </strong>
            </div>
          </div>
          <div className="bot-count-control">
            <span>투입할 봇 수</span>
            <div>
              <button
                onClick={() => onBotRequestChange(Math.max(1, botRequest - 1))}
                type="button"
                aria-label="봇 수 줄이기"
              >
                −
              </button>
              <input
                aria-label="투입할 봇 수"
                max={Math.max(1, capacity)}
                min={1}
                onChange={(event) =>
                  onBotRequestChange(
                    clamp(Number(event.target.value), 1, Math.max(1, capacity)),
                  )
                }
                type="number"
                value={botRequest}
              />
              <button
                onClick={() =>
                  onBotRequestChange(
                    Math.min(Math.max(1, capacity), botRequest + 1),
                  )
                }
                type="button"
                aria-label="봇 수 늘리기"
              >
                +
              </button>
            </div>
            <div className="bot-presets">
              {[5, 10, 20].map((value) => (
                <button
                  key={value}
                  disabled={capacity < 1}
                  onClick={() =>
                    onBotRequestChange(Math.min(value, Math.max(1, capacity)))
                  }
                  type="button"
                >
                  +{value}
                </button>
              ))}
            </div>
          </div>
          <div className="ramp-control">
            <span>접속 간격</span>
            <div>
              {(
                [
                  ["fast", "빠르게 · 120ms"],
                  ["normal", "보통 · 300ms"],
                  ["slow", "천천히 · 600ms"],
                ] as const
              ).map(([value, label]) => (
                <button
                  className={botRamp === value ? "is-active" : ""}
                  key={value}
                  onClick={() => onBotRampChange(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {loadForThisRoom && (
            <div className="bot-load-progress" aria-live="polite">
              <div>
                <span>LoadBot 접속 중</span>
                <strong>
                  {loadForThisRoom.completed}/{loadForThisRoom.total}
                </strong>
              </div>
              <div>
                <i style={{ width: `${loadProgress}%` }} />
              </div>
            </div>
          )}
          <div className="load-actions">
            {loadForThisRoom ? (
              <button
                className="button button-danger"
                onClick={onCancelBots}
                type="button"
              >
                투입 중단
              </button>
            ) : (
              <button
                className="button button-primary"
                disabled={
                  !isRoomActive(room.status) ||
                  capacity === 0 ||
                  loadRunningElsewhere
                }
                onClick={onAddBots}
                type="button"
              >
                {loadRunningElsewhere
                  ? "다른 방 LoadBot 투입 중"
                  : `LoadBot ${Math.min(botRequest, capacity)}명 투입`}
              </button>
            )}
            <button
              className="button button-secondary"
              disabled={bots === 0}
              onClick={onRemoveBots}
              type="button"
            >
              모든 봇 제거
            </button>
          </div>
        </div>

        <div className="runtime-card">
          <div className="section-heading">
            <div>
              <span>RUNTIME RESOURCES</span>
              <strong>
                {isRoomActive(room.status)
                  ? "실시간 게임 프로세스 자원"
                  : "마지막 게임 프로세스 관측값"}
              </strong>
              <p>
                {isRoomActive(room.status)
                  ? "Game child process의 CPU와 RSS를 비교합니다. Pod 전체 사용량은 아닙니다."
                  : "게임 프로세스가 다시 Ready가 될 때까지 마지막 관측값을 표시합니다."}
              </p>
            </div>
            <span className={`health-chip health-${health.tone}`}>
              {health.label}
            </span>
          </div>
          <div className="resource-gauges">
            <ResourceGauge
              label="Game CPU"
              value={`${room.metrics.cpuPercent.toFixed(1)}%`}
              percent={room.metrics.cpuPercent}
              tone={
                room.metrics.cpuPercent >= 88
                  ? "red"
                  : room.metrics.cpuPercent >= 72
                    ? "amber"
                    : "green"
              }
            />
            <ResourceGauge
              label="Game RSS"
              value={`${room.metrics.memoryMb.toFixed(0)} / ${room.metrics.memoryLimitMb} MB`}
              percent={memoryPercent}
              tone={memoryPercent >= 80 ? "amber" : "cyan"}
            />
            <ResourceGauge
              label="Player capacity"
              value={`${room.players.length} / ${room.maxPlayers}`}
              percent={(room.players.length / room.maxPlayers) * 100}
              tone="green"
            />
            <ResourceGauge
              label="Tick budget"
              value={`${room.metrics.tickP95Ms.toFixed(1)} / 10 ms`}
              percent={(room.metrics.tickP95Ms / 10) * 100}
              tone={room.metrics.tickP95Ms > 10 ? "red" : "amber"}
            />
          </div>
          <div className="network-grid">
            <div>
              <span>NETWORK IN</span>
              <strong>
                {room.metrics.networkInKbps === null
                  ? "N/A"
                  : `${room.metrics.networkInKbps.toFixed(0)} kbps`}
              </strong>
            </div>
            <div>
              <span>NETWORK OUT</span>
              <strong>
                {room.metrics.networkOutKbps === null
                  ? "N/A"
                  : `${room.metrics.networkOutKbps.toFixed(0)} kbps`}
              </strong>
            </div>
            <div>
              <span>REDIS OPS</span>
              <strong>
                {room.metrics.redisOpsPerSecond === null
                  ? "N/A"
                  : `${room.metrics.redisOpsPerSecond.toFixed(1)} /s`}
              </strong>
            </div>
            <div>
              <span>WEBSOCKETS</span>
              <strong>{room.metrics.websocketCount}</strong>
            </div>
          </div>
          <div className="runtime-details">
            <div>
              <span>POD IP</span>
              <strong>{room.podIp}</strong>
            </div>
            <div>
              <span>NODE</span>
              <strong>{room.node}</strong>
            </div>
            <div>
              <span>IMAGE</span>
              <strong>{room.imageTag}</strong>
            </div>
            <div>
              <span>UPTIME</span>
              <strong>{formatDuration(room.uptimeSeconds)}</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="management-bottom-grid">
        <div className="operations-card">
          <div className="section-heading">
            <div>
              <span>ROOM CONTROL</span>
              <strong>배포 및 방 제어</strong>
            </div>
          </div>
          <div className="operation-buttons">
            {room.status === "stopped" ? (
              <button
                className="operation-button operation-primary"
                disabled={!scalingAvailable}
                onClick={onStart}
                type="button"
              >
                <i>▶</i>
                <span>
                  <strong>서버 시작</strong>
                  <small>StatefulSet replicas 0 → 1</small>
                </span>
              </button>
            ) : (
              <button
                className="operation-button"
                disabled={
                  !scalingAvailable ||
                  room.status === "recovering" ||
                  room.status === "provisioning"
                }
                onClick={onStop}
                type="button"
              >
                <i>■</i>
                <span>
                  <strong>안전 종료</strong>
                  <small>final snapshot 후 scale-to-zero</small>
                </span>
              </button>
            )}
            <button
              className="operation-button"
              disabled={!isRoomActive(room.status)}
              onClick={onSnapshot}
              type="button"
            >
              <i>◆</i>
              <span>
                <strong>스냅샷 저장</strong>
                <small>실제 Game 상태를 Redis에 저장</small>
              </span>
            </button>
            <button
              className="operation-button operation-warning"
              disabled={!scalingAvailable || !isRoomActive(room.status)}
              onClick={onFailure}
              type="button"
            >
              <i>!</i>
              <span>
                <strong>Pod 장애 주입</strong>
                <small>Room Recovery 시나리오 실행</small>
              </span>
            </button>
            <button
              className="operation-button"
              onClick={onToggleJoin}
              type="button"
            >
              <i>{room.joinLocked ? "⊘" : "＋"}</i>
              <span>
                <strong>
                  {room.joinLocked ? "입장 잠금 해제" : "신규 입장 잠금"}
                </strong>
                <small>
                  현재 {room.joinLocked ? "LOCKED" : "OPEN"} 상태
                </small>
              </span>
            </button>
            <button className="operation-button" onClick={onEdit} type="button">
              <i>✎</i>
              <span>
                <strong>방 설정 수정</strong>
                <small>이름·설명 변경 · 게임 규칙 고정</small>
              </span>
            </button>
            <button
              className="operation-button operation-danger"
              disabled={!scalingAvailable}
              onClick={onDelete}
              type="button"
            >
              <i>×</i>
              <span>
                <strong>방 삭제</strong>
                <small>마지막 ordinal Pod와 room record 제거</small>
              </span>
            </button>
          </div>
        </div>

        <div className="event-timeline-card">
          <div className="section-heading">
            <div>
              <span>LIVE EVENT STREAM</span>
              <strong>운영 이벤트</strong>
            </div>
            <span className="event-live-chip">
              <i />
              LIVE
            </span>
          </div>
          <div className="event-timeline" aria-live="polite">
            {events.slice(0, 7).map((event) => (
              <div
                className={`timeline-event timeline-${event.tone}`}
                key={event.id}
              >
                <time>{event.time}</time>
                <i />
                <div>
                  <span>{event.source}</span>
                  <p>{event.message}</p>
                </div>
              </div>
            ))}
            {events.length === 0 && (
              <div className="event-empty">아직 기록된 이벤트가 없습니다.</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function RoomDetail({
  room,
  scalingAvailable,
  activeTab,
  selectedPlayer,
  events,
  botRequest,
  botRamp,
  loadRun,
  onBack,
  onChangeTab,
  onSelectPlayer,
  onClearPlayer,
  onBotRequestChange,
  onBotRampChange,
  onAddBots,
  onCancelBots,
  onRemoveBots,
  onStart,
  onStop,
  onSnapshot,
  onFailure,
  onToggleJoin,
  onEdit,
  onDelete,
}: {
  room: GameRoom;
  scalingAvailable: boolean;
  activeTab: DetailTab;
  selectedPlayer?: PlayerTelemetry;
  events: OpsEvent[];
  botRequest: number;
  botRamp: "fast" | "normal" | "slow";
  loadRun: BotLoadRun | null;
  onBack: () => void;
  onChangeTab: (tab: DetailTab) => void;
  onSelectPlayer: (playerId: string) => void;
  onClearPlayer: () => void;
  onBotRequestChange: (value: number) => void;
  onBotRampChange: (value: "fast" | "normal" | "slow") => void;
  onAddBots: () => void;
  onCancelBots: () => void;
  onRemoveBots: () => void;
  onStart: () => void;
  onStop: () => void;
  onSnapshot: () => void;
  onFailure: () => void;
  onToggleJoin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { bots, humans } = playerCounts(room);

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: DetailTab,
  ) {
    let nextTab: DetailTab | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = currentTab === "world" ? "manage" : "world";
    } else if (event.key === "Home") {
      nextTab = "world";
    } else if (event.key === "End") {
      nextTab = "manage";
    }

    if (!nextTab) return;
    event.preventDefault();
    onChangeTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`${nextTab}-tab`)?.focus();
    });
  }

  return (
    <section className="room-detail">
      <div className="room-detail-header">
        <button className="back-to-rooms" onClick={onBack} type="button">
          <span>←</span>
          방 목록
        </button>
        <div className="room-detail-title">
          <div>
            <StatusBadge status={room.status} />
            <span className="match-phase-chip">
              {MATCH_PHASE_LABEL[room.matchPhase]}
            </span>
          </div>
          <h1>{room.name}</h1>
          <p>
            {room.region} · {room.mode} · {room.map}
          </p>
        </div>
        <div className="room-detail-quick-stats">
          <div>
            <span>PLAYERS</span>
            <strong>
              {room.players.length}
              <small>/{room.maxPlayers}</small>
            </strong>
          </div>
          <div>
            <span>HUMAN / BOT</span>
            <strong>
              {humans} / {bots}
            </strong>
          </div>
          <div>
            <span>SERVER TICK</span>
            <strong>{room.tickRate.toFixed(1)}Hz</strong>
          </div>
          <div>
            <span>POD</span>
            <strong>
              {room.readyReplicas}/{room.desiredReplicas}
            </strong>
          </div>
        </div>
      </div>

      <div className="primary-tabs" role="tablist" aria-label="방 상세 화면">
        <button
          aria-controls="world-panel"
          aria-selected={activeTab === "world"}
          className={activeTab === "world" ? "is-active" : ""}
          id="world-tab"
          onKeyDown={(event) => handleTabKeyDown(event, "world")}
          onClick={() => onChangeTab("world")}
          role="tab"
          tabIndex={activeTab === "world" ? 0 : -1}
          type="button"
        >
          <span className="tab-number">01</span>
          <span>
            <strong>관리자 전술 맵 & 플레이어 추적</strong>
            <small>전체 위치에서 한 명의 2D 시점까지</small>
          </span>
        </button>
        <button
          aria-controls="manage-panel"
          aria-selected={activeTab === "manage"}
          className={activeTab === "manage" ? "is-active" : ""}
          id="manage-tab"
          onKeyDown={(event) => handleTabKeyDown(event, "manage")}
          onClick={() => onChangeTab("manage")}
          role="tab"
          tabIndex={activeTab === "manage" ? 0 : -1}
          type="button"
        >
          <span className="tab-number">02</span>
          <span>
            <strong>게임 배포·운영 관리</strong>
            <small>실시간 지표, Room Recovery, 봇 부하</small>
          </span>
        </button>
      </div>

      {activeTab === "world" ? (
        <WorldTab
          room={room}
          selectedPlayer={selectedPlayer}
          onSelectPlayer={onSelectPlayer}
          onClearPlayer={onClearPlayer}
          onOpenManagement={() => onChangeTab("manage")}
        />
      ) : (
        <ManagementTab
          room={room}
          scalingAvailable={scalingAvailable}
          events={events}
          botRequest={botRequest}
          botRamp={botRamp}
          loadRun={loadRun}
          onBotRequestChange={onBotRequestChange}
          onBotRampChange={onBotRampChange}
          onAddBots={onAddBots}
          onCancelBots={onCancelBots}
          onRemoveBots={onRemoveBots}
          onStart={onStart}
          onStop={onStop}
          onSnapshot={onSnapshot}
          onFailure={onFailure}
          onToggleJoin={onToggleJoin}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </section>
  );
}

function RoomEditorModal({
  mode,
  initialValue,
  minPlayers,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit";
  initialValue: CreateRoomInput;
  minPlayers: number;
  onCancel: () => void;
  onSubmit: (value: CreateRoomInput) => void;
}) {
  const [form, setForm] = useState(initialValue);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      ...form,
      name: form.name.trim() || "Untitled Room",
      description: form.description.trim() || "Survev game room",
      maxPlayers: Math.max(minPlayers, form.maxPlayers),
      initialBots: Math.min(form.initialBots, form.maxPlayers),
    });
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="room-modal"
        onKeyDown={trapDialogFocus}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-describedby="room-modal-description"
        aria-labelledby="room-modal-title"
      >
        <div className="modal-header">
          <div>
            <span>{mode === "create" ? "DEPLOY NEW ROOM" : "EDIT ROOM"}</span>
            <h2 id="room-modal-title">
              {mode === "create" ? "새 게임 방 배포" : "게임 방 설정 수정"}
            </h2>
            <p id="room-modal-description">
              {mode === "create"
                ? "Room 설정을 저장하고 방 전용 Survev Pod 하나를 할당합니다."
                : "이름과 설명을 변경합니다. 게임 규칙은 Faction 50v50으로 고정됩니다."}
            </p>
          </div>
          <button
            aria-label="모달 닫기"
            className="modal-close"
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="modal-form-grid">
          <label className="form-field form-field-wide">
            <span>방 이름</span>
            <input
              autoFocus
              maxLength={48}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              required
              value={form.name}
            />
          </label>
          <label className="form-field form-field-wide">
            <span>설명</span>
            <input
              maxLength={80}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              value={form.description}
            />
          </label>
          <label className="form-field">
            <span>리전</span>
            <select
              disabled
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  region: event.target.value,
                }))
              }
              value={form.region}
            >
              <option>Seoul / ap-northeast-2</option>
            </select>
          </label>
          <label className="form-field">
            <span>게임 모드</span>
            <select
              disabled
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  mode: event.target.value as CreateRoomInput["mode"],
                }))
              }
              value={form.mode}
            >
              <option>Faction 50v50</option>
            </select>
          </label>
          <label className="form-field">
            <span>맵</span>
            <select
              disabled
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  map: event.target.value,
                }))
              }
              value={form.map}
            >
              <option>Faction Island</option>
            </select>
          </label>
          <label className="form-field">
            <span>최대 인원</span>
            <input
              disabled
              max={100}
              min={100}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  maxPlayers: Number(event.target.value),
                }))
              }
              type="number"
              value={form.maxPlayers}
            />
          </label>
          {mode === "create" && (
            <label className="form-field form-field-wide">
              <span>배포 직후 자동 투입할 LoadBot</span>
              <input
                max={form.maxPlayers}
                min={0}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    initialBots: Number(event.target.value),
                  }))
                }
                type="number"
                value={form.initialBots}
              />
            </label>
          )}
        </div>
        <div className="modal-deployment-preview">
          <div>
            <span>1</span>
            <strong>Room record</strong>
            <small>Control Plane</small>
          </div>
          <i>→</i>
          <div>
            <span>1</span>
            <strong>StatefulSet</strong>
            <small>replicas 1</small>
          </div>
          <i>→</i>
          <div>
            <span>1</span>
            <strong>Survev Pod</strong>
            <small>maxGames 1</small>
          </div>
          <i>⇄</i>
          <div>
            <span>5s</span>
            <strong>Redis</strong>
            <small>room spec snapshot</small>
          </div>
        </div>
        <div className="modal-actions">
          <button
            className="button button-secondary"
            onClick={onCancel}
            type="button"
          >
            취소
          </button>
          <button className="button button-primary" type="submit">
            {mode === "create" ? "방 배포 시작" : "변경사항 저장"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteRoomModal({
  room,
  onCancel,
  onConfirm,
}: {
  room: GameRoom;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="delete-modal"
        onKeyDown={trapDialogFocus}
        role="alertdialog"
        aria-modal="true"
        aria-describedby="delete-room-description"
        aria-labelledby="delete-room-title"
      >
        <span className="delete-icon">!</span>
        <span className="eyebrow">DELETE GAME ROOM</span>
        <h2 id="delete-room-title">{room.name}을 삭제할까요?</h2>
        <p id="delete-room-description">
          Room record를 제거하고 StatefulSet의 마지막 ordinal Pod를
          scale-down합니다. 공유 headless Service는 유지됩니다.
        </p>
        <div className="delete-room-summary">
          <span>{room.id}</span>
          <span>{room.podName}</span>
          <span>{room.players.length} connected</span>
        </div>
        <div className="modal-actions">
          <button
            autoFocus
            className="button button-secondary"
            onClick={onCancel}
            type="button"
          >
            취소
          </button>
          <button
            className="button button-danger"
            onClick={onConfirm}
            type="button"
          >
            방 삭제
          </button>
        </div>
      </div>
    </div>
  );
}

type ControlPlaneConnection = "connecting" | "connected" | "degraded";

function errorMessage(error: unknown) {
  if (error instanceof ControlPlaneError && error.status === 401) {
    return "관리자 토큰이 필요합니다";
  }
  if (error instanceof ControlPlaneError) return error.message;
  if (error instanceof Error) return error.message;
  return "알 수 없는 Control Plane 오류가 발생했습니다";
}

/** Every room, player, metric and operation comes from demo-game's live control plane. */
export function GameAdminConsole() {
  const [rooms, setRooms] = useState<GameRoom[]>([]);
  const [events, setEvents] = useState<OpsEvent[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("world");
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [botRequest, setBotRequest] = useState(10);
  const [botRamp, setBotRamp] = useState<"fast" | "normal" | "slow">(
    "normal",
  );
  const [loadRun, setLoadRun] = useState<BotLoadRun | null>(null);
  const [connection, setConnection] =
    useState<ControlPlaneConnection>("connecting");
  const [lastError, setLastError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [needsAdminToken, setNeedsAdminToken] = useState(false);
  const [capabilities, setCapabilities] = useState<ControlPlaneCapabilities>({
    scalingAvailable: false,
    maxRooms: 3,
  });
  const roomsRef = useRef<GameRoom[]>([]);
  const pendingRequestRef = useRef(false);
  const modalReturnFocusRef = useRef<HTMLElement | null>(null);
  const previousModalRef = useRef<ModalState>(null);

  const selectedRoom =
    rooms.find((room) => room.id === selectedRoomId) ?? null;
  const selectedPlayer =
    selectedRoom?.players.find((player) => player.id === selectedPlayerId) ??
    undefined;
  const roomEvents = useMemo(
    () =>
      selectedRoom
        ? events.filter((event) => event.roomId === selectedRoom.id)
        : [],
    [events, selectedRoom],
  );

  async function refreshControlPlane(options: { quiet?: boolean } = {}) {
    try {
      const [nextState, nextEvents] = await Promise.all([
        controlPlaneClient.getState(),
        controlPlaneClient.listEvents(),
      ]);
      const nextRooms = nextState.rooms;
      roomsRef.current = nextRooms;
      setRooms(nextRooms);
      setEvents(nextEvents);
      setCapabilities(nextState.capabilities);
      setConnection("connected");
      setNeedsAdminToken(false);
      setLastUpdatedAt(new Date());
      if (!options.quiet) setLastError("");
    } catch (error) {
      setConnection("degraded");
      setNeedsAdminToken(
        error instanceof ControlPlaneError && error.status === 401,
      );
      if (!options.quiet) setLastError(errorMessage(error));
      throw error;
    }
  }

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        await refreshControlPlane({ quiet: disposed });
      } catch {
        // Connection state and the actionable error are already reflected in UI.
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedRoomId) return;
    if (!rooms.some((room) => room.id === selectedRoomId)) {
      setSelectedRoomId(null);
      setSelectedPlayerId("");
    }
  }, [rooms, selectedRoomId]);

  useEffect(() => {
    const jobId = loadRun?.jobId;
    const roomId = loadRun?.roomId;
    if (!jobId || !roomId) return;
    let disposed = false;
    const poll = async () => {
      try {
        const job = await controlPlaneClient.getBotLoad(roomId, jobId);
        if (disposed) return;
        setLoadRun((current) =>
          current?.jobId === jobId
            ? { ...current, completed: job.completed }
            : current,
        );
        if (job.state !== "running") {
          setLoadRun(null);
          await refreshControlPlane({ quiet: true });
          if (job.state === "failed") {
            setLastError(job.error ?? "봇 투입 작업에 실패했습니다");
          }
        }
      } catch (error) {
        if (!disposed) setLastError(errorMessage(error));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadRun?.jobId]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modal) {
        setModal(null);
        return;
      }
      if (selectedPlayerId) setSelectedPlayerId("");
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [modal, selectedPlayerId]);

  useEffect(() => {
    if (previousModalRef.current && !modal) {
      window.requestAnimationFrame(() => {
        const returnTarget = modalReturnFocusRef.current;
        if (returnTarget?.isConnected) returnTarget.focus();
        else
          document
            .querySelector<HTMLElement>(
              ".add-room-card, .back-to-rooms, .console-brand",
            )
            ?.focus();
        modalReturnFocusRef.current = null;
      });
    }
    previousModalRef.current = modal;
  }, [modal]);

  async function execute<T>(
    actionName: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    if (pendingRequestRef.current) return undefined;
    pendingRequestRef.current = true;
    setPendingAction(actionName);
    setLastError("");
    try {
      const result = await action();
      await refreshControlPlane({ quiet: true });
      return result;
    } catch (error) {
      setLastError(errorMessage(error));
      return undefined;
    } finally {
      pendingRequestRef.current = false;
      setPendingAction("");
    }
  }

  function openModal(nextModal: Exclude<ModalState, null>) {
    modalReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setModal(nextModal);
  }

  function openRoom(roomId: string) {
    setSelectedRoomId(roomId);
    setSelectedPlayerId("");
    setActiveTab("world");
    setBotRequest(10);
  }

  function backToRooms() {
    setSelectedRoomId(null);
    setSelectedPlayerId("");
    setActiveTab("world");
  }

  function roomToForm(room: GameRoom): CreateRoomInput {
    return {
      name: room.name,
      description: room.description,
      region: room.region,
      map: room.map,
      mode: room.mode,
      maxPlayers: room.maxPlayers,
      initialBots: 0,
    };
  }

  async function createRoom(input: CreateRoomInput) {
    const created = await execute("방 생성", () =>
      controlPlaneClient.createRoom(input),
    );
    if (!created) return;
    setModal(null);
    openRoom(created.id);
  }

  async function updateRoom(roomId: string, input: CreateRoomInput) {
    const updated = await execute("방 설정 저장", () =>
      controlPlaneClient.updateRoom(roomId, input),
    );
    if (updated) setModal(null);
  }

  async function deleteRoom(roomId: string) {
    const deleted = await execute("방 삭제", async () => {
      await controlPlaneClient.deleteRoom(roomId);
      return true;
    });
    if (!deleted) return;
    if (selectedRoomId === roomId) backToRooms();
    setModal(null);
  }

  async function commandRoom(roomId: string, command: RoomCommand) {
    await execute(command, () => controlPlaneClient.commandRoom(roomId, command));
  }

  async function toggleJoinLock(roomId: string) {
    const room = roomsRef.current.find((candidate) => candidate.id === roomId);
    if (!room) return;
    await execute("입장 정책 변경", () =>
      controlPlaneClient.setJoinLocked(roomId, !room.joinLocked),
    );
  }

  async function addBots(roomId: string) {
    const room = roomsRef.current.find((candidate) => candidate.id === roomId);
    if (!room || !isRoomActive(room.status)) return;
    const total = Math.min(
      botRequest,
      Math.max(0, room.maxPlayers - room.players.length),
    );
    if (total < 1) return;
    const intervalMs =
      botRamp === "fast" ? 120 : botRamp === "slow" ? 600 : 300;
    const result = await execute("봇 투입", () =>
      controlPlaneClient.addBots(roomId, { count: total, intervalMs }),
    );
    if (!result) return;
    setLoadRun({
      jobId: result.jobId,
      roomId,
      total: result.accepted,
      completed: 0,
      intervalMs,
    });
  }

  async function cancelBotLoad(roomId: string) {
    const current = loadRun;
    if (!current || current.roomId !== roomId) return;
    const cancelled = await execute("봇 투입 취소", async () => {
      await controlPlaneClient.cancelBotLoad(roomId, current.jobId);
      return true;
    });
    if (cancelled) setLoadRun(null);
  }

  async function removeBots(roomId: string) {
    const removed = await execute("봇 연결 종료", async () => {
      await controlPlaneClient.removeBots(roomId);
      return true;
    });
    if (removed) {
      setLoadRun(null);
      if (selectedPlayer?.isBot) setSelectedPlayerId("");
    }
  }

  const editRoom =
    modal?.type === "edit"
      ? rooms.find((room) => room.id === modal.roomId)
      : undefined;
  const deleteRoomTarget =
    modal?.type === "delete"
      ? rooms.find((room) => room.id === modal.roomId)
      : undefined;
  const connected = connection === "connected";

  return (
    <main className="console-shell">
      <header className="console-topbar">
        <button
          className="console-brand"
          onClick={backToRooms}
          type="button"
          aria-label="방 목록으로 이동"
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
            <b />
          </span>
          <span>
            <strong>Survev Service Control</strong>
            <small>GAME DEPLOYMENT & OPERATIONS</small>
          </span>
        </button>
        <div className="console-environment">
          <span className="environment-chip">DEMO CLUSTER</span>
          <span>jungle-final</span>
          <i />
          <span>ap-northeast-2</span>
        </div>
        <div
          className={`console-connection ${connected ? "" : "is-degraded"}`}
        >
          <i />
          <span>
            <strong>
              {connected
                ? "CONTROL PLANE CONNECTED"
                : connection === "connecting"
                  ? "CONTROL PLANE CONNECTING"
                  : "CONTROL PLANE DEGRADED"}
            </strong>
            <small>
              {lastUpdatedAt
                ? `실데이터 동기화 ${lastUpdatedAt.toLocaleTimeString("ko-KR")}`
                : "Room telemetry 연결 중"}
            </small>
          </span>
          <b>LIVE</b>
        </div>
      </header>

      {(lastError || pendingAction) && (
        <div
          className={`control-plane-notice ${lastError ? "is-error" : ""}`}
          role={lastError ? "alert" : "status"}
        >
          <strong>{lastError ? "요청 실패" : "명령 실행 중"}</strong>
          <span>{lastError || pendingAction}</span>
          {needsAdminToken && (
            <button
              onClick={() => {
                const token = window.prompt("배포 시 설정한 관리자 토큰을 입력하세요");
                if (!token?.trim()) return;
                setControlPlaneAdminToken(token);
                setLastError("");
                void refreshControlPlane();
              }}
              type="button"
            >
              토큰 입력
            </button>
          )}
          {lastError && (
            <button onClick={() => setLastError("")} type="button">
              닫기
            </button>
          )}
        </div>
      )}

      {selectedRoom ? (
        <RoomDetail
          room={selectedRoom}
          scalingAvailable={capabilities.scalingAvailable}
          activeTab={activeTab}
          selectedPlayer={selectedPlayer}
          events={roomEvents}
          botRequest={botRequest}
          botRamp={botRamp}
          loadRun={loadRun}
          onBack={backToRooms}
          onChangeTab={(tab) => {
            setActiveTab(tab);
            if (tab === "manage") setSelectedPlayerId("");
          }}
          onSelectPlayer={setSelectedPlayerId}
          onClearPlayer={() => setSelectedPlayerId("")}
          onBotRequestChange={setBotRequest}
          onBotRampChange={setBotRamp}
          onAddBots={() => void addBots(selectedRoom.id)}
          onCancelBots={() => void cancelBotLoad(selectedRoom.id)}
          onRemoveBots={() => void removeBots(selectedRoom.id)}
          onStart={() => void commandRoom(selectedRoom.id, "start")}
          onStop={() => void commandRoom(selectedRoom.id, "stop")}
          onSnapshot={() => void commandRoom(selectedRoom.id, "snapshot")}
          onFailure={() =>
            void commandRoom(selectedRoom.id, "inject-pod-failure")
          }
          onToggleJoin={() => void toggleJoinLock(selectedRoom.id)}
          onEdit={() => openModal({ type: "edit", roomId: selectedRoom.id })}
          onDelete={() =>
            openModal({ type: "delete", roomId: selectedRoom.id })
          }
        />
      ) : (
        <RoomDirectory
          rooms={rooms}
          capabilities={capabilities}
          onOpenRoom={openRoom}
          onCreate={() => openModal({ type: "create" })}
          onEdit={(roomId) => openModal({ type: "edit", roomId })}
          onDelete={(roomId) => openModal({ type: "delete", roomId })}
        />
      )}

      <footer className="console-footer">
        <span>LIVE CONTROL PLANE</span>
        방·Pod·Redis·플레이어·LoadBot 정보는 demo-game 서버에서 1초마다
        동기화됩니다. 지원되지 않는 클러스터 명령은 서버가 안전하게 거부합니다.
      </footer>

      {modal?.type === "create" && (
        <RoomEditorModal
          key="create-room"
          mode="create"
          initialValue={EMPTY_FORM}
          minPlayers={2}
          onCancel={() => setModal(null)}
          onSubmit={(input) => void createRoom(input)}
        />
      )}
      {editRoom && (
        <RoomEditorModal
          key={`edit-${editRoom.id}`}
          mode="edit"
          initialValue={roomToForm(editRoom)}
          minPlayers={Math.max(2, editRoom.players.length)}
          onCancel={() => setModal(null)}
          onSubmit={(input) => void updateRoom(editRoom.id, input)}
        />
      )}
      {deleteRoomTarget && (
        <DeleteRoomModal
          room={deleteRoomTarget}
          onCancel={() => setModal(null)}
          onConfirm={() => void deleteRoom(deleteRoomTarget.id)}
        />
      )}
    </main>
  );
}
