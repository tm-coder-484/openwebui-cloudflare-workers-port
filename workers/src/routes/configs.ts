/** `/api/v1/configs` — admin settings that live in the config table. */

import { Hono } from 'hono';
import type { AppContext, Env } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { exportConfig, getConfig, getConfigMany, setConfig, setConfigMany } from '../lib/config';
import { bad } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const CONNECTIONS_KEYS: Record<string, string> = {
	ENABLE_NVIDIA_API: 'nvidia.enable',
	NVIDIA_API_BASE_URL: 'nvidia.api_base_url',
	NVIDIA_API_KEY: 'nvidia.api_key',
	NVIDIA_MODEL_IDS: 'nvidia.model_ids',
	ENABLE_DIRECT_CONNECTIONS: 'direct.enable',
	ENABLE_BASE_MODELS_CACHE: 'models.base_models_cache',
	ENABLE_OPENAI_API: 'openai.enable',
	OPENAI_API_BASE_URLS: 'openai.api_base_urls',
	OPENAI_API_KEYS: 'openai.api_keys',
	OPENAI_API_CONFIGS: 'openai.api_configs',
	ENABLE_OLLAMA_API: 'ollama.enable',
	OLLAMA_BASE_URLS: 'ollama.base_urls',
	OLLAMA_API_CONFIGS: 'ollama.api_configs',
	// Ollama Cloud: one base URL, a pool of keys.
	OLLAMA_BASE_URL: 'ollama.base_url',
	OLLAMA_API_KEYS: 'ollama.api_keys',
	ENABLE_WORKERS_AI: 'workers_ai.enable',
	WORKERS_AI_MODELS: 'workers_ai.models'
};

const MODELS_KEYS: Record<string, string> = {
	DEFAULT_MODELS: 'ui.default_models',
	DEFAULT_PINNED_MODELS: 'ui.default_pinned_models',
	MODEL_ORDER_LIST: 'ui.model_order_list',
	DEFAULT_MODEL_METADATA: 'models.default_metadata',
	DEFAULT_MODEL_PARAMS: 'models.default_params'
};

const CODE_EXECUTION_KEYS: Record<string, string> = {
	ENABLE_CODE_EXECUTION: 'code_execution.enable',
	CODE_EXECUTION_ENGINE: 'code_execution.engine',
	ENABLE_CODE_INTERPRETER: 'code_interpreter.enable',
	CODE_INTERPRETER_ENGINE: 'code_interpreter.engine',
	CODE_INTERPRETER_PROMPT_TEMPLATE: 'code_interpreter.prompt_template'
};

async function values(env: Env, keys: Record<string, string>) {
	const config = await getConfigMany(env, Object.values(keys));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(keys)) out[field] = config[key] ?? null;
	return out;
}

async function apply(env: Env, keys: Record<string, string>, body: Record<string, unknown>) {
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(keys)) if (field in body) updates[key] = body[field];
	await setConfigMany(env, updates);
	return values(env, keys);
}

const group = (path: string, keys: Record<string, string>) => {
	app.get(path, async (c) => {
		adminUser(c);
		return c.json(await values(c.env, keys));
	});
	app.post(path, async (c) => {
		adminUser(c);
		return c.json(await apply(c.env, keys, (await c.req.json()) as Record<string, unknown>));
	});
};

group('/connections', CONNECTIONS_KEYS);
group('/models', MODELS_KEYS);
group('/code_execution', CODE_EXECUTION_KEYS);

app.get('/models/defaults', async (c) => {
	adminUser(c);
	return c.json(await values(c.env, MODELS_KEYS));
});

app.get('/banners', async (c) => {
	verifiedUser(c);
	return c.json(await getConfig(c.env, 'ui.banners'));
});

app.post('/banners', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { banners?: unknown[] };
	await setConfig(c.env, 'ui.banners', body.banners ?? []);
	return c.json(await getConfig(c.env, 'ui.banners'));
});

app.get('/suggestions', async (c) => {
	verifiedUser(c);
	return c.json(await getConfig(c.env, 'ui.prompt_suggestions'));
});

app.post('/suggestions', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { suggestions?: unknown[] };
	await setConfig(c.env, 'ui.prompt_suggestions', body.suggestions ?? []);
	return c.json(await getConfig(c.env, 'ui.prompt_suggestions'));
});

app.get('/tool_servers', async (c) => {
	adminUser(c);
	return c.json({ TOOL_SERVER_CONNECTIONS: await getConfig(c.env, 'tool_servers') });
});

app.post('/tool_servers', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { TOOL_SERVER_CONNECTIONS?: unknown[] };
	await setConfig(c.env, 'tool_servers', body.TOOL_SERVER_CONNECTIONS ?? []);
	return c.json({ TOOL_SERVER_CONNECTIONS: await getConfig(c.env, 'tool_servers') });
});

app.post('/tool_servers/verify', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as {
		url?: string;
		path?: string;
		auth_type?: string;
		key?: string;
	};
	if (!body.url) throw bad('A server URL is required');
	const target = `${body.url.replace(/\/+$/, '')}/${(body.path ?? 'openapi.json').replace(/^\/+/, '')}`;
	const response = await fetch(target, {
		headers: body.key ? { Authorization: `Bearer ${body.key}` } : {},
		signal: AbortSignal.timeout(10_000)
	});
	if (!response.ok) throw bad(`Server responded with ${response.status}`);
	return c.json(await response.json());
});

app.get('/terminal_servers', async (c) => {
	adminUser(c);
	return c.json({ TERMINAL_SERVER_CONNECTIONS: [] });
});

app.get('/subagents', async (c) => {
	adminUser(c);
	return c.json({ ENABLE_SUBAGENTS: false });
});

/**
 * Tool settings.
 *
 * These had a default and no way to change it — no key map, no environment
 * variable, no screen. Both routes exist so a deployment can turn a tool group
 * off or lengthen a tool chain without a redeploy.
 */
const TOOL_KEYS: Record<string, string> = {
	TOOLS_MAX_ROUNDS: 'tools.max_rounds',
	ENABLE_MEMORY_TOOLS: 'tools.memory.enable',
	ENABLE_FILE_TOOLS: 'tools.files.enable',
	ENABLE_SEARCH_TOOLS: 'tools.search.enable'
};

app.get('/tools', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, Object.values(TOOL_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(TOOL_KEYS)) out[field] = config[key] ?? null;
	return c.json(out);
});

app.post('/tools', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(TOOL_KEYS)) {
		if (field in body) updates[key] = body[field];
	}
	await setConfigMany(c.env, updates);
	const config = await getConfigMany(c.env, Object.values(TOOL_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(TOOL_KEYS)) out[field] = config[key] ?? null;
	return c.json(out);
});

app.get('/export', async (c) => {
	adminUser(c);
	return c.json(await exportConfig(c.env));
});

app.post('/import', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { config?: Record<string, unknown> };
	await setConfigMany(c.env, body.config ?? {});
	return c.json(await exportConfig(c.env));
});

app.post('/url/verify', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { url?: string; key?: string };
	if (!body.url) throw bad('A URL is required');
	const response = await fetch(`${body.url.replace(/\/+$/, '')}/models`, {
		headers: body.key ? { Authorization: `Bearer ${body.key}` } : {},
		signal: AbortSignal.timeout(10_000)
	});
	if (!response.ok) throw bad(`Connection failed with status ${response.status}`);
	return c.json(await response.json());
});

export default app;
