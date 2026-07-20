"use client";

import {
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
  withControlPlaneAdminTokenRetry,
} from "./control-plane-client.js";

type ConnectionState = "connecting" | "connected" | "degraded";
type ScenarioTone = "warning" | "danger" | "critical";
type ScenarioAction = "start" | "recover";

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
    title: "입장 요청 폭주",
    summary: "선택한 방으로 짧은 시간에 반복 입장 요청을 보냅니다.",
    symptom: "Admission 실패율과 API 부하 상승",
    recovery: "요청 발생기를 중단하고 연결 안정화",
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
    return "관리자 토큰이 없거나 올바르지 않습니다.";
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

function playerCounts(room: GameRoom) {
  const bots = room.players.filter((player) => player.isBot).length;
  return { bots, humans: room.players.length - bots };
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
  const [selectedRoomId, setSelectedRoomId] = useState(rooms[0]?.id ?? "");
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
      const scenarioStateRequest = quiet
        ? controlPlaneClient.getFailureScenarios()
        : withControlPlaneAdminTokenRetry(() =>
            controlPlaneClient.getFailureScenarios(),
          );
      const [state, nextEvents] = await Promise.all([
        scenarioStateRequest,
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
  const roomControllable =
    selectedRoom?.status === "running" || selectedRoom?.status === "degraded";

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
      await withControlPlaneAdminTokenRetry(() =>
        action === "start"
          ? controlPlaneClient.startFailureScenario(selectedRoom.id, scenario.id)
          : controlPlaneClient.recoverFailureScenario(selectedRoom.id, scenario.id),
      );
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

      <div className="scenario-room-selector" aria-label="장애 대상 게임 방">
        {rooms.map((room, index) => {
          const scenarioRoom = scenarioRooms.find((state) => state.roomId === room.id);
          const active = scenarioRoom?.active;
          return (
            <button
              aria-pressed={selectedRoomId === room.id}
              className={selectedRoomId === room.id ? "is-selected" : ""}
              key={room.id}
              onClick={() => {
                setSelectedRoomId(room.id);
                setConfirmation(null);
              }}
              type="button"
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{room.name}</strong>
              <small>{room.map} · {room.players.length}/{room.maxPlayers}</small>
              <b className={active ? "has-active-scenario" : ""}>
                {active ? scenarioLabel(active.scenarioId) : ROOM_STATUS_LABEL[room.status]}
              </b>
            </button>
          );
        })}
      </div>

      {!selectedRoom || !selectedCounts ? (
        <div className="scenario-empty" role="status">게임 방 상태를 불러오는 중입니다.</div>
      ) : (
        <>
          <section className="scenario-room-overview" aria-label={`${selectedRoom.name} 실시간 운영 지표`}>
            <div className="scenario-target-heading">
              <div>
                <span>SELECTED TARGET</span>
                <h2>{selectedRoom.name}</h2>
                <p>{selectedRoom.id} · {selectedRoom.podName} · {selectedRoom.map}</p>
              </div>
              <strong className={`scenario-room-health is-${selectedRoom.status}`}>
                {ROOM_STATUS_LABEL[selectedRoom.status]}
              </strong>
            </div>
            <div className="scenario-metrics">
              <div><span>PLAYERS</span><strong>{selectedRoom.players.length}<small>/{selectedRoom.maxPlayers}</small></strong></div>
              <div className={inputRejected > 0 ? "is-danger" : ""}><span>INPUT REJECTED</span><strong>{inputRejected.toLocaleString("ko-KR")}<small> / accepted {inputAccepted.toLocaleString("ko-KR")}</small></strong></div>
              <div><span>SERVER TICK</span><strong>{selectedRoom.tickRate.toFixed(1)}<small> Hz</small></strong></div>
              <div><span>TICK P95</span><strong>{selectedRoom.metrics.tickP95Ms.toFixed(1)}<small> ms</small></strong></div>
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
              const automaticRecoveryWaiting = Boolean(
                activeForCard &&
                scenario.id === "admission-storm" &&
                activeScenario.autoRecoverAt &&
                Date.now() < Date.parse(activeScenario.autoRecoverAt),
              );
              const recoveryReady = !runtimeRecoveryWaiting && !automaticRecoveryWaiting;
              const startDisabled = Boolean(
                pending || anotherScenarioActive || activeForCard || podCapabilityMissing || stateUnavailable || !roomControllable,
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
                      <EvidenceList evidence={activeScenario.evidence} />
                    </div>
                  )}
                  {!activeForCard && result && (
                    <div className="scenario-last-result">
                      <span>최근 결과 · {new Date(result.at).toLocaleTimeString("ko-KR", { hour12: false })}</span>
                      <strong>{result.message}</strong>
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
                          : runtimeRecoveryWaiting
                            ? "런타임 자동 복구 대기"
                            : automaticRecoveryWaiting
                              ? "Admission 자동 복구 대기"
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
