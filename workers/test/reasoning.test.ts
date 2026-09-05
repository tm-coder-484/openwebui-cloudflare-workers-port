import { describe, expect, it } from 'vitest';
import { extractJSON, stripThinking } from '../src/lib/prompts';
import { parseQueries } from '../src/lib/completions';

/**
 * A reasoning model answering a background task is the case these guard.
 *
 * Providers disagree about where thinking goes. When it arrives inline it is
 * full of JSON, because the model is reasoning *about* JSON — so a parser that
 * scans from the first `{` to the last `}` reads the draft, the prose between
 * and the real answer as one document, and throws.
 */
const THOUGHT =
	'<think>\nThey want { "title": "..." } as raw JSON. I could say ' +
	'{"title": "Draft"} but a shorter phrasing reads better.\n</think>\n';

describe('stripThinking', () => {
	it('removes a closed thinking block', () => {
		expect(stripThinking(`${THOUGHT}{"title":"Deploying to Cloudflare"}`)).toBe(
			'{"title":"Deploying to Cloudflare"}'
		);
	});

	it('accepts the tag names providers actually use', () => {
		for (const tag of ['think', 'thinking', 'reasoning']) {
			expect(stripThinking(`<${tag}>hmm</${tag}>answer`)).toBe('answer');
		}
	});

	it('removes a block the token budget cut off mid-thought', () => {
		// Nothing follows an unterminated block, and keeping it would only feed
		// the parser the braces the model happened to write while thinking.
		expect(stripThinking('<think>I should answer {"title": "Dra')).toBe('');
	});

	it('keeps an answer that never had any thinking in it', () => {
		expect(stripThinking('{"title":"Plain"}')).toBe('{"title":"Plain"}');
		expect(stripThinking('')).toBe('');
	});

	it('leaves an ordinary less-than sign alone', () => {
		expect(stripThinking('3 < 4 and 5 > 2')).toBe('3 < 4 and 5 > 2');
	});
});

describe('extractJSON', () => {
	it('reads the answer past a thought that drafted its own JSON', () => {
		expect(
			extractJSON<{ title: string }>(`${THOUGHT}{"title":"Cloudflare Deploy"}`, 'title')
		).toEqual({ title: 'Cloudflare Deploy' });
	});

	it('takes the last object carrying the key, since that is the model`s final word', () => {
		const reply = '{"title":"First guess"}\nOn reflection:\n{"title":"Better title"}';
		expect(extractJSON<{ title: string }>(reply, 'title')?.title).toBe('Better title');
	});

	it('skips an object that does not carry the key at all', () => {
		const reply = '{"note":"thinking out loud"}\n{"title":"The answer"}';
		expect(extractJSON<{ title: string }>(reply, 'title')?.title).toBe('The answer');
	});

	it('is not fooled by a brace inside a string', () => {
		expect(extractJSON<{ title: string }>('{"title":"A } brace"}', 'title')?.title).toBe(
			'A } brace'
		);
		expect(extractJSON<{ title: string }>('{"title":"an \\" and a }"}', 'title')?.title).toBe(
			'an " and a }'
		);
	});

	it('still reads a fenced answer', () => {
		expect(extractJSON<{ tags: string[] }>('```json\n{"tags":["a"]}\n```', 'tags')?.tags).toEqual([
			'a'
		]);
	});

	it('returns null when the thinking was all there was', () => {
		expect(extractJSON('<think>I should answer {"title": "Dra', 'title')).toBeNull();
		expect(extractJSON('', 'title')).toBeNull();
		expect(extractJSON('no json here', 'title')).toBeNull();
	});

	it('takes any object when no key is named', () => {
		expect(extractJSON<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});
});

describe('parseQueries with a reasoning model', () => {
	it('reads the queries past the thinking', () => {
		const reply =
			'<think>Maybe {"queries":["draft"]} — no, be more specific.</think>\n' +
			'{"queries":["cloudflare d1 read replicas"]}';
		expect(parseQueries(reply)).toEqual(['cloudflare d1 read replicas']);
	});

	it('does not take a line of thinking as the search query', () => {
		// The line fallback used to run on the raw reply, so a truncated thought
		// became the query that was actually sent to the search engine.
		expect(parseQueries('<think>Let me think about what to search for')).toEqual([]);
	});

	it('still falls back to a bare line from a model that ignored the format', () => {
		expect(parseQueries('cloudflare workers pricing')).toEqual(['cloudflare workers pricing']);
	});
});
