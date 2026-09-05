/** `/api/v1/knowledge` — knowledge bases (collections of indexed files). */

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
import { indexChunks, removeChunks, search } from '../lib/retrieval';
import { bad, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';
import { PAGE_SIZE, listPage, readListingQuery } from '../lib/listing';

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
		`SELECT f.*, k.directory_id AS directory_id FROM file f
		 JOIN knowledge_file k ON k.file_id = f.id
		 WHERE k.knowledge_id = ?1 ORDER BY f.created_at DESC`
	)
		.bind(knowledgeId)
		.all();
	return ((results ?? []) as any[]).map((row) => ({
		id: row.id,
		user_id: row.user_id,
		filename: row.filename,
		directory_id: row.directory_id ?? null,
		meta: parseJSON<Record<string, unknown>>(row.meta, {}),
		data: parseJSON<Record<string, unknown>>(row.data, {}),
		created_at: row.created_at,
		updated_at: row.updated_at
	}));
}

async function directoriesFor(c: any, knowledgeId: string) {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM knowledge_directory WHERE knowledge_id = ?1 ORDER BY name ASC'
	)
		.bind(knowledgeId)
		.all();
	return results ?? [];
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
		...(withFiles
			? { files: await filesFor(c, row.id), directories: await directoriesFor(c, row.id) }
			: {}),
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
	const grants = await listGrants(
		c.env,
		'knowledge',
		rows.map((row) => row.id)
	);
	return c.json(await Promise.all(rows.map((row) => serialize(c, row, grants.get(row.id) ?? []))));
});

app.get('/list', async (c) => {
	const rows = await visible(c);
	const grants = await listGrants(
		c.env,
		'knowledge',
		rows.map((row) => row.id)
	);
	return c.json(
		await Promise.all(rows.map((row) => serialize(c, row, grants.get(row.id) ?? [], false)))
	);
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
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'knowledge', id, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM knowledge WHERE id = ?1')
		.bind(id)
		.first<KnowledgeRow>();
	return c.json(await serialize(c, row!));
});

/**
 * Both search endpoints answer `{items, total, page}`.
 *
 * A bare array is what they used to return, and the knowledge pickers do
 * `res.items.map(...)` with no guard — so attaching knowledge from the composer
 * threw "Cannot read properties of undefined (reading 'map')" and the panel
 * never opened. The workspace screen survived only because it happens to write
 * `res.items ?? []`, and its result count was silently always undefined.
 */

const paginate = <T>(items: T[], page: number) => ({
	items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
	total: items.length,
	page
});

app.get('/search', async (c) => {
	const user = verifiedUser(c);
	const rows = await visible(c);
	const options = readListingQuery(c);
	// Serialised first: the sort and the "created / shared with me" filter read
	// the same fields the screen displays, rather than a second set of names.
	const serialized = await Promise.all(rows.map((row) => serialize(c, row, [], false)));
	const window = listPage(serialized, options, user.id);
	return c.json({
		...window,
		items: await Promise.all(
			window.items.map((row) => serialize(c, rows.find((r) => r.id === row.id)!))
		)
	});
});

/**
 * The *files* inside the visible knowledge bases — not retrieval chunks, which
 * is what this returned before. The picker renders `item.filename` and
 * `item.collection.name`, so a chunk gave it nothing to show even once the
 * wrapper was right.
 */
app.get('/search/files', async (c) => {
	verifiedUser(c);
	const query = (c.req.query('query') ?? '').toLowerCase();
	const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
	const knowledgeId = c.req.query('knowledge_id');

	const bases = (await visible(c)).filter((row) => !knowledgeId || row.id === knowledgeId);
	const items: Record<string, unknown>[] = [];
	for (const base of bases) {
		for (const file of await filesFor(c, base.id)) {
			if (query && !String(file.filename).toLowerCase().includes(query)) continue;
			items.push({ ...file, collection: { id: base.id, name: base.name } });
		}
	}
	return c.json(paginate(items, page));
});

async function load(c: any, id: string, permission: 'read' | 'write' = 'read') {
	const user = verifiedUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM knowledge WHERE id = ?1')
		.bind(id)
		.first()) as KnowledgeRow | null;
	if (!row) throw notFound('Knowledge base not found');
	if (!(await hasAccess(c.env, user, 'knowledge', row.id, row.user_id, permission)))
		throw forbidden();
	return { row, user };
}

app.get('/:id', async (c) => {
	const { row } = await load(c, c.req.param('id'));
	const grants = (await listGrants(c.env, 'knowledge', [row.id])).get(row.id) ?? [];
	return c.json(await serialize(c, row, grants));
});

/**
 * The detail screen reads `res.items`, `res.total`, `res.directories` and
 * `res.breadcrumbs`, assigning each straight through. A bare array left
 * `fileItems` undefined and the template then read `.length` off it, so opening
 * a knowledge base rendered nothing and threw.
 */
app.get('/:id/files', async (c) => {
	const { row } = await load(c, c.req.param('id'));
	const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
	const query = (c.req.query('query') ?? '').toLowerCase();

	const all = await filesFor(c, row.id);
	const matched = query
		? all.filter((file) => String(file.filename).toLowerCase().includes(query))
		: all;

	return c.json({
		...paginate(matched, page),
		directories: await directoriesFor(c, row.id),
		breadcrumbs: []
	});
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
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'knowledge', row.id, body.access_grants);
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
	const chunks = await c.env.DB.prepare(
		'SELECT COUNT(*) AS count FROM file_chunk WHERE file_id = ?1'
	)
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
		c.env.DB.prepare('DELETE FROM knowledge_file WHERE knowledge_id = ?1 AND file_id = ?2').bind(
			row.id,
			file_id
		),
		c.env.DB.prepare(
			'UPDATE file_chunk SET knowledge_id = NULL WHERE file_id = ?1 AND knowledge_id = ?2'
		).bind(file_id, row.id)
	]);
	return c.json(await serialize(c, row));
});

app.get('/:id/export', async (c) => {
	const { row } = await load(c, c.req.param('id'));
	const files = await filesFor(c, row.id);
	return c.json({ ...(await serialize(c, row, [], false)), files });
});

app.post('/:id/file/update', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const { file_id } = (await c.req.json()) as { file_id: string };
	const file = await c.env.DB.prepare('SELECT * FROM file WHERE id = ?1')
		.bind(file_id)
		.first<{ id: string; user_id: string; data: string }>();
	if (!file) throw notFound('File not found');
	const content = parseJSON<{ content?: string }>(file.data, {}).content ?? '';
	if (content) {
		await indexChunks(c.env, {
			fileId: file_id,
			knowledgeId: row.id,
			userId: file.user_id,
			text: content
		});
	}
	return c.json(await serialize(c, row));
});

app.get('/:id/files/pending', async (c) => {
	// Indexing happens inline on upload, so nothing is ever pending.
	await load(c, c.req.param('id'));
	return c.json([]);
});

app.post('/:id/dirs/create', async (c) => {
	const { row, user } = await load(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as { name?: string; parent_id?: string | null };
	if (!body.name) throw bad('A directory name is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO knowledge_directory (id, knowledge_id, parent_id, name, user_id, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
	)
		.bind(id, row.id, body.parent_id ?? null, body.name, user.id, timestamp)
		.run();
	const dir = await c.env.DB.prepare('SELECT * FROM knowledge_directory WHERE id = ?1')
		.bind(id)
		.first();
	return c.json(dir);
});

app.post('/:id/dirs/:dirId/update', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as { name?: string; parent_id?: string | null };
	const dirId = c.req.param('dirId');
	if (body.parent_id === dirId) throw bad('A directory cannot be its own parent.');
	const existing = await c.env.DB.prepare(
		'SELECT * FROM knowledge_directory WHERE id = ?1 AND knowledge_id = ?2'
	)
		.bind(dirId, row.id)
		.first<any>();
	if (!existing) throw notFound('Directory not found');

	await c.env.DB.prepare(
		'UPDATE knowledge_directory SET name = ?1, parent_id = ?2, updated_at = ?3 WHERE id = ?4'
	)
		.bind(
			body.name ?? existing.name,
			body.parent_id === undefined ? existing.parent_id : body.parent_id,
			now(),
			dirId
		)
		.run();
	const dir = await c.env.DB.prepare('SELECT * FROM knowledge_directory WHERE id = ?1')
		.bind(dirId)
		.first();
	return c.json(dir);
});

app.delete('/:id/dirs/:dirId/delete', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const dirId = c.req.param('dirId');
	// Children and files move up to the parent rather than disappearing.
	const existing = await c.env.DB.prepare(
		'SELECT * FROM knowledge_directory WHERE id = ?1 AND knowledge_id = ?2'
	)
		.bind(dirId, row.id)
		.first<any>();
	if (!existing) throw notFound('Directory not found');

	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE knowledge_directory SET parent_id = ?1 WHERE parent_id = ?2').bind(
			existing.parent_id ?? null,
			dirId
		),
		c.env.DB.prepare('UPDATE knowledge_file SET directory_id = ?1 WHERE directory_id = ?2').bind(
			existing.parent_id ?? null,
			dirId
		),
		c.env.DB.prepare('DELETE FROM knowledge_directory WHERE id = ?1').bind(dirId)
	]);
	return c.json(true);
});

app.post('/:id/file/move', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as { file_id?: string; directory_id?: string | null };
	if (!body.file_id) throw bad('file_id is required');
	if (body.directory_id) {
		const dir = await c.env.DB.prepare(
			'SELECT id FROM knowledge_directory WHERE id = ?1 AND knowledge_id = ?2'
		)
			.bind(body.directory_id, row.id)
			.first();
		if (!dir) throw notFound('Directory not found');
	}
	await c.env.DB.prepare(
		'UPDATE knowledge_file SET directory_id = ?1 WHERE knowledge_id = ?2 AND file_id = ?3'
	)
		.bind(body.directory_id ?? null, row.id, body.file_id)
		.run();
	return c.json(await serialize(c, row));
});

app.post('/:id/reset', async (c) => {
	const { row } = await load(c, c.req.param('id'), 'write');
	const { results } = await c.env.DB.prepare(
		'SELECT file_id FROM knowledge_file WHERE knowledge_id = ?1'
	)
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
		c.env.DB.prepare('UPDATE file_chunk SET knowledge_id = NULL WHERE knowledge_id = ?1').bind(
			row.id
		),
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
