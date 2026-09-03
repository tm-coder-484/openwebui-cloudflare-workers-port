/** `/api/v1/prompts` — reusable slash-command prompts. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { hasAccess, listGrants, replaceGrants, deleteGrants, visibleResourceIdsClause } from '../lib/access';
import { hasPermission } from '../lib/permissions';
import { bad, forbidden, notFound, now, parseJSON, toBool, toJSON } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface PromptRow {
	id: string;
	command: string;
	user_id: string;
	name: string;
	content: string;
	data: string | null;
	meta: string | null;
	tags: string | null;
	is_active: number;
	version_id: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: PromptRow, grants: any[] = []) => ({
	id: row.id,
	command: row.command,
	user_id: row.user_id,
	name: row.name,
	title: row.name,
	content: row.content,
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	tags: parseJSON<string[]>(row.tags, []),
	is_active: toBool(row.is_active),
	access_grants: grants.map((grant) => ({
		id: grant.id,
		principal_type: grant.principal_type,
		principal_id: grant.principal_id,
		permission: grant.permission
	})),
	timestamp: row.updated_at,
	created_at: row.created_at,
	updated_at: row.updated_at
});

async function listVisible(c: any) {
	const user = verifiedUser(c);
	if (user.role === 'admin') {
		const { results } = await c.env.DB.prepare('SELECT * FROM prompt ORDER BY updated_at DESC').all();
		return { user, rows: (results ?? []) as unknown as PromptRow[] };
	}
	const clause = await visibleResourceIdsClause(c.env, user.id, 'prompt');
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM prompt WHERE user_id = ? OR id IN (${clause.sql}) ORDER BY updated_at DESC`
	)
		.bind(user.id, ...clause.bindings)
		.all();
	return { user, rows: (results ?? []) as unknown as PromptRow[] };
}

async function respond(c: any, rows: PromptRow[]) {
	const grants = await listGrants(c.env, 'prompt', rows.map((row) => row.id));
	return c.json(rows.map((row) => serialize(row, grants.get(row.id) ?? [])));
}

app.get('/', async (c) => {
	const { rows } = await listVisible(c);
	return respond(c, rows);
});

app.get('/list', async (c) => {
	const { rows } = await listVisible(c);
	return respond(c, rows);
});

app.get('/tags', async (c) => {
	const { rows } = await listVisible(c);
	const tags = new Set<string>();
	for (const row of rows) for (const tag of parseJSON<string[]>(row.tags, [])) tags.add(tag);
	return c.json([...tags].map((name) => ({ name })));
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.prompts'))) throw forbidden();
	const body = (await c.req.json()) as any;
	const command = String(body.command ?? '').replace(/^\//, '');
	if (!command || !body.title) throw bad('Command and title are required');
	if (await c.env.DB.prepare('SELECT id FROM prompt WHERE command = ?1').bind(command).first()) {
		throw bad('A prompt with this command already exists.');
	}

	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO prompt (id, command, user_id, name, content, data, meta, tags, is_active, created_at, updated_at)
		 VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`
	)
		.bind(
			command,
			user.id,
			body.title,
			body.content ?? '',
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			toJSON(body.tags ?? []),
			timestamp
		)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'prompt', command, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1').bind(command).first<PromptRow>();
	return c.json(serialize(row!));
});

app.get('/id/:command{.+}', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1').bind(command).first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id))) throw forbidden();
	const grants = (await listGrants(c.env, 'prompt', [row.id])).get(row.id) ?? [];
	return c.json(serialize(row, grants));
});

app.post('/id/:command{.+}/update', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '').replace(/\/update$/, '');
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1').bind(command).first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();

	await c.env.DB.prepare(
		'UPDATE prompt SET name = ?1, content = ?2, data = ?3, meta = ?4, tags = ?5, updated_at = ?6 WHERE id = ?7'
	)
		.bind(
			body.title ?? row.name,
			body.content ?? row.content,
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			toJSON(body.tags ?? parseJSON(row.tags, [])),
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'prompt', row.id, body.access_grants);
	const updated = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1').bind(row.id).first<PromptRow>();
	const grants = (await listGrants(c.env, 'prompt', [row.id])).get(row.id) ?? [];
	return c.json(serialize(updated!, grants));
});

app.post('/id/:command{.+}/access/update', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '').replace(/\/access\/update$/, '');
	const body = (await c.req.json()) as { access_grants?: any[] };
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1').bind(command).first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	const grants = await replaceGrants(c.env, 'prompt', row.id, body.access_grants ?? []);
	return c.json(serialize(row, grants));
});

app.delete('/id/:command{.+}/delete', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '').replace(/\/delete$/, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1').bind(command).first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	await deleteGrants(c.env, 'prompt', row.id);
	await c.env.DB.prepare('DELETE FROM prompt WHERE id = ?1').bind(row.id).run();
	return c.json(true);
});

export default app;
