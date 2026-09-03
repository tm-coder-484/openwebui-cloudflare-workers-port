-- Automations: prompts that run on a schedule, driven by a Cron Trigger.

CREATE TABLE IF NOT EXISTS automation (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	folder_id TEXT,
	name TEXT NOT NULL,
	data TEXT NOT NULL,          -- {prompt, model_id, rrule, target}
	meta TEXT,
	is_active INTEGER NOT NULL DEFAULT 1,
	last_run_at INTEGER,         -- epoch nanoseconds, matching the frontend
	next_run_at INTEGER,         -- epoch nanoseconds
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_next_run_idx ON automation (next_run_at);
CREATE INDEX IF NOT EXISTS automation_user_folder_idx ON automation (user_id, folder_id);

CREATE TABLE IF NOT EXISTS automation_run (
	id TEXT PRIMARY KEY,
	automation_id TEXT NOT NULL,
	chat_id TEXT,
	status TEXT NOT NULL,        -- success | error
	error TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_run_automation_idx ON automation_run (automation_id, created_at DESC);
