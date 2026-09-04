/** `/api/v1/retrieval` — RAG settings plus web/URL ingestion. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { indexChunks, search } from '../lib/retrieval';
import { fetchPageText, resultText, webSearch } from '../lib/websearch';
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
	ENABLE_WEB_SEARCH: 'web.search.enable'
};

/**
 * Web settings live under a `web` object in the response, not alongside the RAG
 * ones. The admin screen does `webConfig = res.web` and dereferences it
 * immediately, so a flat payload leaves it undefined and the whole Web Search
 * tab fails to mount rather than degrading.
 */
const WEB_KEYS: Record<string, string> = {
	ENABLE_WEB_SEARCH: 'web.search.enable',
	WEB_SEARCH_ENGINE: 'web.search.engine',
	WEB_SEARCH_API_KEY: 'web.search.api_key',
	GOOGLE_PSE_API_KEY: 'web.search.google_pse.api_key',
	GOOGLE_PSE_ENGINE_ID: 'web.search.google_pse.engine_id',
	WEB_SEARCH_URL: 'web.search.url',
	SEARXNG_QUERY_URL: 'web.search.url',
	SEARXNG_LANGUAGE: 'web.search.searxng.language',
	// The screen renders this field for the `ollama_cloud` engine; without it in
	// the map the value was accepted, discarded, and came back blank on reload.
	OLLAMA_CLOUD_WEB_SEARCH_API_KEY: 'web.search.ollama_cloud.api_key',
	WEB_SEARCH_RESULT_COUNT: 'web.search.result_count',
	WEB_LOADER_ENGINE: 'web.loader.engine',
	WEB_SEARCH_DOMAIN_FILTER_LIST: 'web.search.domain_filter_list',
	YOUTUBE_LOADER_LANGUAGE: 'web.loader.youtube_language',
	BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL: 'web.search.bypass_embedding',
	BYPASS_WEB_SEARCH_WEB_LOADER: 'web.search.bypass_loader',
	ENABLE_WEB_LOADER_SSL_VERIFICATION: 'web.loader.ssl_verification',
	ENABLE_WEB_SEARCH_CONFIRMATION: 'web.search.confirmation.enable',
	WEB_SEARCH_CONCURRENT_REQUESTS: 'web.search.concurrent_requests',
	WEB_LOADER_CONCURRENT_REQUESTS: 'web.loader.concurrent_requests'
};

const readConfig = async (c: any) => {
	const config = await getConfigMany(c.env, [
		...Object.values(RAG_KEYS),
		...Object.values(WEB_KEYS)
	]);
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(RAG_KEYS)) out[field] = config[key] ?? null;

	const web: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(WEB_KEYS)) web[field] = config[key] ?? null;
	// The screen calls .join(',') on these two when they are arrays and expects a
	// string otherwise; null would render as "null" in the input.
	web.WEB_SEARCH_DOMAIN_FILTER_LIST = web.WEB_SEARCH_DOMAIN_FILTER_LIST ?? '';
	web.YOUTUBE_LOADER_LANGUAGE = web.YOUTUBE_LOADER_LANGUAGE ?? '';

	out.web = web;
	// Kept flat as well: other callers (and this port's own smoke test) read the
	// web fields from the top level.
	for (const [field, value] of Object.entries(web)) if (!(field in out)) out[field] = value;
	return out;
};

app.get('/config', async (c) => {
	adminUser(c);
	return c.json(await readConfig(c));
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	// The screen posts web settings back under `web`; accept either shape so a
	// flat client keeps working.
	const web = (body.web ?? {}) as Record<string, unknown>;
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(RAG_KEYS))
		if (field in body) updates[key] = body[field];
	for (const [field, key] of Object.entries(WEB_KEYS)) {
		const value = field in web ? web[field] : field in body ? body[field] : undefined;
		if (value === undefined) continue;
		// Arrays come back from the two list fields; store them as the strings the
		// screen expects to read next time.
		updates[key] = Array.isArray(value) ? value.join(',') : value;
	}
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

/**
 * Runs a web search, stores each result page as a file, and returns the
 * documents so the caller can cite them.
 */
app.post('/process/web/search', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { query?: string; queries?: string[] };
	const queries = body.queries?.length ? body.queries : body.query ? [body.query] : [];
	if (!queries.length) throw bad('A search query is required');

	const seen = new Set<string>();
	const results = [];
	for (const query of queries.slice(0, 3)) {
		for (const result of await webSearch(c.env, query)) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			results.push(result);
		}
	}

	const timestamp = now();
	const docs = [];
	const files = [];
	for (const result of results) {
		const text = await resultText(c.env, result);
		if (!text) continue;

		const id = uuid();
		await c.env.DB.prepare(
			`INSERT INTO file (id, user_id, hash, filename, path, data, meta, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?7)`
		)
			.bind(
				id,
				user.id,
				await sha256Hex(result.url),
				result.title || result.url,
				toJSON({ content: text }),
				toJSON({
					name: result.title || result.url,
					content_type: 'text/html',
					source: result.url,
					snippet: result.snippet
				}),
				timestamp
			)
			.run();
		await indexChunks(c.env, { fileId: id, userId: user.id, text });

		files.push({
			id,
			filename: result.title || result.url,
			meta: { name: result.title || result.url, source: result.url }
		});
		docs.push({
			content: text,
			metadata: { source: result.url, title: result.title, name: result.title || result.url }
		});
	}

	return c.json({
		status: true,
		collection_name: null,
		filenames: results.map((result) => result.url),
		items: results,
		files,
		docs,
		loaded_count: docs.length
	});
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
