/** `/api/v1/tasks` — title/tag/query generation using the task model. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { generateText, taskModelId } from '../lib/completions';
import {
	FOLLOW_UP_GENERATION_PROMPT,
	TAGS_GENERATION_PROMPT,
	TITLE_GENERATION_PROMPT,
	extractJSON,
	renderMessages
} from '../lib/prompts';
import { bad } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const TASK_KEYS: Record<string, string> = {
	TASK_MODEL: 'task.model',
	TASK_MODEL_EXTERNAL: 'task.model_external',
	ENABLE_TITLE_GENERATION: 'task.title.enable',
	TITLE_GENERATION_PROMPT_TEMPLATE: 'task.title.prompt_template',
	ENABLE_TAGS_GENERATION: 'task.tags.enable',
	TAGS_GENERATION_PROMPT_TEMPLATE: 'task.tags.prompt_template',
	ENABLE_FOLLOW_UP_GENERATION: 'task.follow_up.enable',
	ENABLE_AUTOCOMPLETE_GENERATION: 'task.autocomplete.enable',
	ENABLE_SEARCH_QUERY_GENERATION: 'task.query.enable',
	ENABLE_RETRIEVAL_QUERY_GENERATION: 'task.query.enable'
};

app.get('/config', async (c) => {
	verifiedUser(c);
	const config = await getConfigMany(c.env, Object.values(TASK_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(TASK_KEYS)) out[field] = config[key] ?? null;
	return c.json(out);
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(TASK_KEYS))
		if (field in body) updates[key] = body[field];
	await setConfigMany(c.env, updates);
	const config = await getConfigMany(c.env, Object.values(TASK_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(TASK_KEYS)) out[field] = config[key] ?? null;
	return c.json(out);
});

/** Wraps generated text in the OpenAI response envelope the UI parses. */
const completionEnvelope = (model: string, content: string) => ({
	id: `task-${Date.now()}`,
	object: 'chat.completion',
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
});

async function runTask(c: any, prompt: string, maxTokens = 300) {
	verifiedUser(c);
	const body = (await c.req.json()) as { model?: string; messages?: any[] };
	if (!body.model) throw bad('Model is required');
	const model = await taskModelId(c.env, body.model);
	const content = await generateText(c.env, model, [{ role: 'user', content: prompt }], {
		maxTokens
	});
	return c.json(completionEnvelope(model, content));
}

app.post('/title/completions', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { model?: string; messages?: any[] };
	verifiedUser(c);
	if (!body.model) throw bad('Model is required');
	const model = await taskModelId(c.env, body.model);
	const prompt = TITLE_GENERATION_PROMPT.replace(
		'{{MESSAGES}}',
		renderMessages(body.messages ?? [], 2)
	);
	const content = await generateText(c.env, model, [{ role: 'user', content: prompt }], {
		maxTokens: 100
	});
	return c.json(completionEnvelope(model, content));
});

app.post('/tags/completions', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { model?: string; messages?: any[] };
	verifiedUser(c);
	if (!body.model) throw bad('Model is required');
	const model = await taskModelId(c.env, body.model);
	const prompt = TAGS_GENERATION_PROMPT.replace(
		'{{MESSAGES}}',
		renderMessages(body.messages ?? [], 6)
	);
	const content = await generateText(c.env, model, [{ role: 'user', content: prompt }], {
		maxTokens: 200
	});
	return c.json(completionEnvelope(model, content));
});

app.post('/follow_up/completions', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { model?: string; messages?: any[] };
	verifiedUser(c);
	if (!body.model) throw bad('Model is required');
	const model = await taskModelId(c.env, body.model);
	const prompt = FOLLOW_UP_GENERATION_PROMPT.replace(
		'{{MESSAGES}}',
		renderMessages(body.messages ?? [], 6)
	);
	const content = await generateText(c.env, model, [{ role: 'user', content: prompt }], {
		maxTokens: 300
	});
	return c.json(completionEnvelope(model, content));
});

app.post('/queries/completions', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { model?: string; messages?: any[] };
	verifiedUser(c);
	if (!body.model) throw bad('Model is required');
	const model = await taskModelId(c.env, body.model);
	const prompt =
		'Given the conversation below, produce up to 3 concise web-search queries that would help answer ' +
		'the final user message. Respond with JSON only: { "queries": ["query 1", "query 2"] }\n\n' +
		renderMessages(body.messages ?? [], 6);
	const content = await generateText(c.env, model, [{ role: 'user', content: prompt }], {
		maxTokens: 200
	});
	return c.json(completionEnvelope(model, content));
});

app.post('/emoji/completions', async (c) =>
	runTask(c, 'Reply with a single emoji that best matches the conversation.', 10)
);

app.post('/auto/completions', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { model?: string; prompt?: string };
	verifiedUser(c);
	if (!body.model) throw bad('Model is required');
	const model = await taskModelId(c.env, body.model);
	const prompt =
		'Continue the following text naturally with at most one sentence. Respond with JSON only: ' +
		`{ "text": "..." }\n\n${body.prompt ?? ''}`;
	const content = await generateText(c.env, model, [{ role: 'user', content: prompt }], {
		maxTokens: 100
	});
	return c.json(completionEnvelope(model, content));
});

app.post('/moa/completions', async (c) =>
	runTask(c, 'Synthesize the provided model responses into a single best answer.', 800)
);

export { extractJSON };
export default app;
