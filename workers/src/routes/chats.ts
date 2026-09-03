/** `/api/v1/chats` — conversation CRUD, folders, pins, tags, sharing. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, currentUser, verifiedUser } from '../lib/auth';
import {
	getChat,
	getUserChat,
	insertChat,
	serializeChat,
	serializeChatTitleId,
	updateChatContent,
	type ChatContent,
	type ChatRow
} from '../lib/chats';
import { emitToUser } from '../lib/hub';
import { bad, clampInt, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });
const PAGE_SIZE = 60;

const listQuery = (options: {
	includeArchived?: boolean;
	includeFolders?: boolean;
	includePinned?: boolean;
}) => {
	const clauses = ['user_id = ?1'];
	if (!options.includeFolders) clauses.push('folder_id IS NULL');
	if (!options.includePinned) clauses.push('(pinned IS NULL OR pinned = 0)');
	if (!options.includeArchived) clauses.push('archived = 0');
	return clauses.join(' AND ');
};

app.get('/', async (c) => {
	const user = verifiedUser(c);
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	const where = listQuery({
		includeFolders: c.req.query('include_folders') === 'true',
		includePinned: c.req.query('include_pinned') === 'true'
	});
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM chat WHERE ${where} ORDER BY updated_at DESC LIMIT ${PAGE_SIZE} OFFSET ${
			(page - 1) * PAGE_SIZE
		}`
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChatTitleId));
});

app.get('/list', async (c) => {
	const user = verifiedUser(c);
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM chat WHERE user_id = ?1 AND archived = 0 ORDER BY updated_at DESC
		 LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChatTitleId));
});

app.get('/pinned', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM chat WHERE user_id = ?1 AND pinned = 1 AND archived = 0 ORDER BY updated_at DESC'
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChat));
});

app.get('/all', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM chat WHERE user_id = ?1 AND archived = 0 ORDER BY updated_at DESC'
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChat));
});

app.get('/all/archived', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM chat WHERE user_id = ?1 AND archived = 1 ORDER BY updated_at DESC'
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChat));
});

app.get('/all/db', async (c) => {
	adminUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM chat ORDER BY updated_at DESC'
	).all<ChatRow>();
	return c.json((results ?? []).map(serializeChat));
});

app.get('/all/tags', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare('SELECT * FROM tag WHERE user_id = ?1')
		.bind(user.id)
		.all<{ id: string; user_id: string; name: string; meta: string }>();
	return c.json(
		(results ?? []).map((row) => ({
			...row,
			meta: parseJSON<Record<string, unknown>>(row.meta, {})
		}))
	);
});

app.get('/archived', async (c) => {
	const user = verifiedUser(c);
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM chat WHERE user_id = ?1 AND archived = 1 ORDER BY updated_at DESC
		 LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChatTitleId));
});

app.get('/archived/count', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare(
		'SELECT COUNT(*) AS count FROM chat WHERE user_id = ?1 AND archived = 1'
	)
		.bind(user.id)
		.first<{ count: number }>();
	return c.json({ count: row?.count ?? 0 });
});

app.get('/search', async (c) => {
	const user = verifiedUser(c);
	const text = (c.req.query('text') ?? '').trim().toLowerCase();
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	if (!text) return c.json([]);

	// Tag filters use the `tag:name` prefix, matching upstream's search syntax.
	const tagTerms: string[] = [];
	const words: string[] = [];
	for (const token of text.split(/\s+/)) {
		if (token.startsWith('tag:')) tagTerms.push(token.slice(4).replace(/_/g, ' '));
		else if (token) words.push(token);
	}

	const clauses = ['user_id = ?1'];
	const bindings: unknown[] = [user.id];
	if (words.length) {
		bindings.push(`%${words.join(' ')}%`);
		clauses.push(`(lower(title) LIKE ?${bindings.length} OR lower(chat) LIKE ?${bindings.length})`);
	}
	for (const tag of tagTerms) {
		bindings.push(`%"${tag}"%`);
		clauses.push(`lower(meta) LIKE ?${bindings.length}`);
	}

	const { results } = await c.env.DB.prepare(
		`SELECT * FROM chat WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC
		 LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
	)
		.bind(...bindings)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChatTitleId));
});

app.get('/config', async (c) => {
	verifiedUser(c);
	return c.json({ enable_realtime_chat_save: true });
});

app.post('/new', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { chat: ChatContent; folder_id?: string | null };
	const row = await insertChat(c.env, user.id, body.chat ?? {}, {
		folderId: body.folder_id ?? null
	});
	await emitToUser(c.env, user.id, 'events', [
		{ chat_id: row.id, data: { type: 'chat:list', data: { chat_id: row.id } } }
	]);
	return c.json(serializeChat(row));
});

app.post('/import', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as {
		chat: ChatContent;
		meta?: Record<string, unknown>;
		pinned?: boolean;
		folder_id?: string | null;
	};
	const row = await insertChat(c.env, user.id, body.chat ?? {}, {
		folderId: body.folder_id ?? null
	});
	if (body.pinned || body.meta) {
		await c.env.DB.prepare('UPDATE chat SET pinned = ?1, meta = ?2 WHERE id = ?3')
			.bind(body.pinned ? 1 : 0, toJSON(body.meta ?? {}), row.id)
			.run();
	}
	const updated = await getChat(c.env, row.id);
	return c.json(serializeChat(updated!));
});

app.get('/folder/:id', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM chat WHERE user_id = ?1 AND folder_id = ?2 AND archived = 0 ORDER BY updated_at DESC'
	)
		.bind(user.id, c.req.param('id'))
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChatTitleId));
});

app.get('/folder/:id/list', async (c) => {
	const user = verifiedUser(c);
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM chat WHERE user_id = ?1 AND folder_id = ?2 AND archived = 0
		 ORDER BY updated_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
	)
		.bind(user.id, c.req.param('id'))
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChatTitleId));
});

app.get('/list/user/:id', async (c) => {
	adminUser(c);
	const page = clampInt(c.req.query('page'), 1, 100_000, 1);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM chat WHERE user_id = ?1 ORDER BY updated_at DESC
		 LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`
	)
		.bind(c.req.param('id'))
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChat));
});

app.post('/archive/all', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('UPDATE chat SET archived = 1 WHERE user_id = ?1').bind(user.id).run();
	return c.json(true);
});

app.post('/unarchive/all', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('UPDATE chat SET archived = 0 WHERE user_id = ?1').bind(user.id).run();
	return c.json(true);
});

app.delete('/', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('DELETE FROM chat WHERE user_id = ?1').bind(user.id).run();
	return c.json(true);
});

app.get('/share/:shareId', async (c) => {
	const shareId = c.req.param('shareId');
	const row = await c.env.DB.prepare('SELECT * FROM chat WHERE share_id = ?1')
		.bind(shareId)
		.first<ChatRow>();
	if (!row) throw notFound('Chat not found');
	return c.json(serializeChat(row));
});

app.get('/shared', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM chat WHERE user_id = ?1 AND share_id IS NOT NULL ORDER BY updated_at DESC'
	)
		.bind(user.id)
		.all<ChatRow>();
	return c.json((results ?? []).map(serializeChat));
});

app.delete('/share/all', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('UPDATE chat SET share_id = NULL WHERE user_id = ?1').bind(user.id).run();
	return c.json(true);
});

app.get('/:id', async (c) => {
	const user = currentUser(c);
	const row = await getChat(c.env, c.req.param('id'));
	if (!row) throw notFound('Chat not found');
	if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
	return c.json(serializeChat(row));
});

app.post('/:id', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.param('id');
	const row = await getUserChat(c.env, id, user.id);
	if (!row) throw notFound('Chat not found');

	const body = (await c.req.json()) as { chat?: ChatContent; variables?: Record<string, unknown> };
	const existing = parseJSON<ChatContent>(row.chat, {});
	const merged = { ...existing, ...(body.chat ?? {}) };
	const title = (merged.title as string) || row.title;
	await updateChatContent(c.env, id, merged, { title });
	if (body.variables) {
		await c.env.DB.prepare('UPDATE chat SET variables = ?1 WHERE id = ?2')
			.bind(toJSON(body.variables), id)
			.run();
	}
	const updated = await getChat(c.env, id);
	return c.json(serializeChat(updated!));
});

app.delete('/:id', async (c) => {
	const user = currentUser(c);
	const row = await getChat(c.env, c.req.param('id'));
	if (!row) throw notFound('Chat not found');
	if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
	await c.env.DB.prepare('DELETE FROM chat WHERE id = ?1').bind(row.id).run();
	await emitToUser(c.env, user.id, 'events', [
		{ chat_id: row.id, data: { type: 'chat:list', data: { chat_id: row.id, deleted: true } } }
	]);
	return c.json(true);
});

app.post('/:id/pin', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	await c.env.DB.prepare('UPDATE chat SET pinned = ?1 WHERE id = ?2')
		.bind(row.pinned ? 0 : 1, row.id)
		.run();
	const updated = await getChat(c.env, row.id);
	return c.json(serializeChat(updated!));
});

app.get('/:id/pinned', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	return c.json(Boolean(row?.pinned));
});

app.post('/:id/archive', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	await c.env.DB.prepare('UPDATE chat SET archived = ?1 WHERE id = ?2')
		.bind(row.archived ? 0 : 1, row.id)
		.run();
	const updated = await getChat(c.env, row.id);
	return c.json(serializeChat(updated!));
});

app.post('/:id/clone', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const body = (await c.req.json().catch(() => ({}))) as { title?: string };
	const content = parseJSON<ChatContent>(row.chat, {});
	const cloned = await insertChat(
		c.env,
		user.id,
		{ ...content, title: body.title ?? `Clone of ${row.title}` },
		{ folderId: row.folder_id }
	);
	return c.json(serializeChat(cloned));
});

app.post('/:id/clone/shared', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare('SELECT * FROM chat WHERE share_id = ?1')
		.bind(c.req.param('id'))
		.first<ChatRow>();
	if (!row) throw notFound('Chat not found');
	const content = parseJSON<ChatContent>(row.chat, {});
	const cloned = await insertChat(c.env, user.id, { ...content, title: `Clone of ${row.title}` });
	return c.json(serializeChat(cloned));
});

app.post('/:id/fork', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const body = (await c.req.json().catch(() => ({}))) as { message_id?: string };
	const content = parseJSON<ChatContent>(row.chat, {});
	if (body.message_id && content.history?.messages) {
		content.history = { ...content.history, currentId: body.message_id };
	}
	const forked = await insertChat(
		c.env,
		user.id,
		{ ...content, title: row.title },
		{
			folderId: row.folder_id
		}
	);
	return c.json(serializeChat(forked));
});

app.post('/:id/share', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const shareId = row.share_id ?? uuid();
	await c.env.DB.prepare('UPDATE chat SET share_id = ?1 WHERE id = ?2').bind(shareId, row.id).run();
	const updated = await getChat(c.env, row.id);
	return c.json(serializeChat(updated!));
});

app.delete('/:id/share', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	await c.env.DB.prepare('UPDATE chat SET share_id = NULL WHERE id = ?1').bind(row.id).run();
	return c.json(true);
});

app.post('/:id/folder', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const { folder_id } = (await c.req.json()) as { folder_id: string | null };
	await c.env.DB.prepare('UPDATE chat SET folder_id = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(folder_id ?? null, now(), row.id)
		.run();
	const updated = await getChat(c.env, row.id);
	return c.json(serializeChat(updated!));
});

app.get('/:id/tags', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
	return c.json(
		tags.map((name) => ({ id: name.replace(/\s+/g, '_').toLowerCase(), name, user_id: user.id }))
	);
});

app.post('/:id/tags', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const { name } = (await c.req.json()) as { name: string };
	if (!name) throw bad('Tag name is required');

	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	const tags = new Set(Array.isArray(meta.tags) ? (meta.tags as string[]) : []);
	tags.add(name);
	meta.tags = [...tags];
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE chat SET meta = ?1 WHERE id = ?2').bind(toJSON(meta), row.id),
		c.env.DB.prepare(
			'INSERT OR IGNORE INTO tag (id, user_id, name, meta) VALUES (?1, ?2, ?3, ?4)'
		).bind(name.replace(/\s+/g, '_').toLowerCase(), user.id, name, toJSON({}))
	]);
	return c.json(
		[...tags].map((tag) => ({
			id: tag.replace(/\s+/g, '_').toLowerCase(),
			name: tag,
			user_id: user.id
		}))
	);
});

app.delete('/:id/tags', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const { name } = (await c.req.json()) as { name: string };
	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	const tags = (Array.isArray(meta.tags) ? (meta.tags as string[]) : []).filter(
		(tag) => tag !== name
	);
	meta.tags = tags;
	await c.env.DB.prepare('UPDATE chat SET meta = ?1 WHERE id = ?2')
		.bind(toJSON(meta), row.id)
		.run();
	return c.json(
		tags.map((tag) => ({ id: tag.replace(/\s+/g, '_').toLowerCase(), name: tag, user_id: user.id }))
	);
});

app.delete('/:id/tags/all', async (c) => {
	const user = verifiedUser(c);
	const row = await getUserChat(c.env, c.req.param('id'), user.id);
	if (!row) throw notFound('Chat not found');
	const meta = parseJSON<Record<string, unknown>>(row.meta, {});
	meta.tags = [];
	await c.env.DB.prepare('UPDATE chat SET meta = ?1 WHERE id = ?2')
		.bind(toJSON(meta), row.id)
		.run();
	return c.json(true);
});

app.post('/:id/unread', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('UPDATE chat SET last_read_at = NULL WHERE id = ?1 AND user_id = ?2')
		.bind(c.req.param('id'), user.id)
		.run();
	return c.json(true);
});

app.post('/read', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('UPDATE chat SET last_read_at = ?1 WHERE user_id = ?2')
		.bind(now(), user.id)
		.run();
	return c.json(true);
});

app.get('/:id/messages/:messageId', async (c) => {
	const user = currentUser(c);
	const row = await getChat(c.env, c.req.param('id'));
	if (!row) throw notFound('Chat not found');
	if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
	const content = parseJSON<ChatContent>(row.chat, {});
	const message = content.history?.messages?.[c.req.param('messageId')];
	if (!message) throw notFound('Message not found');
	return c.json(message);
});

export default app;
