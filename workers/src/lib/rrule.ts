/**
 * A small RRULE evaluator (RFC 5545 subset).
 *
 * Automations and calendar events store an iCalendar recurrence rule. Only the
 * shapes the UI can produce are supported — FREQ, INTERVAL, BYDAY, BYHOUR,
 * BYMINUTE, BYMONTHDAY, COUNT=1 and UNTIL — which keeps this dependency-free
 * and small enough to reason about.
 *
 * `DTSTART` values without a `Z` suffix are wall-clock times: they are resolved
 * in the owner's timezone when one is known, so "every day at 09:00" means
 * 09:00 where the user is, not 09:00 UTC.
 */

export interface ParsedRule {
	dtstart: number | null; // epoch ms (UTC instant)
	freq: string;
	interval: number;
	byDay: string[];
	byHour: number[];
	byMinute: number[];
	byMonthDay: number[];
	count: number | null;
	until: number | null;
	timeZone: string | null;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Converts a wall-clock time in `timeZone` to the matching UTC instant.
 * Probes the zone's offset at an approximate instant, then corrects — enough
 * for every offset in use, including half-hour zones.
 */
export function zonedTimeToUtc(
	parts: { year: number; month: number; day: number; hour: number; minute: number },
	timeZone: string | null
): number {
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
	if (!timeZone) return asUtc;
	try {
		const offset = zoneOffset(asUtc, timeZone);
		// Re-probe with the corrected instant so DST boundaries land correctly.
		return asUtc - zoneOffset(asUtc - offset, timeZone);
	} catch {
		return asUtc;
	}
}

/** Offset of `timeZone` at `instant`, in milliseconds east of UTC. */
export function zoneOffset(instant: number, timeZone: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const parts: Record<string, number> = {};
	for (const part of formatter.formatToParts(new Date(instant))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	const asUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour % 24,
		parts.minute,
		parts.second
	);
	return asUtc - instant;
}

/** Wall-clock fields of `instant` in `timeZone` (or UTC when none is given). */
export function zonedParts(
	instant: number,
	timeZone: string | null
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
	const shifted = timeZone ? instant + zoneOffset(instant, timeZone) : instant;
	const date = new Date(shifted);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
		weekday: date.getUTCDay()
	};
}

export function parseRRule(input: string, timeZone: string | null = null): ParsedRule {
	const rule: ParsedRule = {
		dtstart: null,
		freq: 'DAILY',
		interval: 1,
		byDay: [],
		byHour: [],
		byMinute: [],
		byMonthDay: [],
		count: null,
		until: null,
		timeZone
	};

	for (const rawLine of (input ?? '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		if (/^DTSTART/i.test(line)) {
			const value = line.split(':').pop() ?? '';
			const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?(Z)?$/.exec(value.trim());
			if (match) {
				const [, year, month, day, hour = '0', minute = '0', , zulu] = match;
				const fields = {
					year: Number(year),
					month: Number(month),
					day: Number(day),
					hour: Number(hour),
					minute: Number(minute)
				};
				rule.dtstart = zulu
					? Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute)
					: zonedTimeToUtc(fields, timeZone);
			}
			continue;
		}

		for (const pair of line.replace(/^RRULE:/i, '').split(';')) {
			const [rawKey, rawValue] = pair.split('=');
			if (!rawKey || !rawValue) continue;
			const key = rawKey.trim().toUpperCase();
			const value = rawValue.trim().toUpperCase();

			if (key === 'FREQ') rule.freq = value;
			else if (key === 'INTERVAL') rule.interval = Math.max(1, parseInt(value, 10) || 1);
			else if (key === 'BYDAY') rule.byDay = value.split(',').filter(Boolean);
			else if (key === 'BYHOUR') rule.byHour = value.split(',').map(Number).filter(Number.isFinite);
			else if (key === 'BYMINUTE')
				rule.byMinute = value.split(',').map(Number).filter(Number.isFinite);
			else if (key === 'BYMONTHDAY')
				rule.byMonthDay = value.split(',').map(Number).filter(Number.isFinite);
			else if (key === 'COUNT') rule.count = parseInt(value, 10) || null;
			else if (key === 'UNTIL') {
				const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/.exec(value);
				if (match) {
					rule.until = Date.UTC(
						Number(match[1]),
						Number(match[2]) - 1,
						Number(match[3]),
						Number(match[4] ?? '0'),
						Number(match[5] ?? '0')
					);
				}
			}
		}
	}

	return rule;
}

/**
 * First occurrence strictly after `after` (both epoch ms), or null when the
 * rule has no further runs.
 */
export function nextOccurrence(
	rrule: string,
	after: number = Date.now(),
	timeZone: string | null = null
): number | null {
	const rule = parseRRule(rrule, timeZone);
	const start = rule.dtstart ?? after;

	// COUNT=1 is how the UI encodes a one-shot "run once at" schedule.
	if (rule.count === 1) return start > after ? start : null;

	const hours = rule.byHour.length ? rule.byHour : null;
	const minutes = rule.byMinute.length ? rule.byMinute : null;
	const startParts = zonedParts(start, rule.timeZone);

	const targetHours = hours ?? [startParts.hour];
	const targetMinutes = minutes ?? [startParts.minute];
	const targetDays = rule.byDay.length
		? rule.byDay.map((day) => WEEKDAYS.indexOf(day.replace(/^[+-]?\d+/, ''))).filter((d) => d >= 0)
		: null;

	// Walk forward one candidate at a time. The caps below cover more than a
	// year for every frequency, which is far beyond any practical schedule.
	const limits: Record<string, number> = {
		MINUTELY: 1440 * 3,
		HOURLY: 24 * 90,
		DAILY: 800,
		WEEKLY: 160,
		MONTHLY: 60,
		YEARLY: 20
	};
	const limit = limits[rule.freq] ?? 800;

	if (rule.freq === 'MINUTELY' || rule.freq === 'HOURLY') {
		const step = (rule.freq === 'MINUTELY' ? MINUTE : HOUR) * rule.interval;
		let candidate = start;
		if (candidate <= after) {
			const steps = Math.floor((after - candidate) / step) + 1;
			candidate += steps * step;
		}
		for (let i = 0; i < limit; i++, candidate += step) {
			if (rule.until && candidate > rule.until) return null;
			if (candidate > after) return candidate;
		}
		return null;
	}

	let cursor = zonedParts(Math.max(start, after - DAY), rule.timeZone);
	let dayCursor = Date.UTC(cursor.year, cursor.month - 1, cursor.day);

	for (let i = 0; i < limit * 32; i++) {
		const date = new Date(dayCursor);
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		const weekday = date.getUTCDay();

		let matches = true;
		if (rule.freq === 'WEEKLY' && targetDays) matches = targetDays.includes(weekday);
		else if (rule.freq === 'WEEKLY' && !targetDays) matches = weekday === startParts.weekday;
		else if (rule.freq === 'MONTHLY') {
			const wanted = rule.byMonthDay.length ? rule.byMonthDay : [startParts.day];
			matches = wanted.includes(day);
		} else if (rule.freq === 'YEARLY') {
			matches = month === startParts.month && day === startParts.day;
		} else if (rule.freq === 'DAILY' && rule.interval > 1) {
			const days = Math.round(
				(dayCursor - Date.UTC(startParts.year, startParts.month - 1, startParts.day)) / DAY
			);
			matches = days >= 0 && days % rule.interval === 0;
		}

		if (matches) {
			for (const hour of targetHours) {
				for (const minute of targetMinutes) {
					const candidate = zonedTimeToUtc({ year, month, day, hour, minute }, rule.timeZone);
					if (candidate <= after) continue;
					if (candidate < start) continue;
					if (rule.until && candidate > rule.until) return null;
					return candidate;
				}
			}
		}

		dayCursor += DAY;
		if (rule.until && dayCursor > rule.until + DAY) return null;
	}

	return null;
}
