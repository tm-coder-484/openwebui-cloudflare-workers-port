/**
 * `/api/v1/analytics` — admin usage dashboards.
 *
 * Aggregates the `chat_message` rows written when a completion finishes, so the
 * queries stay cheap instead of walking every chat JSON blob.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser } from '../lib/auth';
import { parseJSON } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface Range {
	where: string;
	bindings: unknown[];
}

function range(c: any, extra: string[] = [], extraBindings: unknown[] = []): Range {
	const clauses = [...extra];
	const bindings = [...extraBindings];
	const start = c.req.query('start_date');
	const end = c.req.query('end_date');
	if (start) {
		bindings.push(Number(start));
		clauses.push(`created_at >= ?${bindings.length}`);
	}
	if (end) {
		bindings.push(Number(end));
		clauses.push(`created_at <= ?${bindings.length}`);
	}
	return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', bindings };
}

app.get('/summary', async (c) => {
	adminUser(c);
	const { where, bindings } = range(c);
	const row = await c.env.DB.prepare(
		`SELECT COUNT(*) AS total_messages,
			COUNT(DISTINCT chat_id) AS total_chats,
			COUNT(DISTINCT model_id) AS total_models,
			COUNT(DISTINCT user_id) AS total_users
		 FROM chat_message ${where}`
	)
		.bind(...bindings)
		.first<{
			total_messages: number;
			total_chats: number;
			total_models: number;
			total_users: number;
		}>();
	return c.json({
		total_messages: row?.total_messages ?? 0,
		total_chats: row?.total_chats ?? 0,
		total_models: row?.total_models ?? 0,
		total_users: row?.total_users ?? 0
	});
});

app.get('/models', async (c) => {
	adminUser(c);
	const { where, bindings } = range(c, ['model_id IS NOT NULL']);
	const { results } = await c.env.DB.prepare(
		`SELECT model_id, COUNT(*) AS count, COUNT(DISTINCT user_id) AS unique_users,
			COUNT(DISTINCT chat_id) AS unique_chats
		 FROM chat_message ${where} GROUP BY model_id ORDER BY count DESC`
	)
		.bind(...bindings)
		.all<{ model_id: string; count: number; unique_users: number; unique_chats: number }>();
	return c.json({ models: results ?? [] });
});

app.get('/users', async (c) => {
	adminUser(c);
	const { where, bindings } = range(c, ['user_id IS NOT NULL']);
	const { results } = await c.env.DB.prepare(
		`SELECT m.user_id, u.name, u.email, COUNT(*) AS count
		 FROM chat_message m LEFT JOIN "user" u ON u.id = m.user_id
		 ${where.replace(/created_at/g, 'm.created_at').replace(/user_id/g, 'm.user_id')}
		 GROUP BY m.user_id ORDER BY count DESC`
	)
		.bind(...bindings)
		.all<{ user_id: string; name: string; email: string; count: number }>();
	return c.json({
		users: (results ?? []).map((row) => ({
			...row,
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0
		}))
	});
});

app.get('/daily', async (c) => {
	adminUser(c);
	const { where, bindings } = range(c, ['model_id IS NOT NULL']);
	const { results } = await c.env.DB.prepare(
		`SELECT date(created_at, 'unixepoch') AS date, model_id, COUNT(*) AS count
		 FROM chat_message ${where} GROUP BY date, model_id ORDER BY date ASC`
	)
		.bind(...bindings)
		.all<{ date: string; model_id: string; count: number }>();

	const byDate = new Map<string, Record<string, number>>();
	for (const row of results ?? []) {
		const models = byDate.get(row.date) ?? {};
		models[row.model_id] = row.count;
		byDate.set(row.date, models);
	}
	return c.json({ data: [...byDate.entries()].map(([date, models]) => ({ date, models })) });
});

app.get('/tokens', async (c) => {
	adminUser(c);
	const { where, bindings } = range(c, ['model_id IS NOT NULL']);
	const { results } = await c.env.DB.prepare(`SELECT model_id, usage FROM chat_message ${where}`)
		.bind(...bindings)
		.all<{ model_id: string; usage: string | null }>();

	const totals = new Map<string, { input_tokens: number; output_tokens: number }>();
	for (const row of results ?? []) {
		const usage = parseJSON<Record<string, number>>(row.usage, {});
		const entry = totals.get(row.model_id) ?? { input_tokens: 0, output_tokens: 0 };
		entry.input_tokens += Number(usage.prompt_tokens ?? 0);
		entry.output_tokens += Number(usage.completion_tokens ?? 0);
		totals.set(row.model_id, entry);
	}
	return c.json({
		models: [...totals.entries()].map(([model_id, entry]) => ({ model_id, ...entry }))
	});
});

app.get('/messages', async (c) => {
	adminUser(c);
	const { where, bindings } = range(c);
	const { results } = await c.env.DB.prepare(
		`SELECT id, chat_id, user_id, role, model_id, created_at FROM chat_message
		 ${where} ORDER BY created_at DESC LIMIT 200`
	)
		.bind(...bindings)
		.all();
	return c.json({ messages: results ?? [] });
});

app.get('/models/:id/overview', async (c) => {
	adminUser(c);
	const modelId = c.req.param('id');
	const row = await c.env.DB.prepare(
		`SELECT COUNT(*) AS count, COUNT(DISTINCT user_id) AS unique_users,
			COUNT(DISTINCT chat_id) AS unique_chats
		 FROM chat_message WHERE model_id = ?1`
	)
		.bind(modelId)
		.first<{ count: number; unique_users: number; unique_chats: number }>();
	return c.json({ model_id: modelId, ...(row ?? { count: 0, unique_users: 0, unique_chats: 0 }) });
});

app.get('/models/:id/chats', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare(
		`SELECT DISTINCT m.chat_id, c.title, c.user_id, c.updated_at
		 FROM chat_message m JOIN chat c ON c.id = m.chat_id
		 WHERE m.model_id = ?1 ORDER BY c.updated_at DESC LIMIT 100`
	)
		.bind(c.req.param('id'))
		.all();
	return c.json({ chats: results ?? [] });
});

export default app;
