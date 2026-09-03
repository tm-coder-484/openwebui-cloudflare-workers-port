/**
 * `/api/v1/functions` — pipes/filters/actions registry.
 *
 * The Workers runtime cannot execute the Python plugin bodies these rows hold,
 * so functions are stored and listed but never invoked. `/api/config` reports
 * `enable_plugins: false` so the UI hides execution-only affordances.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { bad, notFound, now, parseJSON, toBool, toJSON } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface FunctionRow {
	id: string;
	user_id: string;
	name: string;
	type: string;
	content: string | null;
	meta: string | null;
	valves: string | null;
	is_active: number;
	is_global: number;
	created_at: number;
	updated_at: number;
}

const serialize = (row: FunctionRow) => ({
	id: row.id,
	user_id: row.user_id,
	name: row.name,
	type: row.type,
	content: row.content,
	meta: parseJSON<Record<string, unknown>>(row.meta, {}),
	is_active: toBool(row.is_active),
	is_global: toBool(row.is_global),
	created_at: row.created_at,
	updated_at: row.updated_at
});

const all = async (c: any) => {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM function ORDER BY updated_at DESC'
	).all();
	return ((results ?? []) as unknown as FunctionRow[]).map(serialize);
};

app.get('/', async (c) => {
	adminUser(c);
	return c.json(await all(c));
});
app.get('/list', async (c) => {
	verifiedUser(c);
	return c.json(await all(c));
});
app.get('/export', async (c) => {
	adminUser(c);
	return c.json(await all(c));
});

app.post('/create', async (c) => {
	const user = adminUser(c);
	const body = (await c.req.json()) as any;
	if (!body?.id || !body?.name || !body?.meta) throw bad('Function id, name and meta are required');
	if (await c.env.DB.prepare('SELECT id FROM function WHERE id = ?1').bind(body.id).first()) {
		throw bad('A function with this id already exists.');
	}
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO function (id, user_id, name, type, content, meta, valves, is_active, is_global, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8, ?8)`
	)
		.bind(
			body.id,
			user.id,
			body.name,
			body.type ?? 'filter',
			body.content ?? '',
			toJSON(body.meta ?? {}),
			toJSON({}),
			timestamp
		)
		.run();
	const row = await c.env.DB.prepare('SELECT * FROM function WHERE id = ?1')
		.bind(body.id)
		.first<FunctionRow>();
	return c.json(serialize(row!));
});

app.get('/id/:id', async (c) => {
	adminUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM function WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<FunctionRow>();
	if (!row) throw notFound('Function not found');
	return c.json(serialize(row));
});

app.post('/id/:id/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM function WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<FunctionRow>();
	if (!row) throw notFound('Function not found');
	await c.env.DB.prepare(
		'UPDATE function SET name = ?1, type = ?2, content = ?3, meta = ?4, updated_at = ?5 WHERE id = ?6'
	)
		.bind(
			body.name ?? row.name,
			body.type ?? row.type,
			body.content ?? row.content,
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM function WHERE id = ?1')
		.bind(row.id)
		.first<FunctionRow>();
	return c.json(serialize(updated!));
});

const toggle = (column: 'is_active' | 'is_global') => async (c: any) => {
	adminUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM function WHERE id = ?1')
		.bind(c.req.param('id'))
		.first()) as FunctionRow | null;
	if (!row) throw notFound('Function not found');
	await c.env.DB.prepare(`UPDATE function SET ${column} = ?1, updated_at = ?2 WHERE id = ?3`)
		.bind(row[column] ? 0 : 1, now(), row.id)
		.run();
	const updated = (await c.env.DB.prepare('SELECT * FROM function WHERE id = ?1')
		.bind(row.id)
		.first()) as FunctionRow;
	return c.json(serialize(updated));
};

app.post('/id/:id/toggle', toggle('is_active'));
app.post('/id/:id/toggle/global', toggle('is_global'));

app.delete('/id/:id/delete', async (c) => {
	adminUser(c);
	await c.env.DB.prepare('DELETE FROM function WHERE id = ?1').bind(c.req.param('id')).run();
	return c.json(true);
});

app.get('/id/:id/valves', async (c) => {
	adminUser(c);
	const row = await c.env.DB.prepare('SELECT valves FROM function WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<{ valves: string }>();
	return c.json(parseJSON(row?.valves, {}));
});
app.get('/id/:id/valves/spec', async (c) => {
	adminUser(c);
	return c.json(null);
});
app.post('/id/:id/valves/update', async (c) => {
	adminUser(c);
	const body = await c.req.json();
	await c.env.DB.prepare('UPDATE function SET valves = ?1 WHERE id = ?2')
		.bind(toJSON(body), c.req.param('id'))
		.run();
	return c.json(body);
});
app.get('/id/:id/valves/user', async (c) => {
	verifiedUser(c);
	return c.json({});
});
app.get('/id/:id/valves/user/spec', async (c) => {
	verifiedUser(c);
	return c.json(null);
});
app.post('/id/:id/valves/user/update', async (c) => {
	verifiedUser(c);
	return c.json(await c.req.json());
});
app.post('/load/url', async () => {
	throw bad('Loading functions from a URL is not supported in the Cloudflare Workers build.');
});

export default app;
