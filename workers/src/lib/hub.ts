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

/**
 * The turns still running for a chat, as the object running them sees it.
 *
 * An empty list is a real answer — the turn finished — so a failure to reach
 * the hub must not look like one. It returns null instead, and the caller says
 * so rather than telling a reloading page the answer has arrived.
 */
export async function runningTasks(
	env: Env,
	chatId: string,
	userId: string
): Promise<string[] | null> {
	try {
		const response = await hubStub(env).fetch(
			`https://hub/tasks?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`
		);
		const body = (await response.json()) as { task_ids?: string[] };
		return body.task_ids ?? [];
	} catch (error) {
		console.warn('[open-webui] could not read running tasks:', error);
		return null;
	}
}

/**
 * Stops running turns: one by task id, or every turn of a chat.
 *
 * Returns the ids that were actually stopped, which is empty when the turn had
 * already finished — a Stop pressed a moment too late is not an error.
 */
export async function stopTasks(
	env: Env,
	userId: string,
	target: { taskId?: string; chatId?: string }
): Promise<string[]> {
	try {
		const response = await hubStub(env).fetch('https://hub/tasks/stop', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId, ...target })
		});
		const body = (await response.json()) as { task_ids?: string[] };
		return body.task_ids ?? [];
	} catch (error) {
		console.warn('[open-webui] could not stop tasks:', error);
		return [];
	}
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
