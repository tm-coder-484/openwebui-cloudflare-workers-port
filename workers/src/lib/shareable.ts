/**
 * The two fields every workspace screen expects on a shareable resource.
 *
 * Models, prompts, tools, skills, knowledge bases, notes and channels are all
 * serialised with `user_id` and `access_grants`, and every screen that lists
 * them reads two more fields that no serialiser in this port was sending:
 *
 *   `write_access` — whether the caller may edit this row. Absent reads as
 *   "no", which showed the owner of a knowledge base a "Read Only" badge,
 *   rendered tool rows dimmed and unclickable, and made a workspace model
 *   refuse to open at all.
 *
 *   `user` — the author, shown next to each row. Absent, every row on five
 *   screens was labelled "Deleted User".
 *
 * Rather than add both to each of the seven serialisers — and silently regress
 * whichever one a later change forgets — they are stamped once, in the
 * middleware, onto anything shaped like a shareable resource. The shape is the
 * rule: an object carrying `access_grants` gets the fields, nothing else does.
 */

import type { Env } from '../types';
import type { AccessGrant } from './access';
import { groupIdsFor } from './access';
import { publicUser } from './users';
import type { UserRow } from './users';

type Shareable = Record<string, unknown>;

/** Every key whose value can hold more serialised resources. */
const NESTED_KEYS = ['items', 'files', 'data', 'models', 'results'];

/**
 * Collects the resources in a response body, without touching anything else.
 *
 * The depth cap is a guard against a cyclic or pathological body costing the
 * request's whole CPU budget; nothing this port serialises nests near it.
 */
export function collectShareables(value: unknown, found: Shareable[] = [], depth = 0): Shareable[] {
	if (depth > 6 || !value || typeof value !== 'object') return found;
	if (Array.isArray(value)) {
		for (const item of value) collectShareables(item, found, depth + 1);
		return found;
	}
	const record = value as Shareable;
	if (Array.isArray(record.access_grants)) found.push(record);
	for (const key of NESTED_KEYS) {
		if (record[key]) collectShareables(record[key], found, depth + 1);
	}
	return found;
}

/**
 * Decides write access from grants that are already loaded.
 *
 * `hasAccess` answers this one resource at a time, with a query per call — the
 * wrong shape for a list, where the answer is wanted for every row. The
 * caller's groups are read once and the rest is decided in memory, so a page of
 * thirty rows costs the same one query as a page of one.
 */
export function writeAccessChecker(user: { id: string; role: string }, groupIds: Set<string>) {
	return (ownerId: unknown, grants: unknown): boolean => {
		if (user.role === 'admin') return true;
		if (typeof ownerId === 'string' && ownerId === user.id) return true;
		if (!Array.isArray(grants)) return false;
		return (grants as AccessGrant[]).some((grant) => {
			if (grant?.permission !== 'write') return false;
			if (grant.principal_type === 'user')
				return grant.principal_id === user.id || grant.principal_id === '*';
			if (grant.principal_type === 'group') return groupIds.has(grant.principal_id);
			return false;
		});
	};
}

async function authorsFor(env: Env, ids: string[]): Promise<Map<string, UserRow>> {
	const byId = new Map<string, UserRow>();
	if (!ids.length) return byId;
	const { results } = await env.DB.prepare(
		`SELECT * FROM "user" WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})`
	)
		.bind(...ids)
		.all<UserRow>();
	for (const row of results ?? []) byId.set(row.id, row);
	return byId;
}

/**
 * Stamps `write_access` and `user` onto every shareable resource in a body.
 *
 * Costs two queries for the whole response — the caller's groups, and the
 * authors of every row at once — regardless of how many rows there are.
 */
export async function stampShareables(
	env: Env,
	user: { id: string; role: string },
	body: unknown
): Promise<boolean> {
	const rows = collectShareables(body);
	if (!rows.length) return false;

	const groupIds =
		user.role === 'admin' ? new Set<string>() : new Set(await groupIdsFor(env, user.id));
	const canWrite = writeAccessChecker(user, groupIds);

	const wanted = new Set<string>();
	for (const row of rows) {
		row.write_access = canWrite(row.user_id, row.access_grants);
		// A serialiser that already resolved the author wins: it may have picked a
		// different shape on purpose (a chat message's author, say).
		if (!row.user && typeof row.user_id === 'string' && row.user_id) wanted.add(row.user_id);
	}

	const authors = await authorsFor(env, [...wanted]);
	for (const row of rows) {
		if (row.user || typeof row.user_id !== 'string') continue;
		const author = authors.get(row.user_id);
		if (author) row.user = publicUser(author);
	}
	return true;
}
