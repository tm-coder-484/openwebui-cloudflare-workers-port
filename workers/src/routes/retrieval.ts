/** `/api/v1/retrieval` — RAG settings plus web/URL ingestion. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { indexChunks, search } from '../lib/retrieval';
import { sha256Hex } from '../lib/crypto';
import { bad, now, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const RAG_KEYS: Record<string, string> = {
	TOP_K: 'rag.top_k',
	CHUNK_SIZE: 'rag.chunk_size',
	CHUNK_OVERLAP: 'rag.chunk_overlap',
	RAG_TEMPLATE: 'rag.template',
	RAG_FULL_CONTEXT: 'rag.full_context',
	ENABLE_RAG_HYBRID_SEARCH: 'rag.hybrid_search',
	RAG_EMBEDDING_ENGINE: 'rag.embedding_engine',
	RAG_EMBEDDING_MODEL: 'rag.embedding_model',
	FILE_MAX_SIZE: 'rag.file.max_size',
	FILE_MAX_COUNT: 'rag.file.max_count',
	ENABLE_WEB_SEARCH: 'web.search.enable',
	WEB_SEARCH_ENGINE: 'web.search.engine',
	WEB_SEARCH_RESULT_COUNT: 'web.search.result_count',
	WEB_LOADER_ENGINE: 'web.loader.engine'
};

const readConfig = async (c: any) => {
	const config = await getConfigMany(c.env, Object.values(RAG_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(RAG_KEYS)) out[field] = config[key] ?? null;
	return out;
};

app.get('/config', async (c) => {
	adminUser(c);
	return c.json(await readConfig(c));
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(RAG_KEYS))
		if (field in body) updates[key] = body[field];
	await setConfigMany(c.env, updates);
	return c.json(await readConfig(c));
});

app.get('/embedding', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, ['rag.embedding_engine', 'rag.embedding_model']);
	return c.json({
		embedding_engine: config['rag.embedding_engine'],
		embedding_model: config['rag.embedding_model']
	});
});

app.post('/embedding/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	await setConfigMany(c.env, {
		'rag.embedding_engine': body.embedding_engine,
		'rag.embedding_model': body.embedding_model
	});
	return c.json(body);
});

app.get('/reranking', async (c) => {
	adminUser(c);
	// Reranking needs a cross-encoder model; Workers AI does not expose one, so
	// hybrid search falls back to the retriever's own ordering.
	return c.json({ reranking_model: '' });
});

app.post('/reranking/update', async (c) => {
	adminUser(c);
	return c.json({ reranking_model: '' });
});

app.post('/reset/db', async (c) => {
	adminUser(c);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM file_chunk'),
		c.env.DB.prepare('DELETE FROM knowledge_file')
	]);
	return c.json(true);
});

app.post('/reset/uploads', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare('SELECT id, path FROM file').all<{
		id: string;
		path: string | null;
	}>();
	for (const row of results ?? []) {
		if (row.path) await c.env.FILES.delete(row.path).catch(() => {});
	}
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM file_chunk'),
		c.env.DB.prepare('DELETE FROM knowledge_file'),
		c.env.DB.prepare('DELETE FROM file')
	]);
	return c.json(true);
});

app.post('/process/youtube', async (c) => {
	verifiedUser(c);
	throw bad('YouTube transcript ingestion is not available in the Cloudflare Workers build.');
});

app.get('/query/settings', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, ['rag.top_k', 'rag.template', 'rag.hybrid_search']);
	return c.json({
		k: config['rag.top_k'],
		template: config['rag.template'],
		hybrid: config['rag.hybrid_search']
	});
});

app.post('/query/settings/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	await setConfigMany(c.env, {
		'rag.top_k': body.k,
		'rag.template': body.template,
		'rag.hybrid_search': body.hybrid
	});
	return c.json(body);
});

app.post('/query/doc', async (c) => {
	verifiedUser(c);
	const body = (await c.req.json()) as { file_id?: string; query?: string; k?: number };
	if (!body.file_id) throw bad('file_id is required');
	const results = await search(c.env, body.query ?? '', { fileIds: [body.file_id], topK: body.k });
	return c.json({
		documents: [results.map((chunk) => chunk.content)],
		metadatas: [results.map((chunk) => ({ file_id: chunk.file_id, chunk_index: chunk.idx }))],
		distances: [results.map((chunk) => 1 - chunk.score)]
	});
});

app.post('/query/collection', async (c) => {
	verifiedUser(c);
	const body = (await c.req.json()) as { collection_names?: string[]; query?: string; k?: number };
	const results = await search(c.env, body.query ?? '', {
		knowledgeIds: body.collection_names ?? [],
		topK: body.k
	});
	return c.json({
		documents: [results.map((chunk) => chunk.content)],
		metadatas: [results.map((chunk) => ({ file_id: chunk.file_id, chunk_index: chunk.idx }))],
		distances: [results.map((chunk) => 1 - chunk.score)]
	});
});

/** Fetches a page and stores it as a file so it can be cited like any upload. */
app.post('/process/web', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { url?: string; collection_name?: string };
	if (!body.url) throw bad('A URL is required');

	const response = await fetch(body.url, {
		headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenWebUI-Workers/1.0)' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) throw bad(`Failed to fetch ${body.url}: ${response.status}`);

	const html = await response.text();
	const text = htmlToText(html);
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO file (id, user_id, hash, filename, path, data, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?7)`
	)
		.bind(
			id,
			user.id,
			await sha256Hex(text),
			body.url,
			toJSON({ content: text }),
			toJSON({ name: body.url, content_type: 'text/html', source: body.url }),
			timestamp
		)
		.run();
	await indexChunks(c.env, { fileId: id, userId: user.id, text });

	return c.json({
		status: true,
		collection_name: body.collection_name ?? id,
		filename: body.url,
		file: { id, filename: body.url, meta: { name: body.url, source: body.url } }
	});
});

app.post('/process/url', async (c) => c.redirect('/api/v1/retrieval/process/web', 307));

app.post('/process/web/search', async (c) => {
	verifiedUser(c);
	throw bad(
		'Web search is not configured. Point WEB_SEARCH_ENGINE at a provider that exposes an HTTP API.'
	);
});

/** Crude tag stripper — enough to make a page searchable without a DOM. */
function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
}

export default app;
