import { describe, expect, it } from 'vitest';
import { globToLike } from '../src/routes/files';

describe('globToLike', () => {
	it('turns the pattern the picker sends into a SQL LIKE', () => {
		// The composer sends `*notes*` while you type and `*` when the box is
		// empty — never a plain substring — so these two are the whole ballgame.
		expect(globToLike('*notes*')).toBe('%notes%');
		expect(globToLike('*')).toBe('%');
	});

	it('treats a pattern with no wildcard as a substring', () => {
		// What an API caller passing a plain word expects.
		expect(globToLike('notes')).toBe('%notes%');
	});

	it('maps ? to a single character', () => {
		expect(globToLike('report?.csv')).toBe('report_.csv');
	});

	it('escapes LIKE metacharacters so they match themselves', () => {
		// Without this a file called "50%.csv" would match far too much, and one
		// called "a_b" would match "axb".
		expect(globToLike('50%')).toBe('%50\\%%');
		expect(globToLike('a_b')).toBe('%a\\_b%');
		expect(globToLike('*50%*')).toBe('%50\\%%');
	});
});
