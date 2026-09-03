/** `/api/v1/memories` — long-term facts the assistant remembers per user. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { scoreChunks } from '../lib/retrieval';
import { bad, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface MemoryRow {
	id: string;
	user_id: string;
	type: string;
	path: string | null;
	content: string;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: MemoryRow) => ({
	id: row.id,
	user_id: row.user_id,
	type: row.type,
	path: row.path,
	content: row.content,
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	created_at: row.created_at,
	updated_at: row.updated_at
});

app.get('/', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM memory WHERE user_id = ?1 ORDER BY updated_at DESC'
	)
		.bind(user.id)
		.all<MemoryRow>();
	return c.json((results ?? []).map(serialize));
});

app.post('/add', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { content?: string; type?: string; path?: string };
	if (!body.content) throw bad('Memory content is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO memory (id, user_id, type, path, content, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
	)
		.bind(
			id,
			user.id,
			body.type === 'user' ? 'user' : 'context',
			body.path ?? null,
			body.content,
			toJSON({}),
			timestamp
		)
		.run();
	const row = await c.env.DB.prepare('SELECT * FROM memory WHERE id = ?1')
		.bind(id)
		.first<MemoryRow>();
	return c.json(serialize(row!));
});

app.post('/query', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { content?: string; k?: number };
	const { results } = await c.env.DB.prepare('SELECT * FROM memory WHERE user_id = ?1')
		.bind(user.id)
		.all<MemoryRow>();
	const ranked = scoreChunks(
		body.content ?? '',
		(results ?? []).map((row) => ({ id: row.id, content: row.content }))
	).slice(0, body.k ?? 5);
	const byId = new Map((results ?? []).map((row) => [row.id, row]));
	return c.json({
		documents: [ranked.map((item) => item.content)],
		metadatas: [ranked.map((item) => ({ id: item.id, created_at: byId.get(item.id)?.created_at }))],
		distances: [ranked.map((item) => 1 - item.score)]
	});
});

app.post('/:id/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { content?: string };
	const row = await c.env.DB.prepare('SELECT * FROM memory WHERE id = ?1 AND user_id = ?2')
		.bind(c.req.param('id'), user.id)
		.first<MemoryRow>();
	if (!row) throw notFound('Memory not found');
	await c.env.DB.prepare('UPDATE memory SET content = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(body.content ?? row.content, now(), row.id)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM memory WHERE id = ?1')
		.bind(row.id)
		.first<MemoryRow>();
	return c.json(serialize(updated!));
});

app.delete('/:id', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('DELETE FROM memory WHERE id = ?1 AND user_id = ?2')
		.bind(c.req.param('id'), user.id)
		.run();
	return c.json(true);
});

app.delete('/delete/user', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('DELETE FROM memory WHERE user_id = ?1').bind(user.id).run();
	return c.json(true);
});

app.post('/reindex', async (c) => {
	verifiedUser(c);
	return c.json(true);
});

export default app;
