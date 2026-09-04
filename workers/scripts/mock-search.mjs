#!/usr/bin/env node
/**
 * A stand-in SearXNG instance, plus the pages it points at.
 *
 * SearXNG is software you host rather than a hosted API, so there is no public
 * endpoint the smoke test can rely on. This serves the same JSON contract a
 * real instance serves with `json` in its `search.formats`, and hosts two
 * result pages so the page loader has something real to fetch.
 *
 *   node scripts/mock-search.mjs [--port 9600]
 *
 * Point the Worker at http://127.0.0.1:<port> under
 * Admin Settings -> Web Search -> Searxng Query URL.
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};

const PORT = Number(flag('port', 9600));
const ORIGIN = flag('origin', `http://127.0.0.1:${PORT}`);

const PAGES = {
	'/page/workers': {
		title: 'Cloudflare Workers',
		body: 'Cloudflare Workers run JavaScript at the edge in V8 isolates, with no cold start.'
	},
	'/page/d1': {
		title: 'D1',
		body: 'D1 is Cloudflare’s SQLite database, queried from a Worker over a binding.'
	}
};

const server = createServer((request, response) => {
	const url = new URL(request.url, ORIGIN);

	if (url.pathname === '/search') {
		// A stock instance serves HTML only and answers this with 403; this one
		// stands in for an instance that has been configured with `json`.
		if (url.searchParams.get('format') !== 'json') {
			response.writeHead(403, { 'Content-Type': 'text/plain' });
			return response.end('Forbidden');
		}
		const query = url.searchParams.get('q') ?? '';
		const body = JSON.stringify({
			query,
			number_of_results: 2,
			results: Object.entries(PAGES).map(([path, page]) => ({
				url: `${ORIGIN}${path}`,
				title: page.title,
				content: `${page.body.slice(0, 60)}…`,
				engine: 'mock'
			}))
		});
		response.writeHead(200, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body)
		});
		return response.end(body);
	}

	const page = PAGES[url.pathname];
	if (page) {
		const html = `<!doctype html><html><head><title>${page.title}</title>
			<style>body{font-family:sans-serif}</style><script>console.log('ignored')</script></head>
			<body><h1>${page.title}</h1><p>${page.body}</p></body></html>`;
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Length': Buffer.byteLength(html)
		});
		return response.end(html);
	}

	response.writeHead(404, { 'Content-Type': 'text/plain' });
	response.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[mock-search] searxng  ${ORIGIN}/search?q=test&format=json`);
	console.log(`[mock-search] pages    ${Object.keys(PAGES).join(', ')}`);
});
