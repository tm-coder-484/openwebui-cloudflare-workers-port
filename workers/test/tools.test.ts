import { describe, expect, it } from 'vitest';
import {
	WEB_TOOLS,
	isToolsUnsupported,
	runToolCall,
	searchPlan,
	toolCallAccumulator
} from '../src/lib/tools';
import { normalizeChunk } from '../src/lib/completions';

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

describe('toolCallAccumulator', () => {
	it('joins arguments split across chunks', () => {
		// Providers stream `arguments` a few characters at a time; only `index`
		// ties the fragments together, since id and name arrive once.
		const acc = toolCallAccumulator();
		acc.push([{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"qu' } }]);
		acc.push([{ index: 0, function: { arguments: 'ery":"cloud' } }]);
		acc.push([{ index: 0, function: { arguments: 'flare"}' } }]);

		expect(acc.calls()).toEqual([
			{ id: 'call_1', name: 'web_search', arguments: '{"query":"cloudflare"}' }
		]);
	});

	it('keeps parallel calls apart by index', () => {
		const acc = toolCallAccumulator();
		acc.push([
			{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{"query":"x"}' } },
			{ index: 1, id: 'b', function: { name: 'web_fetch', arguments: '{"url":' } }
		]);
		acc.push([{ index: 1, function: { arguments: '"https://a.test"}' } }]);

		expect(acc.calls()).toEqual([
			{ id: 'a', name: 'web_search', arguments: '{"query":"x"}' },
			{ id: 'b', name: 'web_fetch', arguments: '{"url":"https://a.test"}' }
		]);
	});

	it('invents an id when the provider omits one', () => {
		const acc = toolCallAccumulator();
		acc.push([{ index: 0, function: { name: 'web_search', arguments: '{}' } }]);
		expect(acc.calls()[0].id).toBe('call_0');
	});

	it('ignores fragments that never named a tool', () => {
		const acc = toolCallAccumulator();
		acc.push([{ index: 0, function: { arguments: '{}' } }]);
		expect(acc.calls()).toEqual([]);
	});

	it('reports nothing for an ordinary text turn', () => {
		expect(toolCallAccumulator().calls()).toEqual([]);
	});
});

describe('normalizeChunk', () => {
	it('surfaces streamed tool-call deltas', () => {
		const chunk = normalizeChunk({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'web_search' } }] } }]
		});
		expect(chunk?.toolCalls?.[0]?.function?.name).toBe('web_search');
	});

	it('surfaces tool calls from a non-streamed reply', () => {
		const chunk = normalizeChunk({
			choices: [{ message: { tool_calls: [{ index: 0, function: { name: 'web_fetch' } }] } }]
		});
		expect(chunk?.toolCalls?.[0]?.function?.name).toBe('web_fetch');
	});

	it('leaves toolCalls undefined on a plain text chunk', () => {
		expect(normalizeChunk({ choices: [{ delta: { content: 'hi' } }] })?.toolCalls).toBeUndefined();
	});
});

describe('WEB_TOOLS', () => {
	it('describes both tools in the OpenAI function shape', () => {
		expect(WEB_TOOLS.map((tool) => tool.function.name)).toEqual(['web_search', 'web_fetch']);
		for (const tool of WEB_TOOLS) {
			expect(tool.type).toBe('function');
			expect(tool.function.parameters.type).toBe('object');
			expect(tool.function.parameters.required.length).toBeGreaterThan(0);
		}
	});
});

describe('runToolCall', () => {
	const searchEnv = envWithConfig({
		'web.search.engine': 'ollama_cloud',
		'web.search.ollama_cloud.api_key': 'key-a'
	});

	it('runs a search and returns citable sources', async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					results: [
						{ title: 'Workers', url: 'https://a.test/1', content: 'x'.repeat(600) },
						{ title: 'D1', url: 'https://a.test/2', content: 'y'.repeat(600) }
					]
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			)) as any;

		const outcome = await runToolCall(
			searchEnv,
			{
				id: 'c1',
				name: 'web_search',
				arguments: '{"query":"cloudflare workers"}'
			},
			{ userId: 'u1' }
		);

		expect(outcome.content).toContain('<source id="1"');
		expect(outcome.content).toContain('https://a.test/1');
		expect(outcome.sources).toHaveLength(2);
		expect(outcome.status).toContain('cloudflare workers');
	});

	it('passes the requested count through to the engine', async () => {
		let body: any;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response('{"results":[]}', { headers: { 'Content-Type': 'application/json' } });
		}) as any;

		await runToolCall(
			searchEnv,
			{
				id: 'c1',
				name: 'web_search',
				arguments: '{"query":"x","count":7}'
			},
			{ userId: 'u1' }
		);
		expect(body.max_results).toBe(7);
	});

	it('tells the model when it produced malformed arguments', async () => {
		// Worth answering rather than throwing: the model can correct itself on
		// the next round instead of the whole turn failing.
		const outcome = await runToolCall(
			searchEnv,
			{
				id: 'c1',
				name: 'web_search',
				arguments: '{"query": '
			},
			{ userId: 'u1' }
		);
		expect(outcome.content).toMatch(/not valid JSON/i);
		expect(outcome.sources).toEqual([]);
	});

	it('refuses a fetch that is not an absolute http URL', async () => {
		const outcome = await runToolCall(
			searchEnv,
			{
				id: 'c1',
				name: 'web_fetch',
				arguments: '{"url":"file:///etc/passwd"}'
			},
			{ userId: 'u1' }
		);
		expect(outcome.content).toMatch(/absolute http/i);
		expect(outcome.sources).toEqual([]);
	});

	it('reads a page and returns it as a source', async () => {
		globalThis.fetch = (async () =>
			new Response('<html><body><p>Edge runtime notes</p></body></html>', {
				headers: { 'Content-Type': 'text/html' }
			})) as any;

		const outcome = await runToolCall(
			envWithConfig({}),
			{
				id: 'c1',
				name: 'web_fetch',
				arguments: '{"url":"https://a.test/page"}'
			},
			{ userId: 'u1' }
		);
		expect(outcome.content).toContain('Edge runtime notes');
		expect(outcome.sources).toHaveLength(1);
	});

	it('names an unknown tool rather than failing the turn', async () => {
		const outcome = await runToolCall(
			envWithConfig({}),
			{
				id: 'c1',
				name: 'delete_everything',
				arguments: '{}'
			},
			{ userId: 'u1' }
		);
		expect(outcome.content).toMatch(/no tool called delete_everything/i);
	});
});

describe('isToolsUnsupported', () => {
	it('recognises the ways providers say they do not do tool calling', () => {
		expect(isToolsUnsupported('This model does not support tools')).toBe(true);
		expect(isToolsUnsupported('Invalid parameter: tool_choice')).toBe(true);
		expect(isToolsUnsupported('unknown field "tools"')).toBe(true);
	});

	it('does not swallow unrelated failures', () => {
		expect(isToolsUnsupported('rate limit exceeded')).toBe(false);
		expect(isToolsUnsupported('context length exceeded')).toBe(false);
	});
});

describe('searchPlan', () => {
	it('searches before the turn in always mode, with no tools', () => {
		expect(searchPlan('always', true, true)).toEqual({ preSearch: true, tools: false });
	});

	it('only offers tools in tool mode', () => {
		expect(searchPlan('tool', true, true)).toEqual({ preSearch: false, tools: true });
	});

	it('does both in combo mode', () => {
		// The point of combo: pages already in hand, and the option to look again.
		expect(searchPlan('combo', true, true)).toEqual({ preSearch: true, tools: true });
	});

	it('falls back to searching first when tools are impossible', () => {
		// Workers AI has no tool-calling shape, so a tool mode there must still
		// search rather than quietly doing nothing.
		expect(searchPlan('tool', true, false)).toEqual({ preSearch: true, tools: false });
		expect(searchPlan('combo', true, false)).toEqual({ preSearch: true, tools: false });
	});

	it('does nothing at all when web search is off for the turn', () => {
		for (const mode of ['always', 'tool', 'combo']) {
			expect(searchPlan(mode, false, true)).toEqual({ preSearch: false, tools: false });
		}
	});

	it('treats an unknown mode as always, not as nothing', () => {
		expect(searchPlan('', true, true)).toEqual({ preSearch: true, tools: false });
		expect(searchPlan('nonsense', true, true)).toEqual({ preSearch: true, tools: false });
	});
});
