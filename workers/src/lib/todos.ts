/**
 * A plan for the current conversation.
 *
 * Stored in `chat.meta.todos` rather than a table of its own: `meta` is already
 * a JSON blob the chat routes read-modify-write for tags and pinning, so this
 * needs no migration — which matters on a deployment where applying one is a
 * manual step.
 *
 * The trade that buys is a read-modify-write on a shared blob. Tool calls
 * within a turn are sequential, so a turn is safe; two turns running at once in
 * the *same* chat could overwrite each other's list. That is unlikely enough to
 * accept and dishonest not to state.
 */

import type { Env } from '../types';
import { getUserChat } from './chats';
import { now, parseJSON, toJSON } from './util';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
	content: string;
	status: TodoStatus;
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * Accepts what a model actually sends.
 *
 * Anything without text is dropped rather than stored as a blank row, and an
 * unrecognised status becomes `pending` — a model writing "todo" or "done"
 * should not lose the item.
 */
export function normalizeTodos(input: unknown): Todo[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item: any) => {
			const content = String(item?.content ?? item?.task ?? item ?? '').trim();
			const raw = String(item?.status ?? '').toLowerCase();
			const status: TodoStatus = STATUSES.includes(raw as TodoStatus)
				? (raw as TodoStatus)
				: raw === 'done' || raw === 'complete'
					? 'completed'
					: raw === 'doing' || raw === 'active'
						? 'in_progress'
						: 'pending';
			return { content, status };
		})
		.filter((todo) => todo.content.length > 0)
		.slice(0, 50);
}

export async function readTodos(env: Env, userId: string, chatId: string): Promise<Todo[] | null> {
	if (!chatId) return null;
	const row = await getUserChat(env, chatId, userId);
	if (!row) return null;
	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	return normalizeTodos(meta.todos);
}

/** Replaces the whole list. Returns false when the chat is not the user's, or not saved. */
export async function writeTodos(
	env: Env,
	userId: string,
	chatId: string,
	todos: Todo[]
): Promise<boolean> {
	if (!chatId) return false;
	const row = await getUserChat(env, chatId, userId);
	if (!row) return false;

	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	meta.todos = todos;
	await env.DB.prepare('UPDATE chat SET meta = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4')
		.bind(toJSON(meta), now(), chatId, userId)
		.run();
	return true;
}

const MARK: Record<TodoStatus, string> = {
	pending: '[ ]',
	in_progress: '[~]',
	completed: '[x]'
};

/** The list as the model should see it coming back. */
export const renderTodos = (todos: Todo[]): string =>
	todos.map((todo) => `${MARK[todo.status]} ${todo.content}`).join('\n');

/**
 * One line for the status strip.
 *
 * The point of a plan is that the user can see it, and a status line is the
 * only channel this port has that renders without a frontend change. It names
 * the step in flight, because that is the useful part while waiting.
 */
export function todoSummary(todos: Todo[]): string {
	if (!todos.length) return 'Cleared the plan';
	const done = todos.filter((todo) => todo.status === 'completed').length;
	const active = todos.find((todo) => todo.status === 'in_progress');
	const progress = `${done}/${todos.length}`;
	return active ? `${progress} — ${active.content}` : `Plan updated (${progress})`;
}
