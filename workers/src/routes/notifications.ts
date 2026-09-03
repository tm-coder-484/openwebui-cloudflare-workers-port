/**
 * `/api/v1/notifications` — webhook targets for chat events.
 *
 * Targets are stored in the config table; delivery itself is not wired up in
 * this port, so the endpoints keep the settings screen functional without
 * pretending messages are being sent.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { getConfig, setConfig } from '../lib/config';
import { bad, now, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface Target {
	id: string;
	name: string;
	url: string;
	type?: string;
	is_default?: boolean;
	created_at: number;
}

const key = (userId: string) => `notifications.targets.${userId}`;

app.get('/targets', async (c) => {
	const user = verifiedUser(c);
	return c.json((await getConfig<Target[]>(c.env, key(user.id))) ?? []);
});

app.post('/targets', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as Partial<Target>;
	if (!body.url) throw bad('A webhook URL is required');
	const targets = (await getConfig<Target[]>(c.env, key(user.id))) ?? [];
	const target: Target = {
		id: uuid(),
		name: body.name ?? body.url,
		url: body.url,
		type: body.type ?? 'webhook',
		is_default: targets.length === 0,
		created_at: now()
	};
	await setConfig(c.env, key(user.id), [...targets, target]);
	return c.json(target);
});

app.delete('/targets/:id', async (c) => {
	const user = verifiedUser(c);
	const targets = (await getConfig<Target[]>(c.env, key(user.id))) ?? [];
	await setConfig(
		c.env,
		key(user.id),
		targets.filter((target) => target.id !== c.req.param('id'))
	);
	return c.json(true);
});

app.post('/targets/:id/default', async (c) => {
	const user = verifiedUser(c);
	const targets = (await getConfig<Target[]>(c.env, key(user.id))) ?? [];
	const updated = targets.map((target) => ({
		...target,
		is_default: target.id === c.req.param('id')
	}));
	await setConfig(c.env, key(user.id), updated);
	return c.json(updated);
});

app.post('/targets/:id/test', async (c) => {
	const user = verifiedUser(c);
	const targets = (await getConfig<Target[]>(c.env, key(user.id))) ?? [];
	const target = targets.find((item) => item.id === c.req.param('id'));
	if (!target) throw bad('Target not found');
	const response = await fetch(target.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text: 'Test notification from Open WebUI' }),
		signal: AbortSignal.timeout(10_000)
	}).catch(() => null);
	return c.json({ status: Boolean(response?.ok) });
});

app.get('/events', async (c) => {
	verifiedUser(c);
	return c.json([]);
});

export default app;
