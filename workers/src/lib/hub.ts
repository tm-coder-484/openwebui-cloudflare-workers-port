/** Thin client for the SocketHub Durable Object. */

import type { Env } from '../types';
import type { CompletionJob } from './completions';

const HUB_NAME = 'hub';

export function hubStub(env: Env): DurableObjectStub {
	return env.SOCKET.get(env.SOCKET.idFromName(HUB_NAME));
}

export async function emitToRoom(
	env: Env,
	room: string,
	event: string,
	args: unknown[]
): Promise<void> {
	try {
		await hubStub(env).fetch('https://hub/emit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ room, event, args })
		});
	} catch (error) {
		console.warn('[open-webui] socket emit failed:', error);
	}
}

export const emitToUser = (env: Env, userId: string, event: string, args: unknown[]) =>
	emitToRoom(env, `user:${userId}`, event, args);

export const emitToChannel = (env: Env, channelId: string, event: string, args: unknown[]) =>
	emitToRoom(env, `channel:${channelId}`, event, args);

export async function startCompletion(env: Env, job: CompletionJob): Promise<void> {
	await hubStub(env).fetch('https://hub/completion', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(job)
	});
}

export async function hubStats(
	env: Env
): Promise<{ sessions: number; users: number; models_in_use: string[] }> {
	try {
		const response = await hubStub(env).fetch('https://hub/stats');
		return (await response.json()) as { sessions: number; users: number; models_in_use: string[] };
	} catch {
		return { sessions: 0, users: 0, models_in_use: [] };
	}
}
