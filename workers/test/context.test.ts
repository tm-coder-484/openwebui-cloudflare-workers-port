import { describe, expect, it } from 'vitest';
import { renderMessages, stripDetailBlocks } from '../src/lib/prompts';

/**
 * A stored message carries the markup the chat screen renders. Sending it back
 * to the model fills context that is the model's to think in, shows it a format
 * to imitate, and — for the background tasks, which summarise "the chat
 * history" — describes the thinking rather than the answer.
 */
const REASONING =
	'<details type="reasoning" done="true" duration="12">\n' +
	'<summary>Thinking</summary>\n' +
	"Okay, the first train has an hour's head start, so 60 miles.\n" +
	'</details>\n\n';

const TOOL_CALL =
	'<details type="tool_calls" done="true" id="call_1" name="web_search">\n' +
	'<summary>web_search</summary>\n' +
	'Arguments: {"query":"train speed"}\n\n' +
	'Searched the web for "train speed"\n' +
	'</details>\n\n';

describe('stripDetailBlocks', () => {
	it('drops a reasoning block and keeps the answer', () => {
		expect(stripDetailBlocks(`${REASONING}The second train catches up at 7pm.`)).toBe(
			'The second train catches up at 7pm.'
		);
	});

	it('drops a block that is the whole message', () => {
		expect(stripDetailBlocks(REASONING)).toBe('');
	});

	it('drops every block when the model thought more than once', () => {
		const message = `${REASONING}Part one.\n\n${REASONING}Part two.`;
		expect(stripDetailBlocks(message)).toBe('Part one.\n\nPart two.');
	});

	it('keeps a tool call`s result, which the model does need', () => {
		// The markup is for the reader; the output is what the answer rests on.
		const stripped = stripDetailBlocks(`${TOOL_CALL}Here is what I found.`);
		expect(stripped).toContain('Searched the web for "train speed"');
		expect(stripped).toContain('Here is what I found.');
		expect(stripped).not.toContain('<details');
		expect(stripped).not.toContain('<summary>');
	});

	it('reads a tool result from the older attribute form too', () => {
		const old =
			'<details type="tool_calls" done="true" name="web_search" result="Found &quot;3&quot; pages">\n' +
			'<summary>Tool: web_search</summary>\n</details>\n\nDone.';
		const stripped = stripDetailBlocks(old);
		expect(stripped).toContain('Found "3" pages');
		expect(stripped).not.toContain('<details');
	});

	it('drops a code interpreter block', () => {
		const message =
			'<details type="code_interpreter" done="true">\n<summary>Analyzed</summary>\nprint(1)\n</details>\n\nThe answer is 1.';
		expect(stripDetailBlocks(message)).toBe('The answer is 1.');
	});

	it('leaves a message that has no markup exactly as it is', () => {
		expect(stripDetailBlocks('Just an answer.')).toBe('Just an answer.');
		expect(stripDetailBlocks('')).toBe('');
	});

	it('leaves prose that merely mentions the tag alone', () => {
		// No block to remove: a `<details>` written about, not written as markup.
		const text = 'Use the <details> element for collapsible sections.';
		expect(stripDetailBlocks(text)).toBe(text);
	});

	it('does not leave a gap where a block was', () => {
		expect(stripDetailBlocks(`Before.\n\n${REASONING}After.`)).toBe('Before.\n\nAfter.');
	});
});

describe('the prompts the background tasks send', () => {
	it('describe the answer, not the thinking', () => {
		// A title generated from the raw history summarised the model's working,
		// which was most of what it was shown.
		const rendered = renderMessages(
			[
				{ role: 'user', content: 'When does the second train catch the first?' },
				{ role: 'assistant', content: `${REASONING}At 7pm.` }
			],
			2
		);
		expect(rendered).not.toContain('<details');
		expect(rendered).not.toContain('head start');
		expect(rendered).toContain('ASSISTANT: At 7pm.');
	});
});
