/**
 * Retrieval for knowledge bases and file context.
 *
 * Two modes:
 *  - Vector search through Workers AI embeddings + Vectorize, when a
 *    `VECTORIZE` binding is present.
 *  - A dependency-free TF-IDF-ish keyword score over the `file_chunk` table
 *    otherwise, so `wrangler dev` works with nothing but D1.
 */

import type { Env } from '../types';
import { getConfig } from './config';
import { now, uuid } from './util';

export interface Chunk {
	id: string;
	content: string;
	file_id?: string;
	knowledge_id?: string | null;
	idx?: number;
}

export interface ScoredChunk extends Chunk {
	score: number;
}

const STOP_WORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'with',
	'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'as', 'at', 'by', 'from'
]);

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
		(token) => token.length > 1 && !STOP_WORDS.has(token)
	);
}

/** Splits text into overlapping chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, chunkSize = 1000, overlap = 100): string[] {
	const clean = text.replace(/\r\n/g, '\n').trim();
	if (!clean) return [];
	if (clean.length <= chunkSize) return [clean];

	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < clean.length) {
		let end = Math.min(cursor + chunkSize, clean.length);
		if (end < clean.length) {
			// Prefer breaking at a paragraph, then a sentence, then a space.
			const window = clean.slice(cursor, end);
			const breakAt = Math.max(
				window.lastIndexOf('\n\n'),
				window.lastIndexOf('. '),
				window.lastIndexOf(' ')
			);
			if (breakAt > chunkSize * 0.5) end = cursor + breakAt + 1;
		}
		chunks.push(clean.slice(cursor, end).trim());
		cursor = end - overlap;
		if (cursor < 0) cursor = 0;
		if (end >= clean.length) break;
	}
	return chunks.filter(Boolean);
}

/** Lightweight lexical ranking used when no vector index is configured. */
export function scoreChunks<T extends Chunk>(query: string, chunks: T[]): (T & { score: number })[] {
	const queryTokens = tokenize(query);
	if (!queryTokens.length) return [];

	const documentFrequency = new Map<string, number>();
	const tokenized = chunks.map((chunk) => {
		const tokens = new Set(tokenize(chunk.content));
		for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		return tokens;
	});

	return chunks
		.map((chunk, index) => {
			const tokens = tokenized[index];
			let score = 0;
			for (const token of queryTokens) {
				if (!tokens.has(token)) continue;
				const df = documentFrequency.get(token) ?? 1;
				score += Math.log(1 + chunks.length / df);
			}
			return { ...chunk, score: score / Math.max(queryTokens.length, 1) };
		})
		.filter((chunk) => chunk.score > 0)
		.sort((a, b) => b.score - a.score);
}

export async function embed(env: Env, texts: string[]): Promise<number[][] | null> {
	if (!env.AI) return null;
	const model = await getConfig<string>(env, 'rag.embedding_model');
	try {
		const result = (await env.AI.run(model as any, { text: texts } as any)) as any;
		return result?.data ?? null;
	} catch (error) {
		console.warn('[open-webui] embedding failed:', error);
		return null;
	}
}

export async function indexChunks(
	env: Env,
	options: { fileId: string; knowledgeId?: string | null; userId: string; text: string }
): Promise<number> {
	const chunkSize = await getConfig<number>(env, 'rag.chunk_size');
	const overlap = await getConfig<number>(env, 'rag.chunk_overlap');
	const chunks = chunkText(options.text, chunkSize ?? 1000, overlap ?? 100);
	if (!chunks.length) return 0;

	const timestamp = now();
	const rows = chunks.map((content, idx) => ({ id: uuid(), content, idx }));

	await env.DB.prepare('DELETE FROM file_chunk WHERE file_id = ?1').bind(options.fileId).run();
	// D1 batches are capped; 50 statements at a time keeps well inside limits.
	for (let offset = 0; offset < rows.length; offset += 50) {
		await env.DB.batch(
			rows.slice(offset, offset + 50).map((row) =>
				env.DB.prepare(
					`INSERT INTO file_chunk (id, file_id, knowledge_id, user_id, idx, content, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
				).bind(row.id, options.fileId, options.knowledgeId ?? null, options.userId, row.idx, row.content, timestamp)
			)
		);
	}

	if (env.VECTORIZE) {
		const vectors = await embed(env, rows.map((row) => row.content));
		if (vectors) {
			await env.VECTORIZE.upsert(
				rows.map((row, index) => ({
					id: row.id,
					values: vectors[index],
					metadata: {
						file_id: options.fileId,
						knowledge_id: options.knowledgeId ?? '',
						user_id: options.userId
					}
				}))
			).catch((error: unknown) => console.warn('[open-webui] vectorize upsert failed:', error));
		}
	}

	return rows.length;
}

export async function removeChunks(env: Env, fileId: string): Promise<void> {
	const { results } = await env.DB.prepare('SELECT id FROM file_chunk WHERE file_id = ?1')
		.bind(fileId)
		.all<{ id: string }>();
	await env.DB.prepare('DELETE FROM file_chunk WHERE file_id = ?1').bind(fileId).run();
	if (env.VECTORIZE && results?.length) {
		await env.VECTORIZE.deleteByIds(results.map((row) => row.id)).catch(() => {});
	}
}

export async function search(
	env: Env,
	query: string,
	options: { fileIds?: string[]; knowledgeIds?: string[]; topK?: number } = {}
): Promise<ScoredChunk[]> {
	const topK = options.topK ?? (await getConfig<number>(env, 'rag.top_k')) ?? 3;

	const clauses: string[] = [];
	const bindings: unknown[] = [];
	if (options.fileIds?.length) {
		clauses.push(`file_id IN (${options.fileIds.map(() => '?').join(', ')})`);
		bindings.push(...options.fileIds);
	}
	if (options.knowledgeIds?.length) {
		clauses.push(`knowledge_id IN (${options.knowledgeIds.map(() => '?').join(', ')})`);
		bindings.push(...options.knowledgeIds);
	}
	if (!clauses.length) return [];

	const { results } = await env.DB.prepare(
		`SELECT id, file_id, knowledge_id, idx, content FROM file_chunk WHERE ${clauses.join(' OR ')}`
	)
		.bind(...bindings)
		.all<Chunk>();

	const chunks = results ?? [];
	if (!chunks.length) return [];

	if (env.VECTORIZE) {
		const embedded = await embed(env, [query]);
		if (embedded?.[0]) {
			try {
				const matches = await env.VECTORIZE.query(embedded[0], { topK: topK * 3 });
				const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
				const scored = (matches?.matches ?? [])
					.map((match: any) => {
						const chunk = byId.get(match.id);
						return chunk ? { ...chunk, score: match.score as number } : null;
					})
					.filter(Boolean) as ScoredChunk[];
				if (scored.length) return scored.slice(0, topK);
			} catch (error) {
				console.warn('[open-webui] vector query failed, falling back to keyword search:', error);
			}
		}
	}

	return scoreChunks(query, chunks).slice(0, topK);
}
