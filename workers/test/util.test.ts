import { describe, expect, it } from 'vitest';
import {
	clampInt,
	csv,
	deepMerge,
	getPath,
	parseDuration,
	parseJSON,
	setPath,
	toBool,
	validateEmail
} from '../src/lib/util';

describe('parseDuration', () => {
	it('parses common suffixes', () => {
		expect(parseDuration('30s')).toBe(30);
		expect(parseDuration('5m')).toBe(300);
		expect(parseDuration('2h')).toBe(7200);
		expect(parseDuration('7d')).toBe(604800);
		expect(parseDuration('1w')).toBe(604800);
	});

	it('treats -1 and empty as "never expires"', () => {
		expect(parseDuration('-1')).toBeNull();
		expect(parseDuration('')).toBeNull();
		expect(parseDuration(null)).toBeNull();
		expect(parseDuration('nonsense')).toBeNull();
	});
});

describe('deepMerge', () => {
	it('merges nested objects without mutating the base', () => {
		const base = { a: { b: 1, c: 2 }, d: 3 };
		const merged = deepMerge(base, { a: { c: 9 }, e: 5 });
		expect(merged).toEqual({ a: { b: 1, c: 9 }, d: 3, e: 5 });
		expect(base.a.c).toBe(2);
	});

	it('replaces arrays wholesale', () => {
		expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
	});
});

describe('paths', () => {
	it('reads and writes dotted paths', () => {
		const target: Record<string, unknown> = {};
		setPath(target, 'a.b.c', 42);
		expect(getPath(target, 'a.b.c')).toBe(42);
		expect(getPath(target, 'a.missing.c')).toBeUndefined();
	});
});

describe('coercion helpers', () => {
	it('parses JSON columns defensively', () => {
		expect(parseJSON('{"a":1}', {})).toEqual({ a: 1 });
		expect(parseJSON('not json', { fallback: true })).toEqual({ fallback: true });
		expect(parseJSON(null, [])).toEqual([]);
		expect(parseJSON('null', 'x')).toBe('x');
	});

	it('coerces booleans from sqlite integers', () => {
		expect(toBool(1)).toBe(true);
		expect(toBool('true')).toBe(true);
		expect(toBool(0)).toBe(false);
		expect(toBool(null)).toBe(false);
	});

	it('clamps integers', () => {
		expect(clampInt('5', 1, 10, 1)).toBe(5);
		expect(clampInt('99', 1, 10, 1)).toBe(10);
		expect(clampInt('abc', 1, 10, 3)).toBe(3);
	});

	it('splits comma separated env vars', () => {
		expect(csv('a, b ,c')).toEqual(['a', 'b', 'c']);
		expect(csv(undefined)).toEqual([]);
	});

	it('validates emails', () => {
		expect(validateEmail('user@example.com')).toBe(true);
		expect(validateEmail('nope')).toBe(false);
	});
});
