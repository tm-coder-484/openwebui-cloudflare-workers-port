/** User row access + serialization shared by the auth and user routes. */

import type { Env, SessionUser } from '../types';
import { now, parseJSON, toJSON, uuid } from './util';

export interface UserRow {
	id: string;
	email: string;
	username: string | null;
	role: string;
	name: string;
	profile_image_url: string | null;
	profile_banner_image_url: string | null;
	bio: string | null;
	gender: string | null;
	date_of_birth: string | null;
	timezone: string | null;
	presence_state: string | null;
	status_emoji: string | null;
	status_message: string | null;
	status_expires_at: number | null;
	info: string | null;
	variables: string | null;
	settings: string | null;
	oauth: string | null;
	scim: string | null;
	last_active_at: number;
	updated_at: number;
	created_at: number;
}

export const DEFAULT_PROFILE_IMAGE = '/user.png';

export function serializeUser(row: UserRow): SessionUser & Record<string, unknown> {
	return {
		id: row.id,
		email: row.email,
		username: row.username,
		role: row.role,
		name: row.name,
		profile_image_url: row.profile_image_url || DEFAULT_PROFILE_IMAGE,
		profile_banner_image_url: row.profile_banner_image_url,
		bio: row.bio,
		gender: row.gender,
		date_of_birth: row.date_of_birth,
		timezone: row.timezone,
		presence_state: row.presence_state,
		status_emoji: row.status_emoji,
		status_message: row.status_message,
		status_expires_at: row.status_expires_at,
		info: parseJSON<Record<string, unknown> | null>(row.info, null),
		settings: parseJSON<Record<string, unknown> | null>(row.settings, null),
		variables: parseJSON<Record<string, unknown>>(row.variables, {}),
		oauth: parseJSON<Record<string, unknown> | null>(row.oauth, null),
		last_active_at: row.last_active_at,
		updated_at: row.updated_at,
		created_at: row.created_at
	};
}

/** The trimmed shape the frontend uses for message authors and member lists. */
export function publicUser(row: UserRow) {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		role: row.role,
		profile_image_url: row.profile_image_url || DEFAULT_PROFILE_IMAGE
	};
}

export async function getUserById(env: Env, id: string): Promise<UserRow | null> {
	return env.DB.prepare('SELECT * FROM "user" WHERE id = ?1').bind(id).first<UserRow>();
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
	return env.DB.prepare('SELECT * FROM "user" WHERE email = ?1')
		.bind(email.toLowerCase())
		.first<UserRow>();
}

export async function getUserByApiKey(env: Env, key: string): Promise<UserRow | null> {
	return env.DB.prepare(
		'SELECT u.* FROM "user" u JOIN api_key k ON k.user_id = u.id WHERE k.key = ?1'
	)
		.bind(key)
		.first<UserRow>();
}

export async function countUsers(env: Env): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM "user"').first<{ count: number }>();
	return row?.count ?? 0;
}

export async function hasUsers(env: Env): Promise<boolean> {
	return (await countUsers(env)) > 0;
}

export interface NewUser {
	email: string;
	name: string;
	role?: string;
	profile_image_url?: string | null;
	id?: string;
}

export async function insertUser(env: Env, data: NewUser): Promise<UserRow> {
	const timestamp = now();
	const id = data.id ?? uuid();
	await env.DB.prepare(
		`INSERT INTO "user" (id, email, name, role, profile_image_url, settings, variables, info,
			last_active_at, updated_at, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)`
	)
		.bind(
			id,
			data.email.toLowerCase(),
			data.name,
			data.role ?? 'pending',
			data.profile_image_url ?? DEFAULT_PROFILE_IMAGE,
			toJSON({}),
			toJSON({}),
			toJSON({}),
			timestamp
		)
		.run();
	const row = await getUserById(env, id);
	if (!row) throw new Error('Failed to create user');
	return row;
}

const UPDATABLE_COLUMNS = new Set([
	'email',
	'username',
	'name',
	'role',
	'profile_image_url',
	'profile_banner_image_url',
	'bio',
	'gender',
	'date_of_birth',
	'timezone',
	'presence_state',
	'status_emoji',
	'status_message',
	'status_expires_at',
	'last_active_at'
]);
const JSON_COLUMNS = new Set(['info', 'variables', 'settings', 'oauth', 'scim']);

export async function updateUser(
	env: Env,
	id: string,
	updates: Record<string, unknown>
): Promise<UserRow | null> {
	const assignments: string[] = [];
	const bindings: unknown[] = [];
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		if (UPDATABLE_COLUMNS.has(key)) {
			assignments.push(`${key} = ?${bindings.length + 1}`);
			bindings.push(value === null ? null : value);
		} else if (JSON_COLUMNS.has(key)) {
			assignments.push(`${key} = ?${bindings.length + 1}`);
			bindings.push(toJSON(value));
		}
	}
	if (assignments.length) {
		assignments.push(`updated_at = ?${bindings.length + 1}`);
		bindings.push(now());
		bindings.push(id);
		await env.DB.prepare(
			`UPDATE "user" SET ${assignments.join(', ')} WHERE id = ?${bindings.length}`
		)
			.bind(...bindings)
			.run();
	}
	return getUserById(env, id);
}

export async function touchLastActive(env: Env, id: string): Promise<void> {
	await env.DB.prepare('UPDATE "user" SET last_active_at = ?1 WHERE id = ?2').bind(now(), id).run();
}

export async function deleteUser(env: Env, id: string): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM "user" WHERE id = ?1').bind(id),
		env.DB.prepare('DELETE FROM auth WHERE id = ?1').bind(id),
		env.DB.prepare('DELETE FROM api_key WHERE user_id = ?1').bind(id),
		env.DB.prepare('DELETE FROM chat WHERE user_id = ?1').bind(id),
		env.DB.prepare('DELETE FROM group_member WHERE user_id = ?1').bind(id)
	]);
}
