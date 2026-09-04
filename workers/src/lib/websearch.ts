/**
 * Web search providers.
 *
 * Everything runs over plain `fetch`, so no provider SDKs are needed. The
 * default (`duckduckgo`) needs no API key but is best-effort — it scrapes the
 * HTML endpoint and can be rate-limited from shared egress IPs, so a keyed
 * provider is recommended for anything beyond casual use.
 */

import type { Env } from '../types';
import { getConfigMany } from './config';
import { HttpError } from './util';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const decodeEntities = (text: string): string =>
	text
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** DuckDuckGo wraps result links in a redirect; unwrap it back to the target. */
function unwrapDuckDuckGoUrl(href: string): string {
	const match = /[?&]uddg=([^&]+)/.exec(href);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			// fall through to the raw href
		}
	}
	return href.startsWith('//') ? `https:${href}` : href;
}

async function duckduckgo(query: string, count: number): Promise<SearchResult[]> {
	const response = await fetch('https://html.duckduckgo.com/html/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': 'Mozilla/5.0 (compatible; OpenWebUI-Workers/1.0)'
		},
		body: new URLSearchParams({ q: query }).toString(),
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) throw new HttpError(502, `DuckDuckGo responded ${response.status}`);

	const html = await response.text();
	const results: SearchResult[] = [];
	const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

	const snippets: string[] = [];
	let snippetMatch: RegExpExecArray | null;
	while ((snippetMatch = snippetPattern.exec(html)) !== null) {
		snippets.push(decodeEntities(snippetMatch[1]));
	}

	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(html)) !== null && results.length < count) {
		results.push({
			url: unwrapDuckDuckGoUrl(match[1]),
			title: decodeEntities(match[2]),
			snippet: snippets[results.length] ?? ''
		});
	}
	return results;
}

async function searxng(baseUrl: string, query: string, count: number): Promise<SearchResult[]> {
	const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
	url.searchParams.set('q', query);
	url.searchParams.set('format', 'json');
	const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new HttpError(502, `SearXNG responded ${response.status}`);
	const payload = (await response.json()) as { results?: any[] };
	return (payload.results ?? []).slice(0, count).map((item) => ({
		title: item.title ?? item.url,
		url: item.url,
		snippet: item.content ?? ''
	}));
}

async function tavily(key: string, query: string, count: number): Promise<SearchResult[]> {
	const response = await fetch('https://api.tavily.com/search', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ api_key: key, query, max_results: count }),
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new HttpError(502, `Tavily responded ${response.status}`);
	const payload = (await response.json()) as { results?: any[] };
	return (payload.results ?? []).map((item) => ({
		title: item.title ?? item.url,
		url: item.url,
		snippet: item.content ?? ''
	}));
}

async function serper(key: string, query: string, count: number): Promise<SearchResult[]> {
	const response = await fetch('https://google.serper.dev/search', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
		body: JSON.stringify({ q: query, num: count }),
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new HttpError(502, `Serper responded ${response.status}`);
	const payload = (await response.json()) as { organic?: any[] };
	return (payload.organic ?? []).slice(0, count).map((item) => ({
		title: item.title ?? item.link,
		url: item.link,
		snippet: item.snippet ?? ''
	}));
}

async function brave(key: string, query: string, count: number): Promise<SearchResult[]> {
	const url = new URL('https://api.search.brave.com/res/v1/web/search');
	url.searchParams.set('q', query);
	url.searchParams.set('count', String(count));
	const response = await fetch(url.toString(), {
		headers: { Accept: 'application/json', 'X-Subscription-Token': key },
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new HttpError(502, `Brave responded ${response.status}`);
	const payload = (await response.json()) as { web?: { results?: any[] } };
	return (payload.web?.results ?? []).slice(0, count).map((item) => ({
		title: item.title ?? item.url,
		url: item.url,
		snippet: item.description ?? ''
	}));
}

/**
 * Google Programmable Search Engine.
 *
 * Needs two values rather than one: an API key and the search engine id (the
 * `cx`), which is what scopes the search. `num` is capped at 10 per request by
 * the API, so a larger result count is clamped rather than silently ignored.
 */
async function googlePse(
	key: string,
	engineId: string,
	query: string,
	count: number
): Promise<SearchResult[]> {
	const url = new URL('https://www.googleapis.com/customsearch/v1');
	url.searchParams.set('key', key);
	url.searchParams.set('cx', engineId);
	url.searchParams.set('q', query);
	url.searchParams.set('num', String(Math.min(Math.max(count, 1), 10)));

	const response = await fetch(url.toString(), {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) {
		// Google puts the useful part in the body; a bare status hides whether
		// it is a bad key, a bad cx, or the daily quota.
		const detail = await response
			.json()
			.then((body: any) => body?.error?.message)
			.catch(() => null);
		throw new HttpError(
			502,
			`Google PSE responded ${response.status}${detail ? `: ${detail}` : ''}`
		);
	}
	const payload = (await response.json()) as { items?: any[] };
	return (payload.items ?? []).slice(0, count).map((item) => ({
		title: item.title ?? item.link,
		url: item.link,
		snippet: item.snippet ?? ''
	}));
}

/** The engines this port actually implements, as opposed to the thirty the admin screen offers. */
export const IMPLEMENTED_ENGINES = [
	'duckduckgo',
	'searxng',
	'google_pse',
	'tavily',
	'serper',
	'brave'
];

export async function webSearch(
	env: Env,
	query: string,
	options: { count?: number } = {}
): Promise<SearchResult[]> {
	const config = await getConfigMany(env, [
		'web.search.engine',
		'web.search.api_key',
		'web.search.url',
		'web.search.result_count',
		'web.search.google_pse.api_key',
		'web.search.google_pse.engine_id'
	]);
	const engine = String(config['web.search.engine'] ?? 'duckduckgo').toLowerCase();
	const key = String(config['web.search.api_key'] ?? '') || env.WEB_SEARCH_API_KEY || '';
	const url = String(config['web.search.url'] ?? '') || env.WEB_SEARCH_URL || '';
	const count = options.count ?? Number(config['web.search.result_count'] ?? 3) ?? 3;

	const needsKey = (name: string) => {
		if (!key) {
			throw new HttpError(
				400,
				`The ${name} web-search provider needs an API key. Set it under ` +
					'Admin Settings → Web Search, or switch the engine to "duckduckgo".'
			);
		}
		return key;
	};

	switch (engine) {
		case 'searxng':
			if (!url) throw new HttpError(400, 'SearXNG needs a base URL (web.search.url).');
			return searxng(url, query, count);
		case 'tavily':
			return tavily(needsKey('Tavily'), query, count);
		case 'serper':
			return serper(needsKey('Serper'), query, count);
		case 'brave':
			return brave(needsKey('Brave'), query, count);
		case 'google_pse': {
			// Its own key/engine pair, so switching engines does not require
			// retyping the shared WEB_SEARCH_API_KEY field.
			const pseKey = String(config['web.search.google_pse.api_key'] ?? '') || key;
			const engineId = String(config['web.search.google_pse.engine_id'] ?? '');
			if (!pseKey || !engineId) {
				throw new HttpError(
					400,
					'Google PSE needs both an API key and a search engine ID. Set them ' +
						'under Admin Settings → Web Search.'
				);
			}
			return googlePse(pseKey, engineId, query, count);
		}
		case 'duckduckgo':
			return duckduckgo(query, count);
		default:
			// The admin screen lists thirty engines; six are implemented. Falling
			// through to DuckDuckGo made every unimplemented one look like it
			// worked — including ones with no API key set — which is worse than
			// failing, because the results looked plausible and came from the
			// wrong place.
			throw new HttpError(
				400,
				`The "${engine}" web-search provider is not implemented in the ` +
					'Cloudflare Workers port. Choose one of: ' +
					`${IMPLEMENTED_ENGINES.join(', ')} — under Admin Settings → Web Search.`
			);
	}
}

/** Fetches a result page and reduces it to plain text for the model. */
export async function fetchPageText(url: string, maxChars = 6000): Promise<string> {
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OpenWebUI-Workers/1.0)' },
			signal: AbortSignal.timeout(12_000)
		});
		if (!response.ok) return '';
		const contentType = response.headers.get('content-type') ?? '';
		if (!/text\/html|text\/plain|application\/(json|xml)/.test(contentType)) return '';
		const body = await response.text();
		return htmlToText(body).slice(0, maxChars);
	} catch {
		return '';
	}
}

/** Crude tag stripper — enough to make a page readable without a DOM. */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}
