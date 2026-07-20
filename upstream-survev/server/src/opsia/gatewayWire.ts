const MAGIC = 0x4f505349; // "OPSI"
const VERSION = 1;
const HEADER_BYTES = 24;

export type GatewayWireFrame = GatewayInputFrame | GatewayAckFrame | GatewayOutputFrame;

export interface GatewayInputFrame {
    kind: "input";
    roomEpoch: number;
    inputSequence: number;
    clientTick: number;
    payload: Uint8Array;
}

export interface GatewayAckFrame {
    kind: "ack";
    roomEpoch: number;
    lastAckInputSequence: number;
    serverTick: number;
}

export interface GatewayOutputFrame {
    kind: "output";
    roomEpoch: number;
    serverTick: number;
    payload: Uint8Array;
}

const safeUint32 = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${name}_invalid`);
    return value;
};

const safeSequence = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_invalid`);
    return value;
};

const header = (
    kind: 1 | 2 | 3,
    roomEpoch: number,
    sequence: number,
    tick: number,
    payloadBytes = 0,
): Uint8Array => {
    const encoded = new Uint8Array(HEADER_BYTES + payloadBytes);
    const view = new DataView(encoded.buffer);
    view.setUint32(0, MAGIC);
    view.setUint8(4, VERSION);
    view.setUint8(5, kind);
    view.setUint16(6, 0);
    view.setUint32(8, safeUint32(roomEpoch, "gateway_room_epoch"));
    view.setBigUint64(12, BigInt(safeSequence(sequence, "gateway_input_sequence")));
    view.setUint32(20, safeUint32(tick, "gateway_tick"));
    return encoded;
};

export const encodeGatewayInput = (input: {
    roomEpoch: number;
    inputSequence: number;
    clientTick: number;
    payload: ArrayBuffer | Uint8Array;
}): Uint8Array => {
    const payload = input.payload instanceof Uint8Array
        ? Uint8Array.from(input.payload)
        : new Uint8Array(input.payload.slice(0));
    const encoded = header(1, input.roomEpoch, input.inputSequence, input.clientTick, payload.byteLength);
    encoded.set(payload, HEADER_BYTES);
    return encoded;
};

export const encodeGatewayAck = (ack: {
    roomEpoch: number;
    lastAckInputSequence: number;
    serverTick: number;
}): Uint8Array => header(2, ack.roomEpoch, ack.lastAckInputSequence, ack.serverTick);

export const encodeGatewayOutput = (output: {
    roomEpoch: number;
    serverTick: number;
    payload: ArrayBuffer | Uint8Array;
}): Uint8Array => {
    const payload = output.payload instanceof Uint8Array
        ? Uint8Array.from(output.payload)
        : new Uint8Array(output.payload.slice(0));
    const encoded = header(3, output.roomEpoch, 0, output.serverTick, payload.byteLength);
    encoded.set(payload, HEADER_BYTES);
    return encoded;
};

export const decodeGatewayFrame = (value: ArrayBuffer | Uint8Array): GatewayWireFrame | undefined => {
    const bytes = value instanceof Uint8Array
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    if (bytes.byteLength < HEADER_BYTES) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== MAGIC) return undefined;
    if (view.getUint8(4) !== VERSION || view.getUint16(6) !== 0) throw new Error("gateway_wire_version_invalid");
    const kind = view.getUint8(5);
    const roomEpoch = view.getUint32(8);
    const sequence = Number(view.getBigUint64(12));
    const tick = view.getUint32(20);
    if (!Number.isSafeInteger(sequence)) throw new Error("gateway_input_sequence_invalid");
    if (kind === 1) {
        return {
            kind: "input",
            roomEpoch,
            inputSequence: sequence,
            clientTick: tick,
            payload: Uint8Array.from(bytes.subarray(HEADER_BYTES)),
        };
    }
    if (kind === 2 && bytes.byteLength === HEADER_BYTES) {
        return {
            kind: "ack",
            roomEpoch,
            lastAckInputSequence: sequence,
            serverTick: tick,
        };
    }
    if (kind === 3) {
        return {
            kind: "output",
            roomEpoch,
            serverTick: tick,
            payload: Uint8Array.from(bytes.subarray(HEADER_BYTES)),
        };
    }
    throw new Error("gateway_wire_kind_invalid");
};

export const isGatewayWireFrame = (value: ArrayBuffer | Uint8Array): boolean => {
    const bytes = value instanceof Uint8Array
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    return bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === MAGIC;
};
