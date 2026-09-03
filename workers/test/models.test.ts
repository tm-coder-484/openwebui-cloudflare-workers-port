import { describe, expect, it } from 'vitest';
import { DEFAULT_NVIDIA_MODELS, nvidiaConnection } from '../src/lib/models';
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
		expect(DEFAULT_NVIDIA_MODELS).toContain('meta/llama-3.3-70b-instruct');
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
