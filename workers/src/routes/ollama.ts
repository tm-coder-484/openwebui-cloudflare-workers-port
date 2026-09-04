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
import { ollamaBases, ollamaKeys } from '../lib/models';
import { bad, HttpError } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

interface OllamaTarget {
	/** Root of the native API — never the `/v1` OpenAI shim. */
	url: string;
	key: string;
}

/**
 * The configured servers, as the *native* API expects to be addressed.
 *
 * Two things this has to get right, both of which it used to get wrong for
 * ollama.com:
 *
 *  - The routes below speak the native protocol (`/api/tags`, `/api/version`),
 *    which lives at the root. A connection entered as `https://ollama.com/v1`
 *    — the URL the model side wants, and the one the setup guide gives — turned
 *    into `https://ollama.com/v1/api/tags`, which is a 404. Verified against the
 *    live service: the root answers 200, the `/v1` form answers 404.
 *  - Ollama Cloud is authenticated. Nothing here sent a key at all, so even the
 *    correct URL would have come back unauthorized on anything user-specific.
 */
async function targets(c: any): Promise<OllamaTarget[]> {
	const config = await getConfigMany(c.env, [
		'ollama.enable',
		'ollama.base_urls',
		'ollama.api_configs',
		'ollama.api_keys'
	]);
	if (!config['ollama.enable']) return [];

	const configs = (config['ollama.api_configs'] as Record<string, any>) ?? {};
	const pooled = ollamaKeys(c.env, config['ollama.api_keys']);
	return ((config['ollama.base_urls'] as string[]) ?? []).map((entry, index) => {
		const own = String(configs[String(index)]?.key ?? configs[entry]?.key ?? '');
		return {
			url: ollamaBases(String(entry)).native,
			// A connection's own key wins; otherwise take one from the shared pool
			// at random, so a pool of keys spreads instead of hammering the first.
			key: own || pooled[Math.floor(Math.random() * pooled.length)] || ''
		};
	});
}

const headersFor = (target: OllamaTarget): Record<string, string> => ({
	'Content-Type': 'application/json',
	...(target.key ? { Authorization: `Bearer ${target.key}` } : {})
});

app.get('/config', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, [
		'ollama.enable',
		'ollama.base_urls',
		'ollama.api_configs'
	]);
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
	const [target] = await targets(c);
	if (!target) return c.json({ version: null });
	const response = await fetch(`${target.url}/api/version`, {
		headers: headersFor(target),
		signal: AbortSignal.timeout(10_000)
	}).catch(() => null);
	return c.json(response?.ok ? await response.json() : { version: null });
});

app.get('/api/tags', async (c) => {
	verifiedUser(c);
	const configured = await targets(c);
	const models: unknown[] = [];
	const failures: string[] = [];

	for (const target of configured) {
		try {
			const response = await fetch(`${target.url}/api/tags`, {
				headers: headersFor(target),
				signal: AbortSignal.timeout(10_000)
			});
			if (!response.ok) {
				failures.push(
					`${target.url} responded ${response.status}` +
						(response.status === 401 || response.status === 403
							? ' — it needs an API key. Add one to this connection, or set OLLAMA_API_KEYS.'
							: '')
				);
				continue;
			}
			const payload = (await response.json()) as { models?: unknown[] };
			models.push(...(payload.models ?? []));
		} catch (error) {
			failures.push(`${target.url}: ${(error as Error).message}`);
		}
	}

	// An empty list is the honest answer when nothing is configured. It is a lie
	// when every configured server failed: that is how a 404 from the wrong URL
	// looked like "this account has no models" for so long.
	if (!models.length && failures.length) {
		throw new HttpError(502, `Could not list Ollama models. ${failures.join('; ')}`);
	}
	return c.json({ models });
});

app.all('/*', async (c) => {
	verifiedUser(c);
	const [target] = await targets(c);
	if (!target) throw bad('No Ollama server is configured.');
	const path = new URL(c.req.url).pathname.replace(/^\/ollama/, '');
	const response = await fetch(`${target.url}${path}`, {
		method: c.req.method,
		headers: headersFor(target),
		body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text()
	});
	return new Response(response.body, {
		status: response.status,
		headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }
	});
});

export default app;
