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
	stripDetailBlocks,
	stripThinking,
	renderMessages
} from './prompts';
import { fullText, search } from './retrieval';
import { resultText, webSearch } from './websearch';
import {
	isToolsUnsupported,
	runToolCall,
	searchPlan,
	toolCallAccumulator,
	toolsFor,
	type ToolCall
} from './tools';
import { HttpError, now, toJSON } from './util';

/**
 * How many times the model may call tools before it has to answer.
 *
 * Three is enough for search → read a result → search again with what it
 * learned, which is the pattern worth supporting; beyond that a model is
 * usually stuck rather than working. Raise it with `tools.max_rounds` for
 * longer chains — file work in particular can want more, since glob, grep,
 * read and edit are four rounds on their own.
 *
 * Clamped rather than trusted: a round is a whole model call plus its tool
 * work, so an unbounded value is a turn that never ends and a bill to match.
 */
const DEFAULT_TOOL_ROUNDS = 3;
const MAX_TOOL_ROUNDS_LIMIT = 20;

export function toolRounds(configured: unknown): number {
	// `null` is what an unset config row reads as, and Number(null) is 0 — which
	// would clamp to a single round and quietly disable multi-step tool use on
	// any deployment that had never set the key.
	if (configured === null || configured === undefined || configured === '') {
		return DEFAULT_TOOL_ROUNDS;
	}
	const value = Number(configured);
	if (!Number.isFinite(value)) return DEFAULT_TOOL_ROUNDS;
	return Math.min(Math.max(Math.floor(value), 1), MAX_TOOL_ROUNDS_LIMIT);
}

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
	/** Keys to retry with when the chosen one is rate-limited (Ollama Cloud). */
	fallbackKeys?: string[];
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
		payload,
		...(connection.fallbackKeys?.length ? { fallbackKeys: connection.fallbackKeys } : {})
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
	/** Raw OpenAI tool-call deltas; reassembled by `toolCallAccumulator`. */
	toolCalls?: any[];
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
			// Streamed as deltas; a non-streamed reply carries them on `message`.
			toolCalls: delta.tool_calls ?? choice.message?.tool_calls ?? undefined,
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

/**
 * A message with the chat screen's markup taken back out.
 *
 * Only the text half of a multi-part message is rewritten; an image part has
 * no markup to strip and must survive untouched.
 */
function withoutDetailBlocks(message: CompletionMessage): CompletionMessage {
	if (typeof message.content === 'string') {
		return { ...message, content: stripDetailBlocks(message.content) };
	}
	if (!Array.isArray(message.content)) return message;
	return {
		...message,
		content: message.content.map((part: any) =>
			part?.type === 'text' && typeof part.text === 'string'
				? { ...part, text: stripDetailBlocks(part.text) }
				: part
		)
	};
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

	const nameFor = (fileId: string | undefined) =>
		files.find((file) => (file.id ?? file.file?.id) === fileId)?.name ??
		files.find((file) => (file.id ?? file.file?.id) === fileId)?.file?.filename ??
		'attachment';

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

	// Full-context mode hands over whole documents instead of retrieved chunks.
	// Both switches on the Documents screen mean the same thing here, and both
	// used to be stored and then ignored: retrieval ran regardless, so a long
	// document reached the model as `top_k` chunks — three thousand characters
	// by default — however long it was.
	const ragConfig = await getConfigMany(env, ['rag.full_context', 'rag.bypass_embedding']);
	const wholeDocuments =
		Boolean(ragConfig['rag.full_context']) || Boolean(ragConfig['rag.bypass_embedding']);

	const chunks =
		!wholeDocuments && (fileIds.length || knowledgeIds.length)
			? await search(env, query, { fileIds, knowledgeIds })
			: [];

	const parts: string[] = [];
	const sources: Record<string, unknown>[] = [];
	let index = 0;

	if (wholeDocuments && (fileIds.length || knowledgeIds.length)) {
		for (const file of await fullText(env, { fileIds, knowledgeIds })) {
			index += 1;
			const name = nameFor(file.file_id) || file.filename;
			parts.push(`<source id="${index}" name="${name}">${file.content}</source>`);
			sources.push({
				source: { id: file.file_id, name },
				document: [file.content],
				metadata: [{ source: file.file_id, name, file_id: file.file_id }]
			});
		}
	}

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

/**
 * Renders a tool call as a `<details type="tool_calls">` block.
 *
 * Status events all land in one strip above the message, so a turn that calls
 * three tools between paragraphs showed them stacked at the top, detached from
 * the text they belong to. The frontend already renders this detail type inline
 * — the same mechanism reasoning uses — so the call appears where it happened.
 *
 * Nothing variable goes in an attribute. The tokeniser reads them with
 * `/(\w+)="(.*?)"/`, which any quote in the value truncates, and matches the
 * opening tag with `[^>]*`, which any `>` ends early — so JSON arguments in an
 * attribute would corrupt the tag rather than merely look wrong. The tool name
 * and id are reduced to characters that cannot do either, and everything else
 * goes in the block body, which is free text and is what the renderer reads for
 * the result.
 */
function toolCallBlock(call: ToolCall, result: string): string {
	const safe = (value: string) => value.replace(/[^\w.-]/g, '_').slice(0, 64);
	const body = [`Arguments: ${call.arguments || '{}'}`, '', result].join('\n');
	return (
		`\n\n<details type="tool_calls" done="true" id="${safe(call.id)}" name="${safe(call.name)}">\n` +
		`<summary>${safe(call.name)}</summary>\n${body}\n</details>\n\n`
	);
}

/** Executes one completion, streaming `chat:completion` events as it goes. */
/**
 * Accumulates `reasoning_content` into a collapsible block.
 *
 * The block is opened `done="false"`, which is what makes the frontend show it
 * as "Thinking..." with a spinner while it fills; `seal` rewrites that to
 * `done="true"` with the elapsed seconds once the model stops, so it settles
 * into "Thought for 12 seconds". The rewrite is possible because a message
 * carrying an open block is sent whole rather than as a delta — see
 * `emitMessage` below for why it has to be.
 */
const REASONING_OPEN = '<details type="reasoning" done="false">';

function openReasoningBlock() {
	let open = false;
	let startedAt = 0;

	return {
		/** Whether a block is currently open, and therefore unterminated. */
		get open() {
			return open;
		},
		/** The text to append for this reasoning delta. */
		push(text: string): string {
			if (open) return text;
			open = true;
			startedAt = Date.now();
			// The frontend tokenises `<details>` with a block-anchored pattern, so a
			// tag glued onto the end of the previous line is parsed as inline HTML
			// and renders as nothing. That is invisible for the first block, which
			// starts the message, and breaks every later one — a model that thinks
			// again after answering.
			return `\n\n${REASONING_OPEN}\n<summary>Thinking</summary>\n${text}`;
		},
		/** The text that closes the block, or '' when none is open. */
		close(): string {
			if (!open) return '';
			open = false;
			// The blank line after </details> does the same job for whatever the
			// model says next.
			return '\n</details>\n\n';
		},
		/**
		 * Marks the block just closed as finished, with how long it took.
		 *
		 * The last unsealed tag is the one that closed: earlier blocks in the same
		 * message were sealed when they closed, so only one can ever match.
		 */
		seal(message: string): string {
			const at = message.lastIndexOf(REASONING_OPEN);
			if (at === -1) return message;
			const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
			return (
				message.slice(0, at) +
				`<details type="reasoning" done="true" duration="${seconds}">` +
				message.slice(at + REASONING_OPEN.length)
			);
		}
	};
}

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
	// Sources accumulate across tool rounds, so a second search does not erase
	// the citations from the first.
	const toolSources: Record<string, unknown>[] = [];

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

		// Past turns carry the markup the chat screen renders — a reasoning block,
		// a tool call. Whichever way the history arrived, it is context now, and
		// the model should be given what was said rather than how it was shown.
		job.body = {
			...job.body,
			messages: (job.body.messages as CompletionMessage[]).map(withoutDetailBlocks)
		};

		// `always` searches once before the model runs; `tool` hands the search to
		// the model as a function; `combo` does both, so it starts with pages in
		// hand and can still search again for what they did not cover.
		const webSearchOn = Boolean(job.body.features?.web_search);
		const mode = String((await getConfig(env, 'web.search.mode')) ?? 'always');
		const canCallTools = resolved.workersAI !== true;
		const plan = searchPlan(mode, webSearchOn, canCallTools);

		// Memory and file tools do not depend on web search being on for the turn,
		// so the tool list is assembled from every enabled group rather than from
		// the search mode alone.
		const toolConfig = await getConfigMany(env, [
			'tools.memory.enable',
			'tools.files.enable',
			'tools.search.enable',
			'tools.todo.enable',
			'tools.knowledge.enable',
			'tools.max_rounds'
		]);
		const maxToolRounds = toolRounds(toolConfig['tools.max_rounds']);
		const tools = canCallTools
			? toolsFor({
					web: plan.tools,
					memory: toolConfig['tools.memory.enable'] !== false,
					files: toolConfig['tools.files.enable'] !== false,
					search: toolConfig['tools.search.enable'] !== false,
					// A plan is kept against the chat row, so it needs a saved chat.
					todo: toolConfig['tools.todo.enable'] !== false && job.saveToChat,
					knowledge: toolConfig['tools.knowledge.enable'] !== false
				})
			: [];
		let useTools = tools.length > 0;
		let preSearched = plan.preSearch;

		if (plan.preSearch) {
			await runWebSearch(env, job, emit, { toolsAvailable: plan.tools });
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
			// Reasoning models stream their working as `reasoning_content` and may
			// send no `content` at all for a long stretch — sometimes for the whole
			// reply. The frontend renders a `<details type="reasoning">` block found
			// in the message text, so the thinking is wrapped into one as it
			// arrives, then closed when the answer proper starts.
			const reasoning = openReasoningBlock();

			/**
			 * Sends the whole message rather than the piece that just arrived.
			 *
			 * The frontend's `<details>` tokeniser needs the closing tag before it
			 * will produce a block at all, so an open one renders as nothing — the
			 * thinking appeared only once the model had finished thinking, which is
			 * the least useful moment for it. Sending the message with a
			 * provisional `</details>` on the end makes the block appear with the
			 * first token and fill in live; the real closing tag replaces it when
			 * the model stops. This is the `content` field the frontend assigns
			 * straight to the message, so it also lets the opening tag be rewritten
			 * afterwards with how long the thinking took.
			 */
			const emitMessage = () =>
				emitCompletion({
					id: job.messageId,
					content: reasoning.open ? `${content}\n</details>` : content,
					done: false
				});

			/**
			 * The floor between two whole-message sends.
			 *
			 * A whole message per token would cost the square of the thought: a
			 * model reasoning for a minute sends thousands of chunks, and resending
			 * a growing message for each turned a 16KB answer into megabytes on the
			 * wire. Coalescing bounds that by wall-clock instead — and no reader
			 * can tell 150ms from instant, which is why this costs nothing that is
			 * worth having.
			 *
			 * Skipping a send is only ever safe because the frontend *replaces* the
			 * message with what it receives rather than appending to it: a dropped
			 * update is superseded by the next, and `closeReasoning` always sends
			 * the final state.
			 *
			 * The first send of a block is never skipped. Appearing at once is the
			 * whole point, and a thought shorter than the interval would otherwise
			 * show nothing until it ended — the bug this exists to fix.
			 */
			const MESSAGE_INTERVAL_MS = 150;
			let lastMessageAt = 0;

			const emitMessageThrottled = async (immediate = false) => {
				const now = Date.now();
				if (!immediate && now - lastMessageAt < MESSAGE_INTERVAL_MS) return;
				lastMessageAt = now;
				await emitMessage();
			};

			/**
			 * Writes the answer so far into the chat.
			 *
			 * The turn survives the client leaving — it runs in the Durable Object
			 * that owns the socket, not in the request — but until this existed
			 * nothing was written until it finished. Reload while a model was
			 * working and the message was there and empty, and stayed empty for as
			 * long as the model took, which on a reasoning model is a minute or
			 * more.
			 *
			 * Coalesced rather than written per token: a token is a few characters
			 * and a write is a round trip to D1. Half a second is under what a
			 * reader notices on a reload and turns a thousand-token answer into
			 * tens of writes rather than a thousand.
			 *
			 * A failed write is swallowed. The next one supersedes it, the write
			 * that ends the turn is what the message is judged on, and a chat that
			 * cannot be saved is not a reason to stop answering.
			 */
			const SAVE_INTERVAL_MS = 500;
			let lastSaveAt = 0;
			let savedLength = -1;

			const saveProgress = async (force = false) => {
				if (!job.saveToChat || content.length === savedLength) return;
				const at = Date.now();
				if (!force && at - lastSaveAt < SAVE_INTERVAL_MS) return;
				lastSaveAt = at;
				savedLength = content.length;
				await upsertMessage(env, job.chatId, job.messageId, { content }).catch((error) =>
					console.warn('[open-webui] could not save the answer so far:', error)
				);
			};

			const pushDelta = async (delta: string, opensBlock = false) => {
				// The reasoning block asks for a blank line before it; at the very
				// start of a message there is nothing to separate it from.
				if (!content) delta = delta.replace(/^\n+/, '');
				if (!delta) return;
				content += delta;
				await saveProgress();
				// A delta is cheaper, and correct for everything except an open
				// reasoning block, where the frontend has nothing to render it into.
				if (reasoning.open) {
					await emitMessageThrottled(opensBlock);
					return;
				}
				await emitCompletion({
					id: job.messageId,
					choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
					done: false
				});
			};

			/**
			 * Ends the open reasoning block, if there is one.
			 *
			 * Both the closing tag and the duration change text already on the
			 * wire, so the message goes out whole once more; after that the stream
			 * is back to deltas, appended to exactly this text.
			 */
			const closeReasoning = async () => {
				const trailing = reasoning.close();
				if (!trailing) return;
				content = reasoning.seal(content + trailing);
				// Never throttled: this carries the last of the thinking, the real
				// closing tag and the duration, and nothing follows it to correct a
				// send that was skipped.
				lastMessageAt = Date.now();
				await emitMessage();
			};

			// Each round is one model turn. A turn that ends in tool calls is run,
			// its results appended, and the model asked again; a turn that produces
			// only text ends the loop. The cap stops a model that keeps calling the
			// same tool from looping forever.
			let messages = request.payload.messages as CompletionMessage[];
			for (let round = 0; ; round += 1) {
				const roundRequest: UpstreamRequest = {
					...request,
					payload: {
						...request.payload,
						messages,
						...(useTools && round < maxToolRounds ? { tools, tool_choice: 'auto' } : {})
					}
				};

				const pending = toolCallAccumulator();
				try {
					for await (const chunk of streamUpstream(env, roundRequest)) {
						if (chunk.usage) usage = chunk.usage;
						if (chunk.toolCalls) pending.push(chunk.toolCalls);
						if (chunk.reasoning) {
							const opening = !reasoning.open;
							await pushDelta(reasoning.push(chunk.reasoning), opening);
						}
						if (chunk.content) {
							await closeReasoning();
							await pushDelta(chunk.content);
						}
					}
				} catch (error) {
					// Not every model accepts `tools`. Rather than failing the message,
					// drop back to the mode that needs nothing of the model: search
					// first, then ask again without tools. Only worth trying before
					// anything has been streamed to the user.
					if (!(useTools && round === 0 && isToolsUnsupported(String((error as Error).message))))
						throw error;
					console.warn('[open-webui] model rejected tools; searching before the turn instead');
					useTools = false;
					// In combo mode the pre-search has already run; searching again
					// would duplicate its sources as well as its cost. And a turn that
					// only offered memory or file tools must not start searching the web
					// just because the model refused them.
					if (webSearchOn && !preSearched) {
						await runWebSearch(env, job, emit);
						preSearched = true;
					}
					messages = buildUpstreamRequest(resolved, job.body, { stream }).payload
						.messages as CompletionMessage[];
					continue;
				}

				const calls = pending.calls();
				if (!calls.length) break;

				// The model's own turn has to go back verbatim, tool calls included,
				// or the follow-up messages have nothing to answer.
				messages = [
					...messages,
					{
						role: 'assistant',
						content: null,
						tool_calls: calls.map((call) => ({
							id: call.id,
							type: 'function',
							function: { name: call.name, arguments: call.arguments }
						}))
					}
				];

				for (const call of calls) {
					await emit({
						chat_id: job.chatId,
						message_id: job.messageId,
						data: {
							type: 'status',
							data: { action: 'web_search', description: `Running ${call.name}…`, done: false }
						}
					});

					const outcome = await runToolCall(env, call, {
						userId: job.userId,
						chatId: job.chatId
					}).catch((error) => ({
						content: `The tool failed: ${(error as Error).message}`,
						sources: [] as Record<string, unknown>[],
						status: `${call.name} failed`
					}));

					messages = [
						...messages,
						{ role: 'tool', tool_call_id: call.id, content: outcome.content }
					];

					for (const source of outcome.sources) {
						await emit({
							chat_id: job.chatId,
							message_id: job.messageId,
							data: { type: 'source', data: source }
						});
					}
					if (outcome.sources.length) {
						toolSources.push(...outcome.sources);
						if (job.saveToChat) {
							await upsertMessage(env, job.chatId, job.messageId, { sources: toolSources });
						}
					}

					await emit({
						chat_id: job.chatId,
						message_id: job.messageId,
						data: {
							type: 'status',
							data: { action: 'web_search', description: outcome.status, done: true }
						}
					});

					// And in the message itself, where the call actually happened.
					await pushDelta(toolCallBlock(call, outcome.status));
				}
			}

			// A model that only ever produced reasoning still needs its block shut.
			await closeReasoning();
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

/**
 * Searches the web for the current turn, appends the pages as sources, and
 * reports progress through the same status events the Python backend emits.
 */
/**
 * Turns the conversation into search queries, the way upstream does.
 *
 * Searching the raw message is close to useless once it is more than a
 * sentence: paste three paragraphs and three paragraphs go to the search
 * engine. The task model is asked for one to three real queries instead.
 *
 * JSON mode is deliberately not requested. Several providers — Ollama among
 * them — accept `response_format` with a 200 and ignore it, so the reply is
 * parsed defensively: the first JSON object in the text, else the first
 * non-empty line, else the raw message.
 */
export async function generateSearchQueries(
	env: Env,
	messages: CompletionMessage[],
	fallback: string,
	answeringModelId: string
): Promise<string[]> {
	const config = await getConfigMany(env, ['task.query.enable', 'task.query.prompt_template']);
	if (config['task.query.enable'] === false) return [fallback];

	const model = await taskModelId(env, answeringModelId);
	if (!model) return [fallback];

	const history = messages
		.slice(-6)
		.map((message) => {
			const text =
				typeof message.content === 'string'
					? message.content
					: Array.isArray(message.content)
						? (message.content as any[])
								.map((part) => (typeof part?.text === 'string' ? part.text : ''))
								.join(' ')
						: '';
			return `${message.role}: ${text}`;
		})
		.join('\n');
	const template =
		(config['task.query.prompt_template'] as string) || DEFAULT_QUERY_GENERATION_PROMPT;
	const prompt = template
		.replaceAll('{{CURRENT_DATE}}', new Date().toISOString().slice(0, 10))
		.replaceAll('{{MESSAGES:END:6}}', history);

	try {
		const reply = await generateText(env, model, [{ role: 'user', content: prompt }], {
			maxTokens: TASK_TOKENS
		});
		const queries = parseQueries(reply);
		return queries.length ? queries.slice(0, 3) : [fallback];
	} catch (error) {
		console.warn('[open-webui] search query generation failed, using the raw message', error);
		return [fallback];
	}
}

/**
 * Pulls a query list out of a reply that may or may not be clean JSON.
 *
 * A reasoning model drafts the JSON while it thinks, so both readings below
 * work on the answer with the thinking removed: a greedy `{…}` match would
 * otherwise span the draft and the answer, and the line fallback would take the
 * first line of the thought as the search query.
 */
export function parseQueries(reply: string): string[] {
	const parsed = extractJSON<{ queries?: unknown }>(reply, 'queries');
	if (Array.isArray(parsed?.queries)) {
		const queries = parsed.queries.map((q: unknown) => String(q).trim()).filter(Boolean);
		if (queries.length) return queries;
	}
	// A model that ignored the format at least tends to put the query on its
	// own line; anything longer than a search query is not one.
	const line = stripThinking(reply)
		.split('\n')
		.map((entry) => entry.replace(/^[-*\d.\s"']+|["']+$/g, '').trim())
		.find((entry) => entry.length > 0 && entry.length < 200 && !/[{}]/.test(entry));
	return line ? [line] : [];
}

const DEFAULT_QUERY_GENERATION_PROMPT = `### Task:
Analyze the chat history to determine the necessity of generating search queries, in the given language. By default, **prioritize generating 1-3 broad and relevant search queries** unless it is absolutely certain that no additional information is required. If no search is unequivocally needed, return an empty list.

### Guidelines:
- Respond **EXCLUSIVELY** with a JSON object. Any extra commentary is strictly prohibited.
- Format: { "queries": ["query1", "query2"] }, each query distinct, concise and relevant.
- Today's date is: {{CURRENT_DATE}}.

### Output:
Strictly return in JSON format:
{
  "queries": ["query1", "query2"]
}

### Chat History:
<chat_history>
{{MESSAGES:END:6}}
</chat_history>`;

async function runWebSearch(
	env: Env,
	job: CompletionJob,
	emit: EventEmitter,
	options: { toolsAvailable?: boolean } = {}
): Promise<void> {
	const messages = (job.body.messages ?? []) as CompletionMessage[];
	const raw = lastUserText(messages);
	if (!raw) return;

	const queries = await generateSearchQueries(env, messages, raw, job.modelId);
	const query = queries[0];

	const status = (data: Record<string, unknown>) =>
		emit({
			chat_id: job.chatId,
			message_id: job.messageId,
			data: { type: 'status', data: { action: 'web_search', ...data } }
		});

	await status({ description: `Searching the web for "${query.slice(0, 80)}"`, done: false });

	try {
		// Every generated query is searched and the pages merged, as upstream
		// does: one query missing the mark no longer means an empty answer.
		const seen = new Set<string>();
		const results: Awaited<ReturnType<typeof webSearch>> = [];
		for (const term of queries) {
			for (const result of await webSearch(env, term)) {
				if (seen.has(result.url)) continue;
				seen.add(result.url);
				results.push(result);
			}
			// The first query is the one the model considered most relevant, so a
			// hit there is usually enough; the rest only run when it came up short.
			if (results.length >= 3) break;
		}
		if (!results.length) {
			await status({ description: 'No web results found', done: true });
			return;
		}

		const parts: string[] = [];
		const sources: Record<string, unknown>[] = [];
		for (const [index, result] of results.entries()) {
			const text = await resultText(env, result);
			if (!text) continue;
			parts.push(
				`<source id="${index + 1}" name="${result.title || result.url}" url="${result.url}">${text}</source>`
			);
			sources.push({
				source: { name: result.title || result.url, url: result.url, id: result.url },
				document: [text],
				metadata: [{ source: result.url, name: result.title || result.url }]
			});
		}

		if (parts.length) {
			job.body = {
				...job.body,
				messages: [
					{
						role: 'system',
						content:
							'The following web pages were retrieved for this question. Use them to answer, ' +
							'cite them inline as [id], and say so if they do not contain the answer.' +
							// In combo mode the model still holds the tools, so "they do not
							// contain the answer" has a better ending than saying so.
							(options.toolsAvailable
								? ' If they do not cover it, call the web_search tool again with a better query.'
								: '') +
							`\n\n${parts.join('\n')}`
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

		await status({
			description: `Searched the web (${parts.length} page${parts.length === 1 ? '' : 's'})`,
			done: true,
			urls: results.map((result) => result.url)
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn('[open-webui] web search failed:', message);
		await status({ description: `Web search failed: ${message}`, done: true, error: true });
	}
}

/**
 * Sends the request, retrying a rate-limited one.
 *
 * Ollama Cloud's 429 is a *concurrency* limit — one in-flight request with a
 * five-deep queue — not a quota: measured against the live service, 120
 * parallel requests produced 109 rejections while 25 sequential ones produced
 * none. So waiting is what actually clears it, and the response carries
 * `retry-after` in seconds saying how long.
 *
 * Each attempt also moves to another key when one is configured. Whether that
 * helps depends on the limit being per-key rather than per-account, which is
 * unconfirmed; it costs nothing either way, and the wait is doing the real
 * work.
 *
 * Anything that is not a 429 or a 5xx is returned untouched — a malformed
 * request or a model the account cannot use fails identically on every key and
 * after every wait.
 */
const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_MAX_WAIT_MS = 15_000;

async function fetchWithKeyFallback(request: UpstreamRequest): Promise<Response> {
	const keys = request.fallbackKeys ?? [];
	const send = (key?: string) =>
		fetch(request.url!, {
			method: 'POST',
			headers: key
				? { ...request.headers, Authorization: `Bearer ${key}` }
				: (request.headers as Record<string, string>),
			body: JSON.stringify(request.payload)
		});

	let response = await send();

	for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt += 1) {
		if (response.status !== 429 && response.status < 500) break;

		// Honour the server's own figure, clamped so a long one cannot stall the
		// request past what a user will wait. Falls back to a short backoff when
		// the header is absent, as it is on a 5xx.
		const header = Number(response.headers.get('retry-after'));
		const wait = Math.min(
			Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** attempt,
			RATE_LIMIT_MAX_WAIT_MS
		);

		// The body has to be consumed or the connection is held open.
		await response.body?.cancel().catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, wait));
		response = await send(keys[attempt % Math.max(keys.length, 1)]);
	}

	return response;
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
		const response = await fetchWithKeyFallback(request);
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

export async function errorDetail(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const parsed = JSON.parse(text);
		// Providers are not consistent even with themselves: Ollama returns
		// {"error":{"message":…}} for 401/402 but a bare {"error":"…"} for 429.
		const error = parsed?.error;
		return (
			(typeof error === 'string' ? error : error?.message) ??
			parsed?.detail ??
			parsed?.message ??
			text.slice(0, 500)
		);
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

/**
 * How much room a background task answer gets.
 *
 * A reasoning model spends this on thinking before it answers, so the old
 * ceiling of 100 tokens for a title bought a truncated thought and no JSON.
 * These tasks ask for a handful of words either way.
 */
const TASK_TOKENS = 1200;

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
				maxTokens: TASK_TOKENS
			});
			const title = extractJSON<{ title?: string }>(raw, 'title')?.title?.trim();
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
				maxTokens: TASK_TOKENS
			});
			const tags = extractJSON<{ tags?: string[] }>(raw, 'tags')?.tags;
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
				maxTokens: TASK_TOKENS
			});
			const followUps = extractJSON<{ follow_ups?: string[] }>(raw, 'follow_ups')?.follow_ups;
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
