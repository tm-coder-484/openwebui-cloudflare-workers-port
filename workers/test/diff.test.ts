import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/lib/diff';

describe('unifiedDiff', () => {
	it('returns nothing when the texts match', () => {
		expect(unifiedDiff('same\ntext', 'same\ntext')).toEqual([]);
	});

	it('marks added and removed lines', () => {
		const diff = unifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree', 'v1', 'v2');
		expect(diff[0]).toBe('--- v1');
		expect(diff[1]).toBe('+++ v2');
		expect(diff).toContain('-two');
		expect(diff).toContain('+TWO');
		expect(diff).toContain(' one');
	});

	it('emits a hunk header with line counts', () => {
		const diff = unifiedDiff('a\nb', 'a\nb\nc');
		expect(diff.some((line) => /^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(line))).toBe(true);
	});

	it('handles a pure insertion and a pure deletion', () => {
		expect(unifiedDiff('', 'hello')).toContain('+hello');
		expect(unifiedDiff('hello', '')).toContain('-hello');
	});

	it('keeps only context around changes in long texts', () => {
		const from = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
		const to = from.replace('line 20', 'line twenty');
		const diff = unifiedDiff(from, to);
		expect(diff).toContain('-line 20');
		expect(diff).toContain('+line twenty');
		// Two headers + one hunk header + 3 context either side + the change.
		expect(diff.length).toBeLessThan(12);
	});
});
