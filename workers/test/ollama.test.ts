import { describe, expect, it } from 'vitest';
import { OLLAMA_CLOUD_URL, ollamaBases, ollamaConnection, ollamaKeys } from '../src/lib/models';
import type { Env } from '../src/types';

const envWith = (stored: Record<string, unknown>, vars: Partial<Env> = {}): Env =>
	({
		...vars,
		DB: {
			prepare: () => ({
				bind: () => ({ all: async () => ({ results: [] }) }),
				all: async () => ({
					results: Object.entries(stored).map(([key, value]) => ({
						key,
						value: JSON.stringify(value)
					}))
				})
			})
		}
	}) as any;

describe('ollamaKeys', () => {
	const env = {} as Env;

	it('accepts an array', () => {
		expect(ollamaKeys(env, ['a', 'b'])).toEqual(['a', 'b']);
	});

	it('accepts a pasted newline-separated block, which is how 15 keys arrive', () => {
		expect(ollamaKeys(env, 'a\nb\nc')).toEqual(['a', 'b', 'c']);
	});

	it('accepts a comma-separated list and trims whitespace', () => {
		expect(ollamaKeys(env, ' a , b ')).toEqual(['a', 'b']);
	});

	it('drops empties left by trailing separators', () => {
		expect(ollamaKeys(env, 'a\n\nb\n')).toEqual(['a', 'b']);
	});

	it('deduplicates, since a repeat adds no rate-limit headroom', () => {
		expect(ollamaKeys(env, ['a', 'b', 'a'])).toEqual(['a', 'b']);
	});

	it('merges keys from the environment', () => {
		expect(ollamaKeys({ OLLAMA_API_KEYS: 'x,y' } as Env, ['a'])).toEqual(['a', 'x', 'y']);
	});
});

describe('ollamaConnection', () => {
	const keys = ['k1', 'k2', 'k3'];

	it('defaults to Ollama Cloud and picks one key, keeping the rest as fallbacks', async () => {
		const connection = await ollamaConnection(
			envWith({ 'ollama.enable': true, 'ollama.api_keys': keys })
		);
		expect(connection?.url).toBe(OLLAMA_CLOUD_URL);
		expect(connection?.provider).toBe('ollama');
		expect(keys).toContain(connection!.key);
		// Every key is accounted for exactly once: one chosen, the others spare.
		expect([connection!.key, ...connection!.fallbackKeys!].sort()).toEqual(keys);
	});

	it('spreads requests across the pool rather than always using the first', async () => {
		const env = envWith({ 'ollama.enable': true, 'ollama.api_keys': keys });
		const seen = new Set<string>();
		for (let i = 0; i < 60; i += 1) seen.add((await ollamaConnection(env))!.key);
		expect(seen.size).toBeGreaterThan(1);
	});

	it('is off when no key is configured for the hosted service', async () => {
		expect(
			await ollamaConnection(envWith({ 'ollama.enable': true, 'ollama.api_keys': [] }))
		).toBeNull();
	});

	it('allows a self-hosted server with no key at all', async () => {
		const connection = await ollamaConnection(
			envWith({
				'ollama.enable': true,
				'ollama.api_keys': [],
				'ollama.base_url': 'https://ollama.internal/v1'
			})
		);
		expect(connection?.url).toBe('https://ollama.internal/v1');
		expect(connection?.key).toBe('');
	});

	it('stays off when disabled', async () => {
		expect(
			await ollamaConnection(envWith({ 'ollama.enable': false, 'ollama.api_keys': keys }))
		).toBeNull();
	});
});

describe('keys entered through the Connections screen', () => {
	// The screen has no pool field: it appends a base URL and stores that
	// connection's key at the matching index in api_configs. Adding the same
	// host repeatedly is how several keys get entered.
	const asScreenWouldSave = (urls: string[], keys: string[]) => ({
		'ollama.enable': true,
		'ollama.base_urls': urls,
		'ollama.api_configs': Object.fromEntries(keys.map((key, i) => [String(i), { key }]))
	});

	it('pools the keys from repeated entries of the same host', async () => {
		const connection = await ollamaConnection(
			envWith(
				asScreenWouldSave(
					['https://ollama.com/v1', 'https://ollama.com/v1', 'https://ollama.com/v1'],
					['a', 'b', 'c']
				)
			)
		);
		expect([connection!.key, ...connection!.fallbackKeys!].sort()).toEqual(['a', 'b', 'c']);
	});

	it('ignores keys belonging to a different host', async () => {
		const connection = await ollamaConnection(
			envWith(
				asScreenWouldSave(
					['https://ollama.com/v1', 'https://other.test/v1'],
					['mine', 'someone-elses']
				)
			)
		);
		expect([connection!.key, ...connection!.fallbackKeys!]).toEqual(['mine']);
	});

	it('tolerates a trailing slash, which the screen does not always strip', async () => {
		const connection = await ollamaConnection(
			envWith(asScreenWouldSave(['https://ollama.com/v1/', 'https://ollama.com/v1'], ['a', 'b']))
		);
		expect([connection!.key, ...connection!.fallbackKeys!].sort()).toEqual(['a', 'b']);
	});

	it('combines screen keys with any set as a Worker var', async () => {
		const connection = await ollamaConnection(
			envWith(asScreenWouldSave(['https://ollama.com/v1'], ['from-screen']), {
				OLLAMA_API_KEYS: 'from-var'
			})
		);
		expect([connection!.key, ...connection!.fallbackKeys!].sort()).toEqual([
			'from-screen',
			'from-var'
		]);
	});
});

describe('ollamaBases', () => {
	// Ollama serves two APIs from one host: the native one at the root and an
	// OpenAI-compatible one under /v1. The Connections screen has a single URL
	// field, so either form typed there has to yield both bases correctly.
	it('derives both bases from a bare host', () => {
		expect(ollamaBases('https://ollama.com')).toEqual({
			openai: 'https://ollama.com/v1',
			native: 'https://ollama.com'
		});
	});

	it('does not double the /v1 when it is already there', () => {
		expect(ollamaBases('https://ollama.com/v1')).toEqual({
			openai: 'https://ollama.com/v1',
			native: 'https://ollama.com'
		});
	});

	it('strips a trailing slash from either form', () => {
		expect(ollamaBases('https://ollama.com/v1/').openai).toBe('https://ollama.com/v1');
		expect(ollamaBases('https://ollama.com/').openai).toBe('https://ollama.com/v1');
	});

	it('leaves a self-hosted host and port intact', () => {
		expect(ollamaBases('http://ollama.internal:11434')).toEqual({
			openai: 'http://ollama.internal:11434/v1',
			native: 'http://ollama.internal:11434'
		});
	});

	it('gives the native base that /api/tags appends to, not the /v1 one', () => {
		// The bug this guards: `${openai}/api/tags` is https://ollama.com/v1/api/tags,
		// which 404s. The native base is what that path belongs on.
		expect(`${ollamaBases('https://ollama.com/v1').native}/api/tags`).toBe(
			'https://ollama.com/api/tags'
		);
	});
});

describe('base URL forms reaching the connection', () => {
	it('resolves a bare host to the OpenAI base', async () => {
		const connection = await ollamaConnection(
			envWith({
				'ollama.enable': true,
				'ollama.base_url': 'https://ollama.com',
				'ollama.api_keys': ['k']
			})
		);
		expect(connection?.url).toBe('https://ollama.com/v1');
	});

	it('pools screen keys whichever form each entry was typed in', async () => {
		const connection = await ollamaConnection(
			envWith({
				'ollama.enable': true,
				'ollama.base_urls': ['https://ollama.com', 'https://ollama.com/v1'],
				'ollama.api_configs': { '0': { key: 'a' }, '1': { key: 'b' } }
			})
		);
		expect([connection!.key, ...connection!.fallbackKeys!].sort()).toEqual(['a', 'b']);
	});
});
