/** `/api/v1/users` — directory, settings, permissions, admin management. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, currentUser, verifiedUser } from '../lib/auth';
import { DEFAULT_USER_PERMISSIONS, getConfig, setConfig } from '../lib/config';
import { resolvePermissions } from '../lib/permissions';
import { hashPassword } from '../lib/crypto';
import {
	countUsers,
	deleteUser,
	getUserById,
	publicUser,
	serializeUser,
	updateUser,
	type UserRow
} from '../lib/users';
import { hubStats } from '../lib/hub';
import { DEFAULT_USER_IMAGE, profileImageResponse } from '../lib/images';
import { bad, clampInt, deepMerge, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });
const PAGE_SIZE = 30;

app.get('/', async (c) => {
	adminUser(c);
	const query = c.req.query('query')?.trim();
	const orderBy = c.req.query('order_by') ?? 'created_at';
	const direction = c.req.query('direction') === 'asc' ? 'ASC' : 'DESC';
	const page = clampInt(c.req.query('page'), 1, 10_000, 1);

	const allowedColumns = new Set([
		'name',
		'email',
		'created_at',
		'updated_at',
		'last_active_at',
		'role'
	]);
	const column = allowedColumns.has(orderBy) ? orderBy : 'created_at';

	const where = query ? 'WHERE lower(name) LIKE ?1 OR lower(email) LIKE ?1' : '';
	const bindings = query ? [`%${query.toLowerCase()}%`] : [];

	const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM "user" ${where}`)
		.bind(...bindings)
		.first<{ count: number }>();
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM "user" ${where} ORDER BY ${column} ${direction} LIMIT ${PAGE_SIZE} OFFSET ${
			(page - 1) * PAGE_SIZE
		}`
	)
		.bind(...bindings)
		.all<UserRow>();

	const users = results ?? [];
	const groupsByUser = new Map<string, string[]>();
	if (users.length) {
		const placeholders = users.map((_, i) => `?${i + 1}`).join(', ');
		const { results: memberships } = await c.env.DB.prepare(
			`SELECT user_id, group_id FROM group_member WHERE user_id IN (${placeholders})`
		)
			.bind(...users.map((user) => user.id))
			.all<{ user_id: string; group_id: string }>();
		for (const row of memberships ?? []) {
			groupsByUser.set(row.user_id, [...(groupsByUser.get(row.user_id) ?? []), row.group_id]);
		}
	}

	return c.json({
		users: users.map((row) => ({
			...serializeUser(row),
			group_ids: groupsByUser.get(row.id) ?? []
		})),
		total: totalRow?.count ?? 0
	});
});

app.get('/all', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM "user" ORDER BY created_at DESC').all<UserRow>();
	return c.json({ users: (results ?? []).map(serializeUser), total: results?.length ?? 0 });
});

app.get('/search', async (c) => {
	verifiedUser(c);
	const query = (c.req.query('query') ?? '').trim().toLowerCase();
	const page = clampInt(c.req.query('page'), 1, 10_000, 1);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM "user" WHERE lower(name) LIKE ?1 OR lower(email) LIKE ?1
		 ORDER BY name ASC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
	)
		.bind(`%${query}%`)
		.all<UserRow>();
	return c.json({ users: (results ?? []).map(publicUser), total: results?.length ?? 0 });
});

app.get('/active', async (c) => {
	verifiedUser(c);
	const stats = await hubStats(c.env);
	return c.json({ user_ids: [], count: stats.users });
});

app.get('/groups', async (c) => {
	const user = currentUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT g.* FROM "group" g JOIN group_member m ON m.group_id = g.id WHERE m.user_id = ?1'
	)
		.bind(user.id)
		.all<any>();
	return c.json(
		(results ?? []).map((row: any) => ({
			...row,
			data: parseJSON(row.data, {}),
			meta: parseJSON(row.meta, {}),
			permissions: parseJSON(row.permissions, {})
		}))
	);
});

app.get('/default/permissions', async (c) => {
	adminUser(c);
	return c.json(await getConfig(c.env, 'user.permissions'));
});

app.get('/default/permissions/defaults', async (c) => {
	adminUser(c);
	return c.json(DEFAULT_USER_PERMISSIONS);
});

app.post('/default/permissions', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const merged = deepMerge(DEFAULT_USER_PERMISSIONS as Record<string, any>, body);
	await setConfig(c.env, 'user.permissions', merged);
	return c.json(merged);
});

app.get('/user/settings', async (c) => {
	const user = currentUser(c);
	return c.json(user.settings ?? {});
});

app.post('/user/settings/update', async (c) => {
	const user = currentUser(c);
	const settings = (await c.req.json()) as Record<string, unknown>;
	await updateUser(c.env, user.id, { settings });
	return c.json(settings);
});

app.get('/user/info', async (c) => {
	const user = currentUser(c);
	return c.json(user.info ?? {});
});

app.post('/user/info/update', async (c) => {
	const user = currentUser(c);
	const info = (await c.req.json()) as Record<string, unknown>;
	const merged = { ...(user.info ?? {}), ...info };
	await updateUser(c.env, user.id, { info: merged });
	return c.json(merged);
});

app.get('/user/variables', async (c) => {
	const user = currentUser(c);
	return c.json(user.variables ?? {});
});

app.post('/user/variables/update', async (c) => {
	const user = currentUser(c);
	const variables = (await c.req.json()) as Record<string, unknown>;
	await updateUser(c.env, user.id, { variables });
	return c.json(variables);
});

app.post('/user/status/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as {
		status_emoji?: string | null;
		status_message?: string | null;
		status_expires_at?: number | null;
	};
	const updated = await updateUser(c.env, user.id, {
		status_emoji: body.status_emoji ?? null,
		status_message: body.status_message ?? null,
		status_expires_at: body.status_expires_at ?? null
	});
	return c.json(updated ? serializeUser(updated) : {});
});

app.post('/update/role', async (c) => {
	const admin = adminUser(c);
	const { id, role } = (await c.req.json()) as { id: string; role: string };
	if (id === admin.id) throw forbidden('You cannot change your own role.');
	if (!['pending', 'user', 'admin'].includes(role)) throw bad('Invalid role');
	const updated = await updateUser(c.env, id, { role });
	if (!updated) throw notFound('User not found');
	return c.json(serializeUser(updated));
});

app.get('/usage', async (c) => {
	adminUser(c);
	const stats = await hubStats(c.env);
	return c.json({ active_users: stats.users, sessions: stats.sessions });
});

app.get('/:id/profile/image', async (c) => {
	// Avatars load through <img> tags, which cannot carry an Authorization
	// header — they authenticate with the session cookie instead. Rather than
	// erroring for a cookie-less session (and rendering a broken avatar),
	// unauthenticated requests get the default image.
	if (!c.get('user')) {
		return profileImageResponse(null, DEFAULT_USER_IMAGE);
	}
	const row = await getUserById(c.env, c.req.param('id'));
	return profileImageResponse(row?.profile_image_url, DEFAULT_USER_IMAGE, {
		etag: row?.updated_at
	});
});

app.get('/:id/groups', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT g.* FROM "group" g JOIN group_member m ON m.group_id = g.id WHERE m.user_id = ?1'
	)
		.bind(c.req.param('id'))
		.all<any>();
	return c.json(results ?? []);
});

app.get('/:id/active', async (c) => {
	verifiedUser(c);
	const row = await getUserById(c.env, c.req.param('id'));
	if (!row) throw notFound('User not found');
	return c.json({ active: now() - (row.last_active_at ?? 0) < 300 });
});

app.get('/:id/info', async (c) => {
	verifiedUser(c);
	const row = await getUserById(c.env, c.req.param('id'));
	if (!row) throw notFound('User not found');
	return c.json(publicUser(row));
});

app.get('/:id/preview', async (c) => {
	verifiedUser(c);
	const row = await getUserById(c.env, c.req.param('id'));
	if (!row) throw notFound('User not found');
	return c.json({
		...publicUser(row),
		bio: row.bio,
		status_emoji: row.status_emoji,
		status_message: row.status_message
	});
});

app.get('/:id', async (c) => {
	const user = currentUser(c);
	const id = c.req.param('id');
	if (user.role !== 'admin' && user.id !== id) throw forbidden();
	const row = await getUserById(c.env, id);
	if (!row) throw notFound('User not found');
	return c.json(serializeUser(row));
});

app.post('/:id/update', async (c) => {
	adminUser(c);
	const id = c.req.param('id');
	const body = (await c.req.json()) as Record<string, any>;
	const row = await getUserById(c.env, id);
	if (!row) throw notFound('User not found');

	if (body.password) {
		await c.env.DB.prepare('UPDATE auth SET password = ?1 WHERE id = ?2')
			.bind(await hashPassword(body.password), id)
			.run();
	}
	if (body.email && body.email !== row.email) {
		await c.env.DB.prepare('UPDATE auth SET email = ?1 WHERE id = ?2')
			.bind(String(body.email).toLowerCase(), id)
			.run();
	}

	const updated = await updateUser(c.env, id, {
		name: body.name,
		email: body.email ? String(body.email).toLowerCase() : undefined,
		role: body.role,
		profile_image_url: body.profile_image_url
	});
	return c.json(updated ? serializeUser(updated) : {});
});

app.delete('/:id', async (c) => {
	const admin = adminUser(c);
	const id = c.req.param('id');
	if (id === admin.id) throw forbidden('You cannot delete your own account.');
	await deleteUser(c.env, id);
	return c.json(true);
});

export default app;
