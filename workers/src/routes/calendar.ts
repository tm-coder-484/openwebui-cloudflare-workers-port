/** `/api/v1/calendars` — calendars, events, recurrence and RSVPs. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';
import { hasAccess, replaceGrants, deleteGrants, grantsFor } from '../lib/access';
import { hasPermission } from '../lib/permissions';
import {
	SCHEDULED_TASKS_CALENDAR_ID,
	expandRecurringEvent,
	msToNs,
	serializeCalendar,
	serializeEvent,
	type CalendarEventRow,
	type CalendarRow
} from '../lib/calendar';
import { nextOccurrence } from '../lib/rrule';
import { getUserById, publicUser } from '../lib/users';
import { bad, forbidden, notFound, now, parseJSON, toJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

async function attendeesFor(c: any, eventId: string) {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM calendar_event_attendee WHERE event_id = ?1'
	)
		.bind(eventId)
		.all();
	return await Promise.all(
		((results ?? []) as any[]).map(async (row) => {
			const user = await getUserById(c.env, row.user_id);
			return {
				id: row.id,
				event_id: row.event_id,
				user_id: row.user_id,
				status: row.status,
				user: user ? publicUser(user) : null,
				created_at: row.created_at,
				updated_at: row.updated_at
			};
		})
	);
}

async function loadCalendar(c: any, id: string, permission: 'read' | 'write' = 'write') {
	const user = verifiedUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM calendar WHERE id = ?1')
		.bind(id)
		.first()) as CalendarRow | null;
	if (!row) throw notFound('Calendar not found');
	if (!(await hasAccess(c.env, user, 'calendar', row.id, row.user_id, permission)))
		throw forbidden();
	return { row, user };
}

app.get('/', async (c) => {
	const user = verifiedUser(c);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM calendar WHERE user_id = ?1 ORDER BY created_at ASC'
	)
		.bind(user.id)
		.all();
	const calendars = ((results ?? []) as unknown as CalendarRow[]).map((row) =>
		serializeCalendar(row)
	);

	// Automations get a read-only calendar so their runs show up alongside events.
	const automations = await c.env.DB.prepare(
		'SELECT COUNT(*) AS count FROM automation WHERE user_id = ?1'
	)
		.bind(user.id)
		.first<{ count: number }>();
	if (automations?.count) {
		const timestamp = msToNs(Date.now());
		calendars.push({
			id: SCHEDULED_TASKS_CALENDAR_ID,
			user_id: user.id,
			name: 'Scheduled Tasks',
			color: '#8b5cf6',
			is_default: false,
			is_system: true,
			data: null,
			meta: null,
			created_at: timestamp,
			updated_at: timestamp
		});
	}

	return c.json(calendars);
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'features.calendar'))) throw forbidden();
	const body = (await c.req.json()) as any;
	if (!body?.name) throw bad('A calendar name is required');

	const id = uuid();
	const timestamp = msToNs(Date.now());
	await c.env.DB.prepare(
		`INSERT INTO calendar (id, user_id, name, color, is_default, data, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
	)
		.bind(
			id,
			user.id,
			body.name,
			body.color ?? null,
			body.is_default ? 1 : 0,
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			timestamp
		)
		.run();
	if (Array.isArray(body.access_grants))
		await replaceGrants(c.env, 'calendar', id, body.access_grants);

	const row = (await c.env.DB.prepare('SELECT * FROM calendar WHERE id = ?1')
		.bind(id)
		.first()) as CalendarRow;
	return c.json(serializeCalendar(row));
});

/**
 * Events in a window: stored events (recurring ones expanded), plus the
 * automations view — upcoming runs from their RRULEs and past runs from history.
 */
app.get('/events', async (c) => {
	const user = verifiedUser(c);
	const startParam = c.req.query('start');
	const endParam = c.req.query('end');
	if (!startParam || !endParam) throw bad('start and end are required (ISO 8601)');

	const startMs = Date.parse(startParam);
	const endMs = Date.parse(endParam);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		throw bad('Invalid date format. Use ISO 8601 (e.g. 2026-04-01T00:00:00Z)');
	}
	const startNs = msToNs(startMs);
	const endNs = msToNs(endMs);
	const calendarIds = c.req.query('calendar_ids')?.split(',').filter(Boolean) ?? null;
	const timeZone = (await getUserById(c.env, user.id))?.timezone ?? null;

	const { results } = await c.env.DB.prepare(
		`SELECT * FROM calendar_event
		 WHERE user_id = ?1 AND is_cancelled = 0
		   AND (rrule IS NOT NULL OR (start_at <= ?3 AND COALESCE(end_at, start_at) >= ?2))`
	)
		.bind(user.id, startNs, endNs)
		.all();

	const events: Record<string, unknown>[] = [];
	for (const row of (results ?? []) as unknown as CalendarEventRow[]) {
		if (calendarIds && !calendarIds.includes(row.calendar_id)) continue;
		const serialized = serializeEvent(row, await attendeesFor(c, row.id));
		if (row.rrule) {
			events.push(...expandRecurringEvent(serialized, startNs, endNs, timeZone));
		} else {
			events.push(serialized);
		}
	}

	const wantsAutomations = !calendarIds || calendarIds.includes(SCHEDULED_TASKS_CALENDAR_ID);
	if (wantsAutomations) {
		const { results: automations } = await c.env.DB.prepare(
			'SELECT * FROM automation WHERE user_id = ?1 AND is_active = 1'
		)
			.bind(user.id)
			.all();

		for (const automation of (automations ?? []) as any[]) {
			const data = parseJSON<{ rrule?: string; prompt?: string }>(automation.data, {});
			if (!data.rrule) continue;
			let cursor = Math.max(startMs, Date.now());
			for (let i = 0; i < 50; i++) {
				const next = nextOccurrence(data.rrule, cursor, timeZone);
				if (next === null || next > endMs) break;
				cursor = next;
				events.push({
					id: `auto_${automation.id}_${next}`,
					calendar_id: SCHEDULED_TASKS_CALENDAR_ID,
					user_id: user.id,
					title: automation.name,
					description: data.prompt ?? '',
					start_at: msToNs(next),
					end_at: null,
					all_day: false,
					rrule: data.rrule,
					color: null,
					location: null,
					data: null,
					meta: { automation_id: automation.id },
					is_cancelled: false,
					attendees: [],
					created_at: automation.created_at,
					updated_at: automation.updated_at
				});
			}
		}

		const { results: runs } = await c.env.DB.prepare(
			`SELECT r.*, a.name AS automation_name FROM automation_run r
			 JOIN automation a ON a.id = r.automation_id
			 WHERE a.user_id = ?1 AND r.created_at BETWEEN ?2 AND ?3`
		)
			.bind(user.id, startNs, endNs)
			.all();

		for (const run of (runs ?? []) as any[]) {
			events.push({
				id: `run_${run.id}`,
				calendar_id: SCHEDULED_TASKS_CALENDAR_ID,
				user_id: user.id,
				title: run.automation_name,
				description: run.status === 'error' ? run.error : '',
				start_at: run.created_at,
				end_at: null,
				all_day: false,
				rrule: null,
				color: null,
				location: null,
				data: null,
				meta: {
					automation_id: run.automation_id,
					run_id: run.id,
					chat_id: run.chat_id,
					status: run.status
				},
				is_cancelled: false,
				attendees: [],
				created_at: run.created_at,
				updated_at: run.created_at
			});
		}
	}

	events.sort((a, b) => Number(a.start_at) - Number(b.start_at));
	return c.json(events);
});

app.get('/events/search', async (c) => {
	const user = verifiedUser(c);
	const query = (c.req.query('query') ?? '').toLowerCase();
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM calendar_event WHERE user_id = ?1
		   AND (lower(title) LIKE ?2 OR lower(COALESCE(description, '')) LIKE ?2)
		 ORDER BY start_at DESC LIMIT 50`
	)
		.bind(user.id, `%${query}%`)
		.all();
	const rows = (results ?? []) as unknown as CalendarEventRow[];
	return c.json(
		await Promise.all(rows.map(async (row) => serializeEvent(row, await attendeesFor(c, row.id))))
	);
});

app.post('/events/create', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as any;
	if (!body?.calendar_id) throw bad('calendar_id is required');
	if (!body?.title) throw bad('An event title is required');
	if (typeof body?.start_at !== 'number') throw bad('start_at (epoch nanoseconds) is required');
	await loadCalendar(c, body.calendar_id, 'write');

	const id = uuid();
	const timestamp = msToNs(Date.now());
	await c.env.DB.prepare(
		`INSERT INTO calendar_event
			(id, calendar_id, user_id, title, description, start_at, end_at, all_day, rrule, color,
			 location, data, meta, is_cancelled, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?14)`
	)
		.bind(
			id,
			body.calendar_id,
			user.id,
			body.title,
			body.description ?? null,
			body.start_at,
			body.end_at ?? null,
			body.all_day ? 1 : 0,
			body.rrule ?? null,
			body.color ?? null,
			body.location ?? null,
			toJSON(body.data ?? {}),
			toJSON(body.meta ?? {}),
			timestamp
		)
		.run();

	for (const attendee of body.attendees ?? []) {
		const attendeeId = attendee?.user_id ?? attendee;
		if (typeof attendeeId !== 'string') continue;
		await c.env.DB.prepare(
			`INSERT OR IGNORE INTO calendar_event_attendee
				(id, event_id, user_id, status, meta, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
		)
			.bind(uuid(), id, attendeeId, 'pending', toJSON({}), timestamp)
			.run();
	}

	const row = (await c.env.DB.prepare('SELECT * FROM calendar_event WHERE id = ?1')
		.bind(id)
		.first()) as CalendarEventRow;
	return c.json(serializeEvent(row, await attendeesFor(c, id)));
});

async function loadEvent(c: any, id: string) {
	const user = verifiedUser(c);
	const row = (await c.env.DB.prepare('SELECT * FROM calendar_event WHERE id = ?1')
		.bind(id)
		.first()) as CalendarEventRow | null;
	if (!row) throw notFound('Event not found');
	if (row.user_id !== user.id && user.role !== 'admin') {
		// Attendees may read (and RSVP to) events they were invited to.
		const attendee = await c.env.DB.prepare(
			'SELECT id FROM calendar_event_attendee WHERE event_id = ?1 AND user_id = ?2'
		)
			.bind(id, user.id)
			.first();
		if (!attendee) throw forbidden();
	}
	return { row, user };
}

app.get('/events/:id', async (c) => {
	const { row } = await loadEvent(c, c.req.param('id'));
	return c.json(serializeEvent(row, await attendeesFor(c, row.id)));
});

app.post('/events/:id/update', async (c) => {
	const { row, user } = await loadEvent(c, c.req.param('id'));
	if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
	const body = (await c.req.json()) as any;

	await c.env.DB.prepare(
		`UPDATE calendar_event SET title = ?1, description = ?2, start_at = ?3, end_at = ?4,
			all_day = ?5, rrule = ?6, color = ?7, location = ?8, data = ?9, meta = ?10,
			is_cancelled = ?11, updated_at = ?12 WHERE id = ?13`
	)
		.bind(
			body.title ?? row.title,
			body.description === undefined ? row.description : body.description,
			body.start_at ?? row.start_at,
			body.end_at === undefined ? row.end_at : body.end_at,
			body.all_day === undefined ? row.all_day : body.all_day ? 1 : 0,
			body.rrule === undefined ? row.rrule : body.rrule,
			body.color === undefined ? row.color : body.color,
			body.location === undefined ? row.location : body.location,
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			body.is_cancelled === undefined ? row.is_cancelled : body.is_cancelled ? 1 : 0,
			msToNs(Date.now()),
			row.id
		)
		.run();

	const updated = (await c.env.DB.prepare('SELECT * FROM calendar_event WHERE id = ?1')
		.bind(row.id)
		.first()) as CalendarEventRow;
	return c.json(serializeEvent(updated, await attendeesFor(c, row.id)));
});

app.post('/events/:id/rsvp', async (c) => {
	const { row, user } = await loadEvent(c, c.req.param('id'));
	const { status } = (await c.req.json()) as { status?: string };
	const value = ['accepted', 'declined', 'tentative', 'pending'].includes(status ?? '')
		? (status as string)
		: 'pending';
	const timestamp = msToNs(Date.now());

	await c.env.DB.prepare(
		`INSERT INTO calendar_event_attendee (id, event_id, user_id, status, meta, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
		 ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
	)
		.bind(uuid(), row.id, user.id, value, toJSON({}), timestamp)
		.run();

	return c.json(serializeEvent(row, await attendeesFor(c, row.id)));
});

app.delete('/events/:id/delete', async (c) => {
	const { row, user } = await loadEvent(c, c.req.param('id'));
	if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM calendar_event_attendee WHERE event_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM calendar_event WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

app.get('/:id', async (c) => {
	const { row } = await loadCalendar(c, c.req.param('id'), 'read');
	return c.json(
		serializeCalendar(row, { access_grants: await grantsFor(c.env, 'calendar', row.id) })
	);
});

app.post('/:id/update', async (c) => {
	const { row } = await loadCalendar(c, c.req.param('id'));
	const body = (await c.req.json()) as any;
	await c.env.DB.prepare(
		'UPDATE calendar SET name = ?1, color = ?2, data = ?3, meta = ?4, updated_at = ?5 WHERE id = ?6'
	)
		.bind(
			body.name ?? row.name,
			body.color === undefined ? row.color : body.color,
			toJSON(body.data ?? parseJSON(row.data, {})),
			toJSON(body.meta ?? parseJSON(row.meta, {})),
			msToNs(Date.now()),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants)) {
		await replaceGrants(c.env, 'calendar', row.id, body.access_grants);
	}
	const updated = (await c.env.DB.prepare('SELECT * FROM calendar WHERE id = ?1')
		.bind(row.id)
		.first()) as CalendarRow;
	return c.json(serializeCalendar(updated));
});

app.post('/:id/default', async (c) => {
	const { row, user } = await loadCalendar(c, c.req.param('id'));
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE calendar SET is_default = 0 WHERE user_id = ?1').bind(user.id),
		c.env.DB.prepare('UPDATE calendar SET is_default = 1, updated_at = ?1 WHERE id = ?2').bind(
			msToNs(Date.now()),
			row.id
		)
	]);
	const updated = (await c.env.DB.prepare('SELECT * FROM calendar WHERE id = ?1')
		.bind(row.id)
		.first()) as CalendarRow;
	return c.json(serializeCalendar(updated));
});

app.delete('/:id/delete', async (c) => {
	const { row } = await loadCalendar(c, c.req.param('id'));
	await deleteGrants(c.env, 'calendar', row.id);
	await c.env.DB.batch([
		c.env.DB.prepare(
			'DELETE FROM calendar_event_attendee WHERE event_id IN (SELECT id FROM calendar_event WHERE calendar_id = ?1)'
		).bind(row.id),
		c.env.DB.prepare('DELETE FROM calendar_event WHERE calendar_id = ?1').bind(row.id),
		c.env.DB.prepare('DELETE FROM calendar WHERE id = ?1').bind(row.id)
	]);
	return c.json(true);
});

export default app;
