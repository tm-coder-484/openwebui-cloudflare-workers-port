/** `/api/v1/evaluations` — message feedback and the arena leaderboard. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { clampInt, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';
import { getUserById, publicUser } from '../lib/users';

const app = new Hono<AppContext>({ strict: false });
const PAGE_SIZE = 30;

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
		.bind(
			id,
			user.id,
			body.type ?? 'rating',
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			toJSON(body.snapshot ?? {}),
			timestamp
		)
		.run();
	const row = await c.env.DB.prepare('SELECT * FROM feedback WHERE id = ?1')
		.bind(id)
		.first<FeedbackRow>();
	return c.json(serialize(row!));
});

app.get('/feedbacks/list', async (c) => {
	adminUser(c);
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	const direction = c.req.query('direction') === 'asc' ? 'ASC' : 'DESC';
	const orderBy = ['created_at', 'updated_at'].includes(c.req.query('order_by') ?? '')
		? (c.req.query('order_by') as string)
		: 'updated_at';
	const modelId = c.req.query('model_id');

	const where = modelId ? "WHERE json_extract(data, '$.model_id') = ?1" : '';
	const bindings = modelId ? [modelId] : [];

	const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM feedback ${where}`)
		.bind(...bindings)
		.first<{ count: number }>();
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM feedback ${where} ORDER BY ${orderBy} ${direction} LIMIT ${PAGE_SIZE} OFFSET ${
			(page - 1) * PAGE_SIZE
		}`
	)
		.bind(...bindings)
		.all<FeedbackRow>();

	const items = await Promise.all(
		(results ?? []).map(async (row) => {
			const author = await getUserById(c.env, row.user_id);
			return { ...serialize(row), user: author ? publicUser(author) : null };
		})
	);
	return c.json({ items, total: total?.count ?? 0 });
});

app.get('/feedbacks/all/ids', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT id FROM feedback').all<{ id: string }>();
	return c.json(results ?? []);
});

app.delete('/feedbacks/all', async (c) => {
	adminUser(c);
	await c.env.DB.prepare('DELETE FROM feedback').run();
	return c.json(true);
});

app.get('/feedbacks/all/export', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM feedback').all<FeedbackRow>();
	return c.json((results ?? []).map(serialize));
});

app.get('/feedbacks/models', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare(
		"SELECT DISTINCT json_extract(data, '$.model_id') AS model_id FROM feedback WHERE model_id IS NOT NULL"
	).all<{ model_id: string }>();
	return c.json((results ?? []).map((row) => row.model_id).filter(Boolean));
});

/**
 * Ratings leaderboard.
 *
 * Upstream runs a full Elo pass (optionally weighted by tag-embedding
 * similarity). This build reports the same shape from a simpler, transparent
 * score: every thumbs-up counts as a win against each sibling model in the
 * comparison, every thumbs-down as a loss.
 */
app.get('/leaderboard', async (c) => {
	verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		"SELECT data FROM feedback WHERE type = 'rating'"
	).all<{
		data: string | null;
	}>();

	type Stats = { won: number; lost: number; count: number; tags: Map<string, number> };
	const stats = new Map<string, Stats>();
	const statsFor = (modelId: string): Stats => {
		if (!stats.has(modelId)) stats.set(modelId, { won: 0, lost: 0, count: 0, tags: new Map() });
		return stats.get(modelId)!;
	};

	for (const row of results ?? []) {
		const data = parseJSON<{
			model_id?: string;
			rating?: number | string;
			sibling_model_ids?: string[];
			tags?: string[];
		}>(row.data, {});
		if (!data.model_id) continue;

		const rating = Number(data.rating ?? 0);
		const entry = statsFor(data.model_id);
		entry.count += 1;
		for (const tag of data.tags ?? []) entry.tags.set(tag, (entry.tags.get(tag) ?? 0) + 1);

		const siblings = data.sibling_model_ids ?? [];
		if (rating > 0) {
			entry.won += Math.max(siblings.length, 1);
			for (const sibling of siblings) statsFor(sibling).lost += 1;
		} else if (rating < 0) {
			entry.lost += Math.max(siblings.length, 1);
			for (const sibling of siblings) statsFor(sibling).won += 1;
		}
	}

	const entries = [...stats.entries()]
		.map(([model_id, entry]) => ({
			model_id,
			rating: 1000 + (entry.won - entry.lost) * 10,
			won: entry.won,
			lost: entry.lost,
			count: entry.count,
			top_tags: [...entry.tags.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([name, count]) => ({ name, count }))
		}))
		.sort((a, b) => b.rating - a.rating);

	return c.json({ entries });
});

app.get('/leaderboard/:id/history', async (c) => {
	verifiedUser(c);
	return c.json({ model_id: c.req.param('id'), history: [] });
});

app.post('/feedback/:id', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM feedback WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<FeedbackRow>();
	if (!row) throw notFound('Feedback not found');
	await c.env.DB.prepare('UPDATE feedback SET data = ?1, meta = ?2, updated_at = ?3 WHERE id = ?4')
		.bind(
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM feedback WHERE id = ?1')
		.bind(row.id)
		.first<FeedbackRow>();
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
