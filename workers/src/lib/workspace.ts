/**
 * Finding things in a user's workspace.
 *
 * The read-only half of a coding assistant's toolkit, aimed at what this app
 * actually has instead of a filesystem: files are rows in D1, and there is a
 * second corpus a shell never has — the user's own past conversations.
 *
 * Everything here is scoped to a user id, and nothing here writes.
 */

import type { Env } from '../types';
import { scoreChunks } from './retrieval';
import { parseJSON } from './util';

/** Glob patterns are matched against file names, so the syntax stays small. */
export function globToRegExp(pattern: string): RegExp {
	let source = '';
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === '*') {
			// `**` crosses separators, `*` does not — the same distinction a shell
			// makes, kept so a pattern copied from one behaves as expected here.
			if (pattern[i + 1] === '*') {
				source += '.*';
				i += 1;
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`, 'i');
}

interface FileRow {
	id: string;
	filename: string;
	data: string;
	updated_at: number;
}

const contentOf = (row: FileRow) =>
	String(parseJSON<{ content?: string }>(row.data, {}).content ?? '');

async function userFileRows(env: Env, userId: string): Promise<FileRow[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, filename, data, updated_at FROM file WHERE user_id = ?1 ORDER BY updated_at DESC'
	)
		.bind(userId)
		.all<FileRow>();
	return results ?? [];
}

export interface GlobHit {
	filename: string;
	characters: number;
	updated_at: number;
}

export async function globFiles(env: Env, userId: string, pattern: string): Promise<GlobHit[]> {
	const matcher = globToRegExp(pattern.trim() || '*');
	return (await userFileRows(env, userId))
		.filter((row) => matcher.test(row.filename))
		.map((row) => ({
			filename: row.filename,
			characters: contentOf(row).length,
			updated_at: row.updated_at
		}));
}

export interface GrepHit {
	filename: string;
	line: number;
	text: string;
}

/**
 * A pattern this long is not a search, and the risk with a user-supplied regex
 * is a catastrophically backtracking one. A Worker's CPU limit ends such a
 * request rather than the isolate, but there is no reason to invite it.
 */
const MAX_PATTERN = 200;
const MAX_HITS = 100;

export async function grepFiles(
	env: Env,
	userId: string,
	pattern: string,
	options: { glob?: string; ignoreCase?: boolean } = {}
): Promise<{ hits: GrepHit[]; filesSearched: number; error?: string }> {
	if (pattern.length > MAX_PATTERN) {
		return {
			hits: [],
			filesSearched: 0,
			error: `The pattern is longer than ${MAX_PATTERN} characters.`
		};
	}

	let matcher: RegExp;
	try {
		matcher = new RegExp(pattern, options.ignoreCase === false ? '' : 'i');
	} catch (error) {
		return {
			hits: [],
			filesSearched: 0,
			error: `Not a valid regular expression: ${(error as Error).message}`
		};
	}

	const rows = (await userFileRows(env, userId)).map((row) => ({
		filename: row.filename,
		content: contentOf(row)
	}));
	return grepIn(rows, pattern, options);
}

/**
 * The matching itself, over files already loaded.
 *
 * Shared by the workspace path and the knowledge path so the two cannot drift —
 * the cap, the line numbering and the truncation are defined once.
 */
export function grepIn(
	files: { filename: string; content: string }[],
	pattern: string,
	options: { glob?: string; ignoreCase?: boolean } = {}
): { hits: GrepHit[]; filesSearched: number; error?: string } {
	if (pattern.length > MAX_PATTERN) {
		return {
			hits: [],
			filesSearched: 0,
			error: `The pattern is longer than ${MAX_PATTERN} characters.`
		};
	}
	let matcher: RegExp;
	try {
		matcher = new RegExp(pattern, options.ignoreCase === false ? '' : 'i');
	} catch (error) {
		return {
			hits: [],
			filesSearched: 0,
			error: `Not a valid regular expression: ${(error as Error).message}`
		};
	}

	const nameFilter = options.glob ? globToRegExp(options.glob) : null;
	const rows = files.filter((file) => !nameFilter || nameFilter.test(file.filename));

	const hits: GrepHit[] = [];
	for (const row of rows) {
		const lines = row.content.split('\n');
		for (let index = 0; index < lines.length; index += 1) {
			if (!matcher.test(lines[index])) continue;
			hits.push({ filename: row.filename, line: index + 1, text: lines[index].slice(0, 300) });
			if (hits.length >= MAX_HITS) return { hits, filesSearched: rows.length };
		}
	}
	return { hits, filesSearched: rows.length };
}

export interface ChatHit {
	chat_id: string;
	title: string;
	role: string;
	excerpt: string;
	created_at: number;
}

/**
 * Searches the user's own past messages.
 *
 * Prefiltered in SQL on any one term so the ranking never loads a whole history
 * into memory, then ranked with the same scorer retrieval uses.
 */
export async function searchChats(
	env: Env,
	userId: string,
	query: string,
	limit = 8
): Promise<ChatHit[]> {
	const terms = (query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
		.filter((term) => term.length > 2)
		.slice(0, 6);
	if (!terms.length) return [];

	const where = terms.map(() => 'lower(m.content) LIKE ?').join(' OR ');
	const { results } = await env.DB.prepare(
		`SELECT m.id, m.chat_id, m.role, m.content, m.created_at, c.title
		 FROM chat_message m JOIN chat c ON c.id = m.chat_id
		 WHERE m.user_id = ? AND m.content IS NOT NULL AND (${where})
		 ORDER BY m.created_at DESC LIMIT 200`
	)
		.bind(userId, ...terms.map((term) => `%${term}%`))
		.all<{
			id: string;
			chat_id: string;
			role: string;
			content: string;
			created_at: number;
			title: string;
		}>();

	const rows = results ?? [];
	if (!rows.length) return [];

	const ranked = scoreChunks(
		query,
		rows.map((row) => ({ id: row.id, content: row.content }))
	).slice(0, limit);
	const byId = new Map(rows.map((row) => [row.id, row]));

	return ranked
		.map((item) => byId.get(item.id))
		.filter(Boolean)
		.map((row) => ({
			chat_id: row!.chat_id,
			title: row!.title || 'Untitled chat',
			role: row!.role,
			excerpt: row!.content.replace(/\s+/g, ' ').slice(0, 300),
			created_at: row!.created_at
		}));
}
