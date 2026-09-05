/**
 * Persisted application config.
 *
 * Upstream keeps a `config` JSON blob in Postgres/SQLite and reads it through
 * `Config.get('a.b.c')`. Here each dotted key is one D1 row so admin writes are
 * cheap single-statement upserts. Values fall back to `DEFAULT_CONFIG`, which
 * itself can be seeded from Worker vars/secrets at first read.
 */

import type { Env } from '../types';
import { csv, deepMerge, now, parseJSON, toBool } from './util';

export const DEFAULT_USER_PERMISSIONS = {
	workspace: {
		models: false,
		knowledge: false,
		prompts: false,
		tools: false,
		skills: false,
		models_import: false,
		models_export: false,
		prompts_import: false,
		prompts_export: false,
		tools_import: false,
		tools_export: false,
		skills_import: false,
		skills_export: false
	},
	sharing: {
		models: false,
		public_models: false,
		knowledge: false,
		public_knowledge: false,
		prompts: false,
		public_prompts: false,
		tools: false,
		public_tools: false,
		skills: false,
		public_skills: false,
		notes: false,
		public_notes: false,
		folders: false,
		public_chats: true,
		open_chats: false,
		public_calendars: false
	},
	access_grants: {
		allow_users: true,
		allow_groups: true
	},
	chat: {
		controls: true,
		valves: true,
		system_prompt: true,
		params: true,
		file_upload: true,
		web_upload: true,
		delete: true,
		delete_message: true,
		continue_response: true,
		regenerate_response: true,
		rate_response: true,
		edit: true,
		share: true,
		export: true,
		import: true,
		stt: true,
		tts: true,
		call: true,
		multiple_models: true,
		temporary: true,
		temporary_enforced: false
	},
	features: {
		api_keys: true,
		notes: true,
		folders: true,
		channels: true,
		direct_tool_servers: false,
		web_search: true,
		image_generation: true,
		code_interpreter: true,
		memories: true,
		automations: true,
		calendar: false,
		webhooks: false
	},
	settings: {
		interface: true
	}
};

/** Every config key the Worker knows about, with upstream's default value. */
export const DEFAULT_CONFIG: Record<string, unknown> = {
	'ui.enable_signup': true,
	'ui.enable_login_form': true,
	'ui.enable_password_change_form': true,
	'ui.enable_community_sharing': true,
	'ui.enable_message_rating': true,
	'ui.enable_user_webhooks': false,
	'ui.default_models': null,
	'ui.default_pinned_models': null,
	'ui.default_interface_settings': {},
	'ui.prompt_suggestions': [
		{
			title: ['Explain a concept', 'like I am five'],
			content: 'Explain {{topic}} to me like I am five years old.'
		},
		{
			title: ['Review this code', 'and suggest improvements'],
			content: 'Review the following code and suggest improvements:\n\n{{code}}'
		},
		{
			title: ['Draft an email', 'to my team'],
			content: 'Write a short, friendly email to my team about {{topic}}.'
		},
		{
			title: ['Summarize', 'a long document'],
			content: 'Summarize the key points of the following text:\n\n{{text}}'
		}
	],
	'ui.pending_user_overlay_title': '',
	'ui.pending_user_overlay_content': '',
	'ui.watermark': '',
	'ui.banners': [],

	'auth.enable_api_keys': true,
	'auth.jwt_expiry': '-1',
	'auth.admin.show': true,

	'ldap.enable': false,

	'direct.enable': false,
	'folders.enable': true,
	'folders.max_file_count': null,
	'channels.enable': true,
	'calendar.enable': true,
	'automations.enable': true,
	'notes.enable': true,
	'memories.enable': true,
	'users.enable_status': true,

	'chat.context_compaction.enable': false,
	'chat.tool_permissions.enable': false,

	'web.search.enable': false,
	'web.search.engine': 'duckduckgo',
	// 'always' searches once before every turn; 'tool' offers the search to the
	// model as a function it can choose to call.
	'web.search.mode': 'always',
	'web.search.api_key': '',
	'web.search.google_pse.api_key': '',
	'web.search.google_pse.engine_id': '',
	'web.search.url': '',
	'web.search.searxng.language': 'en',
	'web.search.ollama_cloud.api_key': '',
	'web.search.result_count': 3,
	'web.search.concurrent_requests': 5,
	// The Web Search screen marks this input `required`, so leaving it unset
	// makes the browser refuse to submit the form and nothing on the whole
	// screen can be saved.
	'web.loader.concurrent_requests': 5,
	'web.search.domain_filter_list': '',
	'web.search.bypass_embedding': false,
	'web.search.bypass_loader': false,
	'web.loader.youtube_language': 'en',
	'web.loader.ssl_verification': true,
	'web.search.confirmation.enable': false,
	'web.search.confirmation.content': '',
	'web.loader.engine': 'fetch',

	'code_execution.enable': true,
	'code_execution.engine': 'pyodide',
	'code_interpreter.enable': true,
	'code_interpreter.engine': 'pyodide',
	'code_interpreter.prompt_template': '',

	'image_generation.enable': false,
	'image_generation.engine': 'openai',
	'image_generation.model': '',
	'image_generation.size': '1024x1024',
	'image_generation.steps': 50,

	'audio.tts.engine': '',
	'audio.tts.voice': 'alloy',
	'audio.tts.model': 'tts-1',
	'audio.tts.split_on': 'punctuation',
	'audio.stt.engine': '',
	'audio.stt.model': 'whisper-1',

	'rag.file.max_size': null,
	'rag.file.max_count': null,
	'rag.top_k': 3,
	'rag.chunk_size': 1000,
	'rag.chunk_overlap': 100,
	'rag.template': '',
	'rag.embedding_engine': 'workers-ai',
	'rag.embedding_model': '@cf/baai/bge-base-en-v1.5',
	'rag.embedding_batch_size': 1,
	'rag.embedding_openai.key': '',
	'rag.embedding_openai.url': '',
	'rag.embedding_ollama.key': '',
	'rag.embedding_ollama.url': '',
	'rag.hybrid_search': false,
	'rag.full_context': false,
	// The Documents screen's other name for the same thing: skip retrieval and
	// give the model the whole document.
	'rag.bypass_embedding': false,

	'file.image_compression_width': null,
	'file.image_compression_height': null,

	'google_drive.enable': false,
	'onedrive.enable': false,

	'task.title.enable': true,
	'task.title.model': null,
	'task.title.prompt_template': '',
	'task.tags.enable': true,
	'task.tags.model': null,
	'task.tags.prompt_template': '',
	'task.follow_up.enable': true,
	'task.autocomplete.enable': false,
	// Turns the conversation into real search queries instead of searching the
	// raw message verbatim.
	'task.query.enable': true,
	'task.query.prompt_template': '',
	'task.emoji.enable': false,
	'task.model': null,
	'task.model_external': null,

	// NVIDIA NIM is the primary model provider: an OpenAI-compatible API that
	// serves the hosted catalogue on build.nvidia.com and self-hosted NIM
	// microservices alike, so one API key is enough to get running.
	'nvidia.enable': true,
	'nvidia.api_base_url': 'https://integrate.api.nvidia.com/v1',
	'nvidia.api_key': '',
	'nvidia.model_ids': [],
	// Unset by default: resolved from the live catalogue (see defaultNvidiaModel).
	'nvidia.default_model': '',

	'openai.enable': true,
	'openai.api_base_urls': [],
	'openai.api_keys': [],
	'openai.api_configs': {},
	'ollama.enable': false,
	// Ollama Cloud speaks the OpenAI API at /v1; several keys can be pooled.
	'ollama.base_url': 'https://ollama.com/v1',
	'ollama.api_keys': [],
	'ollama.base_urls': [],
	'ollama.api_configs': {},
	'workers_ai.enable': true,
	'workers_ai.models': [],

	'models.default': [],
	'models.config': {},
	tool_servers: [],
	terminal_servers: [],
	'subagents.enable': false,

	'evaluation.arena.enable': false,
	'evaluation.arena.models': [],

	'user.permissions': DEFAULT_USER_PERMISSIONS
};

/** Env vars that seed config on first boot (secrets stay out of D1 when empty). */
function envDefaults(env: Env): Record<string, unknown> {
	const seeded: Record<string, unknown> = {};
	if (env.ENABLE_SIGNUP !== undefined) seeded['ui.enable_signup'] = toBool(env.ENABLE_SIGNUP);
	if (env.ENABLE_LOGIN_FORM !== undefined)
		seeded['ui.enable_login_form'] = toBool(env.ENABLE_LOGIN_FORM);
	if (env.ENABLE_OPENAI_API !== undefined) seeded['openai.enable'] = toBool(env.ENABLE_OPENAI_API);
	if (env.ENABLE_WORKERS_AI !== undefined)
		seeded['workers_ai.enable'] = toBool(env.ENABLE_WORKERS_AI);
	if (env.WORKERS_AI_MODELS) seeded['workers_ai.models'] = csv(env.WORKERS_AI_MODELS);
	if (env.DEFAULT_MODELS) seeded['ui.default_models'] = env.DEFAULT_MODELS;
	if (env.JWT_EXPIRES_IN) seeded['auth.jwt_expiry'] = env.JWT_EXPIRES_IN;
	if (env.RAG_EMBEDDING_MODEL) seeded['rag.embedding_model'] = env.RAG_EMBEDDING_MODEL;
	if (env.TASK_MODEL) seeded['task.model'] = env.TASK_MODEL;

	if (env.ENABLE_NVIDIA_API !== undefined) seeded['nvidia.enable'] = toBool(env.ENABLE_NVIDIA_API);
	if (env.NVIDIA_API_KEY) seeded['nvidia.api_key'] = env.NVIDIA_API_KEY;
	if (env.NVIDIA_API_BASE_URL) seeded['nvidia.api_base_url'] = env.NVIDIA_API_BASE_URL;
	if (env.NVIDIA_MODELS) seeded['nvidia.model_ids'] = csv(env.NVIDIA_MODELS);

	const urls = csv(env.OPENAI_API_BASE_URLS ?? env.OPENAI_API_BASE_URL ?? '');
	const keys = csv(env.OPENAI_API_KEYS ?? env.OPENAI_API_KEY ?? '');
	if (keys.length && !urls.length) urls.push('https://api.openai.com/v1');
	if (urls.length) seeded['openai.api_base_urls'] = urls;
	if (keys.length) seeded['openai.api_keys'] = keys;
	return seeded;
}

type ConfigCache = { values: Map<string, unknown>; loadedAt: number };
const CACHE_TTL_MS = 5_000;
const caches = new WeakMap<D1Database, ConfigCache>();

async function load(env: Env): Promise<Map<string, unknown>> {
	const cached = caches.get(env.DB);
	if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.values;

	const values = new Map<string, unknown>();
	try {
		const { results } = await env.DB.prepare('SELECT key, value FROM config').all<{
			key: string;
			value: string;
		}>();
		for (const row of results ?? []) values.set(row.key, parseJSON(row.value, null));
	} catch {
		// Table missing (migrations not applied yet) — fall through to defaults.
	}
	caches.set(env.DB, { values, loadedAt: Date.now() });
	return values;
}

export function invalidateConfigCache(env: Env): void {
	caches.delete(env.DB);
}

export async function getConfig<T = unknown>(env: Env, key: string): Promise<T> {
	const stored = await load(env);
	if (stored.has(key)) return stored.get(key) as T;
	const seeded = envDefaults(env);
	if (key in seeded) return seeded[key] as T;
	return DEFAULT_CONFIG[key] as T;
}

export async function getConfigMany(env: Env, keys: string[]): Promise<Record<string, unknown>> {
	const stored = await load(env);
	const seeded = envDefaults(env);
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		out[key] = stored.has(key)
			? stored.get(key)
			: key in seeded
				? seeded[key]
				: DEFAULT_CONFIG[key];
	}
	return out;
}

export async function setConfig(env: Env, key: string, value: unknown): Promise<void> {
	await env.DB.prepare(
		'INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, ?3) ' +
			'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
	)
		.bind(key, JSON.stringify(value ?? null), now())
		.run();
	invalidateConfigCache(env);
}

export async function setConfigMany(env: Env, entries: Record<string, unknown>): Promise<void> {
	const timestamp = now();
	const statements = Object.entries(entries).map(([key, value]) =>
		env.DB.prepare(
			'INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, ?3) ' +
				'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
		).bind(key, JSON.stringify(value ?? null), timestamp)
	);
	if (statements.length) await env.DB.batch(statements);
	invalidateConfigCache(env);
}

/** Whole-config export used by the admin "export config" button. */
export async function exportConfig(env: Env): Promise<Record<string, unknown>> {
	const stored = await load(env);
	const seeded = envDefaults(env);
	const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...seeded };
	for (const [key, value] of stored) merged[key] = value;
	return merged;
}

export async function getUserPermissions(env: Env): Promise<Record<string, any>> {
	const stored = await getConfig<Record<string, any> | null>(env, 'user.permissions');
	return deepMerge(DEFAULT_USER_PERMISSIONS as Record<string, any>, stored ?? {});
}

/** JWT signing secret; falls back to a deterministic dev key with a loud warning. */
export function secretKey(env: Env): string {
	if (env.WEBUI_SECRET_KEY) return env.WEBUI_SECRET_KEY;
	console.warn(
		'[open-webui] WEBUI_SECRET_KEY is not set — using an insecure development key. ' +
			'Run `wrangler secret put WEBUI_SECRET_KEY` before deploying.'
	);
	return 'open-webui-development-secret-do-not-use-in-production';
}
