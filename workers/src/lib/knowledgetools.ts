/**
 * Knowledge bases, for the model-facing tools.
 *
 * The file tools work on a user's own uploads, where the only question is "is
 * this row theirs". A knowledge base is different: it can be shared, by user or
 * by group, for reading or for writing. So every lookup here goes through the
 * same `visibleResourceIdsClause` and `hasAccess` the HTTP routes use, rather
 * than a second implementation that could drift from them.
 *
 * `hasAccess` needs the caller's role, which the tool context does not carry.
 * It is loaded from D1 by primary key on demand — one indexed lookup, and it
 * cannot be stale or spoofed by a long-running job.
 */

import type { Env } from '../types';
import { hasAccess, visibleResourceIdsClause } from './access';
import { parseJSON } from './util';

export interface KnowledgeBase {
	id: string;
	user_id: string;
	name: string;
	description: string;
	updated_at: number;
}

export interface KnowledgeFile {
	id: string;
	filename: string;
	content: string;
	knowledge_id: string;
	knowledge_name: string;
}

async function callerFor(env: Env, userId: string): Promise<{ id: string; role: string }> {
	const row = await env.DB.prepare('SELECT id, role FROM user WHERE id = ?1')
		.bind(userId)
		.first<{ id: string; role: string }>();
	return { id: userId, role: row?.role ?? 'user' };
}

/** Every knowledge base the user owns or has been granted, newest first. */
export async function visibleKnowledge(env: Env, userId: string): Promise<KnowledgeBase[]> {
	const clause = await visibleResourceIdsClause(env, userId, 'knowledge');
	const { results } = await env.DB.prepare(
		`SELECT id, user_id, name, description, updated_at FROM knowledge
		 WHERE user_id = ? OR id IN (${clause.sql}) ORDER BY updated_at DESC`
	)
		.bind(userId, ...clause.bindings)
		.all<KnowledgeBase>();
	return results ?? [];
}

/** Resolves a base by name or id, but only among those the user can see. */
export async function findKnowledge(
	env: Env,
	userId: string,
	nameOrId: string
): Promise<KnowledgeBase | null> {
	const needle = nameOrId.trim().toLowerCase();
	if (!needle) return null;
	const bases = await visibleKnowledge(env, userId);
	return (
		bases.find((base) => base.id === nameOrId || base.name.toLowerCase() === needle) ??
		bases.find((base) => base.name.toLowerCase().includes(needle)) ??
		null
	);
}

export async function canWrite(env: Env, userId: string, base: KnowledgeBase): Promise<boolean> {
	return hasAccess(env, await callerFor(env, userId), 'knowledge', base.id, base.user_id, 'write');
}

/**
 * The files inside the given bases, with their text.
 *
 * Callers pass bases they have already resolved through `visibleKnowledge`, so
 * this does no access check of its own — the boundary is upstream, where the
 * base was chosen.
 */
export async function filesInKnowledge(env: Env, bases: KnowledgeBase[]): Promise<KnowledgeFile[]> {
	if (!bases.length) return [];
	const byId = new Map(bases.map((base) => [base.id, base]));
	const ids = [...byId.keys()];

	const { results } = await env.DB.prepare(
		`SELECT f.id, f.filename, f.data, k.knowledge_id FROM file f
		 JOIN knowledge_file k ON k.file_id = f.id
		 WHERE k.knowledge_id IN (${ids.map(() => '?').join(', ')})
		 ORDER BY f.created_at DESC`
	)
		.bind(...ids)
		.all<{ id: string; filename: string; data: string; knowledge_id: string }>();

	return (results ?? []).map((row) => ({
		id: row.id,
		filename: row.filename,
		content: String(parseJSON<{ content?: string }>(row.data, {}).content ?? ''),
		knowledge_id: row.knowledge_id,
		knowledge_name: byId.get(row.knowledge_id)?.name ?? ''
	}));
}

/** Adds an existing file row to a base, so a created file lands in a collection. */
export async function attachFileToKnowledge(
	env: Env,
	knowledgeId: string,
	fileId: string
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO knowledge_file (id, knowledge_id, file_id, created_at)
		 VALUES (?1, ?2, ?3, ?4)`
	)
		.bind(crypto.randomUUID(), knowledgeId, fileId, Math.floor(Date.now() / 1000))
		.run();
}
