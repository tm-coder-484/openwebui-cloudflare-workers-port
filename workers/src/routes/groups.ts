/** `/api/v1/groups` — user groups and their permission overrides. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser } from '../lib/auth';
import { bad, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface GroupRow {
	id: string;
	user_id: string;
	name: string;
	description: string;
	data: string | null;
	meta: string | null;
	permissions: string | null;
	created_at: number;
	updated_at: number;
}

async function serialize(c: any, row: GroupRow) {
	const { results } = await c.env.DB.prepare('SELECT user_id FROM group_member WHERE group_id = ?1')
		.bind(row.id)
		.all();
	return {
		id: row.id,
		user_id: row.user_id,
		name: row.name,
		description: row.description,
		data: parseJSON<Record<string, unknown> | null>(row.data, null),
		meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
		permissions: parseJSON<Record<string, unknown> | null>(row.permissions, null),
		user_ids: ((results ?? []) as { user_id: string }[]).map((member) => member.user_id),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

app.get('/', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM "group" ORDER BY updated_at DESC'
	).all();
	const rows = (results ?? []) as unknown as GroupRow[];
	return c.json(await Promise.all(rows.map((row) => serialize(c, row))));
});

app.post('/create', async (c) => {
	const user = adminUser(c);
	const body = (await c.req.json()) as { name?: string; description?: string };
	if (!body.name) throw bad('Group name is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO "group" (id, user_id, name, description, data, meta, permissions, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
	)
		.bind(
			id,
			user.id,
			body.name,
			body.description ?? '',
			toJSON({}),
			toJSON({}),
			toJSON({}),
			timestamp
		)
		.run();
	const row = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(id)
		.first<GroupRow>();
	return c.json(await serialize(c, row!));
});

app.get('/id/:id', async (c) => {
	adminUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<GroupRow>();
	if (!row) throw notFound('Group not found');
	return c.json(await serialize(c, row));
});

app.get('/id/:id/info', async (c) => {
	adminUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<GroupRow>();
	if (!row) throw notFound('Group not found');
	return c.json(await serialize(c, row));
});

app.post('/id/:id/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as any;
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(id)
		.first<GroupRow>();
	if (!row) throw notFound('Group not found');

	await c.env.DB.prepare(
		'UPDATE "group" SET name = ?1, description = ?2, permissions = ?3, updated_at = ?4 WHERE id = ?5'
	)
		.bind(
			body.name ?? row.name,
			body.description ?? row.description,
			toJSON(body.permissions ?? parseJSON(row.permissions, {})),
			now(),
			id
		)
		.run();

	if (Array.isArray(body.user_ids)) {
		const timestamp = now();
		await c.env.DB.batch([
			c.env.DB.prepare('DELETE FROM group_member WHERE group_id = ?1').bind(id),
			...body.user_ids.map((userId: string) =>
				c.env.DB.prepare(
					'INSERT INTO group_member (id, group_id, user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)'
				).bind(uuid(), id, userId, timestamp)
			)
		]);
	}

	const updated = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(id)
		.first<GroupRow>();
	return c.json(await serialize(c, updated!));
});

app.post('/id/:id/users/add', async (c) => {
	adminUser(c);
	const { user_ids } = (await c.req.json()) as { user_ids: string[] };
	const id = c.req.param('id');
	const timestamp = now();
	await c.env.DB.batch(
		(user_ids ?? []).map((userId) =>
			c.env.DB.prepare(
				'INSERT INTO group_member (id, group_id, user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)'
			).bind(uuid(), id, userId, timestamp)
		)
	);
	const row = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(id)
		.first<GroupRow>();
	return c.json(await serialize(c, row!));
});

app.post('/id/:id/users/remove', async (c) => {
	adminUser(c);
	const { user_ids } = (await c.req.json()) as { user_ids: string[] };
	const id = c.req.param('id');
	await c.env.DB.batch(
		(user_ids ?? []).map((userId) =>
			c.env.DB.prepare('DELETE FROM group_member WHERE group_id = ?1 AND user_id = ?2').bind(
				id,
				userId
			)
		)
	);
	const row = await c.env.DB.prepare('SELECT * FROM "group" WHERE id = ?1')
		.bind(id)
		.first<GroupRow>();
	return c.json(await serialize(c, row!));
});

app.delete('/id/:id/delete', async (c) => {
	adminUser(c);
	const id = c.req.param('id');
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM group_member WHERE group_id = ?1').bind(id),
		c.env.DB.prepare(
			"DELETE FROM access_grant WHERE principal_type = 'group' AND principal_id = ?1"
		).bind(id),
		c.env.DB.prepare('DELETE FROM "group" WHERE id = ?1').bind(id)
	]);
	return c.json(true);
});

export default app;
