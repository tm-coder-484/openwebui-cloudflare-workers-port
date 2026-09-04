import { describe, expect, it } from 'vitest';
import { OLLAMA_CLOUD_URL, ollamaConnection, ollamaKeys } from '../src/lib/models';
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
