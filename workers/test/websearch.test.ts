import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_ENGINES, htmlToText, webSearch } from '../src/lib/websearch';
import { parseQueries } from '../src/lib/completions';

describe('htmlToText', () => {
	it('strips markup, scripts and styles', () => {
		const html = `
			<html><head><style>body{color:red}</style><script>alert(1)</script></head>
			<body><h1>Title</h1><p>Hello &amp; welcome to <b>Workers</b>.</p></body></html>`;
		const text = htmlToText(html);
		expect(text).toBe('Title Hello & welcome to Workers .');
		expect(text).not.toContain('alert');
		expect(text).not.toContain('color:red');
	});

	it('decodes the entities that show up in titles', () => {
		expect(htmlToText('<p>Tom&#39;s &quot;quoted&quot; &lt;tag&gt;</p>')).toBe(
			'Tom\'s "quoted" <tag>'
		);
	});
});

describe('Google PSE', () => {
	const envWith = (extra: Record<string, unknown> = {}) =>
		({
			DB: {
				prepare: () => ({
					bind: () => ({ all: async () => ({ results: [] }) }),
					all: async () => ({
						results: Object.entries({
							'web.search.engine': 'google_pse',
							'web.search.google_pse.api_key': 'test-key',
							'web.search.google_pse.engine_id': 'test-cx',
							...extra
						}).map(([key, value]) => ({ key, value: JSON.stringify(value) }))
					})
				})
			}
		}) as any;

	it('calls the customsearch endpoint with the key and cx, and maps results', async () => {
		let called = '';
		globalThis.fetch = (async (url: string) => {
			called = String(url);
			return new Response(
				JSON.stringify({
					items: [
						{ title: 'First', link: 'https://a.test/1', snippet: 'one' },
						{ title: 'Second', link: 'https://a.test/2', snippet: 'two' }
					]
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}) as any;

		const results = await webSearch(envWith(), 'workers', { count: 2 });
		expect(called).toContain('https://www.googleapis.com/customsearch/v1');
		expect(called).toContain('key=test-key');
		expect(called).toContain('cx=test-cx');
		expect(results).toEqual([
			{ title: 'First', url: 'https://a.test/1', snippet: 'one' },
			{ title: 'Second', url: 'https://a.test/2', snippet: 'two' }
		]);
	});

	it('clamps num to the 10 the API allows', async () => {
		let called = '';
		globalThis.fetch = (async (url: string) => {
			called = String(url);
			return new Response('{"items":[]}', {
				headers: { 'Content-Type': 'application/json' }
			});
		}) as any;
		await webSearch(envWith(), 'workers', { count: 50 });
		expect(called).toContain('num=10');
	});

	it('refuses to search when the engine ID is missing', async () => {
		await expect(
			webSearch(envWith({ 'web.search.google_pse.engine_id': '' }), 'workers')
		).rejects.toThrow(/search engine ID/i);
	});

	it("surfaces Google's own error message rather than a bare status", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			})) as any;
		await expect(webSearch(envWith(), 'workers')).rejects.toThrow(/API key not valid/);
	});
});

describe('unimplemented engines', () => {
	const envWithEngine = (engine: string) =>
		({
			DB: {
				prepare: () => ({
					bind: () => ({ all: async () => ({ results: [] }) }),
					all: async () => ({
						results: [{ key: 'web.search.engine', value: JSON.stringify(engine) }]
					})
				})
			}
		}) as any;

	it('says so instead of silently searching DuckDuckGo', async () => {
		// The admin screen offers thirty engines; falling through made every
		// unimplemented one look like it worked, with results from the wrong place.
		await expect(webSearch(envWithEngine('kagi'), 'anything')).rejects.toThrow(/not implemented/i);
	});

	it('names the engines that do work', async () => {
		await expect(webSearch(envWithEngine('yandex'), 'anything')).rejects.toThrow(/duckduckgo/);
	});

	it('still serves the engines it implements', () => {
		expect(IMPLEMENTED_ENGINES).toContain('google_pse');
		expect(IMPLEMENTED_ENGINES).toContain('duckduckgo');
	});
});

/** A DB stub returning exactly the config rows a test cares about. */
const envWithConfig = (rows: Record<string, unknown>) =>
	({
		DB: {
			prepare: () => ({
				bind: () => ({ all: async () => ({ results: [] }) }),
				all: async () => ({
					results: Object.entries(rows).map(([key, value]) => ({
						key,
						value: JSON.stringify(value)
					}))
				})
			})
		}
	}) as any;

describe('Ollama web search', () => {
	it('posts the query to ollama.com with the configured key and maps results', async () => {
		const calls: { url: string; auth: string; body: any }[] = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			calls.push({
				url: String(url),
				auth: String((init.headers as any).Authorization),
				body: JSON.parse(String(init.body))
			});
			return new Response(
				JSON.stringify({
					results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'cloud models' }]
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}) as any;

		const results = await webSearch(
			envWithConfig({
				'web.search.engine': 'ollama_cloud',
				'web.search.ollama_cloud.api_key': 'key-a'
			}),
			'what is ollama',
			{ count: 5 }
		);

		expect(calls[0].url).toBe('https://ollama.com/api/web_search');
		expect(calls[0].auth).toBe('Bearer key-a');
		expect(calls[0].body).toEqual({ query: 'what is ollama', max_results: 5 });
		expect(results).toEqual([
			{ title: 'Ollama', url: 'https://ollama.com/', snippet: 'cloud models' }
		]);
	});

	it('clamps max_results to the 10 the API allows', async () => {
		let body: any;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response('{"results":[]}', { headers: { 'Content-Type': 'application/json' } });
		}) as any;
		await webSearch(
			envWithConfig({
				'web.search.engine': 'ollama_cloud',
				'web.search.ollama_cloud.api_key': 'key-a'
			}),
			'q',
			{ count: 50 }
		);
		expect(body.max_results).toBe(10);
	});

	it('falls through to the next key when one is rate-limited', async () => {
		const tried: string[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const auth = String((init.headers as any).Authorization);
			tried.push(auth);
			if (auth === 'Bearer key-a') return new Response('rate limited', { status: 429 });
			return new Response(
				JSON.stringify({ results: [{ title: 'T', url: 'https://a.test', content: 'c' }] }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}) as any;

		const results = await webSearch(
			envWithConfig({
				'web.search.engine': 'ollama_cloud',
				'web.search.ollama_cloud.api_key': 'key-a\nkey-b'
			}),
			'q'
		);
		expect(tried).toEqual(['Bearer key-a', 'Bearer key-b']);
		expect(results).toHaveLength(1);
	});

	it('reuses the keys entered under Connections, so no second key is needed', async () => {
		let auth = '';
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			auth = String((init.headers as any).Authorization);
			return new Response('{"results":[]}', { headers: { 'Content-Type': 'application/json' } });
		}) as any;

		await webSearch(
			envWithConfig({
				'web.search.engine': 'ollama_cloud',
				'ollama.api_configs': { '0': { key: 'connections-key' } }
			}),
			'q'
		);
		expect(auth).toBe('Bearer connections-key');
	});

	it('asks for a key rather than searching without one', async () => {
		await expect(
			webSearch(envWithConfig({ 'web.search.engine': 'ollama_cloud' }), 'q')
		).rejects.toThrow(/needs an Ollama API key/i);
	});
});

describe('SearXNG', () => {
	const searxngEnv = (extra: Record<string, unknown> = {}) =>
		envWithConfig({ 'web.search.engine': 'searxng', ...extra });

	it('requests the JSON API and maps results', async () => {
		let called = '';
		globalThis.fetch = (async (url: string) => {
			called = String(url);
			return new Response(
				JSON.stringify({ results: [{ title: 'T', url: 'https://a.test', content: 'c' }] }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}) as any;

		const results = await webSearch(
			searxngEnv({ 'web.search.url': 'https://searx.test', 'web.search.searxng.language': 'en' }),
			'workers'
		);
		expect(called).toContain('https://searx.test/search?');
		expect(called).toContain('format=json');
		expect(called).toContain('language=en');
		expect(results).toEqual([{ title: 'T', url: 'https://a.test', snippet: 'c' }]);
	});

	it('does not double up /search on a query URL that already has it', async () => {
		let called = '';
		globalThis.fetch = (async (url: string) => {
			called = String(url);
			return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://a.test' }] }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}) as any;
		await webSearch(searxngEnv({ 'web.search.url': 'https://searx.test/search' }), 'workers');
		expect(called).not.toContain('/search/search');
	});

	it('tries the next instance when the first one fails', async () => {
		const hosts: string[] = [];
		globalThis.fetch = (async (url: string) => {
			const host = new URL(String(url)).host;
			hosts.push(host);
			if (host === 'first.test') return new Response('nope', { status: 429 });
			return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://a.test' }] }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}) as any;

		const results = await webSearch(
			searxngEnv({ 'web.search.url': 'https://first.test, https://second.test' }),
			'workers'
		);
		expect(hosts).toEqual(['first.test', 'second.test']);
		expect(results).toHaveLength(1);
	});

	it('explains a 403 as the JSON format being disabled, not a bad key', async () => {
		// The single most common SearXNG failure: a stock instance serves HTML
		// only, and `format=json` comes back 403 on an engine that has no key.
		globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as any;
		await expect(
			webSearch(searxngEnv({ 'web.search.url': 'https://searx.test' }), 'workers')
		).rejects.toThrow(/search\.formats/);
	});

	it('says an HTML answer is not the JSON API', async () => {
		globalThis.fetch = (async () =>
			new Response('<html><body>results</body></html>', {
				headers: { 'Content-Type': 'text/html' }
			})) as any;
		await expect(
			webSearch(searxngEnv({ 'web.search.url': 'https://searx.test' }), 'workers')
		).rejects.toThrow(/returned HTML, not JSON/);
	});

	it('explains that an instance URL is required', async () => {
		await expect(webSearch(searxngEnv(), 'workers')).rejects.toThrow(/software you host/i);
	});
});

describe('parseQueries', () => {
	it('reads the JSON the prompt asks for', () => {
		expect(parseQueries('{"queries":["cloudflare workers d1","workers kv limits"]}')).toEqual([
			'cloudflare workers d1',
			'workers kv limits'
		]);
	});

	it('finds the JSON inside surrounding chatter', () => {
		// Providers that ignore response_format wrap it in prose or a code fence.
		expect(parseQueries('Sure!\n```json\n{"queries":["a query"]}\n```')).toEqual(['a query']);
	});

	it('falls back to a bare line when the model ignored the format entirely', () => {
		expect(parseQueries('cloudflare workers pricing')).toEqual(['cloudflare workers pricing']);
	});

	it('strips list markers and quotes from a bare line', () => {
		expect(parseQueries('1. "cloudflare workers pricing"')).toEqual(['cloudflare workers pricing']);
	});

	it('returns nothing for an explicitly empty list, so the caller can fall back', () => {
		expect(parseQueries('{"queries":[]}')).toEqual([]);
	});

	it('rejects a line too long to be a search query', () => {
		expect(parseQueries('x'.repeat(400))).toEqual([]);
	});
});
