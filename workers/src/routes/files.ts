/** `/api/v1/files` — uploads stored in R2, metadata in D1, text indexed for RAG. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, currentUser, verifiedUser } from '../lib/auth';
import { hasAccess } from '../lib/access';
import { indexChunks, removeChunks } from '../lib/retrieval';
import { sha256Hex } from '../lib/crypto';
import { bad, clampInt, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface FileRow {
	id: string;
	user_id: string;
	hash: string | null;
	filename: string;
	path: string | null;
	data: string | null;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: FileRow) => ({
	id: row.id,
	user_id: row.user_id,
	hash: row.hash,
	filename: row.filename,
	path: row.path,
	data: parseJSON<Record<string, unknown>>(row.data, {}),
	meta: parseJSON<Record<string, unknown>>(row.meta, {}),
	created_at: row.created_at,
	updated_at: row.updated_at
});

/** Text-ish uploads get chunked for retrieval; binaries are stored as-is. */
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|x-python))/;
const TEXT_EXTENSIONS =
	/\.(txt|md|markdown|csv|tsv|json|yaml|yml|xml|html|htm|css|js|ts|py|go|rs|java|c|h|cpp|hpp|sh|bat|ps1|sql|log|ini|conf|toml|env|svelte|vue)$/i;

const isTextFile = (filename: string, contentType: string) =>
	TEXT_TYPES.test(contentType) || TEXT_EXTENSIONS.test(filename);

/** Stores one upload in R2, records it in D1, and indexes any text content. */
async function storeUpload(c: any, userId: string, file: File, collectionName = '') {
	const id = uuid();
	const buffer = await file.arrayBuffer();
	const hash = await sha256Hex(buffer);
	const key = `${userId}/${id}/${file.name}`;
	const contentType = file.type || 'application/octet-stream';

	await c.env.FILES.put(key, buffer, { httpMetadata: { contentType } });

	const timestamp = now();
	const meta = {
		name: file.name,
		content_type: contentType,
		size: file.size,
		...(collectionName ? { collection_name: collectionName } : {})
	};

	const content = isTextFile(file.name, contentType) ? new TextDecoder().decode(buffer) : '';

	await c.env.DB.prepare(
		`INSERT INTO file (id, user_id, hash, filename, path, data, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
	)
		.bind(id, userId, hash, file.name, key, toJSON({ content }), toJSON(meta), timestamp)
		.run();

	if (content) {
		c.executionCtx?.waitUntil?.(
			indexChunks(c.env, { fileId: id, userId, text: content }).catch((error: unknown) =>
				console.warn('[open-webui] indexing failed:', error)
			)
		);
	}

	const row = (await c.env.DB.prepare('SELECT * FROM file WHERE id = ?1')
		.bind(id)
		.first()) as FileRow;
	return serialize(row);
}

app.post('/', async (c) => {
	const user = verifiedUser(c);
	const form = await c.req.formData();
	const file = form.get('file') as unknown as File | null;
	if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
		throw bad('No file was uploaded.');
	}
	return c.json(await storeUpload(c, user.id, file, (form.get('collection_name') as string) ?? ''));
});

/** Directory upload: the browser posts several files under the same field. */
app.post('/upload/dir', async (c) => {
	const user = verifiedUser(c);
	const form = await c.req.formData();
	const entries = form.getAll('files').concat(form.getAll('file')) as unknown as File[];
	const uploaded = [];
	for (const file of entries) {
		if (!file || typeof (file as any).arrayBuffer !== 'function') continue;
		uploaded.push(await storeUpload(c, user.id, file, (form.get('path') as string) ?? ''));
	}
	if (!uploaded.length) throw bad('No files were uploaded.');
	return c.json(uploaded);
});

app.get('/', async (c) => {
	const user = verifiedUser(c);
	const page = c.req.query('page') ? clampInt(c.req.query('page'), 1, 100_000, 1) : 1;
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM file WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`
	)
		.bind(user.id)
		.all<FileRow>();
	return c.json((results ?? []).map(serialize));
});

app.get('/all', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM file ORDER BY created_at DESC'
	).all<FileRow>();
	return c.json((results ?? []).map(serialize));
});

app.get('/count', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM file WHERE user_id = ?1')
		.bind(user.id)
		.first<{ count: number }>();
	return c.json({ count: row?.count ?? 0 });
});

app.get('/search', async (c) => {
	const user = verifiedUser(c);
	const query = (c.req.query('filename') ?? c.req.query('query') ?? '').toLowerCase();
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM file WHERE user_id = ?1 AND lower(filename) LIKE ?2 ORDER BY created_at DESC LIMIT 50'
	)
		.bind(user.id, `%${query}%`)
		.all<FileRow>();
	return c.json((results ?? []).map(serialize));
});

async function loadFile(c: any, id: string): Promise<FileRow> {
	const user = currentUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM file WHERE id = ?1')
		.bind(id)
		.first()) as FileRow | null;
	if (!row) throw notFound('File not found');
	if (row.user_id !== user.id && !(await hasAccess(c.env, user, 'file', row.id, row.user_id))) {
		throw forbidden();
	}
	return row;
}

app.get('/:id', async (c) => c.json(serialize(await loadFile(c, c.req.param('id')))));

app.get('/:id/content', async (c) => {
	const row = await loadFile(c, c.req.param('id'));
	const object = row.path ? await c.env.FILES.get(row.path) : null;
	if (!object) {
		// Fall back to the inline copy kept for text uploads.
		const data = parseJSON<{ content?: string }>(row.data, {});
		if (data.content) return c.text(data.content);
		throw notFound('File content not found');
	}
	const meta = parseJSON<{ content_type?: string }>(row.meta, {});
	const headers = new Headers();
	headers.set('Content-Type', meta.content_type ?? 'application/octet-stream');
	headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
	return new Response(object.body, { headers });
});

app.get('/:id/content/:filename', async (c) => {
	const row = await loadFile(c, c.req.param('id'));
	const object = row.path ? await c.env.FILES.get(row.path) : null;
	if (!object) throw notFound('File content not found');
	const meta = parseJSON<{ content_type?: string }>(row.meta, {});
	return new Response(object.body, {
		headers: { 'Content-Type': meta.content_type ?? 'application/octet-stream' }
	});
});

app.post('/:id/data/content/update', async (c) => {
	const row = await loadFile(c, c.req.param('id'));
	const { content } = (await c.req.json()) as { content: string };
	await c.env.DB.prepare('UPDATE file SET data = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(toJSON({ content }), now(), row.id)
		.run();
	if (row.path) await c.env.FILES.put(row.path, content);
	c.executionCtx?.waitUntil?.(
		indexChunks(c.env, { fileId: row.id, userId: row.user_id, text: content }).catch(() => {})
	);
	const updated = await c.env.DB.prepare('SELECT * FROM file WHERE id = ?1')
		.bind(row.id)
		.first<FileRow>();
	return c.json(serialize(updated!));
});

app.post('/:id/rename', async (c) => {
	const row = await loadFile(c, c.req.param('id'));
	const { filename } = (await c.req.json()) as { filename: string };
	if (!filename) throw bad('A filename is required');
	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	meta.name = filename;
	await c.env.DB.prepare('UPDATE file SET filename = ?1, meta = ?2, updated_at = ?3 WHERE id = ?4')
		.bind(filename, toJSON(meta), now(), row.id)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM file WHERE id = ?1')
		.bind(row.id)
		.first<FileRow>();
	return c.json(serialize(updated!));
});

app.get('/:id/process/status', async (c) => {
	const row = await loadFile(c, c.req.param('id'));
	const chunks = await c.env.DB.prepare(
		'SELECT COUNT(*) AS count FROM file_chunk WHERE file_id = ?1'
	)
		.bind(row.id)
		.first<{ count: number }>();
	return c.json({ status: 'completed', chunks: chunks?.count ?? 0 });
});

app.delete('/:id', async (c) => {
	const row = await loadFile(c, c.req.param('id'));
	if (row.path) await c.env.FILES.delete(row.path).catch(() => {});
	await removeChunks(c.env, row.id);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM knowledge_file WHERE file_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM file WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

app.delete('/all', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT path FROM file').all<{ path: string }>();
	for (const row of results ?? []) if (row.path) await c.env.FILES.delete(row.path).catch(() => {});
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM file_chunk'),
		c.env.DB.prepare('DELETE FROM knowledge_file'),
		c.env.DB.prepare('DELETE FROM file')
	]);
	return c.json(true);
});

export default app;
