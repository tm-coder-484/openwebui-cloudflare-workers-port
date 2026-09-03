/**
 * Automations: scheduled prompts.
 *
 * A Cron Trigger wakes the Worker every minute; due automations create a chat
 * (or post into a channel) and run their prompt through the same completion
 * pipeline as an interactive message, so streaming, persistence and background
 * tasks all behave identically.
 */

import type { Env } from '../types';
import { insertChat, type ChatContent } from './chats';
import { startCompletion } from './hub';
import { nextOccurrence } from './rrule';
import { getUserById } from './users';
import { now, parseJSON, toBool, toJSON, uuid } from './util';

export interface AutomationRow {
	id: string;
	user_id: string;
	folder_id: string | null;
	name: string;
	data: string;
	meta: string | null;
	is_active: number;
	last_run_at: number | null;
	next_run_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface AutomationData {
	prompt: string;
	model_id: string;
	rrule: string;
	target?: { type?: string; channel_id?: string };
}

/** The frontend stores automation timestamps in nanoseconds. */
export const msToNs = (ms: number): number => ms * 1_000_000;
export const nsToMs = (ns: number): number => Math.floor(ns / 1_000_000);

export function serializeAutomation(row: AutomationRow, extra: Record<string, unknown> = {}) {
	return {
		id: row.id,
		user_id: row.user_id,
		folder_id: row.folder_id,
		name: row.name,
		data: parseJSON<AutomationData>(row.data, { prompt: '', model_id: '', rrule: '' }),
		meta: parseJSON<Record<string, unknown> | null>(row.meta, null),
		is_active: toBool(row.is_active),
		last_run_at: row.last_run_at,
		next_run_at: row.next_run_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
		...extra
	};
}

/** Next fire time in nanoseconds, resolved in the owner's timezone. */
export async function computeNextRun(
	env: Env,
	row: Pick<AutomationRow, 'user_id' | 'data'>,
	after: number = Date.now()
): Promise<number | null> {
	const data = parseJSON<AutomationData>(row.data, { prompt: '', model_id: '', rrule: '' });
	if (!data.rrule) return null;
	const user = await getUserById(env, row.user_id);
	const next = nextOccurrence(data.rrule, after, user?.timezone ?? null);
	return next === null ? null : msToNs(next);
}

export async function recordRun(
	env: Env,
	automationId: string,
	status: 'success' | 'error',
	options: { chatId?: string | null; error?: string | null } = {}
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO automation_run (id, automation_id, chat_id, status, error, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
	)
		.bind(
			uuid(),
			automationId,
			options.chatId ?? null,
			status,
			options.error ?? null,
			msToNs(Date.now())
		)
		.run();
}

/**
 * Runs one automation now: creates the chat, seeds the user turn, and hands the
 * completion to the socket hub. Returns the chat id it wrote into.
 */
export async function runAutomation(env: Env, row: AutomationRow): Promise<string> {
	const data = parseJSON<AutomationData>(row.data, { prompt: '', model_id: '', rrule: '' });
	if (!data.prompt || !data.model_id) throw new Error('Automation is missing a prompt or model');

	const userMessageId = uuid();
	const assistantMessageId = uuid();
	const timestamp = now();
	const chatId = uuid();

	const content: ChatContent = {
		id: chatId,
		title: row.name || 'Automation',
		models: [data.model_id],
		history: {
			currentId: assistantMessageId,
			messages: {
				[userMessageId]: {
					id: userMessageId,
					parentId: null,
					childrenIds: [assistantMessageId],
					role: 'user',
					content: data.prompt,
					timestamp
				},
				[assistantMessageId]: {
					id: assistantMessageId,
					parentId: userMessageId,
					childrenIds: [],
					role: 'assistant',
					content: '',
					done: false,
					model: data.model_id,
					timestamp
				}
			}
		},
		messages: [{ role: 'user', content: data.prompt }],
		files: [],
		tags: [],
		timestamp: Date.now()
	};

	await insertChat(env, row.user_id, content, {
		id: chatId,
		folderId: row.folder_id,
		variables: {}
	});
	await env.DB.prepare('UPDATE chat SET meta = ?1 WHERE id = ?2')
		.bind(toJSON({ automation_id: row.id }), chatId)
		.run();

	await startCompletion(env, {
		userId: row.user_id,
		chatId,
		messageId: assistantMessageId,
		modelId: data.model_id,
		taskId: uuid(),
		saveToChat: true,
		backgroundTasks: { title_generation: false, tags_generation: false },
		body: {
			stream: true,
			model: data.model_id,
			messages: [{ role: 'user', content: data.prompt }],
			user_message: {
				id: userMessageId,
				parentId: null,
				childrenIds: [assistantMessageId],
				role: 'user',
				content: data.prompt
			}
		}
	});

	return chatId;
}

/**
 * Cron entry point: runs everything due and reschedules it. Bounded per tick so
 * one busy minute cannot exhaust the Worker's time budget.
 */
export async function runDueAutomations(env: Env, limit = 25): Promise<number> {
	const nowNs = msToNs(Date.now());
	const { results } = await env.DB.prepare(
		`SELECT * FROM automation
		 WHERE is_active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
		 ORDER BY next_run_at ASC LIMIT ${limit}`
	)
		.bind(nowNs)
		.all<AutomationRow>();

	let ran = 0;
	for (const row of results ?? []) {
		// Reschedule first: a failure must not leave the automation hot-looping.
		const next = await computeNextRun(env, row, Date.now());
		await env.DB.prepare(
			'UPDATE automation SET last_run_at = ?1, next_run_at = ?2, updated_at = ?3 WHERE id = ?4'
		)
			.bind(nowNs, next, now(), row.id)
			.run();

		try {
			const chatId = await runAutomation(env, row);
			await recordRun(env, row.id, 'success', { chatId });
			ran += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[open-webui] automation ${row.id} failed:`, message);
			await recordRun(env, row.id, 'error', { error: message });
		}
	}
	return ran;
}
