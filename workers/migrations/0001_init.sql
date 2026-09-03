-- Open WebUI on Cloudflare Workers — D1 schema.
-- Mirrors the column names of the upstream SQLAlchemy models so payloads stay
-- byte-compatible with the SvelteKit frontend. JSON columns are stored as TEXT.

CREATE TABLE IF NOT EXISTS "user" (
	id TEXT PRIMARY KEY,
	email TEXT UNIQUE,
	username TEXT,
	role TEXT DEFAULT 'pending',
	name TEXT NOT NULL,
	profile_image_url TEXT,
	profile_banner_image_url TEXT,
	bio TEXT,
	gender TEXT,
	date_of_birth TEXT,
	timezone TEXT,
	presence_state TEXT,
	status_emoji TEXT,
	status_message TEXT,
	status_expires_at INTEGER,
	info TEXT,
	variables TEXT,
	settings TEXT,
	oauth TEXT,
	scim TEXT,
	last_active_at INTEGER,
	updated_at INTEGER,
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS user_email_idx ON "user" (email);
CREATE INDEX IF NOT EXISTS user_role_idx ON "user" (role);

CREATE TABLE IF NOT EXISTS auth (
	id TEXT PRIMARY KEY,
	email TEXT,
	password TEXT,
	active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS auth_email_idx ON auth (email);

CREATE TABLE IF NOT EXISTS api_key (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	key TEXT UNIQUE NOT NULL,
	name TEXT,
	created_at INTEGER,
	last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_key_user_id_idx ON api_key (user_id);

CREATE TABLE IF NOT EXISTS config (
	key TEXT PRIMARY KEY,
	value TEXT,
	updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	title TEXT,
	chat TEXT,
	created_at INTEGER,
	updated_at INTEGER,
	share_id TEXT UNIQUE,
	archived INTEGER DEFAULT 0,
	pinned INTEGER DEFAULT 0,
	meta TEXT DEFAULT '{}',
	variables TEXT,
	folder_id TEXT,
	tasks TEXT,
	summary TEXT,
	current_message_id TEXT,
	last_read_at INTEGER,
	timer_at INTEGER
);
CREATE INDEX IF NOT EXISTS chat_user_id_idx ON chat (user_id);
CREATE INDEX IF NOT EXISTS chat_user_updated_idx ON chat (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_folder_id_idx ON chat (folder_id);
CREATE INDEX IF NOT EXISTS chat_user_archived_idx ON chat (user_id, archived);
CREATE INDEX IF NOT EXISTS chat_user_pinned_idx ON chat (user_id, pinned);

-- One row per persisted chat turn. Upstream keeps the same table so the admin
-- analytics dashboards can aggregate without walking every chat JSON blob.
CREATE TABLE IF NOT EXISTS chat_message (
	id TEXT PRIMARY KEY,
	chat_id TEXT NOT NULL,
	user_id TEXT,
	role TEXT NOT NULL,
	parent_id TEXT,
	model_id TEXT,
	content TEXT,
	meta TEXT,
	usage TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS chat_message_chat_idx ON chat_message (chat_id);
CREATE INDEX IF NOT EXISTS chat_message_user_idx ON chat_message (user_id);
CREATE INDEX IF NOT EXISTS chat_message_model_idx ON chat_message (model_id);
CREATE INDEX IF NOT EXISTS chat_message_created_idx ON chat_message (created_at);

CREATE TABLE IF NOT EXISTS shared_chat (
	id TEXT PRIMARY KEY,
	chat_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT,
	chat TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS shared_chat_chat_id_idx ON shared_chat (chat_id);

CREATE TABLE IF NOT EXISTS tag (
	id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT,
	meta TEXT,
	PRIMARY KEY (id, user_id)
);

CREATE TABLE IF NOT EXISTS folder (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	user_id TEXT,
	name TEXT,
	items TEXT,
	meta TEXT,
	data TEXT,
	is_expanded INTEGER DEFAULT 0,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS folder_user_id_idx ON folder (user_id);

CREATE TABLE IF NOT EXISTS file (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	hash TEXT,
	filename TEXT,
	path TEXT,
	data TEXT,
	meta TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS file_user_id_idx ON file (user_id);

CREATE TABLE IF NOT EXISTS model (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	base_model_id TEXT,
	name TEXT,
	params TEXT,
	meta TEXT,
	is_active INTEGER DEFAULT 1,
	updated_at INTEGER,
	created_at INTEGER
);

CREATE TABLE IF NOT EXISTS prompt (
	id TEXT PRIMARY KEY,
	command TEXT UNIQUE,
	user_id TEXT,
	name TEXT,
	content TEXT,
	data TEXT,
	meta TEXT,
	tags TEXT,
	is_active INTEGER DEFAULT 1,
	version_id TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS tool (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	name TEXT,
	content TEXT,
	specs TEXT,
	meta TEXT,
	valves TEXT,
	updated_at INTEGER,
	created_at INTEGER
);

CREATE TABLE IF NOT EXISTS function (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	content TEXT,
	meta TEXT,
	valves TEXT,
	is_active INTEGER DEFAULT 0,
	is_global INTEGER DEFAULT 0,
	updated_at INTEGER,
	created_at INTEGER
);

CREATE TABLE IF NOT EXISTS knowledge (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	name TEXT,
	description TEXT,
	meta TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS knowledge_file (
	id TEXT PRIMARY KEY,
	knowledge_id TEXT NOT NULL,
	file_id TEXT NOT NULL,
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS knowledge_file_knowledge_idx ON knowledge_file (knowledge_id);

-- Chunked file text used by the retrieval layer. Vector ids point at Vectorize
-- when the binding is configured; otherwise the chunks are keyword-scored here.
CREATE TABLE IF NOT EXISTS file_chunk (
	id TEXT PRIMARY KEY,
	file_id TEXT NOT NULL,
	knowledge_id TEXT,
	user_id TEXT,
	idx INTEGER NOT NULL,
	content TEXT NOT NULL,
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS file_chunk_file_idx ON file_chunk (file_id);
CREATE INDEX IF NOT EXISTS file_chunk_knowledge_idx ON file_chunk (knowledge_id);

CREATE TABLE IF NOT EXISTS skill (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	name TEXT UNIQUE,
	description TEXT,
	content TEXT,
	meta TEXT,
	is_active INTEGER DEFAULT 1,
	updated_at INTEGER,
	created_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	type TEXT DEFAULT 'context',
	path TEXT,
	content TEXT,
	meta TEXT,
	updated_at INTEGER,
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS memory_user_id_idx ON memory (user_id);

CREATE TABLE IF NOT EXISTS note (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	title TEXT,
	data TEXT,
	meta TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS note_user_id_idx ON note (user_id);

CREATE TABLE IF NOT EXISTS pinned_note (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	note_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	type TEXT,
	name TEXT,
	description TEXT,
	is_private INTEGER,
	data TEXT,
	meta TEXT,
	created_at INTEGER,
	updated_at INTEGER,
	updated_by TEXT,
	archived_at INTEGER,
	archived_by TEXT,
	deleted_at INTEGER,
	deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS channel_member (
	id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT,
	status TEXT,
	is_active INTEGER NOT NULL DEFAULT 1,
	is_channel_muted INTEGER NOT NULL DEFAULT 0,
	is_channel_pinned INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS channel_member_channel_idx ON channel_member (channel_id);
CREATE INDEX IF NOT EXISTS channel_member_user_idx ON channel_member (user_id);

CREATE TABLE IF NOT EXISTS message (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	channel_id TEXT,
	reply_to_id TEXT,
	parent_id TEXT,
	is_pinned INTEGER NOT NULL DEFAULT 0,
	pinned_at INTEGER,
	pinned_by TEXT,
	content TEXT,
	data TEXT,
	meta TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS message_channel_idx ON message (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_parent_idx ON message (parent_id);

CREATE TABLE IF NOT EXISTS message_reaction (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	message_id TEXT,
	name TEXT,
	created_at INTEGER
);
CREATE INDEX IF NOT EXISTS message_reaction_message_idx ON message_reaction (message_id);

CREATE TABLE IF NOT EXISTS "group" (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	name TEXT,
	description TEXT,
	data TEXT,
	meta TEXT,
	permissions TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS group_member (
	id TEXT PRIMARY KEY,
	group_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS group_member_user_idx ON group_member (user_id, group_id);

CREATE TABLE IF NOT EXISTS access_grant (
	id TEXT PRIMARY KEY,
	resource_type TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	principal_type TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	permission TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (resource_type, resource_id, principal_type, principal_id, permission)
);
CREATE INDEX IF NOT EXISTS access_grant_resource_idx ON access_grant (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS access_grant_principal_idx ON access_grant (principal_type, principal_id);

CREATE TABLE IF NOT EXISTS feedback (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	version INTEGER DEFAULT 0,
	type TEXT,
	data TEXT,
	meta TEXT,
	snapshot TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback (user_id);
