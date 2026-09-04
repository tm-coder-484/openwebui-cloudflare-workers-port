import { describe, expect, it } from 'vitest';
import { htmlToText, webSearch } from '../src/lib/websearch';

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
