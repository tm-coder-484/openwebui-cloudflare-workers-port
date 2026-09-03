-- Knowledge base directories, prompt version history, and channel webhooks.

CREATE TABLE IF NOT EXISTS knowledge_directory (
	id TEXT PRIMARY KEY,
	knowledge_id TEXT NOT NULL,
	parent_id TEXT,
	name TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (knowledge_id, parent_id, name)
);
CREATE INDEX IF NOT EXISTS knowledge_directory_knowledge_idx ON knowledge_directory (knowledge_id);
CREATE INDEX IF NOT EXISTS knowledge_directory_parent_idx ON knowledge_directory (parent_id);

-- Files live at the root of a knowledge base unless they are placed in a directory.
ALTER TABLE knowledge_file ADD COLUMN directory_id TEXT;

CREATE TABLE IF NOT EXISTS prompt_history (
	id TEXT PRIMARY KEY,
	prompt_id TEXT NOT NULL,
	parent_id TEXT,
	snapshot TEXT NOT NULL,
	user_id TEXT NOT NULL,
	commit_message TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prompt_history_prompt_idx ON prompt_history (prompt_id, created_at DESC);

CREATE TABLE IF NOT EXISTS channel_webhook (
	id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT,
	url TEXT NOT NULL,
	events TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_webhook_channel_idx ON channel_webhook (channel_id);
