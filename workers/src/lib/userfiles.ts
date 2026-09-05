/**
 * Text files in a user's own workspace, addressed by name.
 *
 * This is what the file tools operate on. There is no filesystem here and no
 * shell: a "file" is a row in D1 with its bytes in R2, exactly what an upload
 * produces, so anything the model writes shows up in the Files list, can be
 * attached to a chat, and is indexed for retrieval like any other upload.
 *
 * Every statement is scoped to a user id. A tool call carries the id of the
 * account whose turn it is, so a model cannot reach another user's files by
 * naming them.
 */

import type { Env } from '../types';
import { indexChunks } from './retrieval';
import { sha256Hex } from './crypto';
import { now, parseJSON, toJSON, uuid } from './util';

export interface UserFile {
	id: string;
	filename: string;
	content: string;
	updated_at: number;
}

interface FileRow {
	id: string;
	user_id: string;
	filename: string;
	path: string | null;
	data: string;
	updated_at: number;
}

const contentOf = (row: FileRow) =>
	String(parseJSON<{ content?: string }>(row.data, {}).content ?? '');

const toUserFile = (row: FileRow): UserFile => ({
	id: row.id,
	filename: row.filename,
	content: contentOf(row),
	updated_at: row.updated_at
});

export async function listUserFiles(env: Env, userId: string): Promise<UserFile[]> {
	const { results } = await env.DB.prepare(
		'SELECT id, user_id, filename, path, data, updated_at FROM file WHERE user_id = ?1 ORDER BY updated_at DESC'
	)
		.bind(userId)
		.all<FileRow>();
	return (results ?? []).map(toUserFile);
}

/**
 * Finds one file by id or by name.
 *
 * The model refers to files the way a person does — by name — so an exact
 * filename match is tried first, then a case-insensitive one, then the id.
 */
export async function findUserFile(
	env: Env,
	userId: string,
	nameOrId: string
): Promise<UserFile | null> {
	const needle = nameOrId.trim();
	if (!needle) return null;

	const row = await env.DB.prepare(
		`SELECT id, user_id, filename, path, data, updated_at FROM file
		 WHERE user_id = ?1 AND (id = ?2 OR filename = ?2 OR lower(filename) = lower(?2))
		 ORDER BY updated_at DESC LIMIT 1`
	)
		.bind(userId, needle)
		.first<FileRow>();
	return row ? toUserFile(row) : null;
}

/** Writes the content of a file that already exists, keeping R2 and the index in step. */
async function writeContent(env: Env, id: string, userId: string, content: string): Promise<void> {
	const row = await env.DB.prepare('SELECT path FROM file WHERE id = ?1 AND user_id = ?2')
		.bind(id, userId)
		.first<{ path: string | null }>();
	await env.DB.prepare('UPDATE file SET data = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4')
		.bind(toJSON({ content }), now(), id, userId)
		.run();
	if (row?.path) await env.FILES.put(row.path, content);
	await indexChunks(env, { fileId: id, userId, text: content }).catch(() => {});
}

export async function createUserFile(
	env: Env,
	userId: string,
	filename: string,
	content: string
): Promise<UserFile> {
	const id = uuid();
	const timestamp = now();
	const key = `${userId}/${id}/${filename}`;
	const hash = await sha256Hex(new TextEncoder().encode(content));

	await env.FILES.put(key, content, { httpMetadata: { contentType: 'text/plain' } });
	await env.DB.prepare(
		`INSERT INTO file (id, user_id, hash, filename, path, data, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
	)
		.bind(
			id,
			userId,
			hash,
			filename,
			key,
			toJSON({ content }),
			toJSON({ name: filename, content_type: 'text/plain', size: content.length }),
			timestamp
		)
		.run();

	await indexChunks(env, { fileId: id, userId, text: content }).catch(() => {});
	return { id, filename, content, updated_at: timestamp };
}

export type EditOutcome =
	| { ok: true; file: UserFile; replacements: number }
	| { ok: false; reason: 'not-found' | 'no-match' | 'ambiguous'; occurrences?: number };

/**
 * Replaces an exact string in a file.
 *
 * Deliberately not a regex and not a whole-file overwrite: a model rewriting a
 * document from memory silently loses the parts it did not think to repeat.
 * A string that appears more than once is refused rather than guessed at —
 * the model can pass a longer, unique excerpt instead.
 */
export async function editUserFile(
	env: Env,
	userId: string,
	nameOrId: string,
	oldText: string,
	newText: string,
	options: { replaceAll?: boolean } = {}
): Promise<EditOutcome> {
	const file = await findUserFile(env, userId, nameOrId);
	if (!file) return { ok: false, reason: 'not-found' };

	const occurrences = oldText ? file.content.split(oldText).length - 1 : 0;
	if (!occurrences) return { ok: false, reason: 'no-match' };
	if (occurrences > 1 && !options.replaceAll) {
		return { ok: false, reason: 'ambiguous', occurrences };
	}

	const content = options.replaceAll
		? file.content.split(oldText).join(newText)
		: file.content.replace(oldText, newText);
	await writeContent(env, file.id, userId, content);
	return {
		ok: true,
		file: { ...file, content, updated_at: now() },
		replacements: options.replaceAll ? occurrences : 1
	};
}
