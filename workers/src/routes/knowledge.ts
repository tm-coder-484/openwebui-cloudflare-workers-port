/** `/api/v1/knowledge` — knowledge bases (collections of indexed files). */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { hasAccess, listGrants, replaceGrants, deleteGrants, visibleResourceIdsClause } from '../lib/access';
import { hasPermission } from '../lib/permissions';
import { indexChunks, removeChunks, search } from '../lib/retrieval';
import { bad, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface KnowledgeRow {
	id: string;
	user_id: string;
	name: string;
	description: string;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

async function filesFor(c: any, knowledgeId: string) {
	const { results } = await c.env.DB.prepare(
		`SELECT f.* FROM file f JOIN knowledge_file k ON k.file_id = f.id
		 WHERE k.knowledge_id = ?1 ORDER BY f.created_at DESC`
	)
		.bind(knowledgeId)
		.all();
	return ((results ?? []) as any[]).map((row) => ({
		id: row.id,
		user_id: row.user_id,
		filename: row.filename,
		meta: parseJSON<Record<string, unknown>>(row.meta, {}),
		data: parseJSON<Record<string, unknown>>(row.data, {}),
		created_at: row.created_at,
		updated_at: row.updated_at
	}));
}

async function serialize(c: any, row: KnowledgeRow, grants: any[] = [], withFiles = true) {
	return {
		id: row.id,
		user_id: row.user_id,
		name: row.name,
		description: row.description,
		meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
		access_grants: grants.map((grant) => ({
			id: grant.id,
			principal_type: grant.principal_type,
			principal_id: grant.principal_id,
			permission: grant.permission
		})),
		...(withFiles ? { files: await filesFor(c, row.id) } : {}),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

async function visible(c: any) {
	const user = verifiedUser(c);
	const clause = await visibleResourceIdsClause(c.env, user.id, 'knowledge');
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM knowledge WHERE user_id = ? OR id IN (${clause.sql}) ORDER BY updated_at DESC`
	)
		.bind(user.id, ...clause.bindings)
		.all();
	return (results ?? []) as unknown as KnowledgeRow[];
}

app.get('/', async (c) => {
	const rows = await visible(c);
	const grants = await listGrants(c.env, 'knowledge', rows.map((row) => row.id));
	return c.json(await Promise.all(rows.map((row) => serialize(c, row, grants.get(row.id) ?? []))));
});

app.get('/list', async (c) => {
	const rows = await visible(c);
	const grants = await listGrants(c.env, 'knowledge', rows.map((row) => row.id));
	return c.json(await Promise.all(rows.map((row) => serialize(c, row, grants.get(row.id) ?? [], false))));
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.knowledge'))) throw forbidden();
	const body = (await c.req.json()) as any;
	if (!body?.name) throw bad('Knowledge base name is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		'INSERT INTO knowledge (id, user_id, name, description, meta, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)'
	)
		.bind(id, user.id, body.name, body.description ?? '', toJSON(body.meta ?? {}), timestamp)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'knowledge', id, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM knowledge WHERE id = ?1').bind(id).first<KnowledgeRow>();
	return c.json(await serialize(c, row!));
});

app.get('/search', async (c) => {
	const rows = await visible(c);
	const query = (c.req.query('query') ?? '').toLowerCase();
	const matched = rows.filter(
		(row) => row.name.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)
	);
	return c.json(await Promise.all(matched.map((row) => serialize(c, row))));
});

app.get('/search/files', async (c) => {
	const user = verifiedUser(c);
	const query = c.req.query('query') ?? '';
	const knowledgeId = c.req.query('knowledge_id');
	const results = await search(c.env, query, {
		knowledgeIds: knowledgeId ? [knowledgeId] : (await visible(c)).map((row) => row.id)
	});
	return c.json(results);
});

async function load(c: any, id: string, permission: 'read' | 'write' = 'read') {
	const user = verifiedUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM knowledge WHERE id = ?1')
		.bind(id)
		.first()) as KnowledgeRow | null;
	if (!row) throw notFound('Knowledge base not found');
	if (!(await hasAccess(c.env, user, 'knowledge', row.id, row.user_id, permission))) throw forbidden();
	return { row, user };
}

app.get('/:id', async (c) => {
	const { row } = await load(c, c.req.param('id'));
	const grants = (await listGrants(c.env, 'knowledge', [row.id])).get(row.id) ?? [];
	return c.json(await serialize(c, row, grants));
});

app.get('/:id/files', async (c) => {
	const { row } = await load(c, c.req.param('id'));
	return c.json(await filesFor(c, row.id));
});

app.post('/:id/update', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as any;
	await c.env.DB.prepare(
		'UPDATE knowledge SET name = ?1, description = ?2, meta = ?3, updated_at = ?4 WHERE id = ?5'
	)
		.bind(
			body.name ?? row.name,
			body.description ?? row.description,
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants)) await replaceGrants(c.env, 'knowledge', row.id, body.access_grants);
	const updated = await c.env.DB.prepare('SELECT * FROM knowledge WHERE id = ?1')
		.bind(row.id)
		.first<KnowledgeRow>();
	return c.json(await serialize(c, updated!));
});

app.post('/:id/access/update', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as { access_grants?: any[] };
	const grants = await replaceGrants(c.env, 'knowledge', row.id, body.access_grants ?? []);
	return c.json(await serialize(c, row, grants));
});

app.post('/:id/file/add', async (c) => {
	const { row, user } = await load(c, c.req.param('id'), 'write');
	const { file_id } = (await c.req.json()) as { file_id: string };
	const file = await c.env.DB.prepare('SELECT * FROM file WHERE id = ?1')
		.bind(file_id)
		.first<{ id: string; data: string }>();
	if (!file) throw notFound('File not found');

	await c.env.DB.prepare(
		'INSERT OR IGNORE INTO knowledge_file (id, knowledge_id, file_id, created_at) VALUES (?1, ?2, ?3, ?4)'
	)
		.bind(uuid(), row.id, file_id, now())
		.run();
	await c.env.DB.prepare('UPDATE file_chunk SET knowledge_id = ?1 WHERE file_id = ?2')
		.bind(row.id, file_id)
		.run();

	// Re-index if the file was uploaded before it belonged to a collection.
	const chunks = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM file_chunk WHERE file_id = ?1')
		.bind(file_id)
		.first<{ count: number }>();
	if (!chunks?.count) {
		const content = parseJSON<{ content?: string }>(file.data, {}).content ?? '';
		if (content) {
			await indexChunks(c.env, {
				fileId: file_id,
				knowledgeId: row.id,
				userId: user.id,
				text: content
			});
		}
	}

	return c.json(await serialize(c, row));
});

app.post('/:id/file/remove', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const { file_id } = (await c.req.json()) as { file_id: string };
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM knowledge_file WHERE knowledge_id = ?1 AND file_id = ?2').bind(row.id, file_id),
		c.env.DB.prepare('UPDATE file_chunk SET knowledge_id = NULL WHERE file_id = ?1 AND knowledge_id = ?2').bind(
			file_id,
			row.id
		)
	]);
	return c.json(await serialize(c, row));
});

app.post('/:id/reset', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const { results } = await c.env.DB.prepare('SELECT file_id FROM knowledge_file WHERE knowledge_id = ?1')
		.bind(row.id)
		.all<{ file_id: string }>();
	for (const file of results ?? []) await removeChunks(c.env, file.file_id);
	await c.env.DB.prepare('DELETE FROM knowledge_file WHERE knowledge_id = ?1').bind(row.id).run();
	return c.json(await serialize(c, row));
});

app.delete('/:id/delete', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	await deleteGrants(c.env, 'knowledge', row.id);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM knowledge_file WHERE knowledge_id = ?1').bind(row.id),
		c.env.DB.prepare('UPDATE file_chunk SET knowledge_id = NULL WHERE knowledge_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM knowledge WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

app.post('/reindex', async (c) => {
	verifiedUser(c);
	return c.json(true);
});

// External knowledge connectors are an enterprise feature upstream; the UI
// still probes these endpoints, so answer with empty collections.
app.get('/external/connections', async (c) => {
	verifiedUser(c);
	return c.json([]);
});

export default app;
