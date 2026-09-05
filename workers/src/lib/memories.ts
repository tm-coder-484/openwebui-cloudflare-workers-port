/**
 * Long-term memories, per user.
 *
 * The route and the model-facing tools both go through here, so there is one
 * place that knows the table and — more importantly — one place that scopes
 * every statement to a user id.
 */

import type { Env } from '../types';
import { scoreChunks } from './retrieval';
import { now, parseJSON, toJSON, uuid } from './util';

export interface MemoryRow {
	id: string;
	user_id: string;
	type: string;
	path: string | null;
	content: string;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

export const serializeMemory = (row: MemoryRow) => ({
	id: row.id,
	user_id: row.user_id,
	type: row.type,
	path: row.path,
	content: row.content,
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	created_at: row.created_at,
	updated_at: row.updated_at
});

export async function listMemories(env: Env, userId: string): Promise<MemoryRow[]> {
	const { results } = await env.DB.prepare(
		'SELECT * FROM memory WHERE user_id = ?1 ORDER BY updated_at DESC'
	)
		.bind(userId)
		.all<MemoryRow>();
	return results ?? [];
}

export async function addMemory(
	env: Env,
	userId: string,
	content: string,
	options: { type?: string; path?: string | null } = {}
): Promise<MemoryRow> {
	const id = uuid();
	const timestamp = now();
	await env.DB.prepare(
		`INSERT INTO memory (id, user_id, type, path, content, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
	)
		.bind(
			id,
			userId,
			options.type === 'user' ? 'user' : 'context',
			options.path ?? null,
			content,
			toJSON({}),
			timestamp
		)
		.run();
	return (await env.DB.prepare('SELECT * FROM memory WHERE id = ?1')
		.bind(id)
		.first<MemoryRow>()) as MemoryRow;
}

/** Keyword-ranked, the same scorer retrieval uses. */
export async function queryMemories(
	env: Env,
	userId: string,
	query: string,
	limit = 5
): Promise<MemoryRow[]> {
	const rows = await listMemories(env, userId);
	if (!rows.length) return [];
	// An empty query means "what do you know about me": the most recent wins,
	// since there is nothing to rank against.
	if (!query.trim()) return rows.slice(0, limit);

	const ranked = scoreChunks(
		query,
		rows.map((row) => ({ id: row.id, content: row.content }))
	).slice(0, limit);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const hits = ranked.map((item) => byId.get(item.id)).filter(Boolean) as MemoryRow[];
	// Nothing matched lexically: recent memories beat none at all, for the same
	// reason retrieval falls back to the opening of a document.
	return hits.length ? hits : rows.slice(0, limit);
}

export async function deleteMemory(env: Env, userId: string, id: string): Promise<boolean> {
	const row = await env.DB.prepare('SELECT id FROM memory WHERE id = ?1 AND user_id = ?2')
		.bind(id, userId)
		.first<{ id: string }>();
	if (!row) return false;
	await env.DB.prepare('DELETE FROM memory WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
	return true;
}
