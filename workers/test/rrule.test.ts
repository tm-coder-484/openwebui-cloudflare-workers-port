import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseRRule, zonedTimeToUtc, zoneOffset } from '../src/lib/rrule';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('parseRRule', () => {
	it('reads the shapes the automation editor produces', () => {
		const rule = parseRRule('DTSTART:20260401T0930\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2');
		expect(rule.freq).toBe('WEEKLY');
		expect(rule.interval).toBe(2);
		expect(rule.byDay).toEqual(['MO', 'WE']);
		expect(iso(rule.dtstart)).toBe('2026-04-01T09:30:00.000Z');
	});

	it('handles a bare RRULE with no DTSTART', () => {
		const rule = parseRRule('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
		expect(rule.dtstart).toBeNull();
		expect(rule.byHour).toEqual([9]);
		expect(rule.byMinute).toEqual([0]);
	});
});

describe('nextOccurrence', () => {
	const after = Date.UTC(2026, 3, 1, 12, 0); // Wed 1 Apr 2026, 12:00 UTC

	it('schedules the next daily run at the configured time', () => {
		expect(iso(nextOccurrence('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', after))).toBe(
			'2026-04-02T09:00:00.000Z'
		);
	});

	it('schedules later the same day when the time has not passed', () => {
		expect(iso(nextOccurrence('RRULE:FREQ=DAILY;BYHOUR=18;BYMINUTE=30', after))).toBe(
			'2026-04-01T18:30:00.000Z'
		);
	});

	it('honours weekday rules', () => {
		// 1 Apr 2026 is a Wednesday, so weekdays MO/FR next lands on Friday.
		expect(iso(nextOccurrence('RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=0', after))).toBe(
			'2026-04-03T08:00:00.000Z'
		);
	});

	it('repeats hourly with an interval', () => {
		const rule = 'DTSTART:20260401T0000Z\nRRULE:FREQ=HOURLY;INTERVAL=6';
		expect(iso(nextOccurrence(rule, after))).toBe('2026-04-01T18:00:00.000Z');
	});

	it('treats COUNT=1 as a one-shot', () => {
		const future = 'DTSTART:20260401T1500Z\nRRULE:FREQ=DAILY;COUNT=1';
		expect(iso(nextOccurrence(future, after))).toBe('2026-04-01T15:00:00.000Z');

		const past = 'DTSTART:20260401T0900Z\nRRULE:FREQ=DAILY;COUNT=1';
		expect(nextOccurrence(past, after)).toBeNull();
	});

	it('stops at UNTIL', () => {
		const rule = 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260401T235900Z';
		expect(iso(nextOccurrence(rule, after))).toBeNull();
	});

	it('respects monthly and yearly rules', () => {
		const monthly = 'DTSTART:20260115T1000Z\nRRULE:FREQ=MONTHLY';
		expect(iso(nextOccurrence(monthly, after))).toBe('2026-04-15T10:00:00.000Z');

		const yearly = 'DTSTART:20260601T1000Z\nRRULE:FREQ=YEARLY';
		expect(iso(nextOccurrence(yearly, after))).toBe('2026-06-01T10:00:00.000Z');
	});

	it('resolves wall-clock times in the owner timezone', () => {
		// 12:00 UTC is 08:00 in New York, so today's 09:00 local slot is still
		// ahead: 09:00 EDT === 13:00 UTC on the same day.
		const next = nextOccurrence('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', after, 'America/New_York');
		expect(iso(next)).toBe('2026-04-01T13:00:00.000Z');

		// An hour later the slot has passed, so it rolls to the next day.
		const tomorrow = nextOccurrence(
			'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
			Date.UTC(2026, 3, 1, 14, 0),
			'America/New_York'
		);
		expect(iso(tomorrow)).toBe('2026-04-02T13:00:00.000Z');
	});
});

describe('timezone helpers', () => {
	it('computes offsets including DST', () => {
		expect(zoneOffset(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe(-5 * 3600_000);
		expect(zoneOffset(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe(-4 * 3600_000);
		expect(zoneOffset(Date.UTC(2026, 0, 15, 12), 'Asia/Kolkata')).toBe(5.5 * 3600_000);
	});

	it('maps wall-clock times to UTC instants', () => {
		const utc = zonedTimeToUtc(
			{ year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
			'Europe/Berlin'
		);
		expect(iso(utc)).toBe('2026-07-15T07:00:00.000Z');
	});
});
