/**
 * SocketHub — the realtime backbone.
 *
 * A single Durable Object instance owns every WebSocket, which keeps rooms and
 * fan-out trivial (no cross-object coordination). It speaks enough Socket.IO to
 * satisfy the Open WebUI client, and it also runs chat completions: the socket
 * that will receive the tokens already lives here, so streaming never has to
 * hop between objects.
 */

import type { Env } from '../types';
import { resolveToken } from '../lib/auth';
import { hasPermission } from '../lib/permissions';
import { runCompletion, type CompletionJob } from '../lib/completions';
import { touchLastActive } from '../lib/users';
import { now, uuid } from '../lib/util';
import {
	EIO,
	SIO,
	decodeEnginePacket,
	decodeSocketPacket,
	encodeAck,
	encodeConnect,
	encodeConnectError,
	encodeEvent,
	encodeOpen
} from './protocol';

const PING_INTERVAL_MS = 20_000;
const PING_TIMEOUT_MS = 45_000;
const MAX_DOC_UPDATES = 500;

interface Session {
	sid: string;
	socket: WebSocket;
	userId: string | null;
	userName: string | null;
	userRole: string | null;
	rooms: Set<string>;
	lastSeen: number;
	connected: boolean;
}

export class SocketHub implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private sessions = new Map<string, Session>();
	private rooms = new Map<string, Set<string>>();
	private usage = new Map<string, Map<string, number>>();
	/**
	 * The turns running right now, by task id.
	 *
	 * This object is the one that runs them, so it is the only place that knows.
	 * Keeping it here rather than in a table means there is nothing to clean up
	 * and nothing to go stale: if the object is gone the turns are gone with it,
	 * which is the true answer.
	 */
	private running = new Map<string, { chatId: string; userId: string; stop: AbortController }>();
	private docUpdates = new Map<string, unknown[]>();
	private pinging = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/connect') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket upgrade', { status: 426 });
			}
			return this.handleUpgrade(url);
		}

		if (url.pathname === '/emit' && request.method === 'POST') {
			const { room, event, args } = (await request.json()) as {
				room: string;
				event: string;
				args: unknown[];
			};
			this.emitToRoom(room, event, args ?? []);
			return Response.json({ status: true });
		}

		if (url.pathname === '/completion' && request.method === 'POST') {
			const job = (await request.json()) as CompletionJob;
			// Deliberately not awaited: the HTTP caller gets its task id back
			// immediately while tokens keep flowing over the socket.
			this.startCompletion(job);
			return Response.json({ status: true, task_id: job.taskId });
		}

		// Which turns are still running for a chat. The frontend asks after a
		// reload: an answer of "none" means the turn finished while the page was
		// away and the chat should be reloaded to pick up its ending.
		if (url.pathname === '/tasks') {
			const chatId = url.searchParams.get('chat_id');
			const userId = url.searchParams.get('user_id');
			const taskIds = [...this.running.entries()]
				.filter(([, task]) => task.chatId === chatId && task.userId === userId)
				.map(([taskId]) => taskId);
			return Response.json({ task_ids: taskIds });
		}

		// Stop a turn: by task id, or every turn of one chat, which is what the
		// Stop button sends. Only the user who started it may stop it.
		if (url.pathname === '/tasks/stop' && request.method === 'POST') {
			const { taskId, chatId, userId } = (await request.json()) as {
				taskId?: string;
				chatId?: string;
				userId: string;
			};
			const stopped: string[] = [];
			for (const [id, task] of this.running) {
				if (task.userId !== userId) continue;
				if (taskId ? id !== taskId : task.chatId !== chatId) continue;
				task.stop.abort();
				stopped.push(id);
			}
			return Response.json({ task_ids: stopped });
		}

		if (url.pathname === '/stats') {
			return Response.json({
				sessions: this.sessions.size,
				users: new Set([...this.sessions.values()].map((s) => s.userId).filter(Boolean)).size,
				models_in_use: [...this.usage.keys()]
			});
		}

		return new Response('Not found', { status: 404 });
	}

	private handleUpgrade(url: URL): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.accept();

		const sid = uuid().replace(/-/g, '').slice(0, 20);
		const session: Session = {
			sid,
			socket: server,
			userId: null,
			userName: null,
			userRole: null,
			rooms: new Set(),
			lastSeen: Date.now(),
			connected: false
		};
		this.sessions.set(sid, session);

		// A token on the handshake query means we can authenticate before the
		// Socket.IO CONNECT packet arrives.
		const queryToken = url.searchParams.get('token');

		server.addEventListener('message', (event) => {
			const data = typeof event.data === 'string' ? event.data : '';
			if (!data) return;
			this.onFrame(session, data).catch((error) =>
				console.error('[open-webui] socket frame error', error)
			);
		});
		server.addEventListener('close', () => this.dropSession(sid));
		server.addEventListener('error', () => this.dropSession(sid));

		this.send(session, encodeOpen(sid, PING_INTERVAL_MS, PING_TIMEOUT_MS));
		this.schedulePing();

		if (queryToken) {
			this.authenticate(session, queryToken).catch(() => {});
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	private async onFrame(session: Session, frame: string): Promise<void> {
		session.lastSeen = Date.now();
		const { type, payload } = decodeEnginePacket(frame);

		if (type === EIO.PING) {
			this.send(session, EIO.PONG);
			return;
		}
		if (type === EIO.PONG) return;
		if (type === EIO.CLOSE) {
			this.dropSession(session.sid);
			return;
		}
		if (type !== EIO.MESSAGE) return;

		const packet = decodeSocketPacket(payload);
		if (!packet) return;

		if (packet.type === SIO.CONNECT) {
			const auth = (packet.data ?? {}) as { token?: string };
			if (auth?.token) await this.authenticate(session, auth.token);
			if (session.userId || !auth?.token) {
				session.connected = true;
				this.send(session, encodeConnect(session.sid, packet.namespace));
			} else {
				this.send(session, encodeConnectError('Invalid token', packet.namespace));
			}
			return;
		}

		if (packet.type === SIO.DISCONNECT) {
			this.dropSession(session.sid);
			return;
		}

		if (packet.type === SIO.EVENT && Array.isArray(packet.data)) {
			const [event, ...args] = packet.data as [string, ...unknown[]];
			const result = await this.dispatch(session, event, args[0] ?? {});
			if (packet.ackId !== undefined) {
				this.send(session, encodeAck(packet.ackId, result === undefined ? [] : [result]));
			}
		}
	}

	private async authenticate(session: Session, token: string): Promise<void> {
		const user = await resolveToken(this.env, token).catch(() => null);
		if (!user || (user.role !== 'user' && user.role !== 'admin')) return;
		session.userId = user.id;
		session.userName = user.name;
		session.userRole = user.role;
		this.join(session, `user:${user.id}`);
	}

	private async dispatch(session: Session, event: string, data: any): Promise<unknown> {
		switch (event) {
			case 'user-join': {
				const token = data?.auth?.token;
				if (token) await this.authenticate(session, token);
				if (!session.userId) return undefined;
				await this.joinChannels(session);
				return { id: session.userId, name: session.userName };
			}

			case 'join-channels': {
				const token = data?.auth?.token;
				if (token && !session.userId) await this.authenticate(session, token);
				if (session.userId) await this.joinChannels(session);
				return undefined;
			}

			case 'join-note': {
				const token = data?.auth?.token;
				if (token && !session.userId) await this.authenticate(session, token);
				if (session.userId && data?.note_id) this.join(session, `note:${data.note_id}`);
				return undefined;
			}

			case 'heartbeat': {
				if (session.userId) {
					session.lastSeen = Date.now();
					await touchLastActive(this.env, session.userId).catch(() => {});
				}
				return undefined;
			}

			case 'usage': {
				if (!session.userId || !data?.model) return undefined;
				const model = String(data.model);
				const sids = this.usage.get(model) ?? new Map<string, number>();
				sids.set(session.sid, now());
				this.usage.set(model, sids);
				return undefined;
			}

			case 'events:chat': {
				if (!session.userId) return undefined;
				if (data?.data?.type === 'last_read_at' && data?.chat_id) {
					const timestamp = now();
					await this.env.DB.prepare(
						'UPDATE chat SET last_read_at = ?1 WHERE id = ?2 AND user_id = ?3'
					)
						.bind(timestamp, data.chat_id, session.userId)
						.run()
						.catch(() => {});
					this.emitToRoom(`user:${session.userId}`, 'events', [
						{
							chat_id: data.chat_id,
							data: { type: 'chat:list', data: { chat_id: data.chat_id, last_read_at: timestamp } }
						}
					]);
				}
				return undefined;
			}

			case 'events:channel': {
				if (!session.userId || !data?.channel_id) return undefined;
				const room = `channel:${data.channel_id}`;
				if (!session.rooms.has(room)) return undefined;
				if (data?.data?.type === 'typing') {
					this.emitToRoom(room, 'events:channel', [
						{
							channel_id: data.channel_id,
							message_id: data.message_id ?? null,
							data: data.data,
							user: { id: session.userId, name: session.userName }
						}
					]);
				} else if (data?.data?.type === 'last_read_at') {
					await this.env.DB.prepare(
						'UPDATE channel_member SET updated_at = ?1 WHERE channel_id = ?2 AND user_id = ?3'
					)
						.bind(now(), data.channel_id, session.userId)
						.run()
						.catch(() => {});
				}
				return undefined;
			}

			// --- Collaborative notes (Yjs relay) ---
			case 'ydoc:document:join': {
				if (!session.userId || !data?.document_id) return undefined;
				const documentId = normalizeDocumentId(String(data.document_id));
				const room = `doc:${documentId}`;
				this.join(session, room);
				for (const update of this.docUpdates.get(documentId) ?? []) {
					this.send(
						session,
						encodeEvent('ydoc:document:update', [
							{ document_id: data.document_id, socket_id: null, update }
						])
					);
				}
				this.send(
					session,
					encodeEvent('ydoc:document:state', [
						{
							document_id: data.document_id,
							state: [0, 0],
							sessions: [...(this.rooms.get(room) ?? [])]
						}
					])
				);
				return undefined;
			}

			case 'ydoc:document:state': {
				if (!data?.document_id) return undefined;
				const documentId = normalizeDocumentId(String(data.document_id));
				const room = `doc:${documentId}`;
				this.send(
					session,
					encodeEvent('ydoc:document:state', [
						{
							document_id: data.document_id,
							state: [0, 0],
							sessions: [...(this.rooms.get(room) ?? [])]
						}
					])
				);
				return undefined;
			}

			case 'ydoc:document:update': {
				if (!session.userId || !data?.document_id || !data?.update) return undefined;
				const documentId = normalizeDocumentId(String(data.document_id));
				const stored = this.docUpdates.get(documentId) ?? [];
				stored.push(data.update);
				if (stored.length > MAX_DOC_UPDATES) stored.splice(0, stored.length - MAX_DOC_UPDATES);
				this.docUpdates.set(documentId, stored);
				this.emitToRoom(
					`doc:${documentId}`,
					'ydoc:document:update',
					[
						{
							document_id: data.document_id,
							socket_id: data.socket_id ?? session.sid,
							update: data.update
						}
					],
					session.sid
				);
				return undefined;
			}

			case 'ydoc:awareness:update': {
				if (!session.userId || !data?.document_id) return undefined;
				const documentId = normalizeDocumentId(String(data.document_id));
				this.emitToRoom(
					`doc:${documentId}`,
					'ydoc:awareness:update',
					[{ document_id: data.document_id, socket_id: session.sid, update: data.update }],
					session.sid
				);
				return undefined;
			}

			case 'ydoc:document:leave': {
				if (!data?.document_id) return undefined;
				this.leave(session, `doc:${normalizeDocumentId(String(data.document_id))}`);
				return undefined;
			}

			default:
				return undefined;
		}
	}

	private async joinChannels(session: Session): Promise<void> {
		if (!session.userId) return;
		const allowed =
			session.userRole === 'admin' ||
			(await hasPermission(
				this.env,
				{ id: session.userId, role: session.userRole ?? 'user' },
				'features.channels'
			).catch(() => false));
		if (!allowed) return;

		const { results } = await this.env.DB.prepare(
			`SELECT DISTINCT c.id AS id FROM channel c
			 LEFT JOIN channel_member m ON m.channel_id = c.id AND m.user_id = ?1
			 LEFT JOIN access_grant g ON g.resource_type = 'channel' AND g.resource_id = c.id
			 WHERE c.deleted_at IS NULL AND (
				c.user_id = ?1 OR m.user_id IS NOT NULL
				OR (g.principal_type = 'user' AND g.principal_id IN (?1, '*'))
			 )`
		)
			.bind(session.userId)
			.all<{ id: string }>()
			.catch(() => ({ results: [] as { id: string }[] }));

		for (const row of results ?? []) this.join(session, `channel:${row.id}`);
	}

	private startCompletion(job: CompletionJob): void {
		const stop = new AbortController();
		this.running.set(job.taskId, { chatId: job.chatId, userId: job.userId, stop });
		const promise = runCompletion(
			this.env,
			job,
			(event) => {
				this.emitToRoom(`user:${job.userId}`, 'events', [event]);
			},
			stop.signal
		)
			.catch((error) => console.error('[open-webui] completion job failed', error))
			// A failed turn is a finished turn: leaving it registered would tell a
			// reloading page to wait for tokens that are never coming.
			.finally(() => this.running.delete(job.taskId));
		// Keeping the promise on the state extends the object's lifetime until
		// the stream finishes, even if every socket disconnects mid-flight.
		this.state.waitUntil?.(promise);
	}

	private join(session: Session, room: string): void {
		session.rooms.add(room);
		const members = this.rooms.get(room) ?? new Set<string>();
		members.add(session.sid);
		this.rooms.set(room, members);
	}

	private leave(session: Session, room: string): void {
		session.rooms.delete(room);
		const members = this.rooms.get(room);
		if (!members) return;
		members.delete(session.sid);
		if (!members.size) this.rooms.delete(room);
	}

	emitToRoom(room: string, event: string, args: unknown[], exceptSid?: string): void {
		const frame = encodeEvent(event, args);
		for (const sid of this.rooms.get(room) ?? []) {
			if (sid === exceptSid) continue;
			const session = this.sessions.get(sid);
			if (session) this.send(session, frame);
		}
	}

	private send(session: Session, frame: string): void {
		try {
			session.socket.send(frame);
		} catch {
			this.dropSession(session.sid);
		}
	}

	private dropSession(sid: string): void {
		const session = this.sessions.get(sid);
		if (!session) return;
		for (const room of session.rooms) {
			const members = this.rooms.get(room);
			if (!members) continue;
			members.delete(sid);
			if (!members.size) this.rooms.delete(room);
		}
		for (const [model, sids] of this.usage) {
			sids.delete(sid);
			if (!sids.size) this.usage.delete(model);
		}
		this.sessions.delete(sid);
		try {
			session.socket.close(1000, 'closed');
		} catch {
			// already closed
		}
	}

	/**
	 * Engine.IO v4 makes the *server* send heartbeats; without them the client
	 * tears the connection down with "ping timeout" after ~pingInterval.
	 */
	private schedulePing(): void {
		if (this.pinging) return;
		this.pinging = true;
		const tick = () => {
			if (!this.sessions.size) {
				this.pinging = false;
				return;
			}
			const cutoff = Date.now() - PING_TIMEOUT_MS;
			for (const session of [...this.sessions.values()]) {
				if (session.lastSeen < cutoff) {
					this.dropSession(session.sid);
					continue;
				}
				this.send(session, EIO.PING);
			}
			if (this.sessions.size) {
				setTimeout(tick, PING_INTERVAL_MS);
			} else {
				this.pinging = false;
			}
		};
		setTimeout(tick, PING_INTERVAL_MS);
	}
}

/** YdocManager stores `note:x` as `note_x`; normalize back for room keys. */
function normalizeDocumentId(documentId: string): string {
	return documentId.startsWith('note_') ? `note:${documentId.slice(5)}` : documentId;
}
