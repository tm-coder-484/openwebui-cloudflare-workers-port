/**
 * `/api/v1/tools` — tool registry.
 *
 * Upstream executes Python tool code in-process. Workers cannot, so tools are
 * stored and listed (OpenAPI/MCP tool *servers* are configured separately under
 * Admin Settings → Tools), but Python tool bodies are never executed here.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { hasAccess, listGrants, replaceGrants, deleteGrants } from '../lib/access';
import { hasPermission } from '../lib/permissions';
import { bad, forbidden, notFound, now, parseJSON, toJSON } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface ToolRow {
	id: string;
	user_id: string;
	name: string;
	content: string | null;
	specs: string | null;
	meta: string | null;
	valves: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: ToolRow, grants: any[] = []) => ({
	id: row.id,
	user_id: row.user_id,
	name: row.name,
	content: row.content,
	specs: parseJSON<unknown[]>(row.specs, []),
	meta: parseJSON<Record<string, unknown>>(row.meta, {}),
	access_grants: grants.map((grant) => ({
		id: grant.id,
		principal_type: grant.principal_type,
		principal_id: grant.principal_id,
		permission: grant.permission
	})),
	created_at: row.created_at,
	updated_at: row.updated_at
});

async function visibleTools(c: any) {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM tool ORDER BY updated_at DESC').all();
	const rows = (results ?? []) as unknown as ToolRow[];
	const visible: ToolRow[] = [];
	for (const row of rows) {
		if (await hasAccess(c.env, user, 'tool', row.id, row.user_id)) visible.push(row);
	}
	const grants = await listGrants(
		c.env,
		'tool',
		visible.map((row) => row.id)
	);
	return visible.map((row) => serialize(row, grants.get(row.id) ?? []));
}

app.get('/', async (c) => c.json(await visibleTools(c)));
app.get('/list', async (c) => c.json(await visibleTools(c)));
app.get('/export', async (c) => {
	verifiedUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM tool').all();
	return c.json(((results ?? []) as unknown as ToolRow[]).map((row) => serialize(row)));
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.tools'))) throw forbidden();
	const body = (await c.req.json()) as any;
	if (!body?.id || !body?.name) throw bad('Tool id and name are required');
	if (await c.env.DB.prepare('SELECT id FROM tool WHERE id = ?1').bind(body.id).first()) {
		throw bad('A tool with this id already exists.');
	}
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO tool (id, user_id, name, content, specs, meta, valves, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
	)
		.bind(
			body.id,
			user.id,
			body.name,
			body.content ?? '',
			toJSON(body.specs ?? []),
			toJSON(body.meta ?? {}),
			toJSON({}),
			timestamp
		)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'tool', body.id, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(body.id)
		.first<ToolRow>();
	return c.json(serialize(row!));
});

app.get('/id/:id', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<ToolRow>();
	if (!row) throw notFound('Tool not found');
	if (!(await hasAccess(c.env, user, 'tool', row.id, row.user_id))) throw forbidden();
	const grants = (await listGrants(c.env, 'tool', [row.id])).get(row.id) ?? [];
	return c.json(serialize(row, grants));
});

app.post('/id/:id/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<ToolRow>();
	if (!row) throw notFound('Tool not found');
	if (!(await hasAccess(c.env, user, 'tool', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare(
		'UPDATE tool SET name = ?1, content = ?2, specs = ?3, meta = ?4, updated_at = ?5 WHERE id = ?6'
	)
		.bind(
			body.name ?? row.name,
			body.content ?? row.content,
			toJSON(body.specs ?? parseJSON(row.specs, [])),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'tool', row.id, body.access_grants);
	const updated = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(row.id)
		.first<ToolRow>();
	return c.json(serialize(updated!));
});

app.post('/id/:id/access/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { access_grants?: any[] };
	const row = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<ToolRow>();
	if (!row) throw notFound('Tool not found');
	if (!(await hasAccess(c.env, user, 'tool', row.id, row.user_id, 'write'))) throw forbidden();
	const grants = await replaceGrants(c.env, 'tool', row.id, body.access_grants ?? []);
	return c.json(serialize(row, grants));
});

app.delete('/id/:id/delete', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<ToolRow>();
	if (!row) throw notFound('Tool not found');
	if (!(await hasAccess(c.env, user, 'tool', row.id, row.user_id, 'write'))) throw forbidden();
	await deleteGrants(c.env, 'tool', row.id);
	await c.env.DB.prepare('DELETE FROM tool WHERE id = ?1').bind(row.id).run();
	return c.json(true);
});

// Valves are Python-side configuration; nothing executes them in this build.
app.get('/id/:id/valves', async (c) => {
	verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT valves FROM tool WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<{ valves: string }>();
	return c.json(parseJSON(row?.valves, {}));
});
app.get('/id/:id/valves/spec', async (c) => {
	verifiedUser(c);
	return c.json(null);
});
app.post('/id/:id/valves/update', async (c) => {
	const user = verifiedUser(c);
	const body = await c.req.json();
	const row = await c.env.DB.prepare('SELECT * FROM tool WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<ToolRow>();
	if (!row) throw notFound('Tool not found');
	if (!(await hasAccess(c.env, user, 'tool', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare('UPDATE tool SET valves = ?1 WHERE id = ?2')
		.bind(toJSON(body), row.id)
		.run();
	return c.json(body);
});
app.get('/id/:id/valves/user', async (c) => {
	const user = verifiedUser(c);
	const settings = (user.settings ?? {}) as any;
	return c.json(settings?.tools?.valves?.[c.req.param('id')] ?? {});
});
app.get('/id/:id/valves/user/spec', async (c) => {
	verifiedUser(c);
	return c.json(null);
});
app.post('/id/:id/valves/user/update', async (c) => {
	verifiedUser(c);
	return c.json(await c.req.json());
});

app.post('/load/url', async (c) => {
	verifiedUser(c);
	throw bad('Loading tools from a URL is not supported in the Cloudflare Workers build.');
});

export default app;
