/**
 * Chat completion engine.
 *
 * Open WebUI's frontend does NOT read the HTTP response body of
 * `/api/chat/completions` — it expects `{status, task_ids, chat_id}` and then
 * consumes the stream over the Socket.IO `events` channel. So this module runs
 * the upstream request in the background (inside the Durable Object that owns
 * the client's socket) and emits `chat:completion` events as tokens arrive.
 */

import type { Env } from '../types';
import { getConfig, getConfigMany } from './config';
import { resolveModel, type ResolvedModel } from './models';
import { createMessagesList, getChat, setChatTags, setChatTitle, upsertMessage } from './chats';
import type { ChatContent, ChatMessage } from './chats';
import {
	FOLLOW_UP_GENERATION_PROMPT,
	TAGS_GENERATION_PROMPT,
	TITLE_GENERATION_PROMPT,
	extractJSON,
	renderMessages
} from './prompts';
import { search } from './retrieval';
import { HttpError, now, toJSON, uuid } from './util';

/** OpenAI sampling parameters we forward; everything else is Open WebUI's own. */
const FORWARDED_PARAMS = new Set([
	'temperature',
	'top_p',
	'top_k',
	'min_p',
	'max_tokens',
	'max_completion_tokens',
	'frequency_penalty',
	'presence_penalty',
	'repeat_penalty',
	'seed',
	'stop',
	'logit_bias',
	'response_format',
	'reasoning_effort',
	'logprobs',
	'top_logprobs',
	'n',
	'user'
]);

/** Fields the frontend adds that must never reach an OpenAI-compatible API. */
const STRIPPED_FIELDS = new Set([
	'params',
	'files',
	'filter_ids',
	'tool_ids',
	'skill_ids',
	'terminal_id',
	'tool_servers',
	'features',
	'variables',
	'chat_variables',
	'model_item',
	'session_id',
	'chat_id',
	'folder_id',
	'id',
	'message_ids',
	'parent_id',
	'user_message',
	'parent_message',
	'regeneration_prompt',
	'assistant_message_id',
	'background_tasks',
	'metadata',
	'new_chat'
]);

export interface CompletionMessage {
	role: string;
	content: unknown;
	[key: string]: unknown;
}

export interface UpstreamRequest {
	kind: 'openai' | 'workers-ai';
	url?: string;
	headers?: Record<string, string>;
	model: string;
	payload: Record<string, unknown>;
}

/** Normalizes the frontend body into a provider-ready request. */
export function buildUpstreamRequest(
	resolved: ResolvedModel,
	body: Record<string, any>,
	options: { stream?: boolean } = {}
): UpstreamRequest {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (STRIPPED_FIELDS.has(key)) continue;
		if (value === undefined) continue;
		payload[key] = value;
	}

	const params = (body.params ?? {}) as Record<string, unknown>;
	for (const [key, value] of Object.entries({ ...resolved.params, ...params })) {
		if (value === undefined || value === null) continue;
		if (!FORWARDED_PARAMS.has(key)) continue;
		if (key === 'stop' && Array.isArray(value) && value.length === 0) continue;
		payload[key] = value;
	}

	let messages = ((body.messages ?? []) as CompletionMessage[]).map((message) => ({
		role: message.role,
		content: message.content,
		...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
		...(message.name ? { name: message.name } : {})
	}));

	if (resolved.systemPrompt) {
		const rendered = renderSystemPrompt(resolved.systemPrompt, body.variables ?? {});
		const first = messages[0];
		messages =
			first?.role === 'system'
				? [
						{ role: 'system', content: `${rendered}\n\n${String(first.content ?? '')}` },
						...messages.slice(1)
					]
				: [{ role: 'system', content: rendered }, ...messages];
	}

	payload.messages = messages;
	payload.model = resolved.upstreamId;
	payload.stream = options.stream ?? Boolean(body.stream);

	if (payload.stream && resolved.workersAI !== true) {
		payload.stream_options = { include_usage: true };
	}

	if (resolved.workersAI) {
		return { kind: 'workers-ai', model: resolved.upstreamId, payload };
	}

	const connection = resolved.connection;
	if (!connection) {
		throw new HttpError(
			400,
			'No OpenAI-compatible connection is configured for this model. ' +
				'Add one under Admin Settings → Connections, or enable Workers AI.'
		);
	}
	return {
		kind: 'openai',
		url: `${connection.url}/chat/completions`,
		headers: {
			'Content-Type': 'application/json',
			...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {}),
			...(connection.config?.headers ?? {})
		},
		model: resolved.upstreamId,
		payload
	};
}

/** `{{USER_NAME}}`-style placeholders the frontend sends in `variables`. */
export function renderSystemPrompt(template: string, variables: Record<string, unknown>): string {
	let output = template;
	for (const [key, value] of Object.entries(variables ?? {})) {
		output = output.replaceAll(`{{${key}}}`, String(value ?? ''));
	}
	const date = new Date();
	output = output
		.replaceAll('{{CURRENT_DATE}}', date.toISOString().slice(0, 10))
		.replaceAll('{{CURRENT_TIME}}', date.toISOString().slice(11, 19))
		.replaceAll('{{CURRENT_DATETIME}}', date.toISOString());
	return output;
}

export interface NormalizedChunk {
	content?: string;
	reasoning?: string;
	usage?: Record<string, unknown>;
	finishReason?: string | null;
	raw?: unknown;
}

/** Reads an SSE body and yields decoded `data:` payloads. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index: number;
			// Events are separated by a blank line; tolerate \r\n as well.
			while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
				const rawEvent = buffer.slice(0, index);
				buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2));
				for (const line of rawEvent.split(/\r?\n/)) {
					if (!line.startsWith('data:')) continue;
					yield line.slice(5).trim();
				}
			}
		}
		if (buffer.trim().startsWith('data:')) yield buffer.trim().slice(5).trim();
	} finally {
		reader.releaseLock();
	}
}

/** Maps both OpenAI chunks and Workers AI chunks onto one shape. */
export function normalizeChunk(payload: any): NormalizedChunk | null {
	if (!payload || typeof payload !== 'object') return null;

	if (Array.isArray(payload.choices)) {
		const choice = payload.choices[0] ?? {};
		const delta = choice.delta ?? {};
		return {
			content: delta.content ?? choice.message?.content ?? undefined,
			reasoning: delta.reasoning_content ?? delta.reasoning ?? undefined,
			usage: payload.usage ?? undefined,
			finishReason: choice.finish_reason ?? null,
			raw: payload
		};
	}

	// Workers AI text-generation stream: { response: "token", usage?: {...} }
	if (typeof payload.response === 'string') {
		return {
			content: payload.response,
			usage: payload.usage ?? undefined,
			finishReason: null,
			raw: payload
		};
	}
	return null;
}

/**
 * Rebuilds the conversation from the stored chat.
 *
 * The frontend only sends `messages` for temporary chats — for saved ones it
 * sends the system prompt and expects the server to load the history from the
 * database (see "persisted chats load from DB" in Chat.svelte). Without this,
 * every request would reach the model with an empty conversation.
 */
export async function messagesFromChat(
	env: Env,
	chatId: string,
	assistantMessageId: string
): Promise<CompletionMessage[]> {
	const row = await getChat(env, chatId);
	if (!row) return [];
	const content = JSON.parse(row.chat || '{}') as ChatContent;
	const history = content.history;
	if (!history?.messages) return [];

	const assistant = history.messages[assistantMessageId];
	// Walk from the assistant placeholder's parent so the in-flight (empty)
	// assistant turn is never sent back to the model.
	const leafId = assistant?.parentId ?? history.currentId ?? null;

	return createMessagesList(history, leafId)
		.map(toCompletionMessage)
		.filter((message) => message.role === 'user' || hasContent(message));
}

function hasContent(message: CompletionMessage): boolean {
	if (typeof message.content === 'string') return message.content.trim().length > 0;
	return Array.isArray(message.content) && message.content.length > 0;
}

/** Maps a stored chat message onto the OpenAI message shape, images included. */
function toCompletionMessage(message: ChatMessage): CompletionMessage {
	const images = ((message.files as any[]) ?? []).filter(
		(file) => file?.type === 'image' || String(file?.content_type ?? '').startsWith('image/')
	);
	const text = String((message as any)?.merged?.content ?? message.content ?? '');

	if (message.role === 'user' && images.length) {
		return {
			role: 'user',
			content: [
				{ type: 'text', text },
				...images.map((file) => ({ type: 'image_url', image_url: { url: file.url } }))
			]
		};
	}
	return { role: message.role, content: text };
}

interface AttachedFile {
	type?: string;
	id?: string;
	name?: string;
	collection_name?: string;
	content?: string;
	file?: { id?: string; filename?: string; data?: { content?: string } };
	[key: string]: unknown;
}

export interface FileContext {
	context: string;
	sources: Record<string, unknown>[];
}

/**
 * Retrieval for files and knowledge bases attached to the request.
 *
 * Mirrors upstream's `<source id="n" name="...">` context block so models (and
 * the citation UI) see the same structure, and returns the source payloads the
 * frontend renders under the answer.
 */
export async function buildFileContext(
	env: Env,
	files: AttachedFile[],
	query: string
): Promise<FileContext> {
	if (!files?.length || !query.trim()) return { context: '', sources: [] };

	const fileIds: string[] = [];
	const knowledgeIds: string[] = [];
	const inline: { name: string; content: string }[] = [];

	for (const file of files) {
		const type = file.type ?? 'file';
		if (type === 'collection' || type === 'knowledge') {
			const id = file.id ?? file.collection_name;
			if (id) knowledgeIds.push(id);
		} else if (type === 'file') {
			const id = file.id ?? file.file?.id;
			if (id) fileIds.push(id);
			// Notes, pasted text and web pages arrive with their content inline.
			const content = file.content ?? file.file?.data?.content;
			if (!id && typeof content === 'string' && content.trim()) {
				inline.push({ name: String(file.name ?? 'attachment'), content });
			}
		} else if (typeof file.content === 'string' && file.content.trim()) {
			inline.push({ name: String(file.name ?? type), content: file.content });
		}
	}

	const chunks =
		fileIds.length || knowledgeIds.length
			? await search(env, query, { fileIds, knowledgeIds })
			: [];

	const parts: string[] = [];
	const sources: Record<string, unknown>[] = [];
	let index = 0;

	const nameFor = (fileId: string | undefined) =>
		files.find((file) => (file.id ?? file.file?.id) === fileId)?.name ??
		files.find((file) => (file.id ?? file.file?.id) === fileId)?.file?.filename ??
		'attachment';

	for (const chunk of chunks) {
		index += 1;
		const name = nameFor(chunk.file_id);
		parts.push(`<source id="${index}" name="${name}">${chunk.content}</source>`);
		sources.push({
			source: { id: chunk.file_id ?? String(index), name },
			document: [chunk.content],
			metadata: [{ source: chunk.file_id ?? name, name, file_id: chunk.file_id }],
			distances: [Number((1 - chunk.score).toFixed(4))]
		});
	}

	for (const item of inline) {
		index += 1;
		parts.push(`<source id="${index}" name="${item.name}">${item.content}</source>`);
		sources.push({
			source: { id: item.name, name: item.name },
			document: [item.content],
			metadata: [{ source: item.name, name: item.name }]
		});
	}

	return { context: parts.join('\n'), sources };
}

/** Text of the last user turn — the retrieval query. */
export function lastUserText(messages: CompletionMessage[]): string {
	const last = [...messages].reverse().find((message) => message.role === 'user');
	if (!last) return '';
	if (typeof last.content === 'string') return last.content;
	if (Array.isArray(last.content)) {
		return (last.content as any[])
			.map((part) => (typeof part?.text === 'string' ? part.text : ''))
			.join(' ')
			.trim();
	}
	return '';
}

export type EventEmitter = (event: Record<string, unknown>) => void | Promise<void>;

export interface CompletionJob {
	userId: string;
	chatId: string;
	messageId: string;
	modelId: string;
	taskId: string;
	saveToChat: boolean;
	backgroundTasks: Record<string, boolean> | null;
	body: Record<string, any>;
}

/** Executes one completion, streaming `chat:completion` events as it goes. */
export async function runCompletion(
	env: Env,
	job: CompletionJob,
	emit: EventEmitter
): Promise<void> {
	const emitCompletion = (data: Record<string, unknown>) =>
		emit({
			chat_id: job.chatId,
			message_id: job.messageId,
			data: { type: 'chat:completion', data }
		});

	let content = '';
	let usage: Record<string, unknown> | undefined;

	try {
		const resolved = await resolveModel(env, job.modelId);
		if (!resolved) throw new HttpError(404, `Model '${job.modelId}' was not found.`);

		const stream = job.body.stream !== false;

		// Saved chats arrive with only the system prompt; load the rest from D1.
		const requestMessages = (job.body.messages ?? []) as CompletionMessage[];
		if (job.saveToChat && !requestMessages.some((message) => message.role !== 'system')) {
			const history = await messagesFromChat(env, job.chatId, job.messageId);
			job.body = { ...job.body, messages: [...requestMessages, ...history] };
		}

		// Attached files and knowledge bases become a retrieved context block.
		const attached = (job.body.files ?? []) as AttachedFile[];
		if (attached.length) {
			const messages = (job.body.messages ?? []) as CompletionMessage[];
			const { context, sources } = await buildFileContext(env, attached, lastUserText(messages));
			if (context) {
				job.body = {
					...job.body,
					messages: [
						{
							role: 'system',
							content:
								'Use the sources below to answer the user. Cite them inline as [id] when ' +
								`you rely on them, and say so plainly if they do not contain the answer.\n\n${context}`
						},
						...messages
					]
				};
				for (const source of sources) {
					await emit({
						chat_id: job.chatId,
						message_id: job.messageId,
						data: { type: 'source', data: source }
					});
				}
				if (job.saveToChat) {
					await upsertMessage(env, job.chatId, job.messageId, { sources });
				}
			}
		}

		const request = buildUpstreamRequest(resolved, job.body, { stream });

		if (stream) {
			for await (const chunk of streamUpstream(env, request)) {
				if (chunk.usage) usage = chunk.usage;
				if (chunk.content) {
					content += chunk.content;
					await emitCompletion({
						id: job.messageId,
						choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
						done: false
					});
				}
			}
		} else {
			const result = await callUpstream(env, request);
			content = result.content;
			usage = result.usage;
			if (content) {
				await emitCompletion({
					id: job.messageId,
					choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
					done: false
				});
			}
		}

		if (job.saveToChat) {
			await upsertMessage(env, job.chatId, job.messageId, {
				content,
				done: true,
				model: job.modelId,
				...(usage ? { usage } : {})
			});
			await recordTurn(env, job, content, usage);
		}

		await emitCompletion({ id: job.messageId, done: true, content, ...(usage ? { usage } : {}) });
		await emit({
			chat_id: job.chatId,
			message_id: job.messageId,
			data: { type: 'chat:active', data: { active: false } }
		});

		await runBackgroundTasks(env, job, content, emit);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[open-webui] completion failed:', message);
		if (job.saveToChat) {
			await upsertMessage(env, job.chatId, job.messageId, {
				content,
				done: true,
				error: { content: message }
			}).catch(() => {});
		}
		await emit({
			chat_id: job.chatId,
			message_id: job.messageId,
			data: { type: 'chat:message:error', data: { error: { content: message } } }
		});
		await emitCompletion({ id: job.messageId, done: true, error: { message } });
		await emit({
			chat_id: job.chatId,
			message_id: job.messageId,
			data: { type: 'chat:tasks:cancel' }
		});
		await emit({
			chat_id: job.chatId,
			message_id: job.messageId,
			data: { type: 'chat:active', data: { active: false } }
		});
	}
}

/** Mirrors the finished turn into `chat_message` for the analytics dashboards. */
async function recordTurn(
	env: Env,
	job: CompletionJob,
	content: string,
	usage: Record<string, unknown> | undefined
): Promise<void> {
	const timestamp = now();
	const userMessage = job.body.user_message as { id?: string; content?: string } | undefined;
	const statements = [];

	if (userMessage?.id) {
		statements.push(
			env.DB.prepare(
				`INSERT OR REPLACE INTO chat_message
					(id, chat_id, user_id, role, parent_id, model_id, content, meta, usage, created_at, updated_at)
				 VALUES (?1, ?2, ?3, 'user', NULL, NULL, ?4, NULL, NULL, ?5, ?5)`
			).bind(userMessage.id, job.chatId, job.userId, String(userMessage.content ?? ''), timestamp)
		);
	}
	statements.push(
		env.DB.prepare(
			`INSERT OR REPLACE INTO chat_message
				(id, chat_id, user_id, role, parent_id, model_id, content, meta, usage, created_at, updated_at)
			 VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6, NULL, ?7, ?8, ?8)`
		).bind(
			job.messageId,
			job.chatId,
			job.userId,
			userMessage?.id ?? null,
			job.modelId,
			content,
			toJSON(usage ?? null),
			timestamp
		)
	);

	await env.DB.batch(statements).catch((error) =>
		console.warn('[open-webui] failed to record chat_message rows:', error)
	);
}

async function* streamUpstream(
	env: Env,
	request: UpstreamRequest
): AsyncGenerator<NormalizedChunk> {
	let body: ReadableStream<Uint8Array> | null = null;

	if (request.kind === 'workers-ai') {
		if (!env.AI) throw new HttpError(400, 'Workers AI binding is not configured.');
		const result = (await env.AI.run(
			request.model as any,
			{
				messages: request.payload.messages,
				stream: true,
				...(request.payload.max_tokens ? { max_tokens: request.payload.max_tokens } : {}),
				...(request.payload.temperature !== undefined
					? { temperature: request.payload.temperature }
					: {})
			} as any
		)) as unknown as ReadableStream<Uint8Array>;
		body = result;
	} else {
		const response = await fetch(request.url!, {
			method: 'POST',
			headers: request.headers,
			body: JSON.stringify(request.payload)
		});
		if (!response.ok) throw new HttpError(response.status, await errorDetail(response));
		body = response.body;
	}

	if (!body) throw new HttpError(502, 'Upstream returned an empty response body.');

	for await (const data of readSSE(body)) {
		if (!data || data === '[DONE]') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			continue;
		}
		const chunk = normalizeChunk(parsed);
		if (chunk) yield chunk;
	}
}

async function callUpstream(
	env: Env,
	request: UpstreamRequest
): Promise<{ content: string; usage?: Record<string, unknown> }> {
	if (request.kind === 'workers-ai') {
		if (!env.AI) throw new HttpError(400, 'Workers AI binding is not configured.');
		const result = (await env.AI.run(
			request.model as any,
			{
				messages: request.payload.messages,
				...(request.payload.max_tokens ? { max_tokens: request.payload.max_tokens } : {})
			} as any
		)) as any;
		return {
			content: result?.response ?? result?.choices?.[0]?.message?.content ?? '',
			usage: result?.usage
		};
	}

	const response = await fetch(request.url!, {
		method: 'POST',
		headers: request.headers,
		body: JSON.stringify({ ...request.payload, stream: false })
	});
	if (!response.ok) throw new HttpError(response.status, await errorDetail(response));
	const payload = (await response.json()) as any;
	return {
		content: payload?.choices?.[0]?.message?.content ?? '',
		usage: payload?.usage
	};
}

async function errorDetail(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const parsed = JSON.parse(text);
		return parsed?.error?.message ?? parsed?.detail ?? text.slice(0, 500);
	} catch {
		return text.slice(0, 500) || `Upstream error ${response.status}`;
	}
}

/** One-shot text generation used by the task endpoints (title, tags, …). */
export async function generateText(
	env: Env,
	modelId: string,
	messages: CompletionMessage[],
	options: { maxTokens?: number } = {}
): Promise<string> {
	const resolved = await resolveModel(env, modelId);
	if (!resolved) throw new HttpError(404, `Model '${modelId}' was not found.`);
	const request = buildUpstreamRequest(
		resolved,
		{ messages, stream: false, params: { max_tokens: options.maxTokens ?? 1000 } },
		{ stream: false }
	);
	const { content } = await callUpstream(env, request);
	return content;
}

/** Picks the task model: explicit config, else the model that answered. */
export async function taskModelId(env: Env, fallbackModelId: string): Promise<string> {
	const configured = await getConfig<string | null>(env, 'task.model');
	return configured || fallbackModelId;
}

async function runBackgroundTasks(
	env: Env,
	job: CompletionJob,
	content: string,
	emit: EventEmitter
): Promise<void> {
	const tasks = job.backgroundTasks;
	if (!tasks || !job.saveToChat) return;

	const config = await getConfigMany(env, [
		'task.title.enable',
		'task.tags.enable',
		'task.follow_up.enable'
	]);

	const history: CompletionMessage[] = [
		...((job.body.messages ?? []) as CompletionMessage[]),
		{ role: 'assistant', content }
	];
	const model = await taskModelId(env, job.modelId);

	if (tasks.title_generation && config['task.title.enable'] !== false) {
		try {
			const prompt = TITLE_GENERATION_PROMPT.replace('{{MESSAGES}}', renderMessages(history, 2));
			const raw = await generateText(env, model, [{ role: 'user', content: prompt }], {
				maxTokens: 100
			});
			const title = extractJSON<{ title?: string }>(raw)?.title?.trim();
			if (title) {
				await setChatTitle(env, job.chatId, title);
				await emit({
					chat_id: job.chatId,
					message_id: job.messageId,
					data: { type: 'chat:title', data: title }
				});
			}
		} catch (error) {
			console.warn('[open-webui] title generation failed:', error);
		}
	}

	if (tasks.tags_generation && config['task.tags.enable'] !== false) {
		try {
			const prompt = TAGS_GENERATION_PROMPT.replace('{{MESSAGES}}', renderMessages(history, 6));
			const raw = await generateText(env, model, [{ role: 'user', content: prompt }], {
				maxTokens: 200
			});
			const tags = extractJSON<{ tags?: string[] }>(raw)?.tags;
			if (Array.isArray(tags) && tags.length) {
				await setChatTags(env, job.chatId, job.userId, tags.slice(0, 6).map(String));
				await emit({
					chat_id: job.chatId,
					message_id: job.messageId,
					data: { type: 'chat:tags', data: tags }
				});
			}
		} catch (error) {
			console.warn('[open-webui] tag generation failed:', error);
		}
	}

	if (tasks.follow_up_generation && config['task.follow_up.enable'] !== false) {
		try {
			const prompt = FOLLOW_UP_GENERATION_PROMPT.replace(
				'{{MESSAGES}}',
				renderMessages(history, 6)
			);
			const raw = await generateText(env, model, [{ role: 'user', content: prompt }], {
				maxTokens: 300
			});
			const followUps = extractJSON<{ follow_ups?: string[] }>(raw)?.follow_ups;
			if (Array.isArray(followUps) && followUps.length) {
				await upsertMessage(env, job.chatId, job.messageId, { followUps });
				await emit({
					chat_id: job.chatId,
					message_id: job.messageId,
					data: { type: 'chat:message:follow_ups', data: { follow_ups: followUps } }
				});
			}
		} catch (error) {
			console.warn('[open-webui] follow-up generation failed:', error);
		}
	}
}

export const completionTimestamp = now;
