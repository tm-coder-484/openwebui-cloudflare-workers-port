/** `/api/v1/prompts` — reusable slash-command prompts. */

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
import { getUserById, publicUser } from '../lib/users';
import { unifiedDiff } from '../lib/diff';
import {
	bad,
	clampInt,
	forbidden,
	notFound,
	now,
	parseJSON,
	toBool,
	toJSON,
	uuid
} from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface PromptRow {
	id: string;
	command: string;
	user_id: string;
	name: string;
	content: string;
	data: string | null;
	meta: string | null;
	tags: string | null;
	is_active: number;
	version_id: string | null;
	created_at: number;
	updated_at: number;
}

const serialize = (row: PromptRow, grants: any[] = []) => ({
	id: row.id,
	command: row.command,
	user_id: row.user_id,
	name: row.name,
	title: row.name,
	content: row.content,
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	tags: parseJSON<string[]>(row.tags, []),
	is_active: toBool(row.is_active),
	access_grants: grants.map((grant) => ({
		id: grant.id,
		principal_type: grant.principal_type,
		principal_id: grant.principal_id,
		permission: grant.permission
	})),
	timestamp: row.updated_at,
	created_at: row.created_at,
	updated_at: row.updated_at
});

async function listVisible(c: any) {
	const user = verifiedUser(c);
	if (user.role === 'admin') {
		const { results } = await c.env.DB.prepare(
			'SELECT * FROM prompt ORDER BY updated_at DESC'
		).all();
		return { user, rows: (results ?? []) as unknown as PromptRow[] };
	}
	const clause = await visibleResourceIdsClause(c.env, user.id, 'prompt');
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM prompt WHERE user_id = ? OR id IN (${clause.sql}) ORDER BY updated_at DESC`
	)
		.bind(user.id, ...clause.bindings)
		.all();
	return { user, rows: (results ?? []) as unknown as PromptRow[] };
}

/** Snapshots the prompt so the change can be diffed and restored later. */
async function recordHistory(
	c: any,
	promptId: string,
	userId: string,
	snapshot: Record<string, unknown>,
	message?: string
): Promise<void> {
	const previous = (await c.env.DB.prepare(
		'SELECT id FROM prompt_history WHERE prompt_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1'
	)
		.bind(promptId)
		.first()) as { id: string } | null;
	await c.env.DB.prepare(
		`INSERT INTO prompt_history (id, prompt_id, parent_id, snapshot, user_id, commit_message, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
	)
		.bind(uuid(), promptId, previous?.id ?? null, toJSON(snapshot), userId, message ?? null, now())
		.run();
}

async function serializeHistory(c: any, entry: any) {
	const author = await getUserById(c.env, entry.user_id);
	return {
		id: entry.id,
		prompt_id: entry.prompt_id,
		parent_id: entry.parent_id,
		snapshot: parseJSON<Record<string, unknown>>(entry.snapshot, {}),
		user_id: entry.user_id,
		user: author ? publicUser(author) : null,
		commit_message: entry.commit_message,
		created_at: entry.created_at
	};
}

async function respond(c: any, rows: PromptRow[]) {
	const grants = await listGrants(
		c.env,
		'prompt',
		rows.map((row) => row.id)
	);
	return c.json(rows.map((row) => serialize(row, grants.get(row.id) ?? [])));
}

app.get('/', async (c) => {
	const { rows } = await listVisible(c);
	return respond(c, rows);
});

app.get('/list', async (c) => {
	const { rows } = await listVisible(c);
	return respond(c, rows);
});

app.get('/tags', async (c) => {
	const { rows } = await listVisible(c);
	const tags = new Set<string>();
	for (const row of rows) for (const tag of parseJSON<string[]>(row.tags, [])) tags.add(tag);
	return c.json([...tags].map((name) => ({ name })));
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.prompts'))) throw forbidden();
	const body = (await c.req.json()) as any;
	const command = String(body.command ?? '').replace(/^\//, '');
	if (!command || !body.title) throw bad('Command and title are required');
	if (await c.env.DB.prepare('SELECT id FROM prompt WHERE command = ?1').bind(command).first()) {
		throw bad('A prompt with this command already exists.');
	}

	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO prompt (id, command, user_id, name, content, data, meta, tags, is_active, created_at, updated_at)
		 VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`
	)
		.bind(
			command,
			user.id,
			body.title,
			body.content ?? '',
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			toJSON(body.tags ?? []),
			timestamp
		)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'prompt', command, body.access_grants);
	await recordHistory(
		c,
		command,
		user.id,
		{ name: body.title, content: body.content ?? '' },
		'Created'
	);
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1')
		.bind(command)
		.first<PromptRow>();
	return c.json(serialize(row!));
});

app.get('/id/:command{[^/]+}', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id))) throw forbidden();
	const grants = (await listGrants(c.env, 'prompt', [row.id])).get(row.id) ?? [];
	return c.json(serialize(row, grants));
});

app.post('/id/:command{[^/]+}/update', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();

	await c.env.DB.prepare(
		'UPDATE prompt SET name = ?1, content = ?2, data = ?3, meta = ?4, tags = ?5, updated_at = ?6 WHERE id = ?7'
	)
		.bind(
			body.title ?? row.name,
			body.content ?? row.content,
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			toJSON(body.tags ?? parseJSON(row.tags, [])),
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'prompt', row.id, body.access_grants);
	if (body.content !== undefined || body.title !== undefined) {
		await recordHistory(c, row.id, user.id, {
			name: body.title ?? row.name,
			content: body.content ?? row.content
		});
	}
	const updated = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1')
		.bind(row.id)
		.first<PromptRow>();
	const grants = (await listGrants(c.env, 'prompt', [row.id])).get(row.id) ?? [];
	return c.json(serialize(updated!, grants));
});

app.post('/id/:command{[^/]+}/access/update', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const body = (await c.req.json()) as { access_grants?: any[] };
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	const grants = await replaceGrants(c.env, 'prompt', row.id, body.access_grants ?? []);
	return c.json(serialize(row, grants));
});

app.post('/id/:command{[^/]+}/toggle', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare('UPDATE prompt SET is_active = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(row.is_active ? 0 : 1, now(), row.id)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1')
		.bind(row.id)
		.first<PromptRow>();
	return c.json(serialize(updated!));
});

app.post('/id/:command{[^/]+}/update/meta', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const body = (await c.req.json()) as any;
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare(
		'UPDATE prompt SET name = ?1, meta = ?2, tags = ?3, updated_at = ?4 WHERE id = ?5'
	)
		.bind(
			body.title ?? row.name,
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			toJSON(body.tags ?? parseJSON(row.tags, [])),
			now(),
			row.id
		)
		.run();
	const updated = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1')
		.bind(row.id)
		.first<PromptRow>();
	return c.json(serialize(updated!));
});

/** Version history: one snapshot per update, newest first. */
app.get('/id/:command{[^/]+}/history', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id))) throw forbidden();

	const page = clampInt(c.req.query('page'), 0, 100_000, 0);
	const { results } = await c.env.DB.prepare(
		// created_at has second granularity, so two edits in the same second would
		// otherwise come back in an arbitrary order; rowid keeps it deterministic.
		`SELECT * FROM prompt_history WHERE prompt_id = ?1 ORDER BY created_at DESC, rowid DESC
		 LIMIT 30 OFFSET ${page * 30}`
	)
		.bind(row.id)
		.all();
	return c.json(
		await Promise.all(((results ?? []) as any[]).map((entry) => serializeHistory(c, entry)))
	);
});

app.get('/id/:command{[^/]+}/history/diff', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id))) throw forbidden();

	const fromId = c.req.query('from_id');
	const toId = c.req.query('to_id');
	if (!fromId || !toId) throw bad('from_id and to_id are required');

	// Both entries must belong to this prompt: an unbound id would read another
	// prompt's snapshot.
	const from = await c.env.DB.prepare(
		'SELECT * FROM prompt_history WHERE id = ?1 AND prompt_id = ?2'
	)
		.bind(fromId, row.id)
		.first<any>();
	const to = await c.env.DB.prepare('SELECT * FROM prompt_history WHERE id = ?1 AND prompt_id = ?2')
		.bind(toId, row.id)
		.first<any>();
	if (!from || !to) throw notFound('History entry not found');

	const fromSnapshot = parseJSON<Record<string, any>>(from.snapshot, {});
	const toSnapshot = parseJSON<Record<string, any>>(to.snapshot, {});
	return c.json({
		from_id: fromId,
		to_id: toId,
		from_snapshot: fromSnapshot,
		to_snapshot: toSnapshot,
		content_diff: unifiedDiff(
			String(fromSnapshot.content ?? ''),
			String(toSnapshot.content ?? ''),
			`v${fromId.slice(0, 8)}`,
			`v${toId.slice(0, 8)}`
		),
		name_changed: fromSnapshot.name !== toSnapshot.name
	});
});

app.get('/id/:command{[^/]+}/history/:historyId', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id))) throw forbidden();

	const entry = await c.env.DB.prepare(
		'SELECT * FROM prompt_history WHERE id = ?1 AND prompt_id = ?2'
	)
		.bind(c.req.param('historyId'), row.id)
		.first<any>();
	if (!entry) throw notFound('History entry not found');
	return c.json(await serializeHistory(c, entry));
});

/** Restores a previous version, recording the restore as a new snapshot. */
app.post('/id/:command{[^/]+}/update/version', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const body = (await c.req.json()) as { version_id?: string };
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	if (!body.version_id) throw bad('version_id is required');

	const entry = await c.env.DB.prepare(
		'SELECT * FROM prompt_history WHERE id = ?1 AND prompt_id = ?2'
	)
		.bind(body.version_id, row.id)
		.first<any>();
	if (!entry) throw notFound('History entry not found');

	const snapshot = parseJSON<Record<string, any>>(entry.snapshot, {});
	await c.env.DB.prepare(
		'UPDATE prompt SET name = ?1, content = ?2, version_id = ?3, updated_at = ?4 WHERE id = ?5'
	)
		.bind(
			snapshot.name ?? row.name,
			snapshot.content ?? row.content,
			body.version_id,
			now(),
			row.id
		)
		.run();
	await recordHistory(
		c,
		row.id,
		user.id,
		{
			name: snapshot.name ?? row.name,
			content: snapshot.content ?? row.content
		},
		`Restored version ${String(body.version_id).slice(0, 8)}`
	);

	const updated = await c.env.DB.prepare('SELECT * FROM prompt WHERE id = ?1')
		.bind(row.id)
		.first<PromptRow>();
	return c.json(serialize(updated!));
});

app.delete('/id/:command{[^/]+}/delete', async (c) => {
	const user = verifiedUser(c);
	const command = c.req.param('command').replace(/^\//, '');
	const row = await c.env.DB.prepare('SELECT * FROM prompt WHERE command = ?1')
		.bind(command)
		.first<PromptRow>();
	if (!row) throw notFound('Prompt not found');
	if (!(await hasAccess(c.env, user, 'prompt', row.id, row.user_id, 'write'))) throw forbidden();
	await deleteGrants(c.env, 'prompt', row.id);
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM prompt_history WHERE prompt_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM prompt WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

export default app;
