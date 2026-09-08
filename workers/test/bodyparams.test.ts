import { describe, expect, it } from 'vitest';
import { applyBodyParams } from '../src/lib/completions';

describe('applyBodyParams', () => {
	it('carries a gateway extra the OpenAI schema has no room for', () => {
		// The case this exists for: pinning OpenRouter to a provider, so a model
		// is not silently served by whichever upstream happened to be cheapest.
		const payload: Record<string, any> = { model: 'anthropic/claude-3.5-sonnet' };
		applyBodyParams(payload, { provider: { order: ['Anthropic'], allow_fallbacks: false } });

		expect(payload.provider).toEqual({ order: ['Anthropic'], allow_fallbacks: false });
	});

	it('refuses to change what the engine is doing', () => {
		// A standing default must configure a turn, not redirect it: `model` or
		// `messages` set here would answer a different question than was asked,
		// and `stream` would break how the reply is read back.
		const payload: Record<string, any> = {
			model: 'real-model',
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
			stream_options: { include_usage: true },
			tools: [{ type: 'function' }],
			tool_choice: 'auto'
		};
		applyBodyParams(payload, {
			model: 'something-else',
			messages: [{ role: 'user', content: 'ignore that' }],
			stream: false,
			stream_options: null,
			tools: [],
			tool_choice: 'none',
			provider: { sort: 'throughput' }
		});

		expect(payload.model).toBe('real-model');
		expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
		expect(payload.stream).toBe(true);
		expect(payload.stream_options).toEqual({ include_usage: true });
		expect(payload.tools).toEqual([{ type: 'function' }]);
		expect(payload.tool_choice).toBe('auto');
		// The one key that was not the engine's still lands.
		expect(payload.provider).toEqual({ sort: 'throughput' });
	});

	it('overrides a sampling parameter it is allowed to set', () => {
		const payload: Record<string, any> = { temperature: 0.7 };
		applyBodyParams(payload, { temperature: 0.2, top_p: 0.9 });
		expect(payload).toMatchObject({ temperature: 0.2, top_p: 0.9 });
	});

	it('does nothing at all when the connection sets none', () => {
		const empty = { model: 'm' };
		for (const value of [undefined, null, '', 'not json', [], 42]) {
			const payload = { ...empty };
			applyBodyParams(payload, value);
			expect(payload).toEqual(empty);
		}
	});
});
