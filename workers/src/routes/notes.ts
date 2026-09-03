/** `/api/v1/notes` — the notes workspace. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import {
	hasAccess,
	listGrants,
	replaceGrants,
	deleteGrants,
	visibleResourceIdsClause
} from '../lib/access';
import { hasPermission } from '../lib/permissions';
import { bad, clampInt, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface NoteRow {
	id: string;
	user_id: string;
	title: string;
	data: string | null;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: NoteRow, grants: any[] = []) => ({
	id: row.id,
	user_id: row.user_id,
	title: row.title,
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	access_grants: grants.map((grant) => ({
		id: grant.id,
		principal_type: grant.principal_type,
		principal_id: grant.principal_id,
		permission: grant.permission
	})),
	created_at: row.created_at,
	updated_at: row.updated_at
});

async function visibleNotes(c: any, limit?: number, offset = 0) {
	const user = verifiedUser(c);
	const clause = await visibleResourceIdsClause(c.env, user.id, 'note');
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM note WHERE user_id = ? OR id IN (${clause.sql}) ORDER BY updated_at DESC
		 ${limit ? `LIMIT ${limit} OFFSET ${offset}` : ''}`
	)
		.bind(user.id, ...clause.bindings)
		.all();
	const rows = (results ?? []) as unknown as NoteRow[];
	const grants = await listGrants(
		c.env,
		'note',
		rows.map((row) => row.id)
	);
	return rows.map((row) => serialize(row, grants.get(row.id) ?? []));
}

app.get('/', async (c) => {
	const page = c.req.query('page') ? clampInt(c.req.query('page'), 1, 100_000, 1) : null;
	return c.json(page ? await visibleNotes(c, 30, (page - 1) * 30) : await visibleNotes(c));
});

app.get('/list', async (c) => c.json(await visibleNotes(c)));

app.get('/pinned', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT n.* FROM note n JOIN pinned_note p ON p.note_id = n.id WHERE p.user_id = ?1 ORDER BY n.updated_at DESC'
	)
		.bind(user.id)
		.all();
	return c.json(((results ?? []) as unknown as NoteRow[]).map((row) => serialize(row)));
});

app.get('/search', async (c) => {
	const notes = await visibleNotes(c);
	const query = (c.req.query('query') ?? '').toLowerCase();
	return c.json(
		notes.filter(
			(note) =>
				note.title.toLowerCase().includes(query) ||
				JSON.stringify(note.data ?? {})
					.toLowerCase()
					.includes(query)
		)
	);
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'features.notes'))) throw forbidden();
	const body = (await c.req.json()) as any;
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		'INSERT INTO note (id, user_id, title, data, meta, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)'
	)
		.bind(
			id,
			user.id,
			body.title ?? 'Untitled',
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			timestamp
		)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'note', id, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?1').bind(id).first<NoteRow>();
	return c.json(serialize(row!));
});

app.get('/:id', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<NoteRow>();
	if (!row) throw notFound('Note not found');
	if (!(await hasAccess(c.env, user, 'note', row.id, row.user_id))) throw forbidden();
	const grants = (await listGrants(c.env, 'note', [row.id])).get(row.id) ?? [];
	return c.json(serialize(row, grants));
});

app.post('/:id/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<NoteRow>();
	if (!row) throw notFound('Note not found');
	if (!(await hasAccess(c.env, user, 'note', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare(
		'UPDATE note SET title = ?1, data = ?2, meta = ?3, updated_at = ?4 WHERE id = ?5'
	)
		.bind(
			body.title ?? row.title,
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?1')
		.bind(row.id)
		.first<NoteRow>();
	return c.json(serialize(updated!));
});

app.post('/:id/access/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { access_grants?: any[] };
	const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<NoteRow>();
	if (!row) throw notFound('Note not found');
	if (!(await hasAccess(c.env, user, 'note', row.id, row.user_id, 'write'))) throw forbidden();
	const grants = await replaceGrants(c.env, 'note', row.id, body.access_grants ?? []);
	return c.json(serialize(row, grants));
});

app.post('/:id/pin', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.param('id');
	const existing = await c.env.DB.prepare(
		'SELECT id FROM pinned_note WHERE note_id = ?1 AND user_id = ?2'
	)
		.bind(id, user.id)
		.first<{ id: string }>();
	if (existing) {
		await c.env.DB.prepare('DELETE FROM pinned_note WHERE id = ?1').bind(existing.id).run();
		return c.json(false);
	}
	await c.env.DB.prepare(
		'INSERT INTO pinned_note (id, user_id, note_id, created_at) VALUES (?1, ?2, ?3, ?4)'
	)
		.bind(uuid(), user.id, id, now())
		.run();
	return c.json(true);
});

app.delete('/:id/delete', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM note WHERE id = ?1')
		.bind(c.req.param('id'))
		.first<NoteRow>();
	if (!row) throw notFound('Note not found');
	if (!(await hasAccess(c.env, user, 'note', row.id, row.user_id, 'write'))) throw forbidden();
	await deleteGrants(c.env, 'note', row.id);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM pinned_note WHERE note_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM note WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

app.get('/:id/chats', async (c) => {
	verifiedUser(c);
	return c.json([]);
});

export default app;
