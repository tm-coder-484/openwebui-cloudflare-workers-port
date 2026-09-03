/** `/api/v1/evaluations` — message feedback and the arena leaderboard. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { notFound, now, parseJSON, toJSON, uuid } from '../lib/util';
import { getUserById, publicUser } from '../lib/users';

const app = new Hono<AppContext>({ strict: false });

interface FeedbackRow {
	id: string;
	user_id: string;
	version: number;
	type: string;
	data: string | null;
	meta: string | null;
	snapshot: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: FeedbackRow) => ({
	id: row.id,
	user_id: row.user_id,
	version: row.version,
	type: row.type,
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	snapshot: parseJSON<Record<string, unknown> | null>(row.snapshot, null),
	created_at: row.created_at,
	updated_at: row.updated_at
});

app.get('/config', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, ['evaluation.arena.enable', 'evaluation.arena.models']);
	return c.json({
		ENABLE_EVALUATION_ARENA_MODELS: config['evaluation.arena.enable'],
		EVALUATION_ARENA_MODELS: config['evaluation.arena.models']
	});
});

app.post('/config', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	await setConfigMany(c.env, {
		'evaluation.arena.enable': body.ENABLE_EVALUATION_ARENA_MODELS,
		'evaluation.arena.models': body.EVALUATION_ARENA_MODELS
	});
	const config = await getConfigMany(c.env, ['evaluation.arena.enable', 'evaluation.arena.models']);
	return c.json({
		ENABLE_EVALUATION_ARENA_MODELS: config['evaluation.arena.enable'],
		EVALUATION_ARENA_MODELS: config['evaluation.arena.models']
	});
});

app.post('/feedback', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO feedback (id, user_id, version, type, data, meta, snapshot, created_at, updated_at)
		 VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?7)`
	)
		.bind(id, user.id, body.type ?? 'rating', toJSON(body.data ?? {}), toJSON(body.meta ?? {}), toJSON(body.snapshot ?? {}), timestamp)
		.run();
	const row = await c.env.DB.prepare('SELECT * FROM feedback WHERE id = ?1').bind(id).first<FeedbackRow>();
	return c.json(serialize(row!));
});

app.get('/feedbacks/list', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500').all<FeedbackRow>();
	const rows = results ?? [];
	return c.json(
		await Promise.all(
			rows.map(async (row) => {
				const author = await getUserById(c.env, row.user_id);
				return { ...serialize(row), user: author ? publicUser(author) : null };
			})
		)
	);
});

app.get('/feedbacks/all/export', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM feedback').all<FeedbackRow>();
	return c.json((results ?? []).map(serialize));
});

app.get('/feedbacks/models', async (c) => {
	adminUser(c);
	return c.json([]);
});

app.get('/leaderboard', async (c) => {
	verifiedUser(c);
	return c.json([]);
});

app.post('/feedback/:id', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM feedback WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<FeedbackRow>();
	if (!row) throw notFound('Feedback not found');
	await c.env.DB.prepare('UPDATE feedback SET data = ?1, meta = ?2, updated_at = ?3 WHERE id = ?4')
		.bind(toJSON(body.data ?? parseJSON(row.data, {})), toJSON(body.meta ?? parseJSON(row.meta, {})), now(), row.id)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM feedback WHERE id = ?1').bind(row.id).first<FeedbackRow>();
	return c.json(serialize(updated!));
});

app.delete('/feedback/:id', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare(
		`DELETE FROM feedback WHERE id = ?1 ${user.role === 'admin' ? '' : 'AND user_id = ?2'}`
	)
		.bind(...(user.role === 'admin' ? [c.req.param('id')] : [c.req.param('id'), user.id]))
		.run();
	return c.json(true);
});

export default app;
