import { describe, expect, it } from 'vitest';
import {
	DEFAULT_NVIDIA_MODELS,
	NVIDIA_PREFERRED_MODELS,
	defaultNvidiaModel,
	nvidiaConnection
} from '../src/lib/models';
import { buildUpstreamRequest } from '../src/lib/completions';
import type { Env } from '../src/types';
import type { ResolvedModel } from '../src/lib/models';

/** Config falls back to defaults when the table is unreachable, which lets these
 *  tests exercise env seeding without a live D1 binding. */
const envWith = (vars: Partial<Env>): Env =>
	({
		DB: {
			prepare: () => {
				throw new Error('no database in this test');
			}
		},
		...vars
	}) as unknown as Env;

describe('NVIDIA NIM connection', () => {
	it('is configured from an API key alone', async () => {
		const connection = await nvidiaConnection(envWith({ NVIDIA_API_KEY: 'nvapi-test' }));
		expect(connection?.url).toBe('https://integrate.api.nvidia.com/v1');
		expect(connection?.key).toBe('nvapi-test');
		expect(connection?.provider).toBe('nvidia');
	});

	it('stays disabled when the hosted catalogue has no key', async () => {
		expect(await nvidiaConnection(envWith({}))).toBeNull();
	});

	it('allows a self-hosted NIM microservice without a key', async () => {
		const connection = await nvidiaConnection(
			envWith({ NVIDIA_API_BASE_URL: 'https://nim.internal.example/v1/' })
		);
		expect(connection?.url).toBe('https://nim.internal.example/v1');
		expect(connection?.key).toBe('');
	});

	it('honours an explicit model list', async () => {
		const connection = await nvidiaConnection(
			envWith({ NVIDIA_API_KEY: 'nvapi-test', NVIDIA_MODELS: 'meta/llama-3.1-8b-instruct' })
		);
		expect(connection?.config.model_ids).toEqual(['meta/llama-3.1-8b-instruct']);
	});

	it('can be turned off', async () => {
		expect(
			await nvidiaConnection(envWith({ NVIDIA_API_KEY: 'nvapi-test', ENABLE_NVIDIA_API: 'false' }))
		).toBeNull();
	});

	it('ships a catalogue for endpoints that cannot be listed', () => {
		expect(DEFAULT_NVIDIA_MODELS.length).toBeGreaterThan(3);
		// Every entry must be a NIM `owner/model` id, or the picker shows a
		// model the endpoint cannot route to.
		for (const id of DEFAULT_NVIDIA_MODELS) expect(id).toMatch(/^[a-z0-9.-]+\/[a-z0-9._-]+$/);
	});

	it('offers the fallback catalogue before the long-lived ids', () => {
		// The preference list is what picks the default, so the modern models
		// have to come before the older ones kept for pinned deployments.
		expect(NVIDIA_PREFERRED_MODELS.slice(0, DEFAULT_NVIDIA_MODELS.length)).toEqual(
			DEFAULT_NVIDIA_MODELS
		);
		expect(NVIDIA_PREFERRED_MODELS).toContain('meta/llama-3.3-70b-instruct');
		expect(NVIDIA_PREFERRED_MODELS.indexOf('meta/llama-3.3-70b-instruct')).toBeGreaterThan(
			NVIDIA_PREFERRED_MODELS.indexOf('deepseek-ai/deepseek-v4-pro')
		);
	});
});

describe('defaultNvidiaModel', () => {
	const kv = () => {
		const store = new Map<string, string>();
		return {
			store,
			get: async (key: string) => store.get(key) ?? null,
			put: async (key: string, value: string) => void store.set(key, value)
		};
	};

	const envServing = (ids: string[], cache = kv()) =>
		({
			NVIDIA_API_KEY: 'nvapi-test',
			CACHE: cache,
			DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) }
		}) as any;

	const stubFetch = (ids: string[]) => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
				headers: { 'Content-Type': 'application/json' }
			})) as any;
	};

	it('picks the highest-ranked model the endpoint actually serves', async () => {
		stubFetch(['meta/llama-3.3-70b-instruct', 'moonshotai/kimi-k2.6']);
		expect(await defaultNvidiaModel(envServing([]))).toBe('moonshotai/kimi-k2.6');
	});

	it('falls through a retired preferred id instead of naming it', async () => {
		stubFetch(['meta/llama-3.3-70b-instruct']);
		expect(await defaultNvidiaModel(envServing([]))).toBe('meta/llama-3.3-70b-instruct');
	});

	it('uses whatever is listed first when it recognises nothing', async () => {
		stubFetch(['some-lab/brand-new-model', 'some-lab/other']);
		expect(await defaultNvidiaModel(envServing([]))).toBe('some-lab/brand-new-model');
	});

	it('returns null when the endpoint lists nothing', async () => {
		stubFetch([]);
		expect(await defaultNvidiaModel(envServing([]))).toBeNull();
	});

	it('caches the answer so /api/config stays a cheap call', async () => {
		const cache = kv();
		stubFetch(['moonshotai/kimi-k2.6']);
		await defaultNvidiaModel(envServing([], cache));
		expect(cache.store.get('nvidia:default-model')).toBe('moonshotai/kimi-k2.6');

		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
		}) as any;
		expect(await defaultNvidiaModel(envServing([], cache))).toBe('moonshotai/kimi-k2.6');
		expect(called).toBe(false);
	});
});

describe('requests to NIM', () => {
	it('go to the NIM endpoint with its key', () => {
		const resolved: ResolvedModel = {
			id: 'meta/llama-3.3-70b-instruct',
			upstreamId: 'meta/llama-3.3-70b-instruct',
			entry: {
				id: 'meta/llama-3.3-70b-instruct',
				name: 'meta/llama-3.3-70b-instruct',
				object: 'model',
				created: 0,
				owned_by: 'nvidia',
				actions: [],
				tags: [{ name: 'NVIDIA NIM' }]
			},
			params: {},
			workersAI: false,
			connection: {
				url: 'https://integrate.api.nvidia.com/v1',
				key: 'nvapi-test',
				idx: -1,
				provider: 'nvidia',
				config: {}
			}
		};

		const request = buildUpstreamRequest(resolved, {
			messages: [{ role: 'user', content: 'hi' }],
			stream: true
		});

		expect(request.kind).toBe('openai');
		expect(request.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
		expect(request.headers?.Authorization).toBe('Bearer nvapi-test');
		expect(request.payload.model).toBe('meta/llama-3.3-70b-instruct');
	});
});
