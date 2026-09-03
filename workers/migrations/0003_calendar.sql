-- Calendars, events (optionally recurring) and attendee RSVPs.
-- Timestamps are epoch nanoseconds, matching the frontend and automations.

CREATE TABLE IF NOT EXISTS calendar (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	color TEXT,
	is_default INTEGER NOT NULL DEFAULT 0,
	data TEXT,
	meta TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_user_idx ON calendar (user_id);

CREATE TABLE IF NOT EXISTS calendar_event (
	id TEXT PRIMARY KEY,
	calendar_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	start_at INTEGER NOT NULL,
	end_at INTEGER,
	all_day INTEGER NOT NULL DEFAULT 0,
	rrule TEXT,
	color TEXT,
	location TEXT,
	data TEXT,
	meta TEXT,
	is_cancelled INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_event_calendar_idx ON calendar_event (calendar_id, start_at);
CREATE INDEX IF NOT EXISTS calendar_event_user_date_idx ON calendar_event (user_id, start_at);

CREATE TABLE IF NOT EXISTS calendar_event_attendee (
	id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	meta TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS calendar_event_attendee_user_idx ON calendar_event_attendee (user_id, status);
