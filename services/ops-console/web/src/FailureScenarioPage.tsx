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
  type FailureScenarioEvidence,
  type FailureScenarioId,
  type FailureScenarioRoomState,
  type GameRoom,
  type OpsEvent,
  ROOM_STATUS_LABEL,
} from "./control-plane.js";
import {
  ControlPlaneError,
  controlPlaneClient,
} from "./control-plane-client.js";
import { compactPodName } from "./room-display.js";

type ConnectionState = "connecting" | "connected" | "degraded";
type ScenarioTone = "warning" | "danger" | "critical";
type ScenarioAction = "start" | "recover";
type ScenarioRoomCardStyle = CSSProperties & Record<`--${string}`, string | number>;
const ROOM_ID_LABEL_KEY = "game.opsia.dev/room-id";

interface ScenarioDefinition {
  id: FailureScenarioId;
  code: string;
  title: string;
  summary: string;
  symptom: string;
  recovery: string;
  tone: ScenarioTone;
  requiresPodFailure?: boolean;
}

interface PendingScenarioAction {
  roomId: string;
  scenarioId: FailureScenarioId;
  action: ScenarioAction;
}

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

function roomPodLabel(room: GameRoom) {
  return room.podRoomLabel || `${ROOM_ID_LABEL_KEY}=${roomStableId(room)}`;
}

function scenarioRoomIdFromLocation() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("room") ?? "";
}

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "admission-lock",
    code: "01",
    title: "신규 입장 차단",
    summary: "선택한 방의 admission gate를 잠가 새 접속을 거부합니다.",
    symptom: "신규 플레이어 입장 실패 · 기존 세션 유지",
    recovery: "입장 잠금을 해제해 즉시 정상화",
    tone: "warning",
  },
  {
    id: "bot-surge",
    code: "02",
    title: "봇 접속 폭주",
    summary: "정상 프로토콜 봇을 짧은 간격으로 투입해 순간 부하를 만듭니다.",
    symptom: "WebSocket 증가 · CPU와 Tick 지연 관찰",
    recovery: "추가 봇을 정리하고 기본 인원 복원",
    tone: "warning",
  },
  {
    id: "malicious-input",
    code: "03",
    title: "악성 입력 폭주",
    summary: "비정상 입력 빈도의 실제 게임 클라이언트를 연결합니다.",
    symptom: "입력 거부 · 세션 차단 이벤트 발생",
    recovery: "악성 세션 제거 후 정상 봇 유지",
    tone: "danger",
  },
  {
    id: "admission-storm",
    code: "04",
    title: "로비 용량 회귀",
    summary: "중앙 입장 API에 40 RPS를 유지해 replicas 2→1 변경의 용량 부족을 재현합니다.",
    symptom: "신규 입장 성공률 하락 · 기존 게임 세션 유지",
    recovery: "replicas 1→2 복구 후 같은 40 RPS에서 실패율 정상화 확인",
    tone: "danger",
  },
  {
    id: "process-crash",
    code: "05",
    title: "게임 프로세스 Crash",
    summary: "방 내부 Game child process를 종료해 프로세스 복구를 확인합니다.",
    symptom: "Telemetry 단절 · 프로세스 자동 재기동",
    recovery: "감독 프로세스가 게임과 봇을 재연결",
    tone: "critical",
  },
  {
    id: "pod-failure",
    code: "06",
    title: "게임 Pod 장애",
    summary: "Kubernetes에서 선택한 게임 Pod를 삭제해 교체 복구를 시작합니다.",
    symptom: "Pod 교체 · Redis snapshot 기반 복구",
    recovery: "Room Deployment 재생성과 세션 재연결 확인",
    tone: "critical",
    requiresPodFailure: true,
  },
];

const STATUS_LABEL: Record<string, string> = {
  starting: "주입 중",
  active: "장애 발생 중",
  running: "장애 발생 중",
  recovering: "복구 중",
  completed: "완료",
  failed: "실패",
};

function scenarioLabel(scenarioId: FailureScenarioId): string {
  return SCENARIOS.find((scenario) => scenario.id === scenarioId)?.title ?? scenarioId;
}

function actionErrorMessage(error: unknown): string {
  if (error instanceof ControlPlaneError && error.status === 401) {
    return "운영 서버 인증 설정을 확인해야 합니다.";
  }
  if (error instanceof ControlPlaneError) return error.message;
  if (error instanceof Error) return error.message;
  return "장애 시나리오 요청에 실패했습니다.";
}

function evidenceLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toUpperCase();
}

function evidenceValue(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  if (typeof value === "boolean") return value ? "YES" : "NO";
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return `${value.length} items`;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length > 64 ? `${encoded.slice(0, 61)}...` : encoded;
  } catch {
    return String(value);
  }
}

function EvidenceList({ evidence }: { evidence?: FailureScenarioEvidence }) {
  const entries = Object.entries(evidence ?? {}).slice(0, 6);
  if (entries.length === 0) return null;
  return (
    <dl className="scenario-evidence">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{evidenceLabel(key)}</dt>
          <dd>{evidenceValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function evidenceNumber(evidence: FailureScenarioEvidence | undefined, key: string): number {
  const value = Number(evidence?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function AdmissionCapacityPanel({ evidence }: { evidence?: FailureScenarioEvidence }) {
  const failureRate = evidenceNumber(evidence, "failureRatePercent");
  const incident = evidence?.incidentTriggered === true;
  const stopped = evidence?.loadStopped === true;
  return (
    <div className={`admission-capacity-panel ${incident && !stopped ? "is-incident" : ""}`}>
      <div className="admission-success-rate">
        <span>신규 입장 실패율</span>
        <strong>{failureRate.toFixed(1)}<small>%</small></strong>
        <b>{stopped ? "측정 종료" : failureRate >= 20 ? "장애" : "정상 범위"}</b>
      </div>
      <dl>
        <div><dt>요청</dt><dd>{evidenceNumber(evidence, "requestRps").toFixed(1)} req/s</dd></div>
        <div><dt>성공</dt><dd>{evidenceNumber(evidence, "acceptedRps").toFixed(1)} req/s</dd></div>
        <div><dt>거절</dt><dd>{evidenceNumber(evidence, "rejectedRps").toFixed(1)} req/s</dd></div>
        <div><dt>응답 P95</dt><dd>{evidenceNumber(evidence, "responseP95Ms").toFixed(1)} ms</dd></div>
        <div><dt>성공률</dt><dd>{evidenceNumber(evidence, "successRatePercent").toFixed(1)}%</dd></div>
        <div><dt>장애 기준</dt><dd>실패율 20%</dd></div>
      </dl>
    </div>
  );
}

function playerCounts(room: GameRoom) {
  const bots = room.players.filter((player) => player.isBot).length;
  return { bots, humans: room.players.length - bots };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cyclicOffset(index: number, selectedIndex: number, total: number) {
  if (total <= 0) return 0;
  let offset = index - selectedIndex;
  const half = total / 2;
  if (offset > half) offset -= total;
  if (offset < -half) offset += total;
  return offset;
}

function roomPressureProfile(
  room: GameRoom,
  scenarioRoom: FailureScenarioRoomState | undefined,
  index: number,
) {
  // admission-storm targets the shared lobby Deployment. It must not make the
  // selected game room look unhealthy while existing matches keep running.
  const activePenalty =
    scenarioRoom?.active && scenarioRoom.active.scenarioId !== "admission-storm"
      ? 22
      : 0;
  const statusPenalty =
    room.status === "degraded" ? 16 :
      room.status === "recovering" ? 10 :
        room.status === "provisioning" ? 7 :
          room.status === "stopped" ? 4 : 0;
  const botPressure = (scenarioRoom?.hackBots ?? 0) * 1.6 + (scenarioRoom?.normalBots ?? 0) * 0.28;
  const load = clamp(
    Math.round(
      26 +
      index * 5 +
      clamp(room.metrics.cpuPercent, 0, 100) * 0.24 +
      clamp(room.metrics.tickP95Ms, 0, 80) * 0.35 +
      clamp(room.metrics.telemetryLagMs / 50, 0, 25) +
      botPressure +
      activePenalty +
      statusPenalty,
    ),
    12,
    94,
  );
  const latency = clamp(Math.round(room.metrics.tickP95Ms + 18 + index * 6 + activePenalty * 0.8), 18, 180);
  const drop = clamp(Math.round((room.metrics.inputRejected > 0 ? room.metrics.inputRejected / 8 : index * 3) + activePenalty), 0, 99);
  const redis = clamp(Math.round((room.metrics.redisOpsPerSecond ?? 18 + index * 9) + activePenalty * 1.4), 8, 160);
  const series = Array.from({ length: 12 }, (_, point) => {
    const wave = Math.sin((point + 1) * (0.74 + index * 0.08)) * (9 + index);
    const surge = scenarioRoom?.active ? point * 2.4 : (point % 4) * 2.2;
    return clamp(Math.round(load - 19 + wave + surge), 8, 98);
  });
  const linePath = series
    .map((value, point) => {
      const x = (point / (series.length - 1)) * 100;
      const y = 46 - value * 0.38;
      return `${point === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return {
    drop,
    latency,
    linePath,
    load,
    redis,
    fillPath: `${linePath} L 100 48 L 0 48 Z`,
    bars: series.slice(-6),
  };
}

export function FailureScenarioPage({
  rooms,
  connection,
  onError,
}: {
  rooms: GameRoom[];
  connection: ConnectionState;
  onError: (message: string) => void;
}) {
  const [scenarioRooms, setScenarioRooms] = useState<FailureScenarioRoomState[]>([]);
  const [podFailureAvailable, setPodFailureAvailable] = useState(false);
  const [events, setEvents] = useState<OpsEvent[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState(
    () => scenarioRoomIdFromLocation() || rooms[0]?.id || "",
  );
  const [confirmation, setConfirmation] = useState<{
    roomId: string;
    scenarioId: FailureScenarioId;
  } | null>(null);
  const [pending, setPending] = useState<PendingScenarioAction | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refreshPendingRef = useRef(false);

  const refreshScenarioState = useCallback(async (quiet = false) => {
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    try {
      const [state, nextEvents] = await Promise.all([
        controlPlaneClient.getFailureScenarios(),
        controlPlaneClient.listEvents(),
      ]);
      setScenarioRooms(state.rooms);
      setPodFailureAvailable(state.capabilities.podFailure);
      setEvents(nextEvents);
    } catch (error) {
      if (!quiet) onError(actionErrorMessage(error));
    } finally {
      refreshPendingRef.current = false;
    }
  }, [onError]);

  useEffect(() => {
    void refreshScenarioState();
    const timer = window.setInterval(
      () => void refreshScenarioState(true),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [refreshScenarioState]);

  useEffect(() => {
    if (rooms.length === 0) return;
    if (!rooms.some((room) => room.id === selectedRoomId)) {
      setSelectedRoomId(rooms[0]!.id);
      setConfirmation(null);
    }
  }, [rooms, selectedRoomId]);

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const selectedRoomIndex = Math.max(0, rooms.findIndex((room) => room.id === selectedRoomId));
  const selectedScenarioRoom = scenarioRooms.find(
    (room) => room.roomId === selectedRoomId,
  );
  const selectedEvents = useMemo(
    () => events.filter((event) => event.roomId === selectedRoomId).slice(0, 8),
    [events, selectedRoomId],
  );
  const selectedCounts = selectedRoom ? playerCounts(selectedRoom) : undefined;
  const inputAccepted = selectedRoom?.metrics.inputAccepted ?? 0;
  const inputRejected = selectedRoom?.metrics.inputRejected ?? 0;
  const activeScenario = selectedScenarioRoom?.active;
  const admissionFailureRate = activeScenario?.scenarioId === "admission-storm"
    ? evidenceNumber(activeScenario.evidence, "failureRatePercent")
    : 0;
  const roomControllable =
    selectedRoom?.status === "running" || selectedRoom?.status === "degraded";

  const selectAdjacentRoom = useCallback((direction: -1 | 1) => {
    if (rooms.length === 0) return;
    const nextIndex = (selectedRoomIndex + direction + rooms.length) % rooms.length;
    setSelectedRoomId(rooms[nextIndex]!.id);
    setConfirmation(null);
  }, [rooms, selectedRoomIndex]);

  async function runScenarioAction(
    scenario: ScenarioDefinition,
    action: ScenarioAction,
  ) {
    if (!selectedRoom || pending) return;
    const actionState: PendingScenarioAction = {
      roomId: selectedRoom.id,
      scenarioId: scenario.id,
      action,
    };
    setPending(actionState);
    setConfirmation(null);
    onError("");
    try {
      await (action === "start"
        ? controlPlaneClient.startFailureScenario(selectedRoom.id, scenario.id)
        : controlPlaneClient.recoverFailureScenario(selectedRoom.id, scenario.id));
      setAnnouncement(
        `${selectedRoom.name} ${scenario.title} ${action === "start" ? "실행" : "복구"} 요청이 접수되었습니다.`,
      );
      await refreshScenarioState(true);
    } catch (error) {
      const message = actionErrorMessage(error);
      onError(message);
      setAnnouncement(`${scenario.title} 요청 실패: ${message}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="failure-scenario-page" aria-labelledby="scenario-page-title">
      <div className="scenario-page-heading">
        <div>
          <span>FAILURE SCENARIO CONTROL</span>
          <h1 id="scenario-page-title">장애 시나리오</h1>
          <p>발표할 방을 선택하고 실제 장애를 주입한 뒤 복구 상태를 확인하세요.</p>
        </div>
        <div className={`scenario-sync-status is-${connection}`} role="status">
          <i />
          <span>{connection === "connected" ? "실시간 동기화" : connection === "connecting" ? "연결 중" : "연결 확인 필요"}</span>
        </div>
      </div>

      <div className="scenario-room-carousel" aria-label="장애 대상 게임 방">
        <button
          aria-label="이전 방 보기"
          className="scenario-carousel-arrow"
          disabled={rooms.length < 2}
          onClick={() => selectAdjacentRoom(-1)}
          type="button"
        >
          ‹
        </button>
        <div className="scenario-room-selector">
          {rooms.map((room, index) => {
            const scenarioRoom = scenarioRooms.find((state) => state.roomId === room.id);
            const active = scenarioRoom?.active;
            const counts = playerCounts(room);
            const profile = roomPressureProfile(room, scenarioRoom, index);
            const offset = cyclicOffset(index, selectedRoomIndex, rooms.length);
            const absOffset = Math.min(2, Math.abs(offset));
            const cardStyle = {
              "--offset": offset,
              "--abs-offset": absOffset,
              "--load": profile.load,
            } as ScenarioRoomCardStyle;
            return (
              <button
                aria-pressed={selectedRoomId === room.id}
                className={`${selectedRoomId === room.id ? "is-selected" : ""} ${absOffset >= 2 ? "is-far" : ""}`}
                key={room.id}
                onClick={() => {
                  setSelectedRoomId(room.id);
                  setConfirmation(null);
                }}
                style={cardStyle}
                type="button"
              >
                <span className="scenario-room-number">{String(index + 1).padStart(2, "0")}</span>
                <div className="scenario-room-copy">
                  <strong>{roomDisplayName(room)}</strong>
                  <small>{active ? scenarioLabel(active.scenarioId) : ROOM_STATUS_LABEL[room.status]}</small>
                </div>
                <div className="scenario-load-score">
                  <span>LOAD</span>
                  <strong>{profile.load}</strong>
                </div>
                <div className="scenario-room-graph" aria-hidden="true">
                  <svg viewBox="0 0 100 48" preserveAspectRatio="none">
                    <path className="scenario-graph-fill" d={profile.fillPath} />
                    <path className="scenario-graph-line" d={profile.linePath} />
                    {profile.bars.map((value, barIndex) => (
                      <rect
                        height={(value * 0.32).toFixed(1)}
                        key={`${room.id}-bar-${barIndex}`}
                        rx="1.4"
                        width="6"
                        x={(61 + barIndex * 6.4).toFixed(1)}
                        y={(46 - value * 0.32).toFixed(1)}
                      />
                    ))}
                  </svg>
                </div>
                <div className="scenario-room-problems">
                  <span><b>{profile.latency}</b>ms LAT</span>
                  <span><b>{profile.drop}</b>% DROP</span>
                  <span><b>{counts.bots}</b> BOT</span>
                  <span><b>{profile.redis}</b>/s OPS</span>
                </div>
              </button>
            );
          })}
        </div>
        <button
          aria-label="다음 방 보기"
          className="scenario-carousel-arrow"
          disabled={rooms.length < 2}
          onClick={() => selectAdjacentRoom(1)}
          type="button"
        >
          ›
        </button>
      </div>

      {!selectedRoom || !selectedCounts ? (
        <div className="scenario-empty" role="status">게임 방 상태를 불러오는 중입니다.</div>
      ) : (
        <>
          <section className="scenario-room-overview" aria-label={`${selectedRoom.name} 실시간 운영 지표`}>
            <div className="scenario-target-heading">
              <div>
                <span>SELECTED TARGET</span>
                <h2>{roomDisplayName(selectedRoom)}</h2>
                <dl className="scenario-room-identity">
                  <div>
                    <dt>Room ID</dt>
                    <dd>{roomStableId(selectedRoom)}</dd>
                  </div>
                  <div>
                    <dt>Current Pod</dt>
                    <dd title={roomCurrentPodName(selectedRoom)}>{roomPodDisplayName(selectedRoom)}</dd>
                  </div>
                  <div>
                    <dt>Pod Label</dt>
                    <dd title={roomPodLabel(selectedRoom)}>{roomPodLabel(selectedRoom)}</dd>
                  </div>
                </dl>
              </div>
              <strong className={`scenario-room-health is-${selectedRoom.status}`}>
                {ROOM_STATUS_LABEL[selectedRoom.status]}
              </strong>
            </div>
            <div className="scenario-metrics">
              <div><span>PLAYERS</span><strong>{selectedRoom.players.length}<small>/{selectedRoom.maxPlayers}</small></strong></div>
              <div className={inputRejected > 0 ? "is-danger" : ""}><span>INPUT REJECTED</span><strong>{inputRejected.toLocaleString("ko-KR")}<small> / accepted {inputAccepted.toLocaleString("ko-KR")}</small></strong></div>
              <div><span>SERVER TICK</span><strong>{selectedRoom.tickRate.toFixed(1)}<small> Hz</small></strong></div>
              <div className={admissionFailureRate >= 20 ? "is-danger" : ""}>
                <span>로비 입장 실패율</span>
                <strong>{admissionFailureRate.toFixed(1)}<small>%</small></strong>
              </div>
              <div><span>GAME CPU</span><strong>{selectedRoom.metrics.cpuPercent.toFixed(1)}<small>%</small></strong></div>
              <div><span>TELEMETRY</span><strong>{selectedRoom.metrics.telemetryLagMs.toFixed(0)}<small> ms</small></strong></div>
            </div>
            <div className="scenario-bot-state">
              <span>사용자 <strong>{selectedCounts.humans}</strong></span>
              <span>전체 봇 <strong>{selectedCounts.bots}</strong></span>
              <span>기본 유지 {selectedScenarioRoom?.minimumBotsPerRoom ?? "-"}</span>
              <span>정상 봇 <strong>{selectedScenarioRoom?.normalBots ?? "-"}</strong></span>
              <span>악성 봇 <strong>{selectedScenarioRoom?.hackBots ?? "-"}</strong></span>
              <span>입장 <strong>{selectedRoom.joinLocked ? "LOCKED" : "OPEN"}</strong></span>
            </div>
          </section>

          <div className="scenario-grid" aria-label={`${selectedRoom.name} 장애 시나리오 목록`}>
            {SCENARIOS.map((scenario) => {
              const activeForCard = activeScenario?.scenarioId === scenario.id;
              const anotherScenarioActive = Boolean(activeScenario && !activeForCard);
              const pendingForCard = pending?.scenarioId === scenario.id;
              const podCapabilityMissing = scenario.requiresPodFailure && !podFailureAvailable;
              const stateUnavailable = !selectedScenarioRoom;
              const runtimeRecoveryWaiting = Boolean(
                activeForCard &&
                (scenario.id === "process-crash" || scenario.id === "pod-failure") &&
                (selectedRoom.status !== "running" || !selectedRoom.podHealthy),
              );
              const admissionRecoveryWaiting = Boolean(
                activeForCard &&
                scenario.id === "admission-storm" &&
                (
                  evidenceNumber(activeScenario?.evidence, "failureRatePercent") >= 20
                  || activeScenario?.evidence?.incidentTriggered !== true
                ),
              );
              const recoveryReady = !runtimeRecoveryWaiting && !admissionRecoveryWaiting;
              const startDisabled = Boolean(
                pending || anotherScenarioActive || activeForCard || podCapabilityMissing
                || stateUnavailable || !roomControllable,
              );
              const result = selectedScenarioRoom?.lastResults[scenario.id];
              const confirming =
                confirmation?.roomId === selectedRoom.id &&
                confirmation.scenarioId === scenario.id;

              return (
                <article
                  className={`scenario-card tone-${scenario.tone} ${activeForCard ? "is-active" : ""} ${pendingForCard ? "is-pending" : ""}`}
                  key={scenario.id}
                >
                  <div className="scenario-card-heading">
                    <span>{scenario.code}</span>
                    <div>
                      <h3>{scenario.title}</h3>
                      <p id={`scenario-description-${scenario.id}`}>{scenario.summary}</p>
                    </div>
                    {activeForCard && (
                      <b className="scenario-active-badge">
                        <i />{STATUS_LABEL[activeScenario.status] ?? activeScenario.status}
                      </b>
                    )}
                  </div>
                  <div className="scenario-impact">
                    <div><span>EXPECTED</span><strong>{scenario.symptom}</strong></div>
                    <div><span>RECOVERY</span><strong>{scenario.recovery}</strong></div>
                  </div>

                  {activeForCard && (
                    <div className="scenario-active-detail">
                      <span>시작 {new Date(activeScenario.startedAt).toLocaleTimeString("ko-KR", { hour12: false })}</span>
                      {activeScenario.jobId && <span>JOB {activeScenario.jobId}</span>}
                      {scenario.id === "admission-storm" && (
                        <AdmissionCapacityPanel evidence={activeScenario.evidence} />
                      )}
                      <EvidenceList evidence={activeScenario.evidence} />
                    </div>
                  )}
                  {!activeForCard && result && (
                    <div className="scenario-last-result">
                      <span>최근 결과 · {new Date(result.at).toLocaleTimeString("ko-KR", { hour12: false })}</span>
                      <strong>{result.message}</strong>
                      {scenario.id === "admission-storm" && (
                        <AdmissionCapacityPanel evidence={result.evidence} />
                      )}
                      <EvidenceList evidence={result.evidence} />
                    </div>
                  )}

                  {podCapabilityMissing && (
                    <p className="scenario-unavailable">Kubernetes 배포에서만 사용할 수 있습니다.</p>
                  )}
                  {anotherScenarioActive && activeScenario && (
                    <p className="scenario-unavailable">현재 {scenarioLabel(activeScenario.scenarioId)} 시나리오가 실행 중입니다.</p>
                  )}

                  <div className="scenario-actions">
                    {activeForCard ? (
                      <button
                        className="scenario-recover-button"
                        disabled={Boolean(pending) || !recoveryReady}
                        onClick={() => void runScenarioAction(scenario, "recover")}
                        type="button"
                      >
                        {pendingForCard && pending?.action === "recover"
                          ? "복구 요청 중"
                          : scenario.id === "admission-storm"
                            ? admissionRecoveryWaiting
                              ? "40 RPS 복구 검증 대기"
                              : "복구 검증 완료"
                          : runtimeRecoveryWaiting
                            ? "런타임 자동 복구 대기"
                            : "복구 실행"}
                      </button>
                    ) : confirming ? (
                      <div className="scenario-confirmation" role="group" aria-label={`${scenario.title} 실행 확인`}>
                        <p><strong>{selectedRoom.name}</strong>에 실제로 실행할까요?</p>
                        <button onClick={() => setConfirmation(null)} type="button">취소</button>
                        <button
                          autoFocus
                          className="scenario-confirm-button"
                          onClick={() => void runScenarioAction(scenario, "start")}
                          type="button"
                        >
                          실행 확인
                        </button>
                      </div>
                    ) : (
                      <button
                        aria-describedby={`scenario-description-${scenario.id}`}
                        className="scenario-start-button"
                        disabled={startDisabled}
                        onClick={() => setConfirmation({ roomId: selectedRoom.id, scenarioId: scenario.id })}
                        type="button"
                      >
                        {pendingForCard ? "실행 요청 중" : stateUnavailable ? "상태 동기화 중" : "시나리오 실행"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <section className="scenario-event-panel" aria-labelledby="scenario-events-title">
            <div>
              <span>LIVE OPS EVENT</span>
              <h2 id="scenario-events-title">최근 운영 이벤트</h2>
            </div>
            {selectedEvents.length > 0 ? (
              <ol aria-live="polite">
                {selectedEvents.map((event) => (
                  <li className={`tone-${event.tone}`} key={event.id}>
                    <time>{event.time}</time>
                    <i />
                    <strong>{event.source}</strong>
                    <p>{event.message}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="scenario-event-empty">이 방에서 기록된 운영 이벤트가 아직 없습니다.</p>
            )}
          </section>
        </>
      )}

      <p className="scenario-announcement" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
