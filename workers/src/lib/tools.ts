/**
 * Model-invoked tools.
 *
 * The default web-search mode searches once per turn, before the model runs.
 * That is predictable and cheap, but the model has no say in it: it cannot
 * decide the question needs no search, and it cannot search again after reading
 * what came back.
 *
 * This is the other half — the same search and fetch offered as OpenAI-style
 * function tools, so a model that supports tool calling drives them itself.
 * Nothing here is provider-specific beyond the OpenAI tool-calling shape, which
 * NIM, Ollama and every OpenAI-compatible endpoint in this port already speak.
 */

import type { Env } from '../types';
import { fetchPageText, resultText, webSearch } from './websearch';
import { addMemory, deleteMemory, queryMemories } from './memories';
import { createUserFile, editUserFile, findUserFile, listUserFiles } from './userfiles';
import { globFiles, globToRegExp, grepFiles, grepIn, searchChats } from './workspace';
import { normalizeTodos, readTodos, renderTodos, todoSummary, writeTodos } from './todos';
import {
	attachFileToKnowledge,
	canWrite,
	filesInKnowledge,
	findKnowledge,
	visibleKnowledge,
	type KnowledgeBase,
	type KnowledgeFile
} from './knowledgetools';
import { search } from './retrieval';

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON text, as the model produced it — parsed at call time. */
	arguments: string;
}

/**
 * Who the turn belongs to.
 *
 * Memory and file tools read and write that account's own data, so the id is
 * not optional context — it is the boundary. Every statement behind these tools
 * is scoped to it, so a model naming someone else's file gets "not found".
 */
export interface ToolContext {
	userId: string;
	/** The conversation this turn belongs to; the plan is stored against it. */
	chatId?: string;
}

export interface ToolOutcome {
	/** What goes back to the model as the tool message. */
	content: string;
	/** Citable sources, in the shape the frontend renders. */
	sources: Record<string, unknown>[];
	/** One line for the status strip, so the user sees what the model did. */
	status: string;
}

export const WEB_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'web_search',
			description:
				'Search the web for current information. Use this whenever the answer depends ' +
				'on recent events, or on facts you are not confident about. Returns page ' +
				'content with a numbered id for each result, which you should cite as [id].',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query. Keep it short and specific, like a real search.'
					},
					count: {
						type: 'integer',
						description: 'How many results to return. Defaults to the configured amount.'
					}
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'web_fetch',
			description:
				'Fetch one web page and read it as text. Use this to follow a link from a ' +
				'search result when the snippet is not enough.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The absolute URL of the page to read.' }
				},
				required: ['url']
			}
		}
	}
] as const;

/**
 * Reassembles tool calls from a stream.
 *
 * Providers send them a fragment at a time — `arguments` arrives as a string
 * split across chunks, and the `index` is the only thing tying the fragments to
 * a call, since `id` and `name` appear once at the start.
 */
export function toolCallAccumulator() {
	const byIndex = new Map<number, { id: string; name: string; arguments: string }>();

	return {
		push(deltas: any[]): void {
			for (const delta of deltas ?? []) {
				const index = Number(delta?.index ?? 0);
				const existing = byIndex.get(index) ?? { id: '', name: '', arguments: '' };
				byIndex.set(index, {
					id: delta?.id || existing.id,
					name: delta?.function?.name || existing.name,
					arguments: existing.arguments + (delta?.function?.arguments ?? '')
				});
			}
		},
		calls(): ToolCall[] {
			return [...byIndex.entries()]
				.sort(([a], [b]) => a - b)
				.map(([index, call]) => ({
					// Some providers omit the id on a single call; the model only needs
					// it to match the reply, so a stable stand-in is fine.
					id: call.id || `call_${index}`,
					name: call.name,
					arguments: call.arguments
				}))
				.filter((call) => call.name);
		}
	};
}

/** Runs one tool call and shapes the reply for both the model and the UI. */
export async function runToolCall(
	env: Env,
	call: ToolCall,
	context: ToolContext
): Promise<ToolOutcome> {
	let args: Record<string, any> = {};
	try {
		args = call.arguments ? JSON.parse(call.arguments) : {};
	} catch {
		// A model that produced malformed JSON gets told so, rather than having
		// the whole turn fail: it can correct itself on the next round.
		return {
			content: `The arguments were not valid JSON: ${call.arguments.slice(0, 200)}`,
			sources: [],
			status: `Tool call to ${call.name} had malformed arguments`
		};
	}

	const userData = await runUserDataTool(env, call, args, context);
	if (userData) return userData;

	const workspace = await runWorkspaceTool(env, call, args, context);
	if (workspace) return workspace;

	const todo = await runTodoTool(env, call, args, context);
	if (todo) return todo;

	const knowledge = await runKnowledgeTool(env, call, args, context);
	if (knowledge) return knowledge;

	if (call.name === 'web_search') {
		const query = String(args.query ?? '').trim();
		if (!query) {
			return { content: 'No query was given.', sources: [], status: 'Search called with no query' };
		}
		const count = Number.isFinite(args.count) ? Number(args.count) : undefined;
		const results = await webSearch(env, query, count ? { count } : {});
		if (!results.length) {
			return {
				content: `No results for "${query}".`,
				sources: [],
				status: `Searched for "${query}" — nothing found`
			};
		}

		const parts: string[] = [];
		const sources: Record<string, unknown>[] = [];
		for (const [index, result] of results.entries()) {
			const text = await resultText(env, result);
			if (!text) continue;
			const name = result.title || result.url;
			parts.push(`<source id="${index + 1}" name="${name}" url="${result.url}">${text}</source>`);
			sources.push({
				source: { name, url: result.url, id: result.url },
				document: [text],
				metadata: [{ source: result.url, name }]
			});
		}
		return {
			content: parts.join('\n') || `No readable pages for "${query}".`,
			sources,
			status: `Searched the web for "${query}" (${sources.length} page${sources.length === 1 ? '' : 's'})`
		};
	}

	if (call.name === 'web_fetch') {
		const url = String(args.url ?? '').trim();
		if (!/^https?:\/\//i.test(url)) {
			return {
				content: 'The url must be an absolute http(s) URL.',
				sources: [],
				status: 'Fetch called with an invalid URL'
			};
		}
		const text = await fetchPageText(url, 6000, env);
		if (!text) {
			return { content: `Could not read ${url}.`, sources: [], status: `Could not read ${url}` };
		}
		return {
			content: `<source id="1" name="${url}" url="${url}">${text}</source>`,
			sources: [
				{
					source: { name: url, url, id: url },
					document: [text],
					metadata: [{ source: url, name: url }]
				}
			],
			status: `Read ${url}`
		};
	}

	return {
		content: `There is no tool called ${call.name}.`,
		sources: [],
		status: `Unknown tool ${call.name}`
	};
}

/**
 * Whether an upstream error means "this model does not do tool calling".
 *
 * Providers disagree on the wording and the status, so this matches on the
 * shape of the complaint rather than any one provider's text. Used to fall back
 * to searching before the turn instead of failing the message outright.
 */
export function isToolsUnsupported(message: string): boolean {
	return (
		/tool|function[_ ]?call/i.test(message) && /support|invalid|unknown|unrecogni/i.test(message)
	);
}

export type SearchMode = 'always' | 'tool' | 'combo';

export interface SearchPlan {
	/** Search once before the model runs and inject the pages as context. */
	preSearch: boolean;
	/** Offer `web_search`/`web_fetch` to the model for this turn. */
	tools: boolean;
}

/**
 * What a turn should do about web search.
 *
 * Three modes, and the interesting one is `combo`: the model starts with pages
 * already retrieved *and* keeps the tools, so it answers straight away when the
 * pre-search covered the question and searches again when it did not. `always`
 * cannot do the second, `tool` pays a round trip before it has anything to read.
 *
 * Tool calling needs an OpenAI-compatible endpoint — the Workers AI binding has
 * no tool-calling shape — so a mode that asked for tools without them falls back
 * to searching first rather than doing nothing.
 */
export function searchPlan(mode: string, enabled: boolean, canUseTools: boolean): SearchPlan {
	if (!enabled) return { preSearch: false, tools: false };

	const wantsTools = mode === 'tool' || mode === 'combo';
	const tools = wantsTools && canUseTools;
	return { preSearch: !tools || mode === 'combo', tools };
}

export const MEMORY_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'remember',
			description:
				'Save a fact about the user for future conversations — a preference, a ' +
				'project they are working on, how they like answers written. Save the fact ' +
				'itself, phrased so it makes sense months later without this conversation ' +
				'around it. Do not save passwords or one-off details of the current task.',
			parameters: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
						description: 'The fact to remember, as a complete standalone sentence.'
					}
				},
				required: ['content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'recall',
			description:
				'Look up what you have remembered about this user. Call it when the answer ' +
				'depends on their preferences, their setup, or anything they told you before.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'What to look for. Leave empty to list the most recent memories.'
					}
				},
				required: []
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'forget',
			description:
				'Delete one memory by its id, which `recall` returns. Use it when the user ' +
				'says something you remembered is wrong or no longer true.',
			parameters: {
				type: 'object',
				properties: { id: { type: 'string', description: 'The memory id from `recall`.' } },
				required: ['id']
			}
		}
	}
] as const;

export const FILE_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'list_files',
			description:
				"List the files in the user's workspace, with their names and sizes. Pass " +
				'`knowledge` to list the files inside a knowledge base instead.',
			parameters: {
				type: 'object',
				properties: {
					knowledge: { type: 'string', description: 'A knowledge base name, to list its files.' }
				},
				required: []
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_file',
			description:
				'Read one of the user’s files by name. Returns its text with line numbers. ' +
				'For a long file, read the part you need with offset and limit rather than ' +
				'the whole thing.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The file name, or its id.' },
					knowledge: { type: 'string', description: 'Look in this knowledge base.' },
					offset: { type: 'integer', description: 'First line to return, 1-based.' },
					limit: { type: 'integer', description: 'How many lines to return.' }
				},
				required: ['name']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_file',
			description:
				"Create a new text file in the user's workspace. Use this when they ask you " +
				'to write something down, draft a document, or save output. The file appears ' +
				'in their Files list and can be attached to later chats.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'File name including an extension, e.g. notes.md' },
					content: { type: 'string', description: 'The full text of the file.' },
					knowledge: {
						type: 'string',
						description: 'Add the new file to this knowledge base, if you have write access.'
					}
				},
				required: ['name', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'edit_file',
			description:
				'Replace an exact passage in one of the user’s files, leaving the rest ' +
				'untouched. Prefer this over rewriting a file: pass enough surrounding text ' +
				'that `old_text` appears exactly once. Read the file first if unsure.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The file name, or its id.' },
					old_text: { type: 'string', description: 'The exact text to replace.' },
					new_text: { type: 'string', description: 'What to put in its place.' },
					replace_all: {
						type: 'boolean',
						description: 'Replace every occurrence instead of refusing when there are several.'
					}
				},
				required: ['name', 'old_text', 'new_text']
			}
		}
	}
] as const;

/** The tools a turn offers, in the order the model sees them. */
export function toolsFor(enabled: {
	web?: boolean;
	memory?: boolean;
	files?: boolean;
	search?: boolean;
	todo?: boolean;
	knowledge?: boolean;
}): unknown[] {
	return [
		...(enabled.web ? WEB_TOOLS : []),
		...(enabled.memory ? MEMORY_TOOLS : []),
		...(enabled.files ? FILE_TOOLS : []),
		...(enabled.search ? SEARCH_TOOLS : []),
		...(enabled.todo ? TODO_TOOLS : []),
		...(enabled.knowledge ? KNOWLEDGE_TOOLS : [])
	];
}

const plain = (content: string, status: string): ToolOutcome => ({ content, sources: [], status });

/**
 * Resolves the optional `knowledge` argument to a set of files.
 *
 * Returns `null` when no base was named, meaning "the user's own files"; an
 * error outcome when the named base is not visible to them. Every file tool
 * goes through this rather than reaching for `knowledge_file` itself, so the
 * access check exists once.
 */
async function scopeToKnowledge(
	env: Env,
	context: ToolContext,
	named: unknown
): Promise<{ files: KnowledgeFile[]; base: KnowledgeBase } | ToolOutcome | null> {
	const name = String(named ?? '').trim();
	if (!name) return null;

	const base = await findKnowledge(env, context.userId, name);
	if (!base) {
		return plain(
			`There is no knowledge base called ${name} that you can see.`,
			`No knowledge base ${name}`
		);
	}
	return { files: await filesInKnowledge(env, [base]), base };
}

const isOutcome = (value: unknown): value is ToolOutcome =>
	!!value && typeof value === 'object' && 'status' in (value as any);

/** Memory and file tools; returns null for anything it does not handle. */
async function runUserDataTool(
	env: Env,
	call: ToolCall,
	args: Record<string, any>,
	context: ToolContext
): Promise<ToolOutcome | null> {
	const userId = context.userId;

	switch (call.name) {
		case 'remember': {
			const content = String(args.content ?? '').trim();
			if (!content) return plain('Nothing to remember — content was empty.', 'Nothing to remember');
			const memory = await addMemory(env, userId, content);
			return plain(`Remembered (id ${memory.id}).`, `Remembered: ${content.slice(0, 60)}`);
		}

		case 'recall': {
			const rows = await queryMemories(env, userId, String(args.query ?? ''));
			if (!rows.length)
				return plain('Nothing has been remembered about this user yet.', 'No memories');
			const listed = rows.map((row) => `- [${row.id}] ${row.content}`).join('\n');
			return plain(
				`What you remember about this user:\n${listed}`,
				`Recalled ${rows.length} memories`
			);
		}

		case 'forget': {
			const id = String(args.id ?? '').trim();
			const gone = await deleteMemory(env, userId, id);
			return plain(
				gone ? `Forgot memory ${id}.` : `There is no memory with id ${id}.`,
				gone ? 'Forgot a memory' : 'No such memory'
			);
		}

		case 'list_files': {
			const scope = await scopeToKnowledge(env, context, args.knowledge);
			if (isOutcome(scope)) return scope;

			const files = scope ? scope.files : await listUserFiles(env, userId);
			const where = scope ? scope.base.name : 'the workspace';
			if (!files.length) return plain(`${where} has no files.`, `No files in ${where}`);
			const listed = files
				.map((file) => `- ${file.filename} (${file.content.length} characters)`)
				.join('\n');
			return plain(`Files in ${where}:\n${listed}`, `Listed ${files.length} files in ${where}`);
		}

		case 'read_file': {
			const name = String(args.name ?? '').trim();
			const scope = await scopeToKnowledge(env, context, args.knowledge);
			if (isOutcome(scope)) return scope;

			// A named base restricts the search to it; otherwise the user's own
			// files are tried first, then anything in a base they can see.
			const inScope = scope
				? scope.files.find((entry) => entry.filename.toLowerCase() === name.toLowerCase())
				: null;
			const file =
				inScope ??
				(scope
					? null
					: ((await findUserFile(env, userId, name)) ??
						(await filesInKnowledge(env, await visibleKnowledge(env, userId))).find(
							(entry) => entry.filename.toLowerCase() === name.toLowerCase()
						)));
			if (!file) return plain(`There is no file called ${name}.`, `No file named ${name}`);
			if (!file.content) {
				// Binary uploads carry no text: say why rather than returning blank.
				return plain(
					`${file.filename} has no extractable text. Only text files are decoded on upload.`,
					`${file.filename} has no text`
				);
			}

			const lines = file.content.split('\n');
			const offset = Math.max(1, Number(args.offset) || 1);
			const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			// Numbered, so a line from grep_files can be asked for by number and the
			// model can cite where in the file something came from.
			const body = slice.map((line, index) => `${offset + index}\t${line}`).join('\n');
			const range =
				slice.length === lines.length
					? `${lines.length} lines`
					: `lines ${offset}-${offset + slice.length - 1} of ${lines.length}`;

			return {
				content: `<source id="1" name="${file.filename}">${body}</source>`,
				sources: [
					{
						source: { id: file.id, name: file.filename },
						document: [slice.join('\n')],
						metadata: [{ source: file.id, name: file.filename, file_id: file.id }]
					}
				],
				status: `Read ${file.filename} (${range})`
			};
		}

		case 'create_file': {
			const name = String(args.name ?? '').trim();
			const content = String(args.content ?? '');
			if (!name) return plain('A file name is required.', 'Create called with no name');
			const existing = await findUserFile(env, userId, name);
			if (existing) {
				// Overwriting silently would lose whatever was there; the model has
				// edit_file for changes and can pick another name for a new file.
				return plain(
					`${name} already exists. Use edit_file to change it, or choose another name.`,
					`${name} already exists`
				);
			}
			const scope = await scopeToKnowledge(env, context, args.knowledge);
			if (isOutcome(scope)) return scope;
			if (scope && !(await canWrite(env, userId, scope.base))) {
				return plain(
					`You do not have write access to ${scope.base.name}.`,
					`No write access to ${scope.base.name}`
				);
			}

			const file = await createUserFile(env, userId, name, content);
			if (scope) await attachFileToKnowledge(env, scope.base.id, file.id);
			return plain(
				`Created ${file.filename} (${content.length} characters)${scope ? ` in ${scope.base.name}` : ''}.`,
				`Created ${file.filename}${scope ? ` in ${scope.base.name}` : ''}`
			);
		}

		case 'edit_file': {
			const name = String(args.name ?? '').trim();
			const result = await editUserFile(
				env,
				userId,
				name,
				String(args.old_text ?? ''),
				String(args.new_text ?? ''),
				{ replaceAll: Boolean(args.replace_all) }
			);
			if (result.ok) {
				return plain(
					`Edited ${result.file.filename} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'}).`,
					`Edited ${result.file.filename}`
				);
			}
			if (result.reason === 'not-found') {
				return plain(`There is no file called ${name}.`, `No file named ${name}`);
			}
			if (result.reason === 'ambiguous') {
				return plain(
					`old_text appears ${result.occurrences} times in ${name}. Pass a longer, ` +
						'unique excerpt, or set replace_all.',
					`${name}: the text to replace is ambiguous`
				);
			}
			return plain(
				`old_text was not found in ${name}. Read the file and copy the passage exactly.`,
				`${name}: no match for the text to replace`
			);
		}

		default:
			return null;
	}
}

/**
 * Finding things, as opposed to reading or changing them.
 *
 * `glob_files` and `grep_files` are the workspace equivalents of the tools a
 * coding assistant uses to orient itself. `search_chats` has no shell
 * equivalent at all and is the most useful of the three here: the user's own
 * history is a corpus they cannot grep any other way.
 */
export const SEARCH_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'glob_files',
			description:
				"Find the user's files by name pattern — `*.md`, `notes-*`, `**/*.csv`. " +
				'Use it before reading when you are not sure of the exact name.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'A glob pattern matched against file names.' },
					knowledge: { type: 'string', description: 'Search inside this knowledge base.' }
				},
				required: ['pattern']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'grep_files',
			description:
				"Search the contents of the user's files with a regular expression. Returns " +
				'each matching line with its file and line number, which read_file can then ' +
				'read around. Prefer this over reading whole files to find something.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'A JavaScript regular expression.' },
					glob: { type: 'string', description: 'Only search files whose name matches this glob.' },
					knowledge: { type: 'string', description: 'Search inside this knowledge base.' },
					case_sensitive: { type: 'boolean', description: 'Match case exactly. Defaults to false.' }
				},
				required: ['pattern']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'search_chats',
			description:
				'Search the user’s own past conversations. Use it when they refer to ' +
				'something discussed before — "what did we decide about X", "the approach I ' +
				'mentioned last week" — or to avoid contradicting an earlier answer.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to look for in earlier messages.' }
				},
				required: ['query']
			}
		}
	}
] as const;

/** Memory, file and search tools; returns null for anything it does not handle. */
async function runWorkspaceTool(
	env: Env,
	call: ToolCall,
	args: Record<string, any>,
	context: ToolContext
): Promise<ToolOutcome | null> {
	const userId = context.userId;

	if (call.name === 'glob_files') {
		const pattern = String(args.pattern ?? '*');
		const scope = await scopeToKnowledge(env, context, args.knowledge);
		if (isOutcome(scope)) return scope;

		const matcher = globToRegExp(pattern.trim() || '*');
		const hits = scope
			? scope.files
					.filter((file) => matcher.test(file.filename))
					.map((file) => ({ filename: file.filename, characters: file.content.length }))
			: await globFiles(env, userId, pattern);
		const where = scope ? ` in ${scope.base.name}` : '';
		if (!hits.length)
			return plain(`No files match ${pattern}${where}.`, `No files match ${pattern}`);
		const listed = hits.map((hit) => `- ${hit.filename} (${hit.characters} characters)`).join('\n');
		return plain(
			`Files matching ${pattern}${where}:\n${listed}`,
			`${hits.length} files match ${pattern}${where}`
		);
	}

	if (call.name === 'grep_files') {
		const pattern = String(args.pattern ?? '');
		const scope = await scopeToKnowledge(env, context, args.knowledge);
		if (isOutcome(scope)) return scope;

		const result = scope
			? grepIn(
					scope.files.map((file) => ({ filename: file.filename, content: file.content })),
					pattern,
					{ glob: args.glob ? String(args.glob) : undefined, ignoreCase: !args.case_sensitive }
				)
			: await grepFiles(env, userId, pattern, {
					glob: args.glob ? String(args.glob) : undefined,
					ignoreCase: args.case_sensitive ? false : true
				});
		if (result.error) return plain(result.error, `grep_files: ${result.error}`);
		// Naming the base in the status matters as much as scoping to it: the user
		// watching the strip should see where the model actually looked.
		const where = scope ? ` in ${scope.base.name}` : '';
		if (!result.hits.length) {
			return plain(
				`No matches for /${pattern}/ in ${result.filesSearched} files${where}.`,
				`No matches for ${pattern}${where}`
			);
		}
		const listed = result.hits.map((hit) => `${hit.filename}:${hit.line}: ${hit.text}`).join('\n');
		return plain(
			`Matches for /${pattern}/${where}:\n${listed}`,
			`${result.hits.length} matches for ${pattern}${where}`
		);
	}

	if (call.name === 'search_chats') {
		const query = String(args.query ?? '').trim();
		const hits = await searchChats(env, userId, query);
		if (!hits.length) {
			return plain(
				`Nothing in earlier conversations matches "${query}".`,
				`No history for ${query}`
			);
		}
		const listed = hits
			.map(
				(hit) =>
					`- ${hit.title} (${new Date(hit.created_at * 1000).toISOString().slice(0, 10)}, ${hit.role}): ${hit.excerpt}`
			)
			.join('\n');
		return plain(
			`From earlier conversations:\n${listed}`,
			`Found ${hits.length} earlier messages about "${query}"`
		);
	}

	return null;
}

export const TODO_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'todo_write',
			description:
				'Record the plan for a job that takes several steps, and keep it current: ' +
				'mark a step in_progress before starting it and completed as soon as it is ' +
				'done. Send the whole list every time — it replaces the previous one, so ' +
				'anything you leave out is dropped. Exactly one step should be in_progress. ' +
				'Skip this for a request you can answer in one go.',
			parameters: {
				type: 'object',
				properties: {
					todos: {
						type: 'array',
						description: 'The complete plan, in order.',
						items: {
							type: 'object',
							properties: {
								content: { type: 'string', description: 'The step, as an imperative.' },
								status: {
									type: 'string',
									enum: ['pending', 'in_progress', 'completed'],
									description: 'Where the step has got to.'
								}
							},
							required: ['content', 'status']
						}
					}
				},
				required: ['todos']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'todo_read',
			description:
				'Read the plan for this conversation. It survives between messages, so call ' +
				'this when picking up work from an earlier turn.',
			parameters: { type: 'object', properties: {}, required: [] }
		}
	}
] as const;

/** The plan tools; returns null for anything it does not handle. */
async function runTodoTool(
	env: Env,
	call: ToolCall,
	args: Record<string, any>,
	context: ToolContext
): Promise<ToolOutcome | null> {
	if (call.name !== 'todo_write' && call.name !== 'todo_read') return null;

	const chatId = context.chatId ?? '';
	// A temporary chat is never written to the database, so there is nowhere to
	// keep a plan. Saying so beats failing the turn over it.
	const unavailable = plain(
		'A plan cannot be kept for this conversation — it is not a saved chat.',
		'No plan available here'
	);

	if (call.name === 'todo_read') {
		const todos = await readTodos(env, context.userId, chatId);
		if (todos === null) return unavailable;
		if (!todos.length) return plain('No plan has been recorded yet.', 'No plan yet');
		return plain(`The plan for this conversation:\n${renderTodos(todos)}`, todoSummary(todos));
	}

	const todos = normalizeTodos(args.todos);
	const written = await writeTodos(env, context.userId, chatId, todos);
	if (!written) return unavailable;
	return plain(
		todos.length ? `Plan recorded:\n${renderTodos(todos)}` : 'Plan cleared.',
		todoSummary(todos)
	);
}

export const KNOWLEDGE_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'list_knowledge',
			description:
				'List the knowledge bases the user can see, with how many files each holds. ' +
				'Call this first when they mention a collection by name and you need its ' +
				'exact name for the other tools.',
			parameters: { type: 'object', properties: {}, required: [] }
		}
	},
	{
		type: 'function',
		function: {
			name: 'search_knowledge',
			description:
				"Search the contents of the user's knowledge bases and return the passages " +
				'that match, as citable sources. This is the right tool for "what do my ' +
				'documents say about X" — prefer it over reading whole files.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to look for.' },
					knowledge: {
						type: 'string',
						description: 'Limit to one knowledge base, by name. Omit to search all of them.'
					}
				},
				required: ['query']
			}
		}
	}
] as const;

/** Knowledge tools; returns null for anything it does not handle. */
async function runKnowledgeTool(
	env: Env,
	call: ToolCall,
	args: Record<string, any>,
	context: ToolContext
): Promise<ToolOutcome | null> {
	if (call.name === 'list_knowledge') {
		const bases = await visibleKnowledge(env, context.userId);
		if (!bases.length) return plain('There are no knowledge bases.', 'No knowledge bases');
		const files = await filesInKnowledge(env, bases);
		const counts = new Map<string, number>();
		for (const file of files)
			counts.set(file.knowledge_id, (counts.get(file.knowledge_id) ?? 0) + 1);
		const listed = bases
			.map(
				(base) =>
					`- ${base.name} (${counts.get(base.id) ?? 0} files)${base.description ? ` — ${base.description}` : ''}`
			)
			.join('\n');
		return plain(`Knowledge bases:\n${listed}`, `Listed ${bases.length} knowledge bases`);
	}

	if (call.name === 'search_knowledge') {
		const query = String(args.query ?? '').trim();
		if (!query) return plain('No query was given.', 'Search called with no query');

		const named = args.knowledge ? String(args.knowledge) : '';
		const bases = named
			? ([await findKnowledge(env, context.userId, named)].filter(Boolean) as KnowledgeBase[])
			: await visibleKnowledge(env, context.userId);
		if (named && !bases.length) {
			return plain(`There is no knowledge base called ${named}.`, `No knowledge base ${named}`);
		}
		if (!bases.length)
			return plain('There are no knowledge bases to search.', 'No knowledge bases');

		const chunks = await search(env, query, { knowledgeIds: bases.map((base) => base.id) });
		if (!chunks.length) {
			return plain(`Nothing in the knowledge bases matches "${query}".`, `No matches for ${query}`);
		}

		// Chunks carry a file id, not a name; resolve names once for citations.
		const files = await filesInKnowledge(env, bases);
		const byFile = new Map(files.map((file) => [file.id, file]));

		const parts: string[] = [];
		const sources: Record<string, unknown>[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const file = chunk.file_id ? byFile.get(chunk.file_id) : undefined;
			const name = file ? `${file.knowledge_name} / ${file.filename}` : 'knowledge';
			parts.push(`<source id="${index + 1}" name="${name}">${chunk.content}</source>`);
			sources.push({
				source: { id: chunk.file_id ?? String(index), name },
				document: [chunk.content],
				metadata: [{ source: chunk.file_id ?? name, name, file_id: chunk.file_id }]
			});
		}
		return {
			content: parts.join('\n'),
			sources,
			status: `Searched knowledge for "${query}" (${sources.length} passage${sources.length === 1 ? '' : 's'})`
		};
	}

	return null;
}
