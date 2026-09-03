/** Calendar helpers: serialization and recurrence expansion. */

import { nextOccurrence } from './rrule';
import { parseJSON, toBool } from './util';

export const SCHEDULED_TASKS_CALENDAR_ID = '__scheduled_tasks__';

export const NS = 1_000_000;
export const msToNs = (ms: number): number => ms * NS;
export const nsToMs = (ns: number): number => Math.floor(ns / NS);

export interface CalendarRow {
	id: string;
	user_id: string;
	name: string;
	color: string | null;
	is_default: number;
	data: string | null;
	meta: string | null;
	created_at: number;
	updated_at: number;
}

export interface CalendarEventRow {
	id: string;
	calendar_id: string;
	user_id: string;
	title: string;
	description: string | null;
	start_at: number;
	end_at: number | null;
	all_day: number;
	rrule: string | null;
	color: string | null;
	location: string | null;
	data: string | null;
	meta: string | null;
	is_cancelled: number;
	created_at: number;
	updated_at: number;
}

export const serializeCalendar = (row: CalendarRow, extra: Record<string, unknown> = {}) => ({
	id: row.id,
	user_id: row.user_id,
	name: row.name,
	color: row.color,
	is_default: toBool(row.is_default),
	is_system: false,
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	created_at: row.created_at,
	updated_at: row.updated_at,
	...extra
});

export const serializeEvent = (row: CalendarEventRow, attendees: unknown[] = []) => ({
	id: row.id,
	calendar_id: row.calendar_id,
	user_id: row.user_id,
	title: row.title,
	description: row.description,
	start_at: row.start_at,
	end_at: row.end_at,
	all_day: toBool(row.all_day),
	rrule: row.rrule,
	color: row.color,
	location: row.location,
	data: parseJSON<Record<string, unknown> | null>(row.data, null),
	meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
	is_cancelled: toBool(row.is_cancelled),
	attendees,
	created_at: row.created_at,
	updated_at: row.updated_at
});

/**
 * Expands a recurring event into the instances that fall inside a window.
 *
 * Each instance keeps the parent id suffixed with its start time, which is how
 * the frontend distinguishes occurrences of the same series.
 */
export function expandRecurringEvent(
	event: Record<string, any>,
	startNs: number,
	endNs: number,
	timeZone: string | null = null,
	limit = 200
): Record<string, any>[] {
	if (!event.rrule) return [event];

	const durationNs = event.end_at ? event.end_at - event.start_at : 0;
	const rule = event.rrule.includes('DTSTART')
		? event.rrule
		: `DTSTART:${icalStamp(nsToMs(event.start_at))}\n${event.rrule}`;

	const instances: Record<string, any>[] = [];
	// RRULE occurrences land on whole minutes, so align the series start before
	// stepping — otherwise an event created at, say, 10:11:30 would skip its own
	// first occurrence at 10:11:00. Step back one millisecond so an occurrence
	// exactly on the window start is included.
	const seriesStartMs = Math.floor(nsToMs(event.start_at) / 60_000) * 60_000;
	let cursor = Math.max(nsToMs(startNs), seriesStartMs) - 1;
	const endMs = nsToMs(endNs);

	for (let i = 0; i < limit; i++) {
		const next = nextOccurrence(rule, cursor, timeZone);
		if (next === null || next > endMs) break;
		cursor = next;
		const startAt = msToNs(next);
		instances.push({
			...event,
			id: `${event.id}_${startAt}`,
			parent_id: event.id,
			start_at: startAt,
			end_at: durationNs ? startAt + durationNs : null
		});
	}
	return instances;
}

/** `20260401T093000Z` — the DTSTART form the RRULE parser reads. */
export function icalStamp(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, '0');
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
	);
}
