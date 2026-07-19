import type { TeamMode } from "../../../shared/gameConfig";
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
    };
    zone: { x: number; y: number; radius: number; nextX: number; nextY: number; nextRadius: number };
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
}

export interface SocketClientMsg {
    type: ProcessMsgType.ClientSocketMsg;
    socketId: string;
    data: ArrayBuffer | Uint8Array;
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
    | OpsiaSaveResultMsg;
