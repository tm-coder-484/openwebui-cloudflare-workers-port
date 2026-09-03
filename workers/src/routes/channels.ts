/** `/api/v1/channels` — team channels with realtime message fan-out. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import {
	hasAccess,
	listGrants,
	replaceGrants,
	deleteGrants,
	visibleResourceIdsClause
} from '../lib/access';
import { emitToChannel } from '../lib/hub';
import { getUserById, publicUser } from '../lib/users';
import {
	bad,
	clampInt,
	forbidden,
	notFound,
	now,
	nowNs,
	parseJSON,
	toBool,
	toJSON,
	uuid
} from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface ChannelRow {
	id: string;
	user_id: string;
	type: string | null;
	name: string;
	description: string | null;
	is_private: number | null;
	data: string | null;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

interface MessageRow {
	id: string;
	user_id: string;
	channel_id: string;
	reply_to_id: string | null;
	parent_id: string | null;
	is_pinned: number;
	content: string;
	data: string | null;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

const serializeChannel = (row: ChannelRow, grants: any[] = []) => ({
	id: row.id,
	user_id: row.user_id,
	type: row.type,
	name: row.name,
	description: row.description,
	is_private: row.is_private === null ? null : toBool(row.is_private),
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

const serializeWebhook = (row: any) => ({
	id: row.id,
	channel_id: row.channel_id,
	user_id: row.user_id,
	name: row.name,
	url: row.url,
	events: parseJSON<string[]>(row.events, ['message']),
	enabled: toBool(row.enabled),
	created_at: row.created_at,
	updated_at: row.updated_at
});

/** Posts a message to every enabled webhook on the channel. */
async function deliverWebhooks(c: any, channel: ChannelRow, event: string, payload: unknown) {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM channel_webhook WHERE channel_id = ?1 AND enabled = 1'
	)
		.bind(channel.id)
		.all()
		.catch(() => ({ results: [] as any[] }));

	const deliveries = ((results ?? []) as any[])
		.filter((webhook) => parseJSON<string[]>(webhook.events, ['message']).includes(event))
		.map((webhook) =>
			fetch(webhook.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					event,
					channel: { id: channel.id, name: channel.name },
					data: payload
				}),
				signal: AbortSignal.timeout(10_000)
			}).catch((error) => console.warn('[open-webui] webhook delivery failed:', error))
		);

	if (deliveries.length) {
		c.executionCtx?.waitUntil?.(Promise.allSettled(deliveries));
	}
}

async function serializeMessage(c: any, row: MessageRow) {
	const author = await getUserById(c.env, row.user_id);
	const { results: reactions } = await c.env.DB.prepare(
		'SELECT name, user_id FROM message_reaction WHERE message_id = ?1'
	)
		.bind(row.id)
		.all();
	const grouped = new Map<string, string[]>();
	for (const reaction of (reactions ?? []) as { name: string; user_id: string }[]) {
		grouped.set(reaction.name, [...(grouped.get(reaction.name) ?? []), reaction.user_id]);
	}
	const replies = (await c.env.DB.prepare(
		'SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM message WHERE parent_id = ?1'
	)
		.bind(row.id)
		.first()) as { count: number; latest: number | null } | null;

	return {
		id: row.id,
		user_id: row.user_id,
		channel_id: row.channel_id,
		reply_to_id: row.reply_to_id,
		parent_id: row.parent_id,
		is_pinned: toBool(row.is_pinned),
		content: row.content,
		data: parseJSON<Record<string, unknown> | null>(row.data, null),
		meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
		user: author ? publicUser(author) : null,
		reactions: [...grouped.entries()].map(([name, userIds]) => ({
			name,
			user_ids: userIds,
			count: userIds.length
		})),
		reply_count: replies?.count ?? 0,
		latest_reply_at: replies?.latest ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

async function visibleChannels(c: any) {
	const user = verifiedUser(c);
	if (user.role === 'admin') {
		const { results } = await c.env.DB.prepare(
			'SELECT * FROM channel WHERE deleted_at IS NULL ORDER BY updated_at DESC'
		).all();
		return (results ?? []) as unknown as ChannelRow[];
	}
	const clause = await visibleResourceIdsClause(c.env, user.id, 'channel');
	const { results } = await c.env.DB.prepare(
		`SELECT DISTINCT c.* FROM channel c
		 LEFT JOIN channel_member m ON m.channel_id = c.id AND m.user_id = ?
		 WHERE c.deleted_at IS NULL AND (c.user_id = ? OR m.user_id IS NOT NULL OR c.id IN (${clause.sql}))
		 ORDER BY c.updated_at DESC`
	)
		.bind(user.id, user.id, ...clause.bindings)
		.all();
	return (results ?? []) as unknown as ChannelRow[];
}

app.get('/', async (c) => {
	const rows = await visibleChannels(c);
	const grants = await listGrants(
		c.env,
		'channel',
		rows.map((row) => row.id)
	);
	return c.json(rows.map((row) => serializeChannel(row, grants.get(row.id) ?? [])));
});

app.get('/list', async (c) => {
	const rows = await visibleChannels(c);
	return c.json(rows.map((row) => serializeChannel(row)));
});

app.post('/create', async (c) => {
	const user = adminUser(c);
	const body = (await c.req.json()) as any;
	if (!body?.name) throw bad('Channel name is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO channel (id, user_id, type, name, description, is_private, data, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
	)
		.bind(
			id,
			user.id,
			body.type ?? 'channel',
			String(body.name).toLowerCase().replace(/\s+/g, '-'),
			body.description ?? '',
			body.is_private ? 1 : 0,
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			timestamp
		)
		.run();
	await c.env.DB.prepare(
		'INSERT INTO channel_member (id, channel_id, user_id, role, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)'
	)
		.bind(uuid(), id, user.id, 'owner', timestamp)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'channel', id, body.access_grants);
	const row = await c.env.DB.prepare('SELECT * FROM channel WHERE id = ?1')
		.bind(id)
		.first<ChannelRow>();
	return c.json(serializeChannel(row!));
});

async function loadChannel(c: any, id: string, permission: 'read' | 'write' = 'read') {
	const user = verifiedUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM channel WHERE id = ?1 AND deleted_at IS NULL')
		.bind(id)
		.first()) as ChannelRow | null;
	if (!row) throw notFound('Channel not found');
	const member = await c.env.DB.prepare(
		'SELECT id FROM channel_member WHERE channel_id = ?1 AND user_id = ?2'
	)
		.bind(id, user.id)
		.first();
	if (!member && !(await hasAccess(c.env, user, 'channel', row.id, row.user_id, permission))) {
		throw forbidden();
	}
	return { row, user };
}

app.get('/:id', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'));
	const grants = (await listGrants(c.env, 'channel', [row.id])).get(row.id) ?? [];
	return c.json(serializeChannel(row, grants));
});

app.post('/:id/update', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as any;
	await c.env.DB.prepare(
		'UPDATE channel SET name = ?1, description = ?2, data = ?3, meta = ?4, updated_at = ?5 WHERE id = ?6'
	)
		.bind(
			body.name ?? row.name,
			body.description ?? row.description,
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'channel', row.id, body.access_grants);
	const updated = await c.env.DB.prepare('SELECT * FROM channel WHERE id = ?1')
		.bind(row.id)
		.first<ChannelRow>();
	return c.json(serializeChannel(updated!));
});

app.delete('/:id/delete', async (c) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	await deleteGrants(c.env, 'channel', row.id);
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE channel SET deleted_at = ?1, deleted_by = ?2 WHERE id = ?3').bind(
			now(),
			user.id,
			row.id
		),
		c.env.DB.prepare('DELETE FROM channel_member WHERE channel_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM channel_webhook WHERE channel_id = ?1').bind(row.id)
	]);
	return c.json(true);
});

app.get('/:id/messages', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'));
	const skip = clampInt(c.req.query('skip'), 0, 1_000_000, 0);
	const limit = clampInt(c.req.query('limit'), 1, 200, 50);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM message WHERE channel_id = ?1 AND parent_id IS NULL
		 ORDER BY created_at DESC LIMIT ${limit} OFFSET ${skip}`
	)
		.bind(row.id)
		.all();
	const rows = (results ?? []) as unknown as MessageRow[];
	return c.json(await Promise.all(rows.map((message) => serializeMessage(c, message))));
});

app.get('/:id/messages/pinned', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'));
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM message WHERE channel_id = ?1 AND is_pinned = 1 ORDER BY created_at DESC'
	)
		.bind(row.id)
		.all();
	const rows = (results ?? []) as unknown as MessageRow[];
	return c.json(await Promise.all(rows.map((message) => serializeMessage(c, message))));
});

app.post('/:id/messages/post', async (c) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as any;
	if (!body?.content && !body?.data) throw bad('Message content is required');

	const id = uuid();
	const timestamp = nowNs();
	await c.env.DB.prepare(
		`INSERT INTO message (id, user_id, channel_id, reply_to_id, parent_id, is_pinned, content, data, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?9)`
	)
		.bind(
			id,
			user.id,
			row.id,
			body.reply_to_id ?? null,
			body.parent_id ?? null,
			body.content ?? '',
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			timestamp
		)
		.run();
	await c.env.DB.prepare(
		'INSERT OR IGNORE INTO channel_member (id, channel_id, user_id, role, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)'
	)
		.bind(uuid(), row.id, user.id, 'member', now())
		.run()
		.catch(() => {});

	const message = await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1')
		.bind(id)
		.first<MessageRow>();
	const payload = await serializeMessage(c, message!);
	await emitToChannel(c.env, row.id, 'events:channel', [
		{
			channel_id: row.id,
			message_id: id,
			data: { type: 'message', data: payload },
			user: publicUser({ ...user, profile_image_url: user.profile_image_url } as any)
		}
	]);
	await deliverWebhooks(c, row, 'message', payload);
	return c.json(payload);
});

app.post('/:id/messages/:messageId/update', async (c) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	const messageId = c.req.param('messageId');
	const body = (await c.req.json()) as any;
	const message = await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1 AND channel_id = ?2')
		.bind(messageId, row.id)
		.first<MessageRow>();
	if (!message) throw notFound('Message not found');
	if (message.user_id !== user.id && user.role !== 'admin') throw forbidden();

	await c.env.DB.prepare(
		'UPDATE message SET content = ?1, data = ?2, updated_at = ?3 WHERE id = ?4'
	)
		.bind(
			body.content ?? message.content,
			toJSON(body.data ?? parseJSON(message.data, {})),
			nowNs(),
			messageId
		)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1')
		.bind(messageId)
		.first<MessageRow>();
	const payload = await serializeMessage(c, updated!);
	await emitToChannel(c.env, row.id, 'events:channel', [
		{ channel_id: row.id, message_id: messageId, data: { type: 'message:update', data: payload } }
	]);
	return c.json(payload);
});

app.delete('/:id/messages/:messageId/delete', async (c) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	const messageId = c.req.param('messageId');
	const message = await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1 AND channel_id = ?2')
		.bind(messageId, row.id)
		.first<MessageRow>();
	if (!message) throw notFound('Message not found');
	if (message.user_id !== user.id && user.role !== 'admin') throw forbidden();
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM message_reaction WHERE message_id = ?1').bind(messageId),
		c.env.DB.prepare('DELETE FROM message WHERE id = ?1').bind(messageId)
	]);
	await emitToChannel(c.env, row.id, 'events:channel', [
		{
			channel_id: row.id,
			message_id: messageId,
			data: { type: 'message:delete', data: { id: messageId } }
		}
	]);
	return c.json(true);
});

app.get('/:id/messages/:messageId/thread', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'));
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM message WHERE parent_id = ?1 ORDER BY created_at ASC'
	)
		.bind(c.req.param('messageId'))
		.all();
	const rows = (results ?? []) as unknown as MessageRow[];
	return c.json(await Promise.all(rows.map((message) => serializeMessage(c, message))));
});

const reaction = (add: boolean) => async (c: any) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	const messageId = c.req.param('messageId');
	const { name } = (await c.req.json()) as { name: string };
	if (add) {
		await c.env.DB.prepare(
			'INSERT INTO message_reaction (id, user_id, message_id, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
		)
			.bind(uuid(), user.id, messageId, name, now())
			.run();
	} else {
		await c.env.DB.prepare(
			'DELETE FROM message_reaction WHERE message_id = ?1 AND user_id = ?2 AND name = ?3'
		)
			.bind(messageId, user.id, name)
			.run();
	}
	const message = (await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1')
		.bind(messageId)
		.first()) as MessageRow | null;
	if (!message) throw notFound('Message not found');
	const payload = await serializeMessage(c, message);
	await emitToChannel(c.env, row.id, 'events:channel', [
		{ channel_id: row.id, message_id: messageId, data: { type: 'message:reaction', data: payload } }
	]);
	return c.json(payload);
};

app.post('/:id/messages/:messageId/reactions/add', reaction(true));
app.post('/:id/messages/:messageId/reactions/remove', reaction(false));

app.post('/:id/messages/:messageId/pin', async (c) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	const messageId = c.req.param('messageId');
	const message = await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1 AND channel_id = ?2')
		.bind(messageId, row.id)
		.first<MessageRow>();
	if (!message) throw notFound('Message not found');
	const pinned = message.is_pinned ? 0 : 1;
	await c.env.DB.prepare(
		'UPDATE message SET is_pinned = ?1, pinned_at = ?2, pinned_by = ?3 WHERE id = ?4'
	)
		.bind(pinned, pinned ? now() : null, pinned ? user.id : null, messageId)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM message WHERE id = ?1')
		.bind(messageId)
		.first<MessageRow>();
	return c.json(await serializeMessage(c, updated!));
});

app.get('/:id/messages/:messageId/data', async (c) => {
	await loadChannel(c, c.req.param('id'));
	const message = await c.env.DB.prepare('SELECT data FROM message WHERE id = ?1')
		.bind(c.req.param('messageId'))
		.first<{ data: string | null }>();
	if (!message) throw notFound('Message not found');
	return c.json(parseJSON<Record<string, unknown>>(message.data, {}));
});

app.get('/:id/members', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'));
	const { results } = await c.env.DB.prepare(
		'SELECT u.* FROM "user" u JOIN channel_member m ON m.user_id = u.id WHERE m.channel_id = ?1'
	)
		.bind(row.id)
		.all();
	return c.json({
		members: ((results ?? []) as any[]).map(publicUser),
		total: results?.length ?? 0
	});
});

app.get('/:id/members/active', async (c) => {
	await loadChannel(c, c.req.param('id'));
	return c.json([]);
});

app.post('/:id/update/members/add', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'), 'write');
	const { user_ids } = (await c.req.json()) as { user_ids: string[] };
	const timestamp = now();
	await c.env.DB.batch(
		(user_ids ?? []).map((userId) =>
			c.env.DB.prepare(
				'INSERT INTO channel_member (id, channel_id, user_id, role, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)'
			).bind(uuid(), row.id, userId, 'member', timestamp)
		)
	);
	return c.json(true);
});

app.post('/:id/update/members/remove', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'), 'write');
	const { user_ids } = (await c.req.json()) as { user_ids: string[] };
	await c.env.DB.batch(
		(user_ids ?? []).map((userId) =>
			c.env.DB.prepare('DELETE FROM channel_member WHERE channel_id = ?1 AND user_id = ?2').bind(
				row.id,
				userId
			)
		)
	);
	return c.json(true);
});

/**
 * Channel webhooks: outbound notifications for new messages. Delivery is
 * fire-and-forget so a slow or dead endpoint never delays a post.
 */
app.get('/:id/webhooks', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'));
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM channel_webhook WHERE channel_id = ?1 ORDER BY created_at DESC'
	)
		.bind(row.id)
		.all();
	return c.json(((results ?? []) as any[]).map(serializeWebhook));
});

app.post('/:id/webhooks/create', async (c) => {
	const { row, user } = await loadChannel(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as any;
	if (!body?.url) throw bad('A webhook URL is required');
	const id = uuid();
	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO channel_webhook (id, channel_id, user_id, name, url, events, enabled, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
	)
		.bind(
			id,
			row.id,
			user.id,
			body.name ?? null,
			body.url,
			toJSON(body.events ?? ['message']),
			body.enabled === false ? 0 : 1,
			timestamp
		)
		.run();
	const webhook = await c.env.DB.prepare('SELECT * FROM channel_webhook WHERE id = ?1')
		.bind(id)
		.first();
	return c.json(serializeWebhook(webhook));
});

app.post('/:id/webhooks/:webhookId/update', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'), 'write');
	const body = (await c.req.json()) as any;
	const existing = (await c.env.DB.prepare(
		'SELECT * FROM channel_webhook WHERE id = ?1 AND channel_id = ?2'
	)
		.bind(c.req.param('webhookId'), row.id)
		.first()) as any;
	if (!existing) throw notFound('Webhook not found');

	await c.env.DB.prepare(
		'UPDATE channel_webhook SET name = ?1, url = ?2, events = ?3, enabled = ?4, updated_at = ?5 WHERE id = ?6'
	)
		.bind(
			body.name === undefined ? existing.name : body.name,
			body.url ?? existing.url,
			toJSON(body.events ?? parseJSON(existing.events, ['message'])),
			body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
			now(),
			existing.id
		)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM channel_webhook WHERE id = ?1')
		.bind(existing.id)
		.first();
	return c.json(serializeWebhook(updated));
});

app.delete('/:id/webhooks/:webhookId/delete', async (c) => {
	const { row } = await loadChannel(c, c.req.param('id'), 'write');
	await c.env.DB.prepare('DELETE FROM channel_webhook WHERE id = ?1 AND channel_id = ?2')
		.bind(c.req.param('webhookId'), row.id)
		.run();
	return c.json(true);
});

export default app;
