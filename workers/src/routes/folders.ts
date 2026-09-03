/** `/api/v1/folders` — chat folders (nestable). */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { bad, notFound, now, parseJSON, toBool, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface FolderRow {
	id: string;
	parent_id: string | null;
	user_id: string;
	name: string;
	items: string | null;
	meta: string | null;
	data: string | null;
	is_expanded: number;
	created_at: number;
	updated_at: number;
}

const serialize = (row: FolderRow) => ({
	id: row.id,
	parent_id: row.parent_id,
	user_id: row.user_id,
	name: row.name,
	items: parseJSON<Record<string, unknown> | null>(row.items, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	is_expanded: toBool(row.is_expanded),
	created_at: row.created_at,
	updated_at: row.updated_at
});

app.get('/', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM folder WHERE user_id = ?1 ORDER BY updated_at DESC'
	)
		.bind(user.id)
		.all<FolderRow>();
	return c.json((results ?? []).map(serialize));
});

app.get('/shared', async (c) => {
	verifiedUser(c);
	return c.json([]);
});

app.post('/', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { name?: string; parent_id?: string | null };
	if (!body.name) throw bad('Folder name is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO folder (id, parent_id, user_id, name, items, meta, data, is_expanded, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`
	)
		.bind(
			id,
			body.parent_id ?? null,
			user.id,
			body.name,
			toJSON({}),
			toJSON({}),
			toJSON({}),
			timestamp
		)
		.run();
	const row = await c.env.DB.prepare('SELECT * FROM folder WHERE id = ?1')
		.bind(id)
		.first<FolderRow>();
	return c.json(serialize(row!));
});

app.get('/:id', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM folder WHERE id = ?1 AND user_id = ?2')
		.bind(c.req.param('id'), user.id)
		.first<FolderRow>();
	if (!row) throw notFound('Folder not found');
	return c.json(serialize(row));
});

app.post('/:id/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { name?: string; data?: Record<string, unknown> };
	const row = await c.env.DB.prepare('SELECT * FROM folder WHERE id = ?1 AND user_id = ?2')
		.bind(c.req.param('id'), user.id)
		.first<FolderRow>();
	if (!row) throw notFound('Folder not found');
	await c.env.DB.prepare('UPDATE folder SET name = ?1, data = ?2, updated_at = ?3 WHERE id = ?4')
		.bind(body.name ?? row.name, toJSON(body.data ?? parseJSON(row.data, {})), now(), row.id)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM folder WHERE id = ?1')
		.bind(row.id)
		.first<FolderRow>();
	return c.json(serialize(updated!));
});

app.post('/:id/update/parent', async (c) => {
	const user = verifiedUser(c);
	const { parent_id } = (await c.req.json()) as { parent_id: string | null };
	if (parent_id === c.req.param('id')) throw bad('A folder cannot be its own parent.');
	await c.env.DB.prepare(
		'UPDATE folder SET parent_id = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4'
	)
		.bind(parent_id ?? null, now(), c.req.param('id'), user.id)
		.run();
	return c.json(true);
});

app.post('/:id/update/expanded', async (c) => {
	const user = verifiedUser(c);
	const { is_expanded } = (await c.req.json()) as { is_expanded: boolean };
	await c.env.DB.prepare(
		'UPDATE folder SET is_expanded = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4'
	)
		.bind(is_expanded ? 1 : 0, now(), c.req.param('id'), user.id)
		.run();
	return c.json(true);
});

app.post('/:id/read', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('UPDATE chat SET last_read_at = ?1 WHERE folder_id = ?2 AND user_id = ?3')
		.bind(now(), c.req.param('id'), user.id)
		.run();
	return c.json(true);
});

app.delete('/:id', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.param('id');
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE chat SET folder_id = NULL WHERE folder_id = ?1 AND user_id = ?2').bind(
			id,
			user.id
		),
		c.env.DB.prepare(
			'UPDATE folder SET parent_id = NULL WHERE parent_id = ?1 AND user_id = ?2'
		).bind(id, user.id),
		c.env.DB.prepare('DELETE FROM folder WHERE id = ?1 AND user_id = ?2').bind(id, user.id)
	]);
	return c.json(true);
});

export default app;
