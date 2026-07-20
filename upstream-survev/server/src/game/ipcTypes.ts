import type { TeamMode } from "../../../shared/gameConfig";
import type {
    ActiveReleaseRequest,
    CandidatePromoteRequest,
    CandidateSeedRequest,
    OpsiaHandoffStatusData,
} from "../opsia/candidate.ts";
import type { FindGamePrivateBody, ServerGameConfig } from "../utils/types";

export interface GameData {
    id: string;
    teamMode: TeamMode;
    mapName: string;
    canJoin: boolean;
    aliveCount: number;
    startedTime: number;
    stopped: boolean;
    timeRunning: number;
}

export interface OpsiaSnapshotData {
    roomId: string;
    capturedAt: number;
    map: {
        name: string;
        seed: number;
        width: number;
        height: number;
        shoreInset: number;
        grassInset: number;
        rivers: Array<{
            width: number;
            looped: boolean;
            points: Array<{ x: number; y: number }>;
        }>;
        places: Array<{ name: string; x: number; y: number }>;
        objects: Array<{
            id: number;
            type: string;
            kind: "building" | "structure" | "tree" | "rock" | "wall" | "obstacle";
            x: number;
            y: number;
            width: number;
            height: number;
        }>;
        navigation: Array<{
            id: number;
            x: number;
            y: number;
            width: number;
            height: number;
        }>;
    };
    zone: { x: number; y: number; radius: number; nextX: number; nextY: number; nextRadius: number };
    loot: Array<{
        id: number;
        type: string;
        kind: string;
        x: number;
        y: number;
        count: number;
    }>;
    players: Array<{
        sessionId: string;
        nickname: string;
        team: "red" | "blue";
        x: number;
        y: number;
        vx: number;
        vy: number;
        alive: boolean;
        score: number;
        rotation: number;
        health: number;
        armor: number;
        weapon: string;
        ammo: number;
        bandages?: number;
        healthkits?: number;
        isBot: boolean;
        connected: boolean;
    }>;
    tickP95Ms: number;
    tickRate: number;
    cpuPercent: number;
    memoryMb: number;
    uptimeSeconds: number;
    strictMode: boolean;
    inputAccepted: number;
    inputRejected: number;
    snapshot: {
        roomEpoch: number;
        serverTick: number;
        inflight: 0 | 1;
        pending: 0 | 1;
        payloadBytes: number;
        writeDurationMs: number;
        coalescedTotal: number;
        failuresTotal: number;
        timeoutsTotal: number;
        consecutiveFailures: number;
        circuitOpen: boolean;
        handoffEnabled: boolean;
        oldestPendingAgeMs: number;
        lastChecksum?: string;
        lastError?: string;
    };
}

export enum ProcessMsgType {
    Create,
    KeepAlive,
    UpdateData,
    AddJoinToken,
    SocketOpen,
    ClientSocketMsg,
    ServerSocketMsg,
    SocketClose,
    OpsiaSnapshot,
    OpsiaReset,
    OpsiaResetResult,
    OpsiaSave,
    OpsiaSaveResult,
    OpsiaHandoffStatus,
    OpsiaHandoffStatusResult,
    OpsiaHandoffSeed,
    OpsiaHandoffSeedResult,
    GatewayInputAck,
    OpsiaHandoffRelease,
    OpsiaHandoffReleaseResult,
    OpsiaHandoffPromote,
    OpsiaHandoffPromoteResult,
}

export interface CreateGameMsg {
    type: ProcessMsgType.Create;
    config: ServerGameConfig;
    id: string;
}

export interface KeepAliveMsg {
    type: ProcessMsgType.KeepAlive;
}

export interface UpdateDataMsg extends GameData {
    type: ProcessMsgType.UpdateData;
}

export interface AddJoinTokenMsg {
    type: ProcessMsgType.AddJoinToken;
    autoFill: boolean;
    tokens: FindGamePrivateBody["playerData"];
}

export interface SocketOpenMsg {
    type: ProcessMsgType.SocketOpen;
    socketId: string;
    ip: string;
    gatewaySessionId?: string;
    roomEpoch?: number;
}

export interface SocketClientMsg {
    type: ProcessMsgType.ClientSocketMsg;
    socketId: string;
    data: ArrayBuffer | Uint8Array;
    gatewaySessionId?: string;
    inputSequence?: number;
    clientTick?: number;
    roomEpoch?: number;
}

export interface GatewayInputAckMsg {
    type: ProcessMsgType.GatewayInputAck;
    socketId: string;
    roomEpoch: number;
    lastAckInputSequence: number;
    serverTick: number;
}

/**
 * msgs is an array to batch all msgs created in the same game net tick
 * into the same send call
 */
export interface SocketServerMsg {
    type: ProcessMsgType.ServerSocketMsg;
    msgs: Array<{
        socketId: string;
        data: ArrayBuffer | Uint8Array;
        /** Present only when the child proved it still owns this output epoch. */
        roomEpoch?: number;
        serverTick?: number;
    }>;
}

/**
 * Sent by the server to the game when the socket is closed
 * Or by the game to the server when the game wants to close the socket
 */
export interface SocketCloseMsg {
    type: ProcessMsgType.SocketClose;
    socketId: string;
    reason?: string;
    roomEpoch?: number;
    serverTick?: number;
}

export interface OpsiaSnapshotMsg {
    type: ProcessMsgType.OpsiaSnapshot;
    snapshot: OpsiaSnapshotData;
}

export interface OpsiaResetMsg {
    type: ProcessMsgType.OpsiaReset;
    requestId: string;
}

export interface OpsiaResetResultMsg {
    type: ProcessMsgType.OpsiaResetResult;
    requestId: string;
    ok: boolean;
    resetAt?: number;
    error?: string;
}

export interface OpsiaSaveMsg {
    type: ProcessMsgType.OpsiaSave;
    requestId: string;
}

export interface OpsiaSaveResultMsg {
    type: ProcessMsgType.OpsiaSaveResult;
    requestId: string;
    ok: boolean;
    savedAt?: number;
    error?: string;
}

export interface OpsiaHandoffStatusMsg {
    type: ProcessMsgType.OpsiaHandoffStatus;
    requestId: string;
}

export interface OpsiaHandoffStatusResultMsg {
    type: ProcessMsgType.OpsiaHandoffStatusResult;
    requestId: string;
    ok: boolean;
    status?: OpsiaHandoffStatusData;
    error?: string;
}

export interface OpsiaHandoffSeedMsg {
    type: ProcessMsgType.OpsiaHandoffSeed;
    requestId: string;
    request: CandidateSeedRequest;
}

export interface OpsiaHandoffSeedResultMsg {
    type: ProcessMsgType.OpsiaHandoffSeedResult;
    requestId: string;
    ok: boolean;
    status?: OpsiaHandoffStatusData;
    error?: string;
}

export interface OpsiaHandoffReleaseMsg {
    type: ProcessMsgType.OpsiaHandoffRelease;
    requestId: string;
    request: ActiveReleaseRequest;
}

export interface OpsiaHandoffReleaseResultMsg {
    type: ProcessMsgType.OpsiaHandoffReleaseResult;
    requestId: string;
    ok: boolean;
    status?: OpsiaHandoffStatusData;
    error?: string;
}

export interface OpsiaHandoffPromoteMsg {
    type: ProcessMsgType.OpsiaHandoffPromote;
    requestId: string;
    request: CandidatePromoteRequest;
}

export interface OpsiaHandoffPromoteResultMsg {
    type: ProcessMsgType.OpsiaHandoffPromoteResult;
    requestId: string;
    ok: boolean;
    status?: OpsiaHandoffStatusData;
    error?: string;
}

export type ProcessMsg =
    | CreateGameMsg
    | KeepAliveMsg
    | UpdateDataMsg
    | AddJoinTokenMsg
    | SocketOpenMsg
    | SocketClientMsg
    | SocketServerMsg
    | SocketCloseMsg
    | OpsiaSnapshotMsg
    | OpsiaResetMsg
    | OpsiaResetResultMsg
    | OpsiaSaveMsg
    | OpsiaSaveResultMsg
    | OpsiaHandoffStatusMsg
    | OpsiaHandoffStatusResultMsg
    | OpsiaHandoffSeedMsg
    | OpsiaHandoffSeedResultMsg
    | GatewayInputAckMsg
    | OpsiaHandoffReleaseMsg
    | OpsiaHandoffReleaseResultMsg
    | OpsiaHandoffPromoteMsg
    | OpsiaHandoffPromoteResultMsg;
