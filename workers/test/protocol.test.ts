import { describe, expect, it } from 'vitest';
import {
	decodeEnginePacket,
	decodeSocketPacket,
	encodeAck,
	encodeConnect,
	encodeEvent,
	encodeOpen
} from '../src/socket/protocol';

describe('engine.io framing', () => {
	it('encodes the open handshake', () => {
		const frame = encodeOpen('abc', 20000, 45000);
		expect(frame[0]).toBe('0');
		const payload = JSON.parse(frame.slice(1));
		expect(payload).toMatchObject({ sid: 'abc', pingInterval: 20000, pingTimeout: 45000 });
		expect(payload.upgrades).toEqual([]);
	});

	it('splits a frame into type and payload', () => {
		expect(decodeEnginePacket('42["a",1]')).toEqual({ type: '4', payload: '2["a",1]' });
	});
});

describe('socket.io packets', () => {
	it('encodes CONNECT, EVENT and ACK', () => {
		expect(encodeConnect('sid-1')).toBe('40{"sid":"sid-1"}');
		expect(encodeEvent('events', [{ a: 1 }])).toBe('42["events",{"a":1}]');
		expect(encodeAck(7, [{ ok: true }])).toBe('437[{"ok":true}]');
	});

	it('decodes an event with an ack id', () => {
		const packet = decodeSocketPacket('212["user-join",{"auth":{"token":"t"}}]');
		expect(packet).toMatchObject({ type: 2, namespace: '/', ackId: 12 });
		expect(packet?.data).toEqual(['user-join', { auth: { token: 't' } }]);
	});

	it('decodes a connect packet carrying auth', () => {
		const packet = decodeSocketPacket('0{"token":"jwt"}');
		expect(packet?.type).toBe(0);
		expect(packet?.data).toEqual({ token: 'jwt' });
	});

	it('decodes a namespaced packet', () => {
		const packet = decodeSocketPacket('2/admin,["ping"]');
		expect(packet).toMatchObject({ type: 2, namespace: '/admin' });
		expect(packet?.data).toEqual(['ping']);
	});

	it('returns null for malformed payloads', () => {
		expect(decodeSocketPacket('2{not json')).toBeNull();
		expect(decodeSocketPacket('')).toBeNull();
	});
});
