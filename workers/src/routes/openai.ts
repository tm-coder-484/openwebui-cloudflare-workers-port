/** `/openai/*` — passthrough to the configured OpenAI-compatible connections. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getBaseModels, openaiConnections } from '../lib/models';
import { getConfigMany, setConfigMany } from '../lib/config';
import { bad, clampInt } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

app.get('/config', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, [
		'openai.enable',
		'openai.api_base_urls',
		'openai.api_keys',
		'openai.api_configs'
	]);
	return c.json({
		ENABLE_OPENAI_API: config['openai.enable'],
		OPENAI_API_BASE_URLS: config['openai.api_base_urls'],
		OPENAI_API_KEYS: config['openai.api_keys'],
		OPENAI_API_CONFIGS: config['openai.api_configs']
	});
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	await setConfigMany(c.env, {
		'openai.enable': body.ENABLE_OPENAI_API,
		'openai.api_base_urls': body.OPENAI_API_BASE_URLS,
		'openai.api_keys': body.OPENAI_API_KEYS,
		'openai.api_configs': body.OPENAI_API_CONFIGS
	});
	return c.json(body);
});

app.get('/models', async (c) => {
	verifiedUser(c);
	const models = (await getBaseModels(c.env)).filter((model) => model.owned_by === 'openai');
	return c.json({ object: 'list', data: models });
});

app.get('/models/:urlIdx', async (c) => {
	adminUser(c);
	const idx = clampInt(c.req.param('urlIdx'), 0, 100, 0);
	const connections = await openaiConnections(c.env);
	const connection = connections.find((item) => item.idx === idx);
	if (!connection) throw bad('Connection not found');
	const response = await fetch(`${connection.url}/models`, {
		headers: connection.key ? { Authorization: `Bearer ${connection.key}` } : {}
	});
	return c.json(await response.json());
});

app.post('/verify', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { url?: string; key?: string };
	if (!body.url) throw bad('A URL is required');
	const response = await fetch(`${body.url.replace(/\/+$/, '')}/models`, {
		headers: body.key ? { Authorization: `Bearer ${body.key}` } : {},
		signal: AbortSignal.timeout(10_000)
	});
	if (!response.ok) throw bad(`Connection failed with status ${response.status}`);
	return c.json(await response.json());
});

/**
 * Direct passthrough for API clients that speak plain OpenAI (including SSE).
 * The web UI does not use this path — it posts to /api/chat/completions.
 */
app.post('/chat/completions', async (c) => {
	verifiedUser(c);
	const connection = (await openaiConnections(c.env))[0];
	if (!connection) throw bad('No OpenAI-compatible connection is configured.');
	const body = await c.req.json();
	const response = await fetch(`${connection.url}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {})
		},
		body: JSON.stringify(body)
	});
	return new Response(response.body, {
		status: response.status,
		headers: {
			'Content-Type': response.headers.get('content-type') ?? 'application/json',
			'Cache-Control': 'no-cache'
		}
	});
});

export default app;
