/**
 * End-to-end smoke test against a running deployment.
 *
 *   node scripts/smoke.mjs                          # http://127.0.0.1:8787
 *   node scripts/smoke.mjs https://my-worker.dev    # a deployed Worker
 *
 * Signs up (or signs in) as a throwaway account and exercises every major API
 * group, including a streamed completion delivered over Socket.IO. Exits
 * non-zero if any check fails.
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const EMAIL = process.env.SMOKE_EMAIL ?? `smoke-${Date.now()}@example.com`;
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'smoke-test-password';
const NAME = 'Smoke Test';

let token = '';
let passed = 0;
const failures = [];

const check = async (label, fn) => {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
		console.log(`  ✗ ${label} — ${error.message}`);
	}
};

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

async function api(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(options.headers ?? {})
		}
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!response.ok) {
		throw new Error(
			`${options.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 200)}`
		);
	}
	return body;
}

console.log(`Open WebUI smoke test against ${BASE}\n`);

// --- Public surface -------------------------------------------------------
console.log('config');
const config = await api('/api/config');
await check('GET /api/config reports a version', async () =>
	assert(typeof config.version === 'string', 'no version')
);
await check('GET /api/version', async () => {
	const version = await api('/api/version');
	assert(version.version === config.version, 'version mismatch with /api/config');
});

// --- Auth -----------------------------------------------------------------
console.log('\nauth');
await check('sign up (or sign in) a test account', async () => {
	const signup = await api('/api/v1/auths/signup', {
		method: 'POST',
		body: JSON.stringify({ name: NAME, email: EMAIL, password: PASSWORD })
	}).catch(async () =>
		api('/api/v1/auths/signin', {
			method: 'POST',
			body: JSON.stringify({ email: EMAIL, password: PASSWORD })
		})
	);
	assert(signup.token, 'no token returned');
	token = signup.token;
});

const session = await api('/api/v1/auths/');
await check('GET /api/v1/auths/ returns the session user', async () =>
	assert(session.email === EMAIL, `unexpected session email ${session.email}`)
);

const isAdmin = session.role === 'admin';
if (session.role === 'pending') {
	console.log(
		'\nThe test account was created but is pending activation, which is the ' +
			'default for signups after the first admin exists.\nRe-run with an ' +
			'activated account:\n\n  SMOKE_EMAIL=you@example.com SMOKE_PASSWORD=... node scripts/smoke.mjs' +
			`${BASE === 'http://127.0.0.1:8787' ? '' : ' ' + BASE}\n`
	);
	process.exit(1);
}
if (!isAdmin) {
	console.log(`  ! account role is "${session.role}" — admin-only checks are skipped`);
}

// --- Chats ----------------------------------------------------------------
console.log('\nchats');
let chatId = '';
await check('create a chat', async () => {
	const chat = await api('/api/v1/chats/new', {
		method: 'POST',
		body: JSON.stringify({
			chat: { title: 'Smoke chat', models: ['none'], history: { currentId: null, messages: {} } }
		})
	});
	chatId = chat.id;
	assert(chatId, 'no chat id');
});
await check('list chats', async () => {
	const chats = await api('/api/v1/chats/?page=1');
	assert(
		Array.isArray(chats) && chats.some((chat) => chat.id === chatId),
		'chat missing from list'
	);
});
await check('tag, pin and archive a chat', async () => {
	await api(`/api/v1/chats/${chatId}/tags`, {
		method: 'POST',
		body: JSON.stringify({ name: 'smoke' })
	});
	await api(`/api/v1/chats/${chatId}/pin`, { method: 'POST' });
	await api(`/api/v1/chats/${chatId}/archive`, { method: 'POST' });
	const chat = await api(`/api/v1/chats/${chatId}`);
	assert(chat.archived === true, 'chat not archived');
	assert((chat.meta?.tags ?? []).includes('smoke'), 'tag not stored');
});
await check('share and unshare a chat', async () => {
	const shared = await api(`/api/v1/chats/${chatId}/share`, { method: 'POST' });
	assert(shared.share_id, 'no share id');
	const publicChat = await api(`/api/v1/chats/share/${shared.share_id}`);
	assert(publicChat.id === chatId, 'shared chat mismatch');
	await api(`/api/v1/chats/${chatId}/share`, { method: 'DELETE' });
});

// --- Folders --------------------------------------------------------------
console.log('\nfolders');
let folderId = '';
await check('create a folder and move the chat into it', async () => {
	const folder = await api('/api/v1/folders/', {
		method: 'POST',
		body: JSON.stringify({ name: `Smoke ${Date.now()}` })
	});
	folderId = folder.id;
	await api(`/api/v1/chats/${chatId}/folder`, {
		method: 'POST',
		body: JSON.stringify({ folder_id: folderId })
	});
	const chats = await api(`/api/v1/chats/folder/${folderId}`);
	assert(Array.isArray(chats), 'folder listing is not an array');
});

// --- Files and knowledge --------------------------------------------------
console.log('\nfiles & knowledge');
let fileId = '';
await check('upload a text file', async () => {
	const form = new FormData();
	form.append(
		'file',
		new Blob(['Cloudflare Workers run JavaScript at the edge.'], { type: 'text/plain' }),
		'smoke.txt'
	);
	const response = await fetch(`${BASE}/api/v1/files/`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: form
	});
	assert(response.ok, `upload failed: ${response.status}`);
	const file = await response.json();
	fileId = file.id;
	assert(fileId, 'no file id');
});
await check('read the file back', async () => {
	const response = await fetch(`${BASE}/api/v1/files/${fileId}/content`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	const text = await response.text();
	assert(text.includes('Cloudflare Workers'), 'file content mismatch');
});
if (isAdmin || session.permissions?.workspace?.knowledge) {
	await check('create a knowledge base and attach the file', async () => {
		const knowledge = await api('/api/v1/knowledge/create', {
			method: 'POST',
			body: JSON.stringify({ name: 'Smoke KB', description: 'smoke test' })
		});
		await api(`/api/v1/knowledge/${knowledge.id}/file/add`, {
			method: 'POST',
			body: JSON.stringify({ file_id: fileId })
		});
		const files = await api(`/api/v1/knowledge/${knowledge.id}/files`);
		assert(files.length === 1, 'file not attached');
		const search = await api('/api/v1/retrieval/query/collection', {
			method: 'POST',
			body: JSON.stringify({ collection_names: [knowledge.id], query: 'edge javascript', k: 3 })
		});
		assert((search.documents?.[0] ?? []).length > 0, 'retrieval returned nothing');
	});
}

// --- Web search -----------------------------------------------------------
// Needs `node scripts/mock-search.mjs` running; skipped otherwise so the smoke
// test still passes against a deployment with no local mock.
const SEARCH_MOCK = process.env.SMOKE_SEARCH_URL ?? 'http://127.0.0.1:9600';
const searchMockUp = await fetch(`${SEARCH_MOCK}/search?q=ping&format=json`)
	.then((response) => response.ok)
	.catch(() => false);

if (isAdmin && searchMockUp) {
	console.log('\nweb search');
	await check('save the web search settings and read them back', async () => {
		const saved = await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({
				web: {
					ENABLE_WEB_SEARCH: true,
					WEB_SEARCH_ENGINE: 'searxng',
					SEARXNG_QUERY_URL: SEARCH_MOCK,
					SEARXNG_LANGUAGE: 'en',
					// Not used by the searxng engine — checked because the field used
					// to be dropped on save and came back blank on the next reload.
					OLLAMA_CLOUD_WEB_SEARCH_API_KEY: 'smoke-ollama-key',
					WEB_SEARCH_RESULT_COUNT: 2
				}
			})
		});
		assert(saved.web, 'the response has no `web` object for the admin screen to read');
		assert(saved.web.WEB_SEARCH_ENGINE === 'searxng', 'engine not saved');
		assert(saved.web.SEARXNG_QUERY_URL === SEARCH_MOCK, 'searxng URL not saved');
		assert(
			saved.web.OLLAMA_CLOUD_WEB_SEARCH_API_KEY === 'smoke-ollama-key',
			'the Ollama Cloud key was dropped on save'
		);

		const reloaded = await api('/api/v1/retrieval/config');
		assert(reloaded.web.SEARXNG_LANGUAGE === 'en', 'searxng language did not persist');
		assert(
			reloaded.web.OLLAMA_CLOUD_WEB_SEARCH_API_KEY === 'smoke-ollama-key',
			'the Ollama Cloud key did not persist'
		);

		// These inputs are marked `required` on the screen and are rendered for
		// every engine, so a null leaves the browser refusing to submit the form
		// — nothing on the whole tab can be saved, with no error to explain it.
		for (const field of [
			'WEB_SEARCH_RESULT_COUNT',
			'WEB_SEARCH_CONCURRENT_REQUESTS',
			'WEB_LOADER_CONCURRENT_REQUESTS'
		]) {
			assert(
				reloaded.web[field] !== null && reloaded.web[field] !== undefined,
				`${field} is required by the screen but the backend returned nothing, which blocks Save`
			);
		}
	});

	await check('search the web and load the result pages', async () => {
		const result = await api('/api/v1/retrieval/process/web/search', {
			method: 'POST',
			body: JSON.stringify({ query: 'cloudflare workers' })
		});
		const docs = result.docs ?? result.documents ?? [];
		assert(docs.length > 0, 'no search results came back');
		const text = JSON.stringify(docs);
		assert(text.includes('V8 isolates'), 'the result pages were not loaded into text');
		assert(!text.includes('console.log'), 'page scripts leaked into the extracted text');
	});

	await check('use the text the engine returned instead of loading the page again', async () => {
		// Ollama's search returns whole pages, not snippets. Re-fetching those
		// URLs costs a round trip each and, on Ollama, one more call against a
		// rate-limited free tier, for text already in hand.
		const before = await fetch(`${SEARCH_MOCK}/page-loads`).then((r) => r.json());
		const result = await api('/api/v1/retrieval/process/web/search', {
			method: 'POST',
			body: JSON.stringify({ query: 'fulltext cloudflare workers' })
		});
		const after = await fetch(`${SEARCH_MOCK}/page-loads`).then((r) => r.json());

		const docs = result.docs ?? [];
		assert(docs.length > 0, 'no search results came back');
		assert(
			docs.every((doc) => doc.content.length > 500),
			'the full page text from the engine did not reach the model'
		);
		assert(
			after.pageLoads === before.pageLoads,
			`the pages were fetched again anyway (${after.pageLoads - before.pageLoads} extra loads)`
		);
	});

	await check('report an unimplemented engine instead of searching another one', async () => {
		await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ web: { WEB_SEARCH_ENGINE: 'kagi' } })
		});
		const failed = await api('/api/v1/retrieval/process/web/search', {
			method: 'POST',
			body: JSON.stringify({ query: 'anything' })
		}).then(
			() => null,
			(error) => error.message
		);
		assert(failed && /not implemented/i.test(failed), `expected a clear refusal, got: ${failed}`);
		// Leave the deployment on a working engine.
		await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ web: { WEB_SEARCH_ENGINE: 'searxng' } })
		});
	});
}

// --- Notes and memories ---------------------------------------------------
console.log('\nnotes & memories');
await check('create and update a note', async () => {
	const note = await api('/api/v1/notes/create', {
		method: 'POST',
		body: JSON.stringify({ title: 'Smoke note', data: { content: { md: 'hello' } } })
	});
	const updated = await api(`/api/v1/notes/${note.id}/update`, {
		method: 'POST',
		body: JSON.stringify({ title: 'Smoke note edited' })
	});
	assert(updated.title === 'Smoke note edited', 'note not updated');
	await api(`/api/v1/notes/${note.id}/delete`, { method: 'DELETE' });
});
await check('store and query a memory', async () => {
	await api('/api/v1/memories/add', {
		method: 'POST',
		body: JSON.stringify({ content: 'The smoke test likes Durable Objects.' })
	});
	const result = await api('/api/v1/memories/query', {
		method: 'POST',
		body: JSON.stringify({ content: 'durable objects', k: 3 })
	});
	assert((result.documents?.[0] ?? []).length > 0, 'memory query returned nothing');
});

// --- Channels (admin only: creating a channel is an admin action) ---------
if (isAdmin) {
	console.log('\nchannels');
	await check('create a channel, post a message, and receive it over the socket', async () => {
		const channel = await api('/api/v1/channels/create', {
			method: 'POST',
			body: JSON.stringify({ name: `smoke-${Date.now()}`, description: 'smoke test' })
		});
		const socket = await connectSocket(token);
		try {
			const delivered = socket.waitForChannel(channel.id);
			const message = await api(`/api/v1/channels/${channel.id}/messages/post`, {
				method: 'POST',
				body: JSON.stringify({ content: 'hello from the smoke test' })
			});
			assert(message.id, 'message was not created');
			const event = await delivered;
			assert(event?.data?.data?.content === 'hello from the smoke test', 'socket payload mismatch');

			const messages = await api(`/api/v1/channels/${channel.id}/messages?skip=0&limit=10`);
			assert(messages.length === 1, 'message not listed');
		} finally {
			socket.close();
			await api(`/api/v1/channels/${channel.id}/delete`, { method: 'DELETE' }).catch(() => {});
		}
	});
}

// --- Models and completions ----------------------------------------------
console.log('\nmodels & completions');
const models = await api('/api/models').catch(() => ({ data: [] }));
await check('list models', async () => assert(Array.isArray(models.data), 'no model list'));

if (models.data?.length) {
	const modelId = models.data[0].id;
	await check(`stream a completion from ${modelId}`, async () => {
		const socket = await connectSocket(token);
		try {
			const messageId = crypto.randomUUID();
			const userMessageId = crypto.randomUUID();
			const done = socket.waitFor(messageId);
			const response = await api('/api/chat/completions', {
				method: 'POST',
				body: JSON.stringify({
					stream: true,
					model: modelId,
					messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
					id: messageId,
					parent_id: null,
					session_id: socket.sid,
					user_message: {
						id: userMessageId,
						parentId: null,
						childrenIds: [],
						role: 'user',
						content: 'Reply with a short greeting.'
					},
					background_tasks: { title_generation: true }
				})
			});
			assert(response.status === true, 'completion was not accepted');
			assert(Array.isArray(response.task_ids) && response.task_ids.length, 'no task id returned');
			const content = await done;
			assert(content.trim().length > 0, 'no tokens streamed');
		} finally {
			socket.close();
		}
	});
	// Two models answering the same prompt write into one chat document
	// concurrently — this catches regressions in the atomic message merge.
	await check('run two models side by side without losing either answer', async () => {
		const socket = await connectSocket(token);
		try {
			const first = crypto.randomUUID();
			const second = crypto.randomUUID();
			const userMessageId = crypto.randomUUID();
			const secondModelId = models.data[1]?.id ?? modelId;
			const bothDone = Promise.all([socket.waitFor(first), socket.waitFor(second)]);

			const response = await api('/api/chat/completions', {
				method: 'POST',
				body: JSON.stringify({
					stream: true,
					model: modelId,
					messages: [{ role: 'user', content: 'Say hello twice.' }],
					message_ids: [
						{ model_id: modelId, message_id: first },
						{ model_id: secondModelId, message_id: second }
					],
					parent_id: null,
					session_id: socket.sid,
					user_message: {
						id: userMessageId,
						parentId: null,
						childrenIds: [],
						role: 'user',
						content: 'Say hello twice.'
					},
					background_tasks: {}
				})
			});
			assert(response.task_ids.length === 2, 'expected two tasks');
			await bothDone;

			const chat = await api(`/api/v1/chats/${response.chat_id}`);
			const stored = Object.values(chat.chat.history.messages).filter(
				(message) => message.role === 'assistant'
			);
			assert(stored.length === 2, `expected 2 assistant messages, got ${stored.length}`);
			for (const message of stored) {
				assert((message.content ?? '').length > 0, `message ${message.id} lost its content`);
			}
			await api(`/api/v1/chats/${response.chat_id}`, { method: 'DELETE' });
		} finally {
			socket.close();
		}
	});
} else {
	console.log('  ! no models configured — completion check skipped');
}

// --- Admin config shapes --------------------------------------------------
// The admin screens dereference these paths in `onMount` with no guard, so a
// missing one is not a blank field — it is a TypeError that stops the whole tab
// from rendering. This has cost six separate bugs, so the contract is pinned
// here rather than being rediscovered in a browser each time.
if (isAdmin) {
	console.log('\nadmin config shapes');

	const REQUIRED = [
		// endpoint, paths the frontend reads without checking
		[
			'/api/v1/retrieval/embedding',
			[
				'RAG_EMBEDDING_ENGINE',
				'RAG_EMBEDDING_MODEL',
				'openai_config.key',
				'openai_config.url',
				'ollama_config.key',
				'ollama_config.url',
				'azure_openai_config.key',
				'azure_openai_config.version'
			]
		],
		['/api/v1/images/config', ['COMFYUI_WORKFLOW_NODES', 'IMAGES_EDIT_COMFYUI_WORKFLOW_NODES']],
		['/api/v1/retrieval/config', ['web.WEB_SEARCH_ENGINE', 'web.WEB_SEARCH_MODE']]
	];

	for (const [endpoint, paths] of REQUIRED) {
		await check(`${endpoint} has the fields the screen dereferences`, async () => {
			const body = await api(endpoint);
			for (const path of paths) {
				const value = path
					.split('.')
					.reduce((node, part) => (node == null ? undefined : node[part]), body);
				assert(
					value !== undefined,
					`${path} is missing — the screen reads it unguarded and will throw`
				);
			}
		});
	}

	await check('the ComfyUI node lists are arrays, not just present', async () => {
		// `config.COMFYUI_WORKFLOW_NODES.find(...)` runs whatever the engine is.
		const images = await api('/api/v1/images/config');
		assert(Array.isArray(images.COMFYUI_WORKFLOW_NODES), 'COMFYUI_WORKFLOW_NODES is not an array');
		assert(
			Array.isArray(images.IMAGES_EDIT_COMFYUI_WORKFLOW_NODES),
			'IMAGES_EDIT_COMFYUI_WORKFLOW_NODES is not an array'
		);
	});

	await check("the embedding settings round-trip under the screen's field names", async () => {
		const saved = await api('/api/v1/retrieval/embedding/update', {
			method: 'POST',
			body: JSON.stringify({
				RAG_EMBEDDING_ENGINE: 'openai',
				RAG_EMBEDDING_MODEL: 'text-embedding-3-small',
				openai_config: { key: 'smoke-embed-key', url: 'https://api.openai.com/v1' }
			})
		});
		assert(saved.RAG_EMBEDDING_ENGINE === 'openai', 'the engine was not saved');
		assert(saved.openai_config.key === 'smoke-embed-key', 'the provider key was dropped');

		const reloaded = await api('/api/v1/retrieval/embedding');
		assert(
			reloaded.openai_config.url === 'https://api.openai.com/v1',
			'the provider URL did not persist'
		);

		// Put it back so the rest of the run embeds through Workers AI.
		await api('/api/v1/retrieval/embedding/update', {
			method: 'POST',
			body: JSON.stringify({
				RAG_EMBEDDING_ENGINE: 'workers-ai',
				RAG_EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5'
			})
		});
	});
}

// --- Long documents -------------------------------------------------------
// Retrieval hands the model `top_k` chunks — three thousand characters by
// default — however long the document is. The Documents screen has a switch for
// giving it the whole file instead; this checks the switch actually does that.
if (isAdmin && models.data?.length) {
	console.log('\nlong documents');

	const LONG = Array.from(
		{ length: 700 },
		(_, i) => `Section ${i}: Durable Objects give a Worker single-threaded consistency.`
	).join('\n');
	let longFileId = '';

	const askAboutFile = async () => {
		const socket = await connectSocket(token);
		try {
			socket.resetEvents();
			const messageId = crypto.randomUUID();
			const done = socket.waitFor(messageId);
			await api('/api/chat/completions', {
				method: 'POST',
				body: JSON.stringify({
					stream: true,
					model: models.data[0].id,
					messages: [{ role: 'user', content: 'Summarise the attached document.' }],
					files: [{ type: 'file', id: longFileId, name: 'long.txt' }],
					id: messageId,
					parent_id: null,
					session_id: socket.sid,
					user_message: {
						id: crypto.randomUUID(),
						parentId: null,
						childrenIds: [],
						role: 'user',
						content: 'Summarise the attached document.'
					},
					background_tasks: {}
				})
			});
			await done;
			return socket.sourceDocs.join('').length;
		} finally {
			socket.close();
		}
	};

	await check('upload a long document', async () => {
		const form = new FormData();
		form.append('file', new Blob([LONG], { type: 'text/plain' }), 'long.txt');
		const response = await fetch(`${BASE}/api/v1/files/`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: form
		});
		assert(response.ok, `upload failed: ${response.status}`);
		longFileId = (await response.json()).id;
		assert(longFileId, 'no file id');
		assert(LONG.length > 40000, 'the fixture is not long enough to prove anything');
	});

	await check('retrieval mode sends a small slice of it', async () => {
		await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ RAG_FULL_CONTEXT: false, BYPASS_EMBEDDING_AND_RETRIEVAL: false })
		});
		// Indexing is queued behind the upload response; give it a moment.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const delivered = await askAboutFile();
		assert(delivered > 0, 'no document text reached the model at all');
		assert(
			delivered < LONG.length / 2,
			`expected a retrieved slice, got ${delivered} of ${LONG.length} characters`
		);
	});

	await check('full context mode sends the whole document', async () => {
		const saved = await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ RAG_FULL_CONTEXT: true })
		});
		assert(saved.RAG_FULL_CONTEXT === true, 'the full-context switch was not saved');
		const delivered = await askAboutFile();
		assert(
			delivered >= LONG.length,
			`only ${delivered} of ${LONG.length} characters reached the model`
		);
	});

	await check('the bypass switch persists and does the same', async () => {
		const saved = await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({
				RAG_FULL_CONTEXT: false,
				BYPASS_EMBEDDING_AND_RETRIEVAL: true
			})
		});
		assert(saved.BYPASS_EMBEDDING_AND_RETRIEVAL === true, 'the bypass switch was dropped on save');
		const delivered = await askAboutFile();
		assert(
			delivered >= LONG.length,
			`only ${delivered} of ${LONG.length} characters reached the model`
		);
		await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ BYPASS_EMBEDDING_AND_RETRIEVAL: false })
		});
	});
}

// --- Model-invoked web search --------------------------------------------
// The other web-search mode: instead of searching before every turn, the model
// is given `web_search`/`web_fetch` as tools and decides for itself. Needs both
// mocks, and the mock models that exercise tool calling.
const toolModels = (models.data ?? []).map((model) => model.id);
if (isAdmin && searchMockUp && toolModels.includes('mock-tools')) {
	console.log('\nweb search as a tool');

	const runTurn = async (modelId, prompt) => {
		const socket = await connectSocket(token);
		try {
			socket.resetEvents();
			const messageId = crypto.randomUUID();
			const done = socket.waitFor(messageId);
			await api('/api/chat/completions', {
				method: 'POST',
				body: JSON.stringify({
					stream: true,
					model: modelId,
					messages: [{ role: 'user', content: prompt }],
					features: { web_search: true },
					id: messageId,
					parent_id: null,
					session_id: socket.sid,
					user_message: {
						id: crypto.randomUUID(),
						parentId: null,
						childrenIds: [],
						role: 'user',
						content: prompt
					},
					background_tasks: {}
				})
			});
			const content = await done;
			return { content, statuses: [...socket.statuses], sources: socket.sourceCount };
		} finally {
			socket.close();
		}
	};

	await check('switch web search to tool mode', async () => {
		const saved = await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({
				web: {
					ENABLE_WEB_SEARCH: true,
					WEB_SEARCH_MODE: 'tool',
					WEB_SEARCH_ENGINE: 'searxng',
					SEARXNG_QUERY_URL: SEARCH_MOCK
				}
			})
		});
		assert(saved.web.WEB_SEARCH_MODE === 'tool', 'the search mode was not saved');
	});

	await check('the model calls the search tool and cites what it found', async () => {
		const before = await fetch(`${SEARCH_MOCK}/page-loads`).then((r) => r.json());
		const turn = await runTurn('mock-tools', 'What is Cloudflare Workers?');
		const after = await fetch(`${SEARCH_MOCK}/page-loads`).then((r) => r.json());

		// The query is the model's, assembled from argument fragments split across
		// stream chunks — not the user's message.
		assert(
			turn.statuses.some((line) => line.includes('cloudflare workers')),
			`no search status for the model's own query: ${JSON.stringify(turn.statuses)}`
		);
		assert(turn.sources > 0, 'the tool results were not emitted as citable sources');
		assert(turn.content.trim().length > 0, 'the model never produced an answer after the tool ran');
		assert(after.pageLoads > before.pageLoads, 'the search never reached the engine');
	});

	await check('a model that refuses tools falls back to searching first', async () => {
		const turn = await runTurn('mock-no-tools', 'What is Cloudflare Workers?');
		assert(
			turn.content.trim().length > 0,
			'the turn failed instead of falling back when the model rejected tools'
		);
		assert(
			turn.statuses.some((line) => /Searching the web|Searched the web/.test(line)),
			`no pre-search status after the fallback: ${JSON.stringify(turn.statuses)}`
		);
	});

	await check('combo mode searches first and still leaves the model its tools', async () => {
		await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ web: { WEB_SEARCH_MODE: 'combo' } })
		});
		const turn = await runTurn('mock-tools', 'What is Cloudflare Workers?');

		// The pre-search query comes from the task model; the tool query is the
		// model's own. Both statuses prove combo did both things.
		assert(
			turn.statuses.some((line) => /Searching the web|Searched the web \(/.test(line)),
			`no pre-search status: ${JSON.stringify(turn.statuses)}`
		);
		assert(
			turn.statuses.some((line) => line.includes('cloudflare workers')),
			`the model never got to call the tool: ${JSON.stringify(turn.statuses)}`
		);
		assert(turn.content.trim().length > 0, 'no answer was produced');
	});

	await check('combo mode does not search twice when the model refuses tools', async () => {
		// The pre-search has already run by the time the endpoint rejects `tools`,
		// so the fallback must not run it again.
		const turn = await runTurn('mock-no-tools', 'What is Cloudflare Workers?');
		const searches = turn.statuses.filter((line) => /^Searching the web for/.test(line));
		assert(
			searches.length === 1,
			`expected one search, saw ${searches.length}: ${JSON.stringify(searches)}`
		);
		assert(turn.content.trim().length > 0, 'no answer was produced');
	});

	await check('put web search back into always mode', async () => {
		const saved = await api('/api/v1/retrieval/config/update', {
			method: 'POST',
			body: JSON.stringify({ web: { WEB_SEARCH_MODE: 'always' } })
		});
		assert(saved.web.WEB_SEARCH_MODE === 'always', 'the search mode was not restored');
	});
}

// --- Retrieval in a completion -------------------------------------------
if (fileId && models.data?.length) {
	console.log('\nfile context');
	await check('attach a file to a completion and receive citations', async () => {
		const socket = await connectSocket(token);
		try {
			const messageId = crypto.randomUUID();
			const done = socket.waitFor(messageId);
			await api('/api/chat/completions', {
				method: 'POST',
				body: JSON.stringify({
					stream: true,
					model: models.data[0].id,
					messages: [{ role: 'user', content: 'What runs at the edge?' }],
					files: [{ type: 'file', id: fileId, name: 'smoke.txt' }],
					id: messageId,
					parent_id: null,
					session_id: socket.sid,
					user_message: {
						id: crypto.randomUUID(),
						parentId: null,
						childrenIds: [],
						role: 'user',
						content: 'What runs at the edge?'
					},
					background_tasks: {}
				})
			});
			await done;
			assert(socket.sourcesSeen() > 0, 'no source events were emitted');
		} finally {
			socket.close();
		}
	});
}

// --- Admin ----------------------------------------------------------------
if (isAdmin) {
	console.log('\nadmin');
	await check('read and write admin config', async () => {
		const before = await api('/api/v1/auths/admin/config');
		await api('/api/v1/auths/admin/config', {
			method: 'POST',
			body: JSON.stringify({
				...before,
				ENABLE_COMMUNITY_SHARING: !before.ENABLE_COMMUNITY_SHARING
			})
		});
		const after = await api('/api/v1/auths/admin/config');
		assert(
			after.ENABLE_COMMUNITY_SHARING === !before.ENABLE_COMMUNITY_SHARING,
			'config did not persist'
		);
		await api('/api/v1/auths/admin/config', { method: 'POST', body: JSON.stringify(before) });
	});
	await check('list users', async () => {
		const users = await api('/api/v1/users/?page=1');
		assert(Array.isArray(users.users), 'no user list');
	});
	await check('analytics summary', async () => {
		const summary = await api('/api/v1/analytics/summary');
		assert(typeof summary.total_messages === 'number', 'no analytics');
	});
	await check('read and write the OAuth admin config', async () => {
		const before = await api('/api/v1/auths/admin/config/oauth');
		assert('ENABLE_OAUTH' in before, 'no OAuth config');
		assert(before.ENABLE_OAUTH_PERSISTENT_CONFIG === true, 'OAuth config is not editable');
		await api('/api/v1/auths/admin/config/oauth', {
			method: 'POST',
			body: JSON.stringify({ OAUTH_PROVIDER_NAME: 'Smoke SSO' })
		});
		const after = await api('/api/v1/auths/admin/config/oauth');
		assert(after.OAUTH_PROVIDER_NAME === 'Smoke SSO', 'OAuth config did not persist');
		await api('/api/v1/auths/admin/config/oauth', {
			method: 'POST',
			body: JSON.stringify({ OAUTH_PROVIDER_NAME: before.OAUTH_PROVIDER_NAME || 'SSO' })
		});
	});

	// Full sign-in round trip, only when a mock IdP is running:
	//   node scripts/mock-oidc.mjs &   (see CLOUDFLARE.md)
	const idp = process.env.SMOKE_OIDC_URL ?? 'http://127.0.0.1:9500';
	const discovery = `${idp.replace(/\/+$/, '')}/.well-known/openid-configuration`;
	const idpUp = await fetch(discovery)
		.then((response) => response.ok)
		.catch(() => false);

	if (idpUp) {
		const before = await api('/api/v1/auths/admin/config/oauth');
		try {
			await check('sign in through an OIDC provider end to end', async () => {
				await api('/api/v1/auths/admin/config/oauth', {
					method: 'POST',
					body: JSON.stringify({
						ENABLE_OAUTH: true,
						OAUTH_PROVIDER_NAME: 'Smoke IdP',
						OAUTH_CLIENT_ID: process.env.SMOKE_OIDC_CLIENT_ID ?? 'open-webui',
						OAUTH_CLIENT_SECRET: process.env.SMOKE_OIDC_CLIENT_SECRET ?? 'open-webui-secret',
						OPENID_PROVIDER_URL: discovery,
						ENABLE_OAUTH_SIGNUP: true
					})
				});

				const config = await api('/api/config');
				assert(config.oauth?.providers?.oidc === 'Smoke IdP', 'the provider is not advertised');

				// Follow login -> IdP -> callback by hand so the flow cookie and the
				// `state` parameter are carried exactly as a browser would.
				const login = await fetch(`${BASE}/oauth/oidc/login`, { redirect: 'manual' });
				assert(login.status === 302, `login did not redirect (${login.status})`);
				const flowCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
				assert(flowCookie.startsWith('oauth_flow='), 'no flow cookie was set');

				const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
				assert(authorize.status === 302, 'the IdP did not redirect back');

				const callback = await fetch(authorize.headers.get('location'), {
					redirect: 'manual',
					headers: { Cookie: flowCookie }
				});
				assert(callback.status === 302, `the callback did not redirect (${callback.status})`);
				const location = callback.headers.get('location') ?? '';
				assert(!location.includes('error='), `sign-in failed: ${decodeURIComponent(location)}`);

				const sessionCookie = (callback.headers.get('set-cookie') ?? '')
					.split(/,\s*(?=[A-Za-z_]+=)/)
					.find((entry) => entry.startsWith('token='));
				assert(sessionCookie, 'no session cookie was issued');
				const sessionToken = sessionCookie.split(';')[0].slice('token='.length);

				const session = await fetch(`${BASE}/api/v1/auths/`, {
					headers: { Authorization: `Bearer ${sessionToken}` }
				}).then((response) => response.json());
				assert(session.email, `the session token does not resolve: ${JSON.stringify(session)}`);
			});

			await check('reject an OAuth callback whose state does not match', async () => {
				const login = await fetch(`${BASE}/oauth/oidc/login`, { redirect: 'manual' });
				const flowCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
				const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
				const tampered = (authorize.headers.get('location') ?? '').replace(
					/state=[^&]*/,
					'state=tampered'
				);
				const callback = await fetch(tampered, {
					redirect: 'manual',
					headers: { Cookie: flowCookie }
				});
				assert(
					(callback.headers.get('location') ?? '').includes('error='),
					'a mismatched state was accepted'
				);
			});
		} finally {
			const restore = {};
			for (const [field, value] of Object.entries(before)) {
				if (field !== 'OAUTH_PROVIDERS' && field !== 'ENABLE_OAUTH_PERSISTENT_CONFIG') {
					restore[field] = value;
				}
			}
			await api('/api/v1/auths/admin/config/oauth', {
				method: 'POST',
				body: JSON.stringify(restore)
			});
		}
	} else {
		console.log('  · OIDC sign-in skipped (no mock IdP on ' + idp + ')');
	}
}

// --- Cleanup --------------------------------------------------------------
console.log('\ncleanup');
await check('delete the test chat, folder and file', async () => {
	if (chatId) await api(`/api/v1/chats/${chatId}`, { method: 'DELETE' });
	if (folderId) await api(`/api/v1/folders/${folderId}`, { method: 'DELETE' });
	if (fileId) await api(`/api/v1/files/${fileId}`, { method: 'DELETE' });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}

/** Minimal Socket.IO client: enough to authenticate and collect chat events. */
async function connectSocket(authToken) {
	const url = `${BASE.replace(/^http/, 'ws')}/ws/socket.io/?EIO=4&transport=websocket`;
	const ws = new WebSocket(url);
	const listeners = new Map();
	const channelListeners = new Map();
	let sid = null;
	let sources = 0;
	const statusLines = [];
	const sourceDocs = [];

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('socket connect timed out')), 15000);
		ws.addEventListener('error', () => reject(new Error('socket error')));
		ws.addEventListener('message', (event) => {
			const frame = String(event.data);
			if (frame[0] === '0') {
				ws.send('40' + JSON.stringify({ token: authToken }));
				return;
			}
			if (frame[0] === '2') {
				ws.send('3');
				return;
			}
			if (frame.startsWith('40')) {
				sid = JSON.parse(frame.slice(2)).sid;
				ws.send('42' + JSON.stringify(['user-join', { auth: { token: authToken } }]));
				clearTimeout(timer);
				resolve();
				return;
			}
			if (frame.startsWith('42')) {
				const [name, payload] = JSON.parse(frame.slice(2));
				if (name === 'events:channel') {
					const channelHandler = channelListeners.get(payload.channel_id);
					if (channelHandler) channelHandler(payload);
					return;
				}
				if (name !== 'events') return;
				if (payload.data?.type === 'source') {
					sources += 1;
					for (const doc of payload.data?.data?.document ?? []) sourceDocs.push(String(doc));
				}
				if (payload.data?.type === 'status') {
					statusLines.push(String(payload.data?.data?.description ?? ''));
				}
				const handler = listeners.get(payload.message_id);
				if (handler) handler(payload);
			}
		});
	});

	return {
		get sid() {
			return sid;
		},
		// Status lines and source events are how the tool loop shows its work, so
		// the tool-mode checks read them back off the socket.
		get statuses() {
			return statusLines;
		},
		get sourceCount() {
			return sources;
		},
		get sourceDocs() {
			return sourceDocs;
		},
		resetEvents() {
			statusLines.length = 0;
			sourceDocs.length = 0;
			sources = 0;
		},
		waitFor(messageId) {
			return new Promise((resolve, reject) => {
				let content = '';
				const timer = setTimeout(() => reject(new Error('stream timed out')), 60000);
				listeners.set(messageId, (payload) => {
					const event = payload.data;
					if (event?.type !== 'chat:completion') return;
					const delta = event.data?.choices?.[0]?.delta?.content;
					if (delta) content += delta;
					if (event.data?.error) {
						clearTimeout(timer);
						reject(new Error(JSON.stringify(event.data.error).slice(0, 200)));
					}
					if (event.data?.done) {
						clearTimeout(timer);
						resolve(event.data.content ?? content);
					}
				});
			});
		},
		sourcesSeen() {
			return sources;
		},
		waitForChannel(channelId) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('channel event timed out')), 15000);
				channelListeners.set(channelId, (payload) => {
					clearTimeout(timer);
					resolve(payload);
				});
			});
		},
		close() {
			try {
				ws.close();
			} catch {
				// already closed
			}
		}
	};
}
