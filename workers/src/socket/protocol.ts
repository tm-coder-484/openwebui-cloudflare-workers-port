/**
 * Minimal Engine.IO v4 + Socket.IO v5 codec.
 *
 * Only what the Open WebUI frontend actually uses: the default namespace, the
 * WebSocket transport, string payloads, and optional acks. Binary attachments
 * (packet types 5/6) are not produced by the client, so they are rejected
 * rather than half-supported.
 */

export const EIO = {
	OPEN: '0',
	CLOSE: '1',
	PING: '2',
	PONG: '3',
	MESSAGE: '4'
} as const;

export const SIO = {
	CONNECT: 0,
	DISCONNECT: 1,
	EVENT: 2,
	ACK: 3,
	CONNECT_ERROR: 4
} as const;

export interface SocketPacket {
	type: number;
	namespace: string;
	ackId?: number;
	data?: unknown;
}

export function encodeOpen(sid: string, pingInterval = 25_000, pingTimeout = 20_000): string {
	return (
		EIO.OPEN +
		JSON.stringify({
			sid,
			upgrades: [],
			pingInterval,
			pingTimeout,
			maxPayload: 1_000_000
		})
	);
}

export function encodeConnect(sid: string, namespace = '/'): string {
	const ns = namespace === '/' ? '' : `${namespace},`;
	return `${EIO.MESSAGE}${SIO.CONNECT}${ns}${JSON.stringify({ sid })}`;
}

export function encodeConnectError(message: string, namespace = '/'): string {
	const ns = namespace === '/' ? '' : `${namespace},`;
	return `${EIO.MESSAGE}${SIO.CONNECT_ERROR}${ns}${JSON.stringify({ message })}`;
}

export function encodeEvent(event: string, args: unknown[], namespace = '/'): string {
	const ns = namespace === '/' ? '' : `${namespace},`;
	return `${EIO.MESSAGE}${SIO.EVENT}${ns}${JSON.stringify([event, ...args])}`;
}

export function encodeAck(ackId: number, args: unknown[], namespace = '/'): string {
	const ns = namespace === '/' ? '' : `${namespace},`;
	return `${EIO.MESSAGE}${SIO.ACK}${ns}${ackId}${JSON.stringify(args)}`;
}

export function encodeDisconnect(namespace = '/'): string {
	const ns = namespace === '/' ? '' : `${namespace},`;
	return `${EIO.MESSAGE}${SIO.DISCONNECT}${ns}`;
}

/** Decodes the Socket.IO layer of an Engine.IO MESSAGE frame (leading `4`). */
export function decodeSocketPacket(payload: string): SocketPacket | null {
	if (!payload.length) return null;
	const type = Number(payload[0]);
	if (!Number.isInteger(type)) return null;

	let rest = payload.slice(1);
	let namespace = '/';
	if (rest.startsWith('/')) {
		const comma = rest.indexOf(',');
		if (comma === -1) {
			namespace = rest;
			rest = '';
		} else {
			namespace = rest.slice(0, comma);
			rest = rest.slice(comma + 1);
		}
	}

	let ackId: number | undefined;
	const digits = /^\d+/.exec(rest);
	if (digits) {
		ackId = Number(digits[0]);
		rest = rest.slice(digits[0].length);
	}

	let data: unknown = undefined;
	if (rest.length) {
		try {
			data = JSON.parse(rest);
		} catch {
			return null;
		}
	}
	return { type, namespace, ackId, data };
}

/** Splits an incoming frame into its Engine.IO type and the remaining payload. */
export function decodeEnginePacket(frame: string): { type: string; payload: string } {
	return { type: frame.slice(0, 1), payload: frame.slice(1) };
}
