/** `/api/v1/skills` — reusable markdown instruction blocks. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { hasAccess, listGrants, replaceGrants, deleteGrants } from '../lib/access';
import { hasPermission } from '../lib/permissions';
import { bad, forbidden, notFound, now, parseJSON, toBool, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface SkillRow {
	id: string;
	user_id: string;
	name: string;
	description: string | null;
	content: string;
	meta: string | null;
	is_active: number;
	created_at: number;
	updated_at: number;
}

const serialize = (row: SkillRow, grants: any[] = []) => ({
	id: row.id,
	user_id: row.user_id,
	name: row.name,
	description: row.description,
	content: row.content,
	meta: parseJSON<Record<string, unknown>>(row.meta, {}),
	is_active: toBool(row.is_active),
	access_grants: grants.map((grant) => ({
		id: grant.id,
		principal_type: grant.principal_type,
		principal_id: grant.principal_id,
		permission: grant.permission
	})),
	created_at: row.created_at,
	updated_at: row.updated_at
});

async function visibleSkills(c: any) {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM skill ORDER BY updated_at DESC').all();
	const rows = (results ?? []) as unknown as SkillRow[];
	const visible: SkillRow[] = [];
	for (const row of rows) {
		if (await hasAccess(c.env, user, 'skill', row.id, row.user_id)) visible.push(row);
	}
	const grants = await listGrants(c.env, 'skill', visible.map((row) => row.id));
	return visible.map((row) => serialize(row, grants.get(row.id) ?? []));
}

app.get('/', async (c) => c.json(await visibleSkills(c)));
app.get('/list', async (c) => c.json(await visibleSkills(c)));
app.get('/export', async (c) => c.json(await visibleSkills(c)));

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.skills'))) throw forbidden();
	const body = (await c.req.json()) as any;
	if (!body?.name) throw bad('Skill name is required');
	const id = body.id ?? uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO skill (id, user_id, name, description, content, meta, is_active, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`
	)
		.bind(id, user.id, body.name, body.description ?? '', body.content ?? '', toJSON(body.meta ?? {}), timestamp)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'skill', id, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(id).first<SkillRow>();
	return c.json(serialize(row!));
});

app.get('/id/:id', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(c.req.param('id')).first<SkillRow>();
	if (!row) throw notFound('Skill not found');
	if (!(await hasAccess(c.env, user, 'skill', row.id, row.user_id))) throw forbidden();
	const grants = (await listGrants(c.env, 'skill', [row.id])).get(row.id) ?? [];
	return c.json(serialize(row, grants));
});

app.post('/id/:id/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(c.req.param('id')).first<SkillRow>();
	if (!row) throw notFound('Skill not found');
	if (!(await hasAccess(c.env, user, 'skill', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare(
		'UPDATE skill SET name = ?1, description = ?2, content = ?3, meta = ?4, updated_at = ?5 WHERE id = ?6'
	)
		.bind(
			body.name ?? row.name,
			body.description ?? row.description,
			body.content ?? row.content,
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'skill', row.id, body.access_grants);
	const updated = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(row.id).first<SkillRow>();
	return c.json(serialize(updated!));
});

app.post('/id/:id/toggle', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(c.req.param('id')).first<SkillRow>();
	if (!row) throw notFound('Skill not found');
	if (!(await hasAccess(c.env, user, 'skill', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare('UPDATE skill SET is_active = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(row.is_active ? 0 : 1, now(), row.id)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(row.id).first<SkillRow>();
	return c.json(serialize(updated!));
});

app.post('/id/:id/access/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { access_grants?: any[] };
	const row = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(c.req.param('id')).first<SkillRow>();
	if (!row) throw notFound('Skill not found');
	if (!(await hasAccess(c.env, user, 'skill', row.id, row.user_id, 'write'))) throw forbidden();
	const grants = await replaceGrants(c.env, 'skill', row.id, body.access_grants ?? []);
	return c.json(serialize(row, grants));
});

app.delete('/id/:id/delete', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM skill WHERE id = ?1').bind(c.req.param('id')).first<SkillRow>();
	if (!row) throw notFound('Skill not found');
	if (!(await hasAccess(c.env, user, 'skill', row.id, row.user_id, 'write'))) throw forbidden();
	await deleteGrants(c.env, 'skill', row.id);
	await c.env.DB.prepare('DELETE FROM skill WHERE id = ?1').bind(row.id).run();
	return c.json(true);
});

export default app;
