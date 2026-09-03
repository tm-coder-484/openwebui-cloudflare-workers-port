/** Group permission resolution — mirrors utils/access_control.get_permissions. */

import type { Env } from '../types';
import { getUserPermissions } from './config';
import { getPath, parseJSON } from './util';

async function groupPermissionsFor(env: Env, userId: string): Promise<Record<string, any>[]> {
	const { results } = await env.DB.prepare(
		'SELECT g.permissions AS permissions FROM "group" g ' +
			'JOIN group_member m ON m.group_id = g.id WHERE m.user_id = ?1'
	)
		.bind(userId)
		.all<{ permissions: string | null }>();
	return (results ?? []).map((row) => parseJSON<Record<string, any>>(row.permissions, {}));
}

/** Most-permissive merge: `true` from any group wins over the default. */
function combine(base: Record<string, any>, extra: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = { ...base };
	for (const [key, value] of Object.entries(extra ?? {})) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			out[key] = combine(typeof out[key] === 'object' && out[key] ? out[key] : {}, value);
		} else {
			out[key] = out[key] || value;
		}
	}
	return out;
}

export async function resolvePermissions(env: Env, userId: string): Promise<Record<string, any>> {
	let permissions = structuredClone(await getUserPermissions(env));
	for (const groupPermissions of await groupPermissionsFor(env, userId)) {
		permissions = combine(permissions, groupPermissions);
	}
	return permissions;
}

/** `has(env, user, 'workspace.models')` — admins always pass. */
export async function hasPermission(
	env: Env,
	user: { id: string; role: string },
	key: string
): Promise<boolean> {
	if (user.role === 'admin') return true;
	const permissions = await resolvePermissions(env, user.id);
	return Boolean(getPath(permissions, key));
}
