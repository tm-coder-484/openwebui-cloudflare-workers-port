/**
 * `/ollama/*` — proxy to Ollama servers reachable over the public internet.
 *
 * Workers cannot reach `localhost`, so an Ollama endpoint must be a routable
 * HTTPS URL (a tunnel, or a host on Cloudflare Tunnel). When none is set the
 * endpoints answer with empty lists so the UI degrades cleanly.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { bad } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

async function baseUrls(c: any): Promise<string[]> {
	const config = await getConfigMany(c.env, ['ollama.enable', 'ollama.base_urls']);
	if (!config['ollama.enable']) return [];
	return ((config['ollama.base_urls'] as string[]) ?? []).map((url) => url.replace(/\/+$/, ''));
}

app.get('/config', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, ['ollama.enable', 'ollama.base_urls', 'ollama.api_configs']);
	return c.json({
		ENABLE_OLLAMA_API: config['ollama.enable'],
		OLLAMA_BASE_URLS: config['ollama.base_urls'],
		OLLAMA_API_CONFIGS: config['ollama.api_configs']
	});
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	await setConfigMany(c.env, {
		'ollama.enable': body.ENABLE_OLLAMA_API,
		'ollama.base_urls': body.OLLAMA_BASE_URLS,
		'ollama.api_configs': body.OLLAMA_API_CONFIGS
	});
	return c.json(body);
});

app.get('/api/version', async (c) => {
	verifiedUser(c);
	const urls = await baseUrls(c);
	if (!urls.length) return c.json({ version: null });
	const response = await fetch(`${urls[0]}/api/version`).catch(() => null);
	return c.json(response?.ok ? await response.json() : { version: null });
});

app.get('/api/tags', async (c) => {
	verifiedUser(c);
	const urls = await baseUrls(c);
	const models: unknown[] = [];
	for (const url of urls) {
		const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) }).catch(
			() => null
		);
		if (response?.ok) {
			const payload = (await response.json()) as { models?: unknown[] };
			models.push(...(payload.models ?? []));
		}
	}
	return c.json({ models });
});

app.all('/*', async (c) => {
	verifiedUser(c);
	const urls = await baseUrls(c);
	if (!urls.length) throw bad('No Ollama server is configured.');
	const path = new URL(c.req.url).pathname.replace(/^\/ollama/, '');
	const response = await fetch(`${urls[0]}${path}`, {
		method: c.req.method,
		headers: { 'Content-Type': 'application/json' },
		body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text()
	});
	return new Response(response.body, {
		status: response.status,
		headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }
	});
});

export default app;
