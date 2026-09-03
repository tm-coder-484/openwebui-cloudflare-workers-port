/**
 * Model registry.
 *
 * Base models come from (a) every configured OpenAI-compatible connection and
 * (b) Workers AI when the `AI` binding is present. Workspace models stored in
 * D1 are layered on top: a row with `base_model_id` is a preset, a row whose id
 * matches a base model overrides its metadata.
 */

import type { Env, SessionUser } from '../types';
import { getConfigMany } from './config';
import { grantsFor, listGrants, groupIdsFor, type AccessGrant } from './access';
import { now, parseJSON } from './util';

export interface ModelEntry {
	id: string;
	name: string;
	object: 'model';
	created: number;
	owned_by: string;
	urlIdx?: number;
	connection_type?: string;
	openai?: Record<string, unknown>;
	workers_ai?: Record<string, unknown>;
	info?: Record<string, unknown>;
	preset?: boolean;
	actions: unknown[];
	tags: { name: string }[];
	filters?: unknown[];
	pipe?: Record<string, unknown>;
	[key: string]: unknown;
}

/** Text-generation models exposed through the Workers AI binding. */
export const DEFAULT_WORKERS_AI_MODELS = [
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'@cf/meta/llama-3.1-8b-instruct',
	'@cf/meta/llama-3.2-3b-instruct',
	'@cf/meta/llama-3.2-1b-instruct',
	'@cf/mistral/mistral-7b-instruct-v0.1',
	'@cf/qwen/qwen1.5-14b-chat-awq',
	'@cf/google/gemma-7b-it'
];

export interface OpenAIConnection {
	url: string;
	key: string;
	idx: number;
	config: Record<string, any>;
	/** Marks the NVIDIA NIM connection so its models can be labelled and ranked. */
	provider?: 'nvidia' | 'openai';
}

/** Curated NIM catalogue used when the endpoint cannot be listed (self-hosted
 *  NIM containers serve a single model and some deployments block /models). */
/**
 * Shown only when an endpoint does not implement `/models` — the hosted NIM
 * catalogue does, so this is the self-hosted-microservice fallback. Ordered
 * strongest-first because the first entry becomes the picker's default.
 */
export const DEFAULT_NVIDIA_MODELS = [
	'deepseek-ai/deepseek-v4-pro',
	'moonshotai/kimi-k2.6',
	'z-ai/glm5',
	'qwen/qwen3-235b-a22b',
	'deepseek-ai/deepseek-v3.2',
	'openai/gpt-oss-120b',
	'nvidia/llama-3.3-nemotron-super-49b-v1.5',
	'meta/llama-4-maverick-17b-128e-instruct',
	'qwen/qwen3-coder-480b-a35b-instruct',
	'mistralai/mistral-large-3-675b-instruct-2512'
];

/**
 * Preference order for the model new chats open with.
 *
 * The catalogue turns over quickly, so nothing here is pinned: the default is
 * whichever of these the deployment's endpoint actually serves, and if it
 * serves none of them, whatever it lists first. A retired id costs nothing but
 * a step down the list.
 */
export const NVIDIA_PREFERRED_MODELS = [
	...DEFAULT_NVIDIA_MODELS,
	// Long-lived ids, kept last so an older or pinned NIM still resolves.
	'meta/llama-3.1-405b-instruct',
	'meta/llama-3.3-70b-instruct'
];

const DEFAULT_MODEL_CACHE_KEY = 'nvidia:default-model';
const DEFAULT_MODEL_TTL = 3600;

/**
 * The model to open new chats with, resolved against the live catalogue and
 * cached in KV so `/api/config` stays a cheap call.
 */
export async function defaultNvidiaModel(env: Env): Promise<string | null> {
	const cached = await env.CACHE?.get(DEFAULT_MODEL_CACHE_KEY).catch(() => null);
	if (cached) return cached;

	const connection = await nvidiaConnection(env);
	if (!connection) return null;

	const available = await fetchOpenAIModels(connection);
	const ids = new Set(available.map((model) => model.id));
	const chosen = NVIDIA_PREFERRED_MODELS.find((id) => ids.has(id)) ?? available[0]?.id ?? null;

	if (chosen) {
		await env.CACHE?.put(DEFAULT_MODEL_CACHE_KEY, chosen, {
			expirationTtl: DEFAULT_MODEL_TTL
		}).catch(() => {});
	}
	return chosen;
}

/**
 * The NVIDIA NIM connection.
 *
 * NIM speaks the OpenAI API, so it reuses the same request path; it is resolved
 * separately (and first) so its models stay the primary option in the picker.
 */
export async function nvidiaConnection(env: Env): Promise<OpenAIConnection | null> {
	const config = await getConfigMany(env, [
		'nvidia.enable',
		'nvidia.api_base_url',
		'nvidia.api_key',
		'nvidia.model_ids'
	]);
	if (config['nvidia.enable'] === false) return null;

	const url = String(config['nvidia.api_base_url'] ?? '').replace(/\/+$/, '');
	const key = String(config['nvidia.api_key'] ?? '');
	if (!url) return null;
	// The hosted catalogue needs a key; a self-hosted NIM container may not.
	if (!key && url.includes('api.nvidia.com')) return null;

	return {
		url,
		key,
		idx: -1,
		provider: 'nvidia',
		config: { model_ids: (config['nvidia.model_ids'] as string[]) ?? [] }
	};
}

export async function openaiConnections(env: Env): Promise<OpenAIConnection[]> {
	const config = await getConfigMany(env, [
		'openai.enable',
		'openai.api_base_urls',
		'openai.api_keys',
		'openai.api_configs'
	]);
	if (!config['openai.enable']) return [];
	const urls = (config['openai.api_base_urls'] as string[]) ?? [];
	const keys = (config['openai.api_keys'] as string[]) ?? [];
	const configs = (config['openai.api_configs'] as Record<string, any>) ?? {};
	return urls
		.map((url, idx) => ({
			url: url.replace(/\/+$/, ''),
			key: keys[idx] ?? '',
			idx,
			provider: 'openai' as const,
			config: configs[String(idx)] ?? configs[url] ?? {}
		}))
		.filter((connection) => connection.url && connection.config?.enable !== false);
}

async function fetchOpenAIModels(connection: OpenAIConnection): Promise<ModelEntry[]> {
	const isNvidia = connection.provider === 'nvidia';
	const ownedBy = isNvidia ? 'nvidia' : 'openai';
	const tags = isNvidia ? [{ name: 'NVIDIA NIM' }] : [];

	// An explicit model_ids list skips the network round-trip entirely.
	const manualIds: string[] = connection.config?.model_ids ?? [];
	if (manualIds.length) {
		return manualIds.map((id) => ({
			id,
			name: id,
			object: 'model' as const,
			created: now(),
			owned_by: ownedBy,
			openai: { id },
			urlIdx: connection.idx,
			connection_type: connection.config?.connection_type ?? 'external',
			actions: [],
			tags
		}));
	}

	try {
		const response = await fetch(`${connection.url}/models`, {
			headers: {
				'Content-Type': 'application/json',
				...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {})
			},
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) {
			console.warn(`[open-webui] ${connection.url}/models responded ${response.status}`);
			return isNvidia ? nvidiaFallbackModels(connection) : [];
		}
		const payload = (await response.json()) as { data?: any[] } | any[];
		const list = Array.isArray(payload) ? payload : (payload?.data ?? []);
		return list
			.filter((model: any) => model?.id)
			.map((model: any) => ({
				...model,
				id: String(model.id),
				name: model.name ?? model.id,
				object: 'model' as const,
				created: model.created ?? now(),
				owned_by: ownedBy,
				openai: model,
				urlIdx: connection.idx,
				connection_type: connection.config?.connection_type ?? 'external',
				actions: [],
				tags
			}));
	} catch (error) {
		console.warn(`[open-webui] failed to list models from ${connection.url}:`, error);
		return isNvidia ? nvidiaFallbackModels(connection) : [];
	}
}

function nvidiaFallbackModels(connection: OpenAIConnection): ModelEntry[] {
	return DEFAULT_NVIDIA_MODELS.map((id) => ({
		id,
		name: id,
		object: 'model' as const,
		created: 0,
		owned_by: 'nvidia',
		openai: { id },
		urlIdx: connection.idx,
		connection_type: 'external',
		actions: [],
		tags: [{ name: 'NVIDIA NIM' }]
	}));
}

function workersAIModels(env: Env, configured: string[]): ModelEntry[] {
	if (!env.AI) return [];
	const ids = configured.length ? configured : DEFAULT_WORKERS_AI_MODELS;
	return ids.map((id) => ({
		id,
		name: id.split('/').pop() ?? id,
		object: 'model' as const,
		created: 0,
		owned_by: 'cloudflare',
		connection_type: 'local',
		workers_ai: { id },
		actions: [],
		tags: [{ name: 'Workers AI' }]
	}));
}

export interface ModelRow {
	id: string;
	user_id: string;
	base_model_id: string | null;
	name: string;
	params: string | null;
	meta: string | null;
	is_active: number;
	updated_at: number;
	created_at: number;
}

export function serializeModelRow(row: ModelRow, grants: AccessGrant[] = []) {
	return {
		id: row.id,
		user_id: row.user_id,
		base_model_id: row.base_model_id,
		name: row.name,
		params: parseJSON<Record<string, unknown>>(row.params, {}),
		meta: parseJSON<Record<string, unknown>>(row.meta, {}),
		access_grants: grants.map((grant) => ({
			id: grant.id,
			principal_type: grant.principal_type,
			principal_id: grant.principal_id,
			permission: grant.permission
		})),
		is_active: Boolean(row.is_active),
		updated_at: row.updated_at,
		created_at: row.created_at
	};
}

export async function listModelRows(env: Env): Promise<ModelRow[]> {
	const { results } = await env.DB.prepare('SELECT * FROM model').all<ModelRow>();
	return results ?? [];
}

export async function getModelRow(env: Env, id: string): Promise<ModelRow | null> {
	return env.DB.prepare('SELECT * FROM model WHERE id = ?1').bind(id).first<ModelRow>();
}

/** Base models only — no workspace overlay. Used by the admin models page. */
export async function getBaseModels(env: Env): Promise<ModelEntry[]> {
	const config = await getConfigMany(env, ['workers_ai.enable', 'workers_ai.models']);
	const nvidia = await nvidiaConnection(env);
	const connections = await openaiConnections(env);

	// NVIDIA NIM is listed first so it is the default option in the picker.
	const [nvidiaModels, ...fetched] = await Promise.all([
		nvidia ? fetchOpenAIModels(nvidia) : Promise.resolve([]),
		...connections.map(fetchOpenAIModels)
	]);

	const models: ModelEntry[] = [...nvidiaModels, ...fetched.flat()];
	if (config['workers_ai.enable'] !== false) {
		models.push(...workersAIModels(env, (config['workers_ai.models'] as string[]) ?? []));
	}
	return models;
}

/** Full model list: base models + workspace overrides/presets. */
export async function getAllModels(env: Env): Promise<ModelEntry[]> {
	const base = await getBaseModels(env);
	const byId = new Map<string, ModelEntry>(base.map((model) => [model.id, model]));

	const rows = await listModelRows(env);
	const grantMap = await listGrants(
		env,
		'model',
		rows.map((row) => row.id)
	);

	for (const row of rows) {
		if (!row.is_active) {
			byId.delete(row.id);
			continue;
		}
		const info = serializeModelRow(row, grantMap.get(row.id) ?? []);
		const parent = row.base_model_id ? byId.get(row.base_model_id) : byId.get(row.id);
		const meta = info.meta as Record<string, any>;

		byId.set(row.id, {
			...(parent ?? {}),
			id: row.id,
			name: row.name,
			object: 'model',
			created: row.created_at,
			owned_by: parent?.owned_by ?? 'openai',
			info,
			preset: true,
			actions: [],
			tags: Array.isArray(meta?.tags) ? meta.tags : [],
			...(row.base_model_id ? { base_model_id: row.base_model_id } : {})
		} as ModelEntry);
	}

	return [...byId.values()];
}

/** Applies workspace access grants; admins see everything. */
export async function filterModelsForUser(
	env: Env,
	models: ModelEntry[],
	user: SessionUser
): Promise<ModelEntry[]> {
	if (user.role === 'admin') return models;
	const groupIds = new Set(await groupIdsFor(env, user.id));
	return models.filter((model) => {
		const info = model.info as { user_id?: string; access_grants?: AccessGrant[] } | undefined;
		// Base models with no workspace row are visible to everyone.
		if (!info) return true;
		if (info.user_id === user.id) return true;
		const grants = info.access_grants ?? [];
		if (!grants.length) return false;
		return grants.some((grant) => {
			if (grant.principal_type === 'user') {
				return grant.principal_id === user.id || grant.principal_id === '*';
			}
			return grant.principal_type === 'group' && groupIds.has(grant.principal_id);
		});
	});
}

/** Resolve the upstream target for a model id, following presets one level. */
export interface ResolvedModel {
	id: string;
	upstreamId: string;
	entry: ModelEntry;
	params: Record<string, any>;
	systemPrompt?: string;
	connection?: OpenAIConnection;
	workersAI: boolean;
}

export async function resolveModel(env: Env, modelId: string): Promise<ResolvedModel | null> {
	const models = await getAllModels(env);
	const entry = models.find((model) => model.id === modelId);
	if (!entry) return null;

	let params: Record<string, any> = {};
	let systemPrompt: string | undefined;
	let target = entry;

	const info = entry.info as
		| { params?: Record<string, any>; meta?: Record<string, any> }
		| undefined;
	if (info?.params) {
		params = { ...info.params };
		if (typeof params.system === 'string' && params.system.trim()) systemPrompt = params.system;
		delete params.system;
	}

	const baseId = (entry as any).base_model_id as string | undefined;
	if (baseId) {
		const base = models.find((model) => model.id === baseId);
		if (base) target = base;
	}

	const upstreamId = (target.openai as any)?.id ?? (target.workers_ai as any)?.id ?? target.id;

	if (target.workers_ai) {
		return { id: modelId, upstreamId, entry: target, params, systemPrompt, workersAI: true };
	}

	// owned_by identifies the provider; NIM models resolve to the NIM connection.
	const nvidia = await nvidiaConnection(env);
	const connections = await openaiConnections(env);
	const connection =
		(target.owned_by === 'nvidia' ? nvidia : null) ??
		connections.find((item) => item.idx === target.urlIdx) ??
		connections[0] ??
		nvidia ??
		undefined;
	return {
		id: modelId,
		upstreamId,
		entry: target,
		params,
		systemPrompt,
		connection,
		workersAI: false
	};
}

export async function modelGrants(env: Env, modelId: string) {
	return grantsFor(env, 'model', modelId);
}
