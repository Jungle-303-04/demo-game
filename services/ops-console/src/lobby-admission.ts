export interface LobbyAdmissionStatus {
  active: boolean;
  failureRatePercent: number;
  targetRps: number;
  requestRps: number;
  incidentTriggered: boolean;
}

export const EMPTY_LOBBY_ADMISSION_STATUS: LobbyAdmissionStatus = Object.freeze({
  active: false,
  failureRatePercent: 0,
  targetRps: 0,
  requestRps: 0,
  incidentTriggered: false,
});

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const normalizeLobbyAdmissionStatus = (
  value: unknown,
): LobbyAdmissionStatus => {
  if (!value || typeof value !== "object") return { ...EMPTY_LOBBY_ADMISSION_STATUS };
  const candidate = value as Partial<LobbyAdmissionStatus>;
  if (
    typeof candidate.active !== "boolean"
    || !finiteNumber(candidate.failureRatePercent)
    || !finiteNumber(candidate.targetRps)
    || !finiteNumber(candidate.requestRps)
    || typeof candidate.incidentTriggered !== "boolean"
  ) {
    return { ...EMPTY_LOBBY_ADMISSION_STATUS };
  }
  return {
    active: candidate.active,
    failureRatePercent: Math.min(100, Math.max(0, candidate.failureRatePercent)),
    targetRps: Math.max(0, candidate.targetRps),
    requestRps: Math.max(0, candidate.requestRps),
    incidentTriggered: candidate.incidentTriggered,
  };
};
