/**
 * A tiny OpenAI-compatible server for local development.
 *
 * Lets you exercise the whole chat pipeline (streaming, title generation,
 * follow-ups) without an API key:
 *
 *   node scripts/mock-openai.mjs           # listens on http://127.0.0.1:11435/v1
 *   wrangler secret / .dev.vars:  OPENAI_API_BASE_URL=http://127.0.0.1:11435/v1
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_OPENAI_PORT ?? 11435);
const MODELS = ['mock-gpt', 'mock-gpt-mini'];

const readBody = (req) =>
	new Promise((resolve) => {
		let data = '';
		req.on('data', (chunk) => (data += chunk));
		req.on('end', () => {
			try {
				resolve(JSON.parse(data || '{}'));
			} catch {
				resolve({});
			}
		});
	});

const reply = (messages) => {
	const last = [...(messages ?? [])].reverse().find((message) => message.role === 'user');
	const text =
		typeof last?.content === 'string'
			? last.content
			: (last?.content ?? []).map((part) => part?.text ?? '').join(' ');

	// Background task prompts ask for a specific JSON shape; answer in kind.
	if (text.includes('concise title')) return '{"title": "Mock Conversation"}';
	if (text.includes('categorizing the main themes')) return '{"tags": ["General", "Testing"]}';
	if (text.includes('follow-up questions'))
		return '{"follow_ups": ["Tell me more?", "Can you summarize that?"]}';
	return `Hello from the mock model! You said: ${text || '(nothing)'}`;
};

createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	if (url.pathname.endsWith('/models')) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				object: 'list',
				data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' }))
			})
		);
		return;
	}

	if (url.pathname.endsWith('/chat/completions')) {
		const body = await readBody(req);
		if (process.env.MOCK_OPENAI_DEBUG) {
			console.log('[mock] request body:', JSON.stringify(body).slice(0, 800));
		}
		const content = reply(body.messages);

		if (!body.stream) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					id: 'mock-1',
					object: 'chat.completion',
					created: Math.floor(Date.now() / 1000),
					model: body.model ?? MODELS[0],
					choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 10, completion_tokens: content.length, total_tokens: 42 }
				})
			);
			return;
		}

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		});
		const words = content.split(' ');
		let index = 0;
		const timer = setInterval(() => {
			if (index >= words.length) {
				clearInterval(timer);
				res.write(
					`data: ${JSON.stringify({
						id: 'mock-1',
						object: 'chat.completion.chunk',
						model: body.model ?? MODELS[0],
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
						usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 42 }
					})}\n\n`
				);
				res.write('data: [DONE]\n\n');
				res.end();
				return;
			}
			res.write(
				`data: ${JSON.stringify({
					id: 'mock-1',
					object: 'chat.completion.chunk',
					model: body.model ?? MODELS[0],
					choices: [
						{ index: 0, delta: { content: (index ? ' ' : '') + words[index] }, finish_reason: null }
					]
				})}\n\n`
			);
			index += 1;
		}, 20);
		return;
	}

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: { message: `Unknown path ${url.pathname}` } }));
}).listen(PORT, '127.0.0.1', () => {
	console.log(`Mock OpenAI-compatible API listening on http://127.0.0.1:${PORT}/v1`);
});
