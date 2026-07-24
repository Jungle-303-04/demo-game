import type {
  AddBotsInput,
  AddBotsResult,
  CreateRoomInput,
  ControlPlaneCapabilities,
  FailureScenarioId,
  FailureScenarioState,
  GameRoom,
  LobbyAdmissionStatus,
  OpsEvent,
  RemoveBotsResult,
  RoomCommand,
} from "./control-plane.js";
import { normalizeLobbyAdmissionStatus } from "../../src/lobby-admission.js";

interface RoomsResponse {
  rooms: GameRoom[];
  capabilities: ControlPlaneCapabilities;
  admission: LobbyAdmissionStatus;
}

interface RawRoomsResponse {
  rooms: GameRoom[];
  capabilities: ControlPlaneCapabilities;
  admission?: unknown;
}

interface RoomResponse {
  room: GameRoom;
}

interface EventsResponse {
  events: OpsEvent[];
}

export interface BotLoadStatus {
  jobId: string;
  roomId: string;
  total: number;
  completed: number;
  intervalMs: number;
  state: "running" | "completed" | "cancelled" | "failed";
  error?: string;
}

interface ApiErrorBody {
  error?: string;
  detail?: string;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ControlPlaneError(
      response.status,
      body.detail ?? body.error ?? `request_failed_${response.status}`,
    );
  }
  return body;
}

const roomPath = (roomId: string, suffix = "") =>
  `/api/admin/rooms/${encodeURIComponent(roomId)}${suffix}`;

export const controlPlaneClient = {
  async getState(compact = false): Promise<RoomsResponse> {
    const response = await request<RawRoomsResponse>(
      `/api/admin/rooms${compact ? "?compact=1" : ""}`,
    );
    return {
      ...response,
      admission: normalizeLobbyAdmissionStatus(response.admission),
    };
  },

  async listEvents(): Promise<OpsEvent[]> {
    return (await request<EventsResponse>("/api/admin/events")).events;
  },

  async getFailureScenarios(): Promise<FailureScenarioState> {
    return request<FailureScenarioState>("/api/admin/scenarios");
  },

  async startFailureScenario(
    roomId: string,
    scenarioId: FailureScenarioId,
  ): Promise<void> {
    await request(
      roomPath(roomId, `/scenarios/${encodeURIComponent(scenarioId)}/start`),
      { method: "POST" },
    );
  },

  async recoverFailureScenario(
    roomId: string,
    scenarioId: FailureScenarioId,
  ): Promise<void> {
    await request(
      roomPath(roomId, `/scenarios/${encodeURIComponent(scenarioId)}/recover`),
      { method: "POST" },
    );
  },

  async createRoom(input: CreateRoomInput): Promise<GameRoom> {
    return (
      await request<RoomResponse>("/api/admin/rooms", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).room;
  },

  async updateRoom(
    roomId: string,
    input: CreateRoomInput,
  ): Promise<GameRoom> {
    return (
      await request<RoomResponse>(roomPath(roomId), {
        method: "PATCH",
        body: JSON.stringify(input),
      })
    ).room;
  },

  async deleteRoom(roomId: string): Promise<void> {
    await request(roomPath(roomId), { method: "DELETE" });
  },

  async commandRoom(roomId: string, command: RoomCommand): Promise<void> {
    await request(roomPath(roomId, "/commands"), {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  },

  async resetRoom(roomId: string): Promise<void> {
    await request(roomPath(roomId, "/reset"), { method: "POST" });
  },

  async addBots(
    roomId: string,
    input: AddBotsInput,
  ): Promise<AddBotsResult> {
    return request<AddBotsResult>(roomPath(roomId, "/bots"), {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async cancelBotLoad(roomId: string, jobId: string): Promise<void> {
    await request(
      roomPath(roomId, `/bot-jobs/${encodeURIComponent(jobId)}/cancel`),
      { method: "POST" },
    );
  },

  async getBotLoad(roomId: string, jobId: string): Promise<BotLoadStatus> {
    return request<BotLoadStatus>(
      roomPath(roomId, `/bot-jobs/${encodeURIComponent(jobId)}`),
    );
  },

  async removeBots(roomId: string, count: number): Promise<RemoveBotsResult> {
    return request<RemoveBotsResult>(roomPath(roomId, "/bots"), {
      method: "DELETE",
      body: JSON.stringify({ count }),
    });
  },

  async setJoinLocked(roomId: string, locked: boolean): Promise<void> {
    await request(roomPath(roomId, "/join-lock"), {
      method: "PUT",
      body: JSON.stringify({ locked }),
    });
  },
};
