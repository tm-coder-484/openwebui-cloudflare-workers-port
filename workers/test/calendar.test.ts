import { describe, expect, it } from 'vitest';
import { expandRecurringEvent, icalStamp, msToNs, nsToMs } from '../src/lib/calendar';

const at = (iso: string) => msToNs(Date.parse(iso));

describe('expandRecurringEvent', () => {
	const base = {
		id: 'event-1',
		title: 'Standup',
		start_at: at('2026-04-01T09:00:00Z'),
		end_at: at('2026-04-01T09:15:00Z'),
		rrule: 'RRULE:FREQ=DAILY'
	};

	it('returns the event unchanged when it does not recur', () => {
		const single = { ...base, rrule: null };
		expect(
			expandRecurringEvent(single, at('2026-04-01T00:00:00Z'), at('2026-04-08T00:00:00Z'))
		).toEqual([single]);
	});

	it('expands daily occurrences inside the window', () => {
		const instances = expandRecurringEvent(
			base,
			at('2026-04-01T00:00:00Z'),
			at('2026-04-05T00:00:00Z')
		);
		expect(instances).toHaveLength(4);
		expect(new Date(nsToMs(instances[0].start_at)).toISOString()).toBe('2026-04-01T09:00:00.000Z');
		expect(new Date(nsToMs(instances[3].start_at)).toISOString()).toBe('2026-04-04T09:00:00.000Z');
	});

	it('preserves the duration of each occurrence', () => {
		const [first] = expandRecurringEvent(
			base,
			at('2026-04-01T00:00:00Z'),
			at('2026-04-02T00:00:00Z')
		);
		expect(nsToMs(first.end_at) - nsToMs(first.start_at)).toBe(15 * 60_000);
	});

	it('gives each occurrence a distinct id that points back at the series', () => {
		const instances = expandRecurringEvent(
			base,
			at('2026-04-01T00:00:00Z'),
			at('2026-04-03T00:00:00Z')
		);
		expect(new Set(instances.map((event) => event.id)).size).toBe(instances.length);
		for (const instance of instances) expect(instance.parent_id).toBe('event-1');
	});

	it('only returns weekly occurrences on the configured days', () => {
		const weekly = { ...base, rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO' };
		const instances = expandRecurringEvent(
			weekly,
			at('2026-04-01T00:00:00Z'),
			at('2026-04-30T00:00:00Z')
		);
		for (const instance of instances) {
			expect(new Date(nsToMs(instance.start_at)).getUTCDay()).toBe(1);
		}
		expect(instances.length).toBeGreaterThan(2);
	});

	it('includes the first occurrence when the event start carries seconds', () => {
		// Occurrences land on whole minutes; the series must not skip its own start.
		const withSeconds = {
			...base,
			start_at: at('2026-04-01T09:00:37Z'),
			end_at: at('2026-04-01T09:15:37Z')
		};
		const instances = expandRecurringEvent(
			withSeconds,
			at('2026-03-31T00:00:00Z'),
			at('2026-04-03T00:00:00Z')
		);
		expect(new Date(nsToMs(instances[0].start_at)).toISOString()).toBe('2026-04-01T09:00:00.000Z');
		expect(instances).toHaveLength(2);
	});
});

describe('icalStamp', () => {
	it('formats a UTC DTSTART', () => {
		expect(icalStamp(Date.parse('2026-04-01T09:30:00Z'))).toBe('20260401T093000Z');
	});
});
