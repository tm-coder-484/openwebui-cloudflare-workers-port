import { describe, expect, it } from 'vitest';

/**
 * The frontend tokenises `<details>` with a block-anchored pattern:
 *   /^<details(\s+[^>]*)?>\n/
 * applied at the start of a block. A tag that lands mid-line is parsed as
 * inline HTML and renders as nothing at all. These tests hold the emitted text
 * to that contract, since nothing else in the stack would notice.
 */
const DETAILS_AT_BLOCK_START = /(^|\n\n)<details(\s+[^>]*)?>\n/;

const rendersAsDetails = (message: string, from: number) =>
	DETAILS_AT_BLOCK_START.test(message.slice(Math.max(0, from - 2)));

describe('reasoning blocks', () => {
	// A stand-in for the streaming loop: reasoning, answer, reasoning again.
	const stream = (parts: { reasoning?: string; content?: string }[]) => {
		let content = '';
		let open = false;
		const push = (text: string) => {
			if (!content) text = text.replace(/^\n+/, '');
			content += text;
		};
		for (const part of parts) {
			if (part.reasoning) {
				if (!open) {
					open = true;
					push(`\n\n<details type="reasoning">\n<summary>Thinking</summary>\n${part.reasoning}`);
				} else push(part.reasoning);
			}
			if (part.content) {
				if (open) {
					open = false;
					push('\n</details>\n\n');
				}
				push(part.content);
			}
		}
		if (open) push('\n</details>\n\n');
		return content;
	};

	it('starts the first block at the very beginning, with no leading blank line', () => {
		const message = stream([{ reasoning: 'first thought' }, { content: 'The answer.' }]);
		expect(message.startsWith('<details type="reasoning">\n')).toBe(true);
	});

	it('starts a later block on its own line', () => {
		// This is the bug: a model that thinks again after answering had the tag
		// glued onto the end of the previous paragraph, so it rendered as nothing.
		const message = stream([
			{ reasoning: 'first' },
			{ content: 'Part one.' },
			{ reasoning: 'second thought' },
			{ content: 'Part two.' }
		]);
		const second = message.indexOf('<details', 1);
		expect(second).toBeGreaterThan(0);
		expect(rendersAsDetails(message, second)).toBe(true);
	});

	it('leaves a blank line after the block so the answer is its own paragraph', () => {
		const message = stream([{ reasoning: 'thinking' }, { content: 'The answer.' }]);
		expect(message).toContain('</details>\n\nThe answer.');
	});

	it('closes a block the model never finished', () => {
		const message = stream([{ reasoning: 'thought that never ends' }]);
		expect(message).toContain('</details>');
	});
});

describe('tool call blocks', () => {
	// Mirrors toolCallBlock in completions.ts.
	const block = (name: string, args: string, result: string, id = 'call_1') => {
		const safe = (value: string) => value.replace(/[^\w.-]/g, '_').slice(0, 64);
		const body = [`Arguments: ${args || '{}'}`, '', result].join('\n');
		return (
			`\n\n<details type="tool_calls" done="true" id="${safe(id)}" name="${safe(name)}">\n` +
			`<summary>${safe(name)}</summary>\n${body}\n</details>\n\n`
		);
	};

	// The frontend's attribute parser, which is what the sanitising is for.
	const parseAttributes = (tag: string) => {
		const found: Record<string, string> = {};
		for (const [, key, value] of tag.matchAll(/(\w+)="(.*?)"/g)) found[key] = value;
		return found;
	};
	const openingTag = (message: string) =>
		message.slice(message.indexOf('<details'), message.indexOf('>\n') + 1);

	it('renders as a details block wherever it lands in the message', () => {
		const message = `Some text.${block('web_search', '{"query":"x"}', 'Searched')}More text.`;
		const at = message.indexOf('<details');
		expect(rendersAsDetails(message, at)).toBe(true);
	});

	it('keeps the arguments and the result in the body, not in an attribute', () => {
		// Attributes cannot hold arbitrary text: the parser reads them with
		// /(\w+)="(.*?)"/g, which has no notion of an escape, so the first quote in
		// a JSON argument ends the value and the rest of the tag is misread.
		// Everything variable therefore lives between the tags.
		const args = '{"query":"a \\"quoted\\" thing"}';
		const message = block('web_search', args, 'Searched the web');
		const tag = openingTag(message);

		expect(tag).not.toContain(args);
		expect(tag).not.toContain('Searched the web');
		expect(message).toContain(`Arguments: ${args}`);
		expect(message).toContain('\nSearched the web\n</details>');
	});

	it('parses back to exactly the four attributes it means to set', () => {
		const message = block('web_search', '{"query":"x"}', 'Searched');
		expect(parseAttributes(openingTag(message))).toEqual({
			type: 'tool_calls',
			done: 'true',
			id: 'call_1',
			name: 'web_search'
		});
	});

	it('sanitises a name and id that would otherwise break out of the tag', () => {
		// An upstream is free to send whatever it likes as a tool call id.
		const message = block('evil" onload="x', '{}', 'ok', 'id" type="reasoning');
		const attributes = parseAttributes(openingTag(message));

		expect(attributes.type).toBe('tool_calls');
		expect(attributes.name).toBe('evil__onload__x');
		expect(attributes.id).toBe('id__type__reasoning');
		expect(attributes.onload).toBeUndefined();
	});

	it('falls back to an empty object when the model sends no arguments', () => {
		expect(block('get_time', '', 'ok')).toContain('Arguments: {}');
	});
});
