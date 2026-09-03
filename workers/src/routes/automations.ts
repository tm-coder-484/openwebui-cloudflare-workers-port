/** `/api/v1/automations` — scheduled prompts, executed by the Cron Trigger. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { hasPermission } from '../lib/permissions';
import {
	computeNextRun,
	recordRun,
	runAutomation,
	serializeAutomation,
	type AutomationRow
} from '../lib/automations';
import { nextOccurrence } from '../lib/rrule';
import { getUserById } from '../lib/users';
import { bad, clampInt, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

async function load(c: any, id: string): Promise<AutomationRow> {
	const user = verifiedUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM automation WHERE id = ?1')
		.bind(id)
		.first()) as AutomationRow | null;
	if (!row) throw notFound('Automation not found');
	if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
	return row;
}

/** The next few fire times, so the UI can show an upcoming-runs preview. */
async function upcoming(c: any, row: AutomationRow, count = 3): Promise<number[]> {
	const data = parseJSON<{ rrule?: string }>(row.data, {});
	if (!data.rrule) return [];
	const user = await getUserById(c.env, row.user_id);
	const runs: number[] = [];
	let cursor = Date.now();
	for (let i = 0; i < count; i++) {
		const next = nextOccurrence(data.rrule, cursor, user?.timezone ?? null);
		if (next === null) break;
		runs.push(next * 1_000_000);
		cursor = next;
	}
	return runs;
}

async function withDetails(c: any, row: AutomationRow) {
	const lastRun = await c.env.DB.prepare(
		'SELECT * FROM automation_run WHERE automation_id = ?1 ORDER BY created_at DESC LIMIT 1'
	)
		.bind(row.id)
		.first();
	return serializeAutomation(row, {
		last_run: lastRun ?? null,
		next_runs: await upcoming(c, row)
	});
}

app.get('/list', async (c) => {
	const user = verifiedUser(c);
	const folderId = c.req.query('folder_id');
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM automation WHERE user_id = ?1 ${folderId ? 'AND folder_id = ?2' : ''}
		 ORDER BY updated_at DESC`
	)
		.bind(...(folderId ? [user.id, folderId] : [user.id]))
		.all();
	const rows = (results ?? []) as unknown as AutomationRow[];
	return c.json(await Promise.all(rows.map((row) => withDetails(c, row))));
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'features.automations'))) throw forbidden();
	const body = (await c.req.json()) as any;
	if (!body?.name) throw bad('An automation name is required');
	if (!body?.data?.prompt || !body?.data?.model_id) {
		throw bad('An automation needs a prompt and a model');
	}
	if (!body?.data?.rrule) throw bad('An automation needs a schedule');

	const id = uuid();
	const timestamp = now();
	const nextRun = await computeNextRun(c.env, { user_id: user.id, data: toJSON(body.data)! });

	await c.env.DB.prepare(
		`INSERT INTO automation
			(id, user_id, folder_id, name, data, meta, is_active, last_run_at, next_run_at, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?9)`
	)
		.bind(
			id,
			user.id,
			body.folder_id ?? null,
			body.name,
			toJSON(body.data),
			toJSON(body.meta ?? {}),
			body.is_active === false ? 0 : 1,
			nextRun,
			timestamp
		)
		.run();

	const row = (await c.env.DB.prepare('SELECT * FROM automation WHERE id = ?1')
		.bind(id)
		.first()) as AutomationRow;
	return c.json(await withDetails(c, row));
});

app.get('/:id', async (c) => c.json(await withDetails(c, await load(c, c.req.param('id')))));

app.post('/:id/update', async (c) => {
	const row = await load(c, c.req.param('id'));
	const body = (await c.req.json()) as any;
	const data = body.data ?? parseJSON(row.data, {});
	const nextRun = await computeNextRun(c.env, { user_id: row.user_id, data: toJSON(data)! });

	await c.env.DB.prepare(
		`UPDATE automation SET name = ?1, folder_id = ?2, data = ?3, meta = ?4, is_active = ?5,
			next_run_at = ?6, updated_at = ?7 WHERE id = ?8`
	)
		.bind(
			body.name ?? row.name,
			body.folder_id === undefined ? row.folder_id : body.folder_id,
			toJSON(data),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			body.is_active === undefined ? row.is_active : body.is_active ? 1 : 0,
			body.is_active === false ? null : nextRun,
			now(),
			row.id
		)
		.run();

	const updated = (await c.env.DB.prepare('SELECT * FROM automation WHERE id = ?1')
		.bind(row.id)
		.first()) as AutomationRow;
	return c.json(await withDetails(c, updated));
});

app.post('/:id/toggle', async (c) => {
	const row = await load(c, c.req.param('id'));
	const active = row.is_active ? 0 : 1;
	const nextRun = active ? await computeNextRun(c.env, row) : null;
	await c.env.DB.prepare(
		'UPDATE automation SET is_active = ?1, next_run_at = ?2, updated_at = ?3 WHERE id = ?4'
	)
		.bind(active, nextRun, now(), row.id)
		.run();
	const updated = (await c.env.DB.prepare('SELECT * FROM automation WHERE id = ?1')
		.bind(row.id)
		.first()) as AutomationRow;
	return c.json(await withDetails(c, updated));
});

app.post('/:id/run', async (c) => {
	const row = await load(c, c.req.param('id'));
	try {
		const chatId = await runAutomation(c.env, row);
		await recordRun(c.env, row.id, 'success', { chatId });
		await c.env.DB.prepare('UPDATE automation SET last_run_at = ?1 WHERE id = ?2')
			.bind(Date.now() * 1_000_000, row.id)
			.run();
		return c.json({ status: true, chat_id: chatId });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordRun(c.env, row.id, 'error', { error: message });
		throw bad(message);
	}
});

app.get('/:id/runs', async (c) => {
	const row = await load(c, c.req.param('id'));
	const skip = clampInt(c.req.query('skip'), 0, 1_000_000, 0);
	const limit = clampInt(c.req.query('limit'), 1, 100, 20);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM automation_run WHERE automation_id = ?1
		 ORDER BY created_at DESC LIMIT ${limit} OFFSET ${skip}`
	)
		.bind(row.id)
		.all();
	return c.json(results ?? []);
});

app.delete('/:id/delete', async (c) => {
	const row = await load(c, c.req.param('id'));
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM automation_run WHERE automation_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM automation WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

export default app;
