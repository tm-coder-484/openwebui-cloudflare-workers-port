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
import { ollamaKeys } from './models';
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

/**
 * SearXNG — a metasearch engine you run yourself.
 *
 * Two things make it fail in ways the bare status code does not explain, so
 * both are handled here:
 *
 *  - `format: json` is *not* in a stock instance's `search.formats`. An
 *    instance that only serves HTML answers the same URL with 403, which
 *    otherwise reads as "wrong key" on an engine that has no key.
 *  - Public instances rate-limit hard, and Workers egress from shared
 *    Cloudflare IPs, so one instance is a single point of failure. A list is
 *    accepted and tried in order.
 */
async function searxng(
	baseUrls: string[],
	query: string,
	count: number,
	language: string
): Promise<SearchResult[]> {
	const failures: string[] = [];

	for (const base of baseUrls) {
		// A URL already pointing at /search (upstream's "Searxng Query URL",
		// often written `http://host:8080/search?q=<query>`) is kept as-is.
		const trimmed = base.replace(/\/+$/, '');
		const url = new URL(
			/\/search$/.test(new URL(trimmed).pathname) ? trimmed : `${trimmed}/search`
		);
		url.searchParams.set('q', query);
		url.searchParams.set('format', 'json');
		if (language && language !== 'all') url.searchParams.set('language', language);

		try {
			const response = await fetch(url.toString(), {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(15_000)
			});
			if (!response.ok) {
				failures.push(
					response.status === 403
						? `${url.host} refused the JSON API (403) — add "json" to \`search.formats\` in its settings.yml`
						: `${url.host} responded ${response.status}`
				);
				continue;
			}
			// An HTML-only instance can answer 200 with a page rather than JSON.
			const body = await response.text();
			let payload: { results?: any[] };
			try {
				payload = JSON.parse(body);
			} catch {
				// Measured across the 81 public instances on searx.space: nine answer
				// 200 with a "verifying your browser" page rather than results.
				failures.push(
					`${url.host} returned HTML, not JSON — either its \`search.formats\` ` +
						'omits "json", or it served a bot check'
				);
				continue;
			}
			const results = (payload.results ?? []).slice(0, count).map((item: any) => ({
				title: item.title ?? item.url,
				url: item.url,
				snippet: item.content ?? ''
			}));
			if (results.length) return results;
			failures.push(`${url.host} returned no results`);
		} catch (error) {
			failures.push(`${url.host}: ${(error as Error).message}`);
		}
	}

	throw new HttpError(502, `SearXNG search failed. ${failures.join('; ')}`);
}

/**
 * Ollama's hosted web search — `POST /api/web_search` on ollama.com.
 *
 * This is the one engine on this deployment that needs no extra account: the
 * same API key that runs the models runs the search. The key list arrives
 * already rotated (see `ollamaSearchKeys`), so this walks it from wherever it
 * starts and falls back through the rest on a per-key rate limit.
 */
async function ollamaCloud(keys: string[], query: string, count: number): Promise<SearchResult[]> {
	let lastError = '';

	for (const key of keys) {
		const response = await fetch('https://ollama.com/api/web_search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
			// max_results is capped at 10 by the API; asking for more is rejected.
			body: JSON.stringify({ query, max_results: Math.min(Math.max(count, 1), 10) }),
			signal: AbortSignal.timeout(20_000)
		});

		if (response.ok) {
			const payload = (await response.json()) as { results?: any[] };
			return (payload.results ?? []).slice(0, count).map((item: any) => ({
				// `title` comes back as an empty string often enough — two of three
				// results on a plain docs query — that `??` is not enough here.
				title: item.title || item.url,
				url: item.url,
				// Not a snippet: this is the whole page, tens of thousands of
				// characters of it, which is why `resultText` below stops the caller
				// from fetching the same page a second time.
				snippet: item.content ?? ''
			}));
		}

		lastError = `${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`;
		// 401/403 is a bad key and 429 is that key's rate limit: both are worth
		// retrying with the next key. Anything else is the service itself.
		if (![401, 403, 429].includes(response.status)) break;
	}

	throw new HttpError(502, `Ollama web search failed (${lastError || 'no API key accepted'}).`);
}

/**
 * Ollama's page loader — `POST /api/web_fetch`.
 *
 * Worth preferring over a direct fetch: a Worker requesting a page arrives from
 * a shared Cloudflare IP with no browser fingerprint, and a good share of sites
 * answer that with a 403 or a bot-check page. Ollama fetches server-side and
 * returns text that is already stripped of markup.
 */
async function ollamaFetchPage(keys: string[], target: string): Promise<string> {
	for (const key of keys) {
		try {
			const response = await fetch('https://ollama.com/api/web_fetch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
				body: JSON.stringify({ url: target }),
				signal: AbortSignal.timeout(20_000)
			});
			if (response.ok) {
				const payload = (await response.json()) as { content?: string };
				return String(payload.content ?? '');
			}
			if (![401, 403, 429].includes(response.status)) return '';
		} catch {
			// Try the next key, then fall back to fetching the page directly.
		}
	}
	return '';
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
	'ollama_cloud',
	'duckduckgo',
	'searxng',
	'google_pse',
	'tavily',
	'serper',
	'brave'
];

/** Splits a newline/comma separated list, so several SearXNG instances can be pasted in. */
const listOf = (value: unknown): string[] =>
	(Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\n,]/))
		.map((entry) => entry.trim())
		.filter(Boolean);

/**
 * The keys `ollama_cloud` search may use: the dedicated admin field first, then
 * the pool that already drives chat completions. Reusing the pool is the point
 * — a deployment with fifteen Ollama keys in Connections gets working search
 * without entering a sixteenth anywhere.
 */
async function ollamaSearchKeys(env: Env): Promise<string[]> {
	const config = await getConfigMany(env, [
		'web.search.ollama_cloud.api_key',
		'ollama.api_keys',
		'ollama.base_urls',
		'ollama.api_configs'
	]);
	const dedicated = listOf(config['web.search.ollama_cloud.api_key']);
	const pooled = ollamaKeys(env, config['ollama.api_keys']);
	// Connections adds one host per key, so the keys live under api_configs.
	const configs = (config['ollama.api_configs'] as Record<string, any>) ?? {};
	const fromConnections = Object.values(configs)
		.map((entry: any) => String(entry?.key ?? ''))
		.filter(Boolean);
	const keys = [...new Set([...dedicated, ...pooled, ...fromConnections])];

	// Rotated, not just ordered. Walking the list from the front would send every
	// request to the first key until it 429s, leaving the other fourteen idle and
	// paying a wasted round trip on each fallback — and one chat turn now makes
	// up to three searches plus a fetch per result. A random start spreads the
	// load the way chat completions already do, and the rest of the list stays in
	// place behind it as the fallbacks.
	if (keys.length < 2) return keys;
	const start = Math.floor(Math.random() * keys.length);
	return [...keys.slice(start), ...keys.slice(0, start)];
}

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
		'web.search.google_pse.engine_id',
		'web.search.searxng.language'
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
		case 'ollama_cloud': {
			const keys = await ollamaSearchKeys(env);
			if (!keys.length) {
				throw new HttpError(
					400,
					'Ollama web search needs an Ollama API key. Paste one under Admin Settings → ' +
						'Web Search, or add an ollama.com connection under Admin Settings → Connections ' +
						'and its key is reused here.'
				);
			}
			return ollamaCloud(keys, query, count);
		}
		case 'searxng': {
			const instances = listOf(url);
			if (!instances.length) {
				throw new HttpError(
					400,
					'SearXNG needs the URL of an instance you can reach — it is software you host, ' +
						'not a hosted API. Set "Searxng Query URL" under Admin Settings → Web Search ' +
						'(several may be given, comma separated), and make sure the instance has ' +
						'"json" in its `search.formats`.'
				);
			}
			return searxng(
				instances,
				query,
				count,
				String(config['web.search.searxng.language'] ?? '').trim()
			);
		}
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

/**
 * Fetches a page and reduces it to plain text for the model.
 *
 * With `env` supplied and an Ollama key configured, the page is loaded through
 * Ollama's `/api/web_fetch` first. A direct fetch from a Worker is refused by a
 * large share of sites — shared egress IP, no browser fingerprint — and an
 * empty page is why a search that found results can still answer with nothing.
 * The direct fetch stays as the fallback so no key is required.
 */
/**
 * A snippet at least this long is a page, not a teaser, and is used as-is.
 *
 * Engines differ by orders of magnitude: Google PSE returns one line, Ollama
 * returns the whole page — measured at 3k to 22k characters on an ordinary
 * documentation query. Re-fetching a page whose text is already in hand costs a
 * round trip and, for Ollama, one more call against a rate-limited free tier.
 */
const SNIPPET_IS_A_PAGE = 500;

/**
 * The text to give the model for one search result.
 *
 * Prefers what the engine already returned, falls back to loading the page, and
 * falls back again to the snippet however short it is.
 */
export async function resultText(env: Env, result: SearchResult, maxChars = 6000): Promise<string> {
	if (result.snippet.length >= SNIPPET_IS_A_PAGE) return result.snippet.slice(0, maxChars);
	return (await fetchPageText(result.url, maxChars, env)) || result.snippet.slice(0, maxChars);
}

export async function fetchPageText(url: string, maxChars = 6000, env?: Env): Promise<string> {
	if (env) {
		const keys = await ollamaSearchKeys(env).catch(() => []);
		if (keys.length) {
			const text = await ollamaFetchPage(keys, url);
			if (text) return text.slice(0, maxChars);
		}
	}
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
