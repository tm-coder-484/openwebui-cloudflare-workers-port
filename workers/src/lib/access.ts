/**
 * Access grants for shareable resources (models, prompts, knowledge, tools,
 * notes, channels, files). A grant is (resource, principal, permission);
 * `principal_type: 'user', principal_id: '*'` is the public marker the frontend
 * looks for.
 */

import type { Env } from '../types';
import { now, uuid } from './util';

export type Permission = 'read' | 'write';

export interface AccessGrant {
	id: string;
	resource_type: string;
	resource_id: string;
	principal_type: string;
	principal_id: string;
	permission: Permission;
	created_at: number;
}

export interface GrantInput {
	principal_type: string;
	principal_id: string;
	permission: Permission;
}

export async function listGrants(
	env: Env,
	resourceType: string,
	resourceIds: string[]
): Promise<Map<string, AccessGrant[]>> {
	const grouped = new Map<string, AccessGrant[]>();
	if (!resourceIds.length) return grouped;
	const placeholders = resourceIds.map((_, i) => `?${i + 2}`).join(', ');
	const { results } = await env.DB.prepare(
		`SELECT * FROM access_grant WHERE resource_type = ?1 AND resource_id IN (${placeholders})`
	)
		.bind(resourceType, ...resourceIds)
		.all<AccessGrant>();
	for (const grant of results ?? []) {
		const list = grouped.get(grant.resource_id) ?? [];
		list.push(grant);
		grouped.set(grant.resource_id, list);
	}
	return grouped;
}

export async function grantsFor(
	env: Env,
	resourceType: string,
	resourceId: string
): Promise<AccessGrant[]> {
	return (await listGrants(env, resourceType, [resourceId])).get(resourceId) ?? [];
}

export async function replaceGrants(
	env: Env,
	resourceType: string,
	resourceId: string,
	grants: GrantInput[]
): Promise<AccessGrant[]> {
	const statements: D1PreparedStatement[] = [
		env.DB.prepare('DELETE FROM access_grant WHERE resource_type = ?1 AND resource_id = ?2').bind(
			resourceType,
			resourceId
		)
	];
	const timestamp = now();
	const seen = new Set<string>();
	for (const grant of grants ?? []) {
		if (!grant?.principal_type || !grant?.principal_id) continue;
		const permission: Permission = grant.permission === 'write' ? 'write' : 'read';
		const key = `${grant.principal_type}:${grant.principal_id}:${permission}`;
		if (seen.has(key)) continue;
		seen.add(key);
		statements.push(
			env.DB.prepare(
				`INSERT INTO access_grant
					(id, resource_type, resource_id, principal_type, principal_id, permission, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
			).bind(uuid(), resourceType, resourceId, grant.principal_type, grant.principal_id, permission, timestamp)
		);
	}
	await env.DB.batch(statements);
	return grantsFor(env, resourceType, resourceId);
}

export async function deleteGrants(
	env: Env,
	resourceType: string,
	resourceId: string
): Promise<void> {
	await env.DB.prepare('DELETE FROM access_grant WHERE resource_type = ?1 AND resource_id = ?2')
		.bind(resourceType, resourceId)
		.run();
}

export const isPublic = (grants: AccessGrant[] | undefined): boolean =>
	(grants ?? []).some(
		(g) => g.principal_type === 'user' && g.principal_id === '*' && g.permission === 'read'
	);

export async function groupIdsFor(env: Env, userId: string): Promise<string[]> {
	const { results } = await env.DB.prepare('SELECT group_id FROM group_member WHERE user_id = ?1')
		.bind(userId)
		.all<{ group_id: string }>();
	return (results ?? []).map((row) => row.group_id);
}

/**
 * SQL fragment selecting resource ids a user may see: their own rows plus any
 * row with a matching grant. Callers splice it into their WHERE clause.
 */
export async function visibleResourceIdsClause(
	env: Env,
	userId: string,
	resourceType: string,
	permission: Permission = 'read'
): Promise<{ sql: string; bindings: unknown[] }> {
	const groupIds = await groupIdsFor(env, userId);
	const principals: [string, string][] = [
		['user', userId],
		['user', '*']
	];
	for (const groupId of groupIds) principals.push(['group', groupId]);

	const permissions = permission === 'read' ? ['read', 'write'] : ['write'];
	const conditions: string[] = [];
	const bindings: unknown[] = [resourceType];
	for (const [type, id] of principals) {
		conditions.push(
			`(principal_type = ? AND principal_id = ? AND permission IN (${permissions
				.map(() => '?')
				.join(', ')}))`
		);
		bindings.push(type, id, ...permissions);
	}
	return {
		sql: `SELECT resource_id FROM access_grant WHERE resource_type = ? AND (${conditions.join(' OR ')})`,
		bindings
	};
}

export async function hasAccess(
	env: Env,
	user: { id: string; role: string },
	resourceType: string,
	resourceId: string,
	ownerId: string | null,
	permission: Permission = 'read'
): Promise<boolean> {
	if (user.role === 'admin') return true;
	if (ownerId && ownerId === user.id) return true;
	const grants = await grantsFor(env, resourceType, resourceId);
	if (!grants.length) return false;
	const groupIds = new Set(await groupIdsFor(env, user.id));
	return grants.some((grant) => {
		if (permission === 'write' && grant.permission !== 'write') return false;
		if (grant.principal_type === 'user') {
			return grant.principal_id === user.id || grant.principal_id === '*';
		}
		if (grant.principal_type === 'group') return groupIds.has(grant.principal_id);
		return false;
	});
}
