import { describe, expect, it } from 'vitest';
import {
	buildUpstreamRequest,
	normalizeChunk,
	readSSE,
	renderSystemPrompt,
	errorDetail
} from '../src/lib/completions';
import type { ResolvedModel } from '../src/lib/models';

const openaiModel: ResolvedModel = {
	id: 'gpt-4o',
	upstreamId: 'gpt-4o',
	entry: {
		id: 'gpt-4o',
		name: 'gpt-4o',
		object: 'model',
		created: 0,
		owned_by: 'openai',
		actions: [],
		tags: []
	},
	params: {},
	workersAI: false,
	connection: { url: 'https://api.example.com/v1', key: 'secret', idx: 0, config: {} }
};

describe('buildUpstreamRequest', () => {
	it('strips Open WebUI-only fields', () => {
		const request = buildUpstreamRequest(openaiModel, {
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
			chat_id: 'abc',
			session_id: 'sock',
			features: { web_search: true },
			tool_ids: ['x'],
			background_tasks: { title_generation: true },
			user_message: { id: '1' },
			model_item: { id: 'gpt-4o' }
		});
		expect(request.payload).not.toHaveProperty('chat_id');
		expect(request.payload).not.toHaveProperty('features');
		expect(request.payload).not.toHaveProperty('background_tasks');
		expect(request.payload).not.toHaveProperty('model_item');
		expect(request.payload.model).toBe('gpt-4o');
		expect(request.url).toBe('https://api.example.com/v1/chat/completions');
		expect(request.headers?.Authorization).toBe('Bearer secret');
	});

	it('forwards only known sampling parameters', () => {
		const request = buildUpstreamRequest(openaiModel, {
			messages: [],
			params: { temperature: 0.5, stream_delta_chunk_size: 12, reasoning_tags: ['a'], stop: [] }
		});
		expect(request.payload.temperature).toBe(0.5);
		expect(request.payload).not.toHaveProperty('stream_delta_chunk_size');
		expect(request.payload).not.toHaveProperty('reasoning_tags');
		expect(request.payload).not.toHaveProperty('stop');
	});

	it('prepends the model system prompt', () => {
		const request = buildUpstreamRequest(
			{ ...openaiModel, systemPrompt: 'You are {{USER_NAME}}.' },
			{ messages: [{ role: 'user', content: 'hi' }], variables: { USER_NAME: 'Ada' } }
		);
		const messages = request.payload.messages as { role: string; content: string }[];
		expect(messages[0]).toEqual({ role: 'system', content: 'You are Ada.' });
		expect(messages[1].role).toBe('user');
	});

	it('merges into an existing system message rather than duplicating', () => {
		const request = buildUpstreamRequest(
			{ ...openaiModel, systemPrompt: 'Base.' },
			{
				messages: [
					{ role: 'system', content: 'Extra.' },
					{ role: 'user', content: 'hi' }
				]
			}
		);
		const messages = request.payload.messages as { role: string; content: string }[];
		expect(messages).toHaveLength(2);
		expect(messages[0].content).toBe('Base.\n\nExtra.');
	});

	it('routes Workers AI models to the binding', () => {
		const request = buildUpstreamRequest(
			{
				...openaiModel,
				workersAI: true,
				connection: undefined,
				upstreamId: '@cf/meta/llama-3.1-8b-instruct'
			},
			{ messages: [] }
		);
		expect(request.kind).toBe('workers-ai');
		expect(request.model).toBe('@cf/meta/llama-3.1-8b-instruct');
	});

	it('fails loudly when no connection is configured', () => {
		expect(() =>
			buildUpstreamRequest({ ...openaiModel, connection: undefined }, { messages: [] })
		).toThrow(/connection/i);
	});
});

describe('normalizeChunk', () => {
	it('reads OpenAI deltas', () => {
		expect(
			normalizeChunk({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] })?.content
		).toBe('hi');
	});

	it('reads Workers AI chunks', () => {
		expect(normalizeChunk({ response: 'hello' })?.content).toBe('hello');
	});

	it('carries usage through', () => {
		expect(normalizeChunk({ choices: [{ delta: {} }], usage: { total_tokens: 7 } })?.usage).toEqual(
			{
				total_tokens: 7
			}
		);
	});

	it('ignores unknown payloads', () => {
		expect(normalizeChunk({ nothing: true })).toBeNull();
		expect(normalizeChunk(null)).toBeNull();
	});
});

describe('readSSE', () => {
	const streamOf = (chunks: string[]) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			}
		});

	it('splits events across chunk boundaries', async () => {
		const received: string[] = [];
		for await (const data of readSSE(streamOf(['data: {"a":', '1}\n\ndata: [DONE]\n\n']))) {
			received.push(data);
		}
		expect(received).toEqual(['{"a":1}', '[DONE]']);
	});

	it('handles CRLF framing', async () => {
		const received: string[] = [];
		for await (const data of readSSE(streamOf(['data: one\r\n\r\ndata: two\r\n\r\n']))) {
			received.push(data);
		}
		expect(received).toEqual(['one', 'two']);
	});
});

describe('renderSystemPrompt', () => {
	it('substitutes variables and date placeholders', () => {
		const output = renderSystemPrompt('{{NAME}} on {{CURRENT_DATE}}', { NAME: 'Ada' });
		expect(output.startsWith('Ada on ')).toBe(true);
		expect(output).not.toContain('{{CURRENT_DATE}}');
	});
});

describe('normalizeChunk reasoning', () => {
	it('reads reasoning_content, which thinking models stream instead of content', () => {
		const chunk = normalizeChunk({
			choices: [{ delta: { reasoning_content: 'let me think' }, finish_reason: null }]
		});
		expect(chunk?.reasoning).toBe('let me think');
		expect(chunk?.content).toBeUndefined();
	});

	it('also accepts the bare `reasoning` spelling', () => {
		const chunk = normalizeChunk({ choices: [{ delta: { reasoning: 'hmm' } }] });
		expect(chunk?.reasoning).toBe('hmm');
	});

	it('keeps content and reasoning separate when a chunk carries both', () => {
		const chunk = normalizeChunk({
			choices: [{ delta: { content: 'answer', reasoning_content: 'because' } }]
		});
		expect(chunk?.content).toBe('answer');
		expect(chunk?.reasoning).toBe('because');
	});
});

describe('provider error shapes', () => {
	const res = (body: string, status = 400) =>
		new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

	it('reads the OpenAI shape', async () => {
		expect(await errorDetail(res('{"error":{"message":"Unauthorized"}}', 401))).toBe(
			'Unauthorized'
		);
	});

	it("reads Ollama's bare-string 429 without returning raw JSON", async () => {
		// Its 401/402 are OpenAI-shaped but its 429 is {"error":"..."}.
		expect(await errorDetail(res('{"error":"too many concurrent requests"}', 429))).toBe(
			'too many concurrent requests'
		);
	});

	it('surfaces the upgrade message on a gated model', async () => {
		const body = JSON.stringify({
			error: { message: 'this model requires a subscription', type: 'api_error' }
		});
		expect(await errorDetail(res(body, 402))).toBe('this model requires a subscription');
	});

	it('falls back to the raw text when the body is not JSON', async () => {
		expect(await errorDetail(res('upstream exploded', 500))).toBe('upstream exploded');
	});
});

describe('normalizeChunk against a real Ollama delta', () => {
	it('ignores the empty content string sent alongside reasoning', () => {
		// Ollama streams {"content":"","reasoning":" user"} during thinking, so
		// testing for the key's presence rather than its truthiness would emit
		// hundreds of empty deltas.
		const chunk = normalizeChunk({
			choices: [{ index: 0, delta: { content: '', reasoning: ' user' }, finish_reason: null }]
		});
		expect(chunk?.reasoning).toBe(' user');
		expect(chunk?.content).toBe('');
		expect(Boolean(chunk?.content)).toBe(false);
	});

	it('handles the final empty delta that closes the stream', () => {
		const chunk = normalizeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
		expect(chunk?.finishReason).toBe('stop');
		expect(chunk?.content).toBeUndefined();
	});
});
