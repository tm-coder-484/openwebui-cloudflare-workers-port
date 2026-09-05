/**
 * Model-invoked tools.
 *
 * The default web-search mode searches once per turn, before the model runs.
 * That is predictable and cheap, but the model has no say in it: it cannot
 * decide the question needs no search, and it cannot search again after reading
 * what came back.
 *
 * This is the other half — the same search and fetch offered as OpenAI-style
 * function tools, so a model that supports tool calling drives them itself.
 * Nothing here is provider-specific beyond the OpenAI tool-calling shape, which
 * NIM, Ollama and every OpenAI-compatible endpoint in this port already speak.
 */

import type { Env } from '../types';
import { fetchPageText, resultText, webSearch } from './websearch';

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON text, as the model produced it — parsed at call time. */
	arguments: string;
}

export interface ToolOutcome {
	/** What goes back to the model as the tool message. */
	content: string;
	/** Citable sources, in the shape the frontend renders. */
	sources: Record<string, unknown>[];
	/** One line for the status strip, so the user sees what the model did. */
	status: string;
}

export const WEB_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'web_search',
			description:
				'Search the web for current information. Use this whenever the answer depends ' +
				'on recent events, or on facts you are not confident about. Returns page ' +
				'content with a numbered id for each result, which you should cite as [id].',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query. Keep it short and specific, like a real search.'
					},
					count: {
						type: 'integer',
						description: 'How many results to return. Defaults to the configured amount.'
					}
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'web_fetch',
			description:
				'Fetch one web page and read it as text. Use this to follow a link from a ' +
				'search result when the snippet is not enough.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The absolute URL of the page to read.' }
				},
				required: ['url']
			}
		}
	}
] as const;

/**
 * Reassembles tool calls from a stream.
 *
 * Providers send them a fragment at a time — `arguments` arrives as a string
 * split across chunks, and the `index` is the only thing tying the fragments to
 * a call, since `id` and `name` appear once at the start.
 */
export function toolCallAccumulator() {
	const byIndex = new Map<number, { id: string; name: string; arguments: string }>();

	return {
		push(deltas: any[]): void {
			for (const delta of deltas ?? []) {
				const index = Number(delta?.index ?? 0);
				const existing = byIndex.get(index) ?? { id: '', name: '', arguments: '' };
				byIndex.set(index, {
					id: delta?.id || existing.id,
					name: delta?.function?.name || existing.name,
					arguments: existing.arguments + (delta?.function?.arguments ?? '')
				});
			}
		},
		calls(): ToolCall[] {
			return [...byIndex.entries()]
				.sort(([a], [b]) => a - b)
				.map(([index, call]) => ({
					// Some providers omit the id on a single call; the model only needs
					// it to match the reply, so a stable stand-in is fine.
					id: call.id || `call_${index}`,
					name: call.name,
					arguments: call.arguments
				}))
				.filter((call) => call.name);
		}
	};
}

/** Runs one tool call and shapes the reply for both the model and the UI. */
export async function runToolCall(env: Env, call: ToolCall): Promise<ToolOutcome> {
	let args: Record<string, any> = {};
	try {
		args = call.arguments ? JSON.parse(call.arguments) : {};
	} catch {
		// A model that produced malformed JSON gets told so, rather than having
		// the whole turn fail: it can correct itself on the next round.
		return {
			content: `The arguments were not valid JSON: ${call.arguments.slice(0, 200)}`,
			sources: [],
			status: `Tool call to ${call.name} had malformed arguments`
		};
	}

	if (call.name === 'web_search') {
		const query = String(args.query ?? '').trim();
		if (!query) {
			return { content: 'No query was given.', sources: [], status: 'Search called with no query' };
		}
		const count = Number.isFinite(args.count) ? Number(args.count) : undefined;
		const results = await webSearch(env, query, count ? { count } : {});
		if (!results.length) {
			return {
				content: `No results for "${query}".`,
				sources: [],
				status: `Searched for "${query}" — nothing found`
			};
		}

		const parts: string[] = [];
		const sources: Record<string, unknown>[] = [];
		for (const [index, result] of results.entries()) {
			const text = await resultText(env, result);
			if (!text) continue;
			const name = result.title || result.url;
			parts.push(`<source id="${index + 1}" name="${name}" url="${result.url}">${text}</source>`);
			sources.push({
				source: { name, url: result.url, id: result.url },
				document: [text],
				metadata: [{ source: result.url, name }]
			});
		}
		return {
			content: parts.join('\n') || `No readable pages for "${query}".`,
			sources,
			status: `Searched the web for "${query}" (${sources.length} page${sources.length === 1 ? '' : 's'})`
		};
	}

	if (call.name === 'web_fetch') {
		const url = String(args.url ?? '').trim();
		if (!/^https?:\/\//i.test(url)) {
			return {
				content: 'The url must be an absolute http(s) URL.',
				sources: [],
				status: 'Fetch called with an invalid URL'
			};
		}
		const text = await fetchPageText(url, 6000, env);
		if (!text) {
			return { content: `Could not read ${url}.`, sources: [], status: `Could not read ${url}` };
		}
		return {
			content: `<source id="1" name="${url}" url="${url}">${text}</source>`,
			sources: [
				{
					source: { name: url, url, id: url },
					document: [text],
					metadata: [{ source: url, name: url }]
				}
			],
			status: `Read ${url}`
		};
	}

	return {
		content: `There is no tool called ${call.name}.`,
		sources: [],
		status: `Unknown tool ${call.name}`
	};
}

/**
 * Whether an upstream error means "this model does not do tool calling".
 *
 * Providers disagree on the wording and the status, so this matches on the
 * shape of the complaint rather than any one provider's text. Used to fall back
 * to searching before the turn instead of failing the message outright.
 */
export function isToolsUnsupported(message: string): boolean {
	return (
		/tool|function[_ ]?call/i.test(message) && /support|invalid|unknown|unrecogni/i.test(message)
	);
}
