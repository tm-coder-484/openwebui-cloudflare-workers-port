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
// `mock-reasoner` streams reasoning_content the way a thinking model does,
// which is the case that used to render as an empty message.
// Milliseconds between streamed tokens. The default keeps the suites quick;
// raise it to watch a slow model stream, which is when in-progress rendering
// matters and when a fast one is too quick to observe.
const TOKEN_DELAY = Number(process.env.MOCK_OPENAI_DELAY ?? 20);
let busyOnceServed = false;
const MODELS = ['mock-gpt', 'mock-gpt-mini', 'mock-reasoner', 'mock-tools', 'mock-no-tools'];

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

// The recent chat requests this mock was sent. A test that needs to know what
// the Worker put on the wire — rather than what came back — reads them from
// here. A list rather than the last one alone: a turn is followed by its
// background tasks, so "the last request" is a title prompt, not the turn.
const recentRequests = [];

createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	if (url.pathname.endsWith('/__recent-requests')) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(recentRequests));
		return;
	}

	if (url.pathname.endsWith('/__reset-requests')) {
		recentRequests.length = 0;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{"ok":true}');
		return;
	}

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
		// Rate-limits one nominated key, so key failover can be exercised.
		if ((req.headers.authorization ?? '').includes('rate-limited-key')) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
		}
		// Mimics Ollama Cloud's concurrency limit: the first call is rejected with a
		// bare-string body and a retry-after, the next succeeds.
		if ((req.headers.authorization ?? '').includes('busy-once')) {
			if (!busyOnceServed) {
				busyOnceServed = true;
				res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' });
				return res.end(JSON.stringify({ error: 'too many concurrent requests' }));
			}
		}
		const body = await readBody(req);
		recentRequests.push(body);
		if (recentRequests.length > 20) recentRequests.shift();

		// Answers a query-generation prompt the way a real task model would, so the
		// web-search path can be exercised end to end.
		if (JSON.stringify(body?.messages ?? []).includes('Strictly return in JSON format')) {
			const reply = JSON.stringify({
				id: 'q1',
				object: 'chat.completion',
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: '{"queries":["d1 read replica latency"]}' },
						finish_reason: 'stop'
					}
				]
			});
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(reply);
			return;
		}
		if (process.env.MOCK_OPENAI_DEBUG) {
			console.log('[mock] request body:', JSON.stringify(body).slice(0, 800));
		}

		// `mock-no-tools` stands in for a model whose endpoint rejects `tools`, so
		// the fallback to searching before the turn can be exercised.
		if (body.model === 'mock-no-tools' && body.tools) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: { message: 'This model does not support tools' } }));
		}

		// `mock-tools` calls one tool, then answers from what came back. Which tool
		// is chosen by a TOOLTEST: marker in the conversation, so the smoke test can
		// drive memory and file tools as well as search. The arguments are split
		// across chunks the way real providers stream them.
		const alreadyRan = (body.messages ?? []).some((message) => message.role === 'tool');
		const conversation = JSON.stringify(body.messages ?? []);
		const marker = /TOOLTEST:(\w+)(?:\s+([^"\\]*))?/.exec(conversation);
		const toolCallFrames = () => {
			const kind = marker?.[1];
			const rest = (marker?.[2] ?? '').trim();
			const one = (name, args) => [
				{
					index: 0,
					id: `call_mock_${name}`,
					type: 'function',
					function: { name, arguments: JSON.stringify(args) }
				}
			];
			if (kind === 'remember') return one('remember', { content: rest || 'a remembered fact' });
			if (kind === 'recall') return one('recall', { query: rest });
			if (kind === 'create')
				return one('create_file', { name: 'agent-note.md', content: 'alpha\nbravo\ncharlie' });
			if (kind === 'edit')
				return one('edit_file', { name: 'agent-note.md', old_text: 'bravo', new_text: 'delta' });
			if (kind === 'list') return one('list_files', {});
			if (kind === 'glob') return one('glob_files', { pattern: '*.md' });
			if (kind === 'grep') return one('grep_files', { pattern: 'bravo' });
			if (kind === 'history') return one('search_chats', { query: rest || 'durable objects' });
			if (kind === 'plan')
				return one('todo_write', {
					todos: [
						{ content: 'Find the notes', status: 'completed' },
						{ content: 'Edit them', status: 'in_progress' },
						{ content: 'Check the result', status: 'pending' }
					]
				});
			if (kind === 'planread') return one('todo_read', {});
			if (kind === 'kblist') return one('list_knowledge', {});
			if (kind === 'kbsearch') return one('search_knowledge', { query: rest || 'edge javascript' });
			if (kind === 'kbfiles') return one('list_files', { knowledge: rest || 'Tool KB' });
			if (kind === 'kbgrep')
				return one('grep_files', { pattern: 'Cloudflare', knowledge: rest || 'Tool KB' });
			return [
				{
					index: 0,
					id: 'call_mock_1',
					type: 'function',
					function: { name: 'web_search', arguments: '{"qu' }
				},
				{ index: 0, function: { arguments: 'ery":"cloud' } },
				{ index: 0, function: { arguments: 'flare workers"}' } }
			];
		};
		if (body.model === 'mock-tools' && body.tools && !alreadyRan) {
			const frames = toolCallFrames();
			const unusedFrames = [
				{
					index: 0,
					id: 'call_mock_1',
					type: 'function',
					function: { name: 'web_search', arguments: '{"qu' }
				},
				{ index: 0, function: { arguments: 'ery":"cloud' } },
				{ index: 0, function: { arguments: 'flare workers"}' } }
			];
			if (!body.stream) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(
					JSON.stringify({
						id: 'mock-tool-1',
						object: 'chat.completion',
						model: body.model,
						choices: [
							{
								index: 0,
								message: {
									role: 'assistant',
									content: null,
									tool_calls: [
										{
											id: 'call_mock_1',
											type: 'function',
											function: { name: 'web_search', arguments: '{"query":"cloudflare workers"}' }
										}
									]
								},
								finish_reason: 'tool_calls'
							}
						]
					})
				);
			}
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive'
			});
			for (const delta of frames) {
				res.write(
					`data: ${JSON.stringify({
						id: 'mock-tool-1',
						object: 'chat.completion.chunk',
						model: body.model,
						choices: [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }]
					})}\n\n`
				);
			}
			res.write(
				`data: ${JSON.stringify({
					id: 'mock-tool-1',
					object: 'chat.completion.chunk',
					model: body.model,
					choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
				})}\n\n`
			);
			res.write('data: [DONE]\n\n');
			return res.end();
		}
		const content = reply(body.messages);

		if (!body.stream) {
			// A reasoning model thinks before it answers, and providers disagree
			// about where that goes. Two shapes matter for the background tasks:
			//
			//   - the thinking arrives inline in `content`, wrapped in <think>,
			//     and is full of braces, which is what breaks a parser that scans
			//     from the first `{` to the last `}`;
			//   - the budget runs out mid-thought, so the answer never arrives at
			//     all and `content` holds only a truncated thought.
			//
			// Both are what "title generation is unreliable with reasoning models"
			// looks like from the server.
			if (body.model === 'mock-reasoner') {
				const thought =
					'<think>\nLet me consider the format. They want { "title": "..." } as ' +
					'raw JSON. I could answer {"title": "Draft"} but let me reconsider — ' +
					'a shorter phrasing reads better.\n</think>\n';
				// max_tokens is spent on thinking first, exactly as upstream spends it.
				const budget = body.max_tokens ?? body.max_completion_tokens ?? 1000;
				const truncated = budget < 400;
				const payload = truncated ? thought.slice(0, 200) : thought + content;
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						id: 'mock-1',
						object: 'chat.completion',
						created: Math.floor(Date.now() / 1000),
						model: body.model,
						choices: [
							{
								index: 0,
								message: { role: 'assistant', content: payload },
								finish_reason: truncated ? 'length' : 'stop'
							}
						],
						usage: { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310 }
					})
				);
				return;
			}

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
			// A thinking model streams its working as reasoning_content and its
			// answer as content, both on `delta`. It thinks twice: once before
			// answering and once in the middle, which is the case that used to
			// render as nothing at all because the reopened block was glued to
			// the end of the previous line instead of starting its own.
			const thinking = body.model === 'mock-reasoner' && (index < 3 || (index >= 6 && index < 8));
			const token = (index ? ' ' : '') + words[index];
			res.write(
				`data: ${JSON.stringify({
					id: 'mock-1',
					object: 'chat.completion.chunk',
					model: body.model ?? MODELS[0],
					choices: [
						{
							index: 0,
							delta: thinking ? { reasoning_content: token } : { content: token },
							finish_reason: null
						}
					]
				})}\n\n`
			);
			index += 1;
		}, TOKEN_DELAY);
		return;
	}

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: { message: `Unknown path ${url.pathname}` } }));
}).listen(PORT, '127.0.0.1', () => {
	console.log(`Mock OpenAI-compatible API listening on http://127.0.0.1:${PORT}/v1`);
});
