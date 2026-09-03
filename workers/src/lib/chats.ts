/** Chat row helpers. The conversation itself lives in the `chat` JSON column. */

import type { Env } from '../types';
import { now, parseJSON, toBool, toJSON, uuid } from './util';

export interface ChatRow {
	id: string;
	user_id: string;
	title: string;
	chat: string;
	created_at: number;
	updated_at: number;
	share_id: string | null;
	archived: number;
	pinned: number | null;
	meta: string | null;
	variables: string | null;
	folder_id: string | null;
	tasks: string | null;
	summary: string | null;
	current_message_id: string | null;
	last_read_at: number | null;
	timer_at: number | null;
}

export interface ChatMessage {
	id: string;
	parentId: string | null;
	childrenIds: string[];
	role: string;
	content: string;
	[key: string]: unknown;
}

export interface ChatContent {
	id?: string;
	title?: string;
	models?: string[];
	history?: { currentId: string | null; messages: Record<string, ChatMessage> };
	messages?: unknown[];
	files?: unknown[];
	tags?: string[];
	timestamp?: number;
	[key: string]: unknown;
}

export function serializeChat(row: ChatRow) {
	return {
		id: row.id,
		user_id: row.user_id,
		title: row.title,
		chat: parseJSON<ChatContent>(row.chat, {}),
		updated_at: row.updated_at,
		created_at: row.created_at,
		share_id: row.share_id,
		archived: toBool(row.archived),
		pinned: toBool(row.pinned),
		meta: parseJSON<Record<string, unknown>>(row.meta, {}),
		variables: parseJSON<Record<string, unknown>>(row.variables, {}),
		folder_id: row.folder_id,
		tasks: parseJSON<unknown[] | null>(row.tasks, null),
		summary: row.summary,
		current_message_id: row.current_message_id,
		last_read_at: row.last_read_at,
		timer_at: row.timer_at
	};
}

/** The compact shape used by sidebar listings. */
export function serializeChatTitleId(row: ChatRow) {
	return {
		id: row.id,
		title: row.title,
		updated_at: row.updated_at,
		created_at: row.created_at,
		last_read_at: row.last_read_at,
		pinned: toBool(row.pinned),
		archived: toBool(row.archived),
		folder_id: row.folder_id,
		active: false
	};
}

export async function getChat(env: Env, id: string): Promise<ChatRow | null> {
	return env.DB.prepare('SELECT * FROM chat WHERE id = ?1').bind(id).first<ChatRow>();
}

export async function getUserChat(env: Env, id: string, userId: string): Promise<ChatRow | null> {
	return env.DB.prepare('SELECT * FROM chat WHERE id = ?1 AND user_id = ?2')
		.bind(id, userId)
		.first<ChatRow>();
}

export async function insertChat(
	env: Env,
	userId: string,
	content: ChatContent,
	options: { id?: string; folderId?: string | null; variables?: Record<string, unknown> } = {}
): Promise<ChatRow> {
	const id = options.id ?? content.id ?? uuid();
	const timestamp = now();
	const title = (content.title as string) || 'New Chat';
	await env.DB.prepare(
		`INSERT INTO chat (id, user_id, title, chat, created_at, updated_at, archived, pinned,
			meta, variables, folder_id)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, 0, ?6, ?7, ?8)`
	)
		.bind(
			id,
			userId,
			title,
			toJSON({ ...content, id }),
			timestamp,
			toJSON({}),
			toJSON(options.variables ?? {}),
			options.folderId ?? null
		)
		.run();
	const row = await getChat(env, id);
	if (!row) throw new Error('Failed to create chat');
	return row;
}

export async function updateChatContent(
	env: Env,
	id: string,
	content: ChatContent,
	extra: Partial<Record<'title' | 'summary' | 'current_message_id', string | null>> = {}
): Promise<ChatRow | null> {
	const assignments = ['chat = ?1', 'updated_at = ?2'];
	const bindings: unknown[] = [toJSON(content), now()];

	const title = extra.title ?? (content.title as string | undefined);
	if (title !== undefined) {
		bindings.push(title);
		assignments.push(`title = ?${bindings.length}`);
	}
	if (extra.summary !== undefined) {
		bindings.push(extra.summary);
		assignments.push(`summary = ?${bindings.length}`);
	}
	if (extra.current_message_id !== undefined) {
		bindings.push(extra.current_message_id);
		assignments.push(`current_message_id = ?${bindings.length}`);
	}
	bindings.push(id);

	await env.DB.prepare(`UPDATE chat SET ${assignments.join(', ')} WHERE id = ?${bindings.length}`)
		.bind(...bindings)
		.run();
	return getChat(env, id);
}

/** Linear path from the root to `currentId`, mirroring the frontend helper. */
export function createMessagesList(
	history: { currentId: string | null; messages: Record<string, ChatMessage> },
	messageId: string | null
): ChatMessage[] {
	if (!messageId || !history?.messages?.[messageId]) return [];
	const message = history.messages[messageId];
	const parents = message.parentId ? createMessagesList(history, message.parentId) : [];
	return [...parents, message];
}

/** Merge a partial message into the chat's history (upstream: upsert_message_to_chat). */
export async function upsertMessage(
	env: Env,
	chatId: string,
	messageId: string,
	patch: Record<string, unknown>
): Promise<void> {
	const row = await getChat(env, chatId);
	if (!row) return;
	const content = parseJSON<ChatContent>(row.chat, {});
	const history = content.history ?? { currentId: null, messages: {} };
	const existing = history.messages[messageId] ?? {
		id: messageId,
		parentId: null,
		childrenIds: [],
		role: 'assistant',
		content: ''
	};
	history.messages[messageId] = { ...existing, ...patch } as ChatMessage;
	if (!history.currentId) history.currentId = messageId;
	content.history = history;
	content.messages = createMessagesList(history, history.currentId);
	await updateChatContent(env, chatId, content, { current_message_id: history.currentId });
}

export async function getMessage(
	env: Env,
	chatId: string,
	messageId: string
): Promise<ChatMessage | null> {
	const row = await getChat(env, chatId);
	if (!row) return null;
	const content = parseJSON<ChatContent>(row.chat, {});
	return content.history?.messages?.[messageId] ?? null;
}

export async function setChatTitle(env: Env, chatId: string, title: string): Promise<void> {
	const row = await getChat(env, chatId);
	if (!row) return;
	const content = parseJSON<ChatContent>(row.chat, {});
	content.title = title;
	await env.DB.prepare('UPDATE chat SET title = ?1, chat = ?2, updated_at = ?3 WHERE id = ?4')
		.bind(title, toJSON(content), now(), chatId)
		.run();
}

export async function setChatTags(
	env: Env,
	chatId: string,
	userId: string,
	tags: string[]
): Promise<void> {
	const row = await getChat(env, chatId);
	if (!row) return;
	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	const existing = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
	const merged = [...new Set([...existing, ...tags])];
	meta.tags = merged;
	await env.DB.prepare('UPDATE chat SET meta = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(toJSON(meta), now(), chatId)
		.run();

	const statements = merged.map((tag) =>
		env.DB.prepare(
			'INSERT OR IGNORE INTO tag (id, user_id, name, meta) VALUES (?1, ?2, ?3, ?4)'
		).bind(tag.replace(/\s+/g, '_').toLowerCase(), userId, tag, toJSON({}))
	);
	if (statements.length) await env.DB.batch(statements);
}
