/** `/api/v1/memories` — long-term facts the assistant remembers per user. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import {
	addMemory,
	deleteMemory,
	listMemories,
	queryMemories,
	serializeMemory as serialize,
	type MemoryRow
} from '../lib/memories';
import { bad, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

app.get('/', async (c) => {
	const user = verifiedUser(c);
	return c.json((await listMemories(c.env, user.id)).map(serialize));
});

app.post('/add', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { content?: string; type?: string; path?: string };
	if (!body.content) throw bad('Memory content is required');
	const row = await addMemory(c.env, user.id, body.content, {
		type: body.type,
		path: body.path
	});
	return c.json(serialize(row));
});

app.post('/query', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { content?: string; k?: number };
	const rows = await queryMemories(c.env, user.id, body.content ?? '', body.k ?? 5);
	return c.json({
		documents: [rows.map((row) => row.content)],
		metadatas: [rows.map((row) => ({ id: row.id, created_at: row.created_at }))],
		distances: [rows.map(() => 0)]
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
