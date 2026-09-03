/** Root API surface: config, version, models, and chat completions. */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, getUserPermissions } from '../lib/config';
import { resolvePermissions } from '../lib/permissions';
import { countUsers, hasUsers } from '../lib/users';
import { WEBUI_VERSION } from '../lib/version';
import { getAllModels, getBaseModels, filterModelsForUser } from '../lib/models';
import { insertChat, getUserChat, upsertMessage, type ChatContent } from '../lib/chats';
import { hubStats, startCompletion, emitToUser } from '../lib/hub';
import { HttpError, bad, notFound, now, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const isSavedChatId = (chatId: string | null | undefined): boolean =>
	Boolean(chatId) &&
	!chatId!.startsWith('temporary:') &&
	!chatId!.startsWith('local:') &&
	!chatId!.startsWith('channel:');

app.get('/health', (c) => c.json({ status: true }));
app.get('/health/db', async (c) => {
	await c.env.DB.prepare('SELECT 1').first();
	return c.json({ status: true });
});

app.get('/api/version', (c) => c.json({ version: WEBUI_VERSION }));

app.get('/api/version/updates', (c) =>
	// Update checks would call out to GitHub on every page load; the Workers
	// build reports "current" and leaves upgrades to `wrangler deploy`.
	c.json({ current: WEBUI_VERSION, latest: WEBUI_VERSION })
);

app.get('/api/changelog', (c) => c.json({}));

app.get('/api/config', async (c) => {
	const user = c.get('user');
	const config = await getConfigMany(c.env, [
		'oauth.enable',
		'oauth.auto_redirect',
		'ldap.enable',
		'ui.enable_signup',
		'ui.enable_login_form',
		'auth.enable_api_keys',
		'ui.enable_password_change_form',
		'direct.enable',
		'folders.enable',
		'folders.max_file_count',
		'channels.enable',
		'calendar.enable',
		'automations.enable',
		'notes.enable',
		'chat.context_compaction.enable',
		'chat.tool_permissions.enable',
		'web.search.enable',
		'web.search.confirmation.enable',
		'web.search.confirmation.content',
		'code_execution.enable',
		'code_interpreter.enable',
		'image_generation.enable',
		'task.autocomplete.enable',
		'ui.enable_community_sharing',
		'ui.enable_message_rating',
		'ui.enable_user_webhooks',
		'users.enable_status',
		'google_drive.enable',
		'onedrive.enable',
		'memories.enable',
		'ui.default_models',
		'ui.default_pinned_models',
		'ui.default_interface_settings',
		'ui.prompt_suggestions',
		'code_execution.engine',
		'code_interpreter.engine',
		'audio.tts.engine',
		'audio.tts.voice',
		'audio.tts.split_on',
		'audio.stt.engine',
		'rag.file.max_size',
		'rag.file.max_count',
		'file.image_compression_width',
		'file.image_compression_height',
		'ui.pending_user_overlay_title',
		'ui.pending_user_overlay_content',
		'ui.watermark'
	]);

	const onboarding = user ? false : !(await hasUsers(c.env));

	const base: Record<string, unknown> = {
		...(onboarding ? { onboarding: true } : {}),
		status: true,
		name: c.env.WEBUI_NAME ?? 'Open WebUI',
		version: WEBUI_VERSION,
		default_locale: '',
		oauth: {
			providers: {},
			auto_redirect: config['oauth.auto_redirect'] ?? false
		},
		features: {
			auth: true,
			auth_trusted_header: false,
			enable_signup_password_confirmation: false,
			enable_ldap: false,
			enable_signup: config['ui.enable_signup'],
			enable_login_form: config['ui.enable_login_form'],
			// Long-polling is not implemented on Workers; the client must use WS.
			enable_websocket: true,
			websocket_heartbeat_interval: 30,
			...(user
				? {
						enable_api_keys: config['auth.enable_api_keys'],
						enable_password_change_form: config['ui.enable_password_change_form'],
						enable_version_update_check: false,
						enable_pyodide_file_persistence: false,
						enable_public_active_users_count: true,
						enable_easter_eggs: true,
						enable_direct_connections: config['direct.enable'],
						enable_plugins: false,
						enable_folders: config['folders.enable'],
						folder_max_file_count: config['folders.max_file_count'],
						enable_channels: config['channels.enable'],
						enable_calendar: config['calendar.enable'],
						enable_automations: config['automations.enable'],
						enable_notes: config['notes.enable'],
						enable_context_compaction: config['chat.context_compaction.enable'],
						enable_tool_permissions: config['chat.tool_permissions.enable'],
						enable_web_search: config['web.search.enable'],
						enable_web_search_confirmation: config['web.search.confirmation.enable'],
						web_search_confirmation_content: config['web.search.confirmation.content'],
						enable_code_execution: config['code_execution.enable'],
						enable_code_interpreter: config['code_interpreter.enable'],
						enable_image_generation: config['image_generation.enable'],
						enable_autocomplete_generation: config['task.autocomplete.enable'],
						enable_community_sharing: config['ui.enable_community_sharing'],
						enable_message_rating: config['ui.enable_message_rating'],
						enable_user_webhooks: config['ui.enable_user_webhooks'],
						enable_user_status: config['users.enable_status'],
						enable_admin_export: true,
						enable_admin_chat_access: true,
						enable_admin_analytics: true,
						enable_google_drive_integration: config['google_drive.enable'],
						enable_onedrive_integration: config['onedrive.enable'],
						enable_memories: config['memories.enable']
					}
				: {})
		}
	};

	if (user && (user.role === 'admin' || user.role === 'user')) {
		Object.assign(base, {
			default_models: config['ui.default_models'],
			default_pinned_models: config['ui.default_pinned_models'],
			default_prompt_suggestions: config['ui.prompt_suggestions'],
			code: {
				engine: config['code_execution.engine'],
				interpreter_engine: config['code_interpreter.engine']
			},
			audio: {
				tts: {
					engine: config['audio.tts.engine'],
					voice: config['audio.tts.voice'],
					split_on: config['audio.tts.split_on']
				},
				stt: { engine: config['audio.stt.engine'] }
			},
			file: {
				max_size: config['rag.file.max_size'],
				max_count: config['rag.file.max_count'],
				image_compression: {
					width: config['file.image_compression_width'],
					height: config['file.image_compression_height']
				}
			},
			permissions: await getUserPermissions(c.env),
			google_drive: { client_id: '', api_key: '' },
			onedrive: {
				client_id_personal: '',
				client_id_business: '',
				sharepoint_url: '',
				sharepoint_tenant_id: ''
			},
			ui: {
				default_interface_settings: config['ui.default_interface_settings'],
				pending_user_overlay_title: config['ui.pending_user_overlay_title'],
				pending_user_overlay_content: config['ui.pending_user_overlay_content'],
				response_watermark: config['ui.watermark'],
				iframe_csp: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'"
			},
			license_metadata: null
		});
	} else if (user && user.role === 'pending') {
		Object.assign(base, {
			ui: {
				pending_user_overlay_title: config['ui.pending_user_overlay_title'],
				pending_user_overlay_content: config['ui.pending_user_overlay_content']
			}
		});
	}

	return c.json(base);
});

app.get('/api/models', async (c) => {
	const user = verifiedUser(c);
	const models = await filterModelsForUser(c.env, await getAllModels(c.env), user);
	return c.json({ data: models });
});

app.get('/api/v1/models', async (c) => {
	const user = verifiedUser(c);
	const models = await filterModelsForUser(c.env, await getAllModels(c.env), user);
	return c.json({ data: models });
});

app.get('/api/models/base', async (c) => {
	adminUser(c);
	return c.json({ data: await getBaseModels(c.env) });
});

app.post('/api/models/unload', async (c) => {
	adminUser(c);
	// Nothing to unload: models live behind provider APIs, not in this process.
	return c.json({ status: true });
});

app.get('/api/usage', async (c) => {
	verifiedUser(c);
	const stats = await hubStats(c.env);
	return c.json({ user_ids: [], models: stats.models_in_use, active_users: stats.users });
});

app.get('/api/v1/pipelines/list', async (c) => {
	adminUser(c);
	return c.json({ data: [] });
});

app.get('/api/v1/pipelines', async (c) => {
	adminUser(c);
	return c.json({ data: [] });
});

app.get('/api/events', async (c) => {
	adminUser(c);
	return c.json({ schema: WEBUI_VERSION, events: [] });
});

app.get('/api/events/webhooks', async (c) => {
	adminUser(c);
	return c.json([]);
});

/**
 * The frontend posts here and expects `{status, task_ids, chat_id}` — the
 * assistant tokens arrive later over Socket.IO, not in this response body.
 */
app.post('/api/chat/completions', chatCompletions);
app.post('/api/v1/chat/completions', chatCompletions);

async function chatCompletions(c: any) {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as Record<string, any>;

	const modelId: string = body.model;
	if (!modelId) throw bad('Model not specified');

	const models = await filterModelsForUser(c.env, await getAllModels(c.env), user);
	if (!models.some((model) => model.id === modelId)) {
		throw notFound(`Model '${modelId}' was not found or you do not have access to it.`);
	}

	const backgroundTasks = (body.background_tasks ?? null) as Record<string, boolean> | null;
	const hasParentIdField = Object.prototype.hasOwnProperty.call(body, 'parent_id');
	const isNewChat = hasParentIdField && body.parent_id === null && !body.chat_id;

	// message_ids carries one entry per model in a side-by-side comparison.
	const entries: { model_id: string; message_id: string }[] = Array.isArray(body.message_ids)
		? body.message_ids
		: [{ model_id: modelId, message_id: body.id ?? uuid() }];

	let chatId: string = body.chat_id || '';
	const userMessage = body.user_message ?? null;

	if (isNewChat) {
		chatId = uuid();
		const assistantIds = entries.map((entry) => entry.message_id).filter(Boolean);
		const messages: Record<string, any> = {};
		if (userMessage?.id) {
			messages[userMessage.id] = { ...userMessage, childrenIds: assistantIds };
		}
		for (const entry of entries) {
			if (!entry.message_id) continue;
			messages[entry.message_id] = {
				id: entry.message_id,
				parentId: userMessage?.id ?? null,
				childrenIds: [],
				role: 'assistant',
				content: '',
				done: false,
				model: entry.model_id,
				timestamp: now()
			};
		}
		const content: ChatContent = {
			id: chatId,
			title: 'New Chat',
			models: entries.map((entry) => entry.model_id),
			history: { currentId: assistantIds[0] ?? userMessage?.id ?? null, messages },
			messages: userMessage ? [{ role: 'user', content: userMessage.content ?? '' }] : [],
			files: body.files ?? [],
			tags: [],
			timestamp: Date.now()
		};
		await insertChat(c.env, user.id, content, {
			id: chatId,
			folderId: body.folder_id ?? null,
			variables: body.chat_variables ?? {}
		});
		await emitToUser(c.env, user.id, 'events', [
			{ chat_id: chatId, data: { type: 'chat:list', data: { chat_id: chatId } } }
		]);
	} else if (isSavedChatId(chatId)) {
		const chat = await getUserChat(c.env, chatId, user.id);
		if (!chat) throw notFound('Chat not found');
		if (userMessage?.id) {
			await upsertMessage(c.env, chatId, userMessage.id, userMessage);
		}
		for (const entry of entries) {
			if (!entry.message_id) continue;
			await upsertMessage(c.env, chatId, entry.message_id, {
				id: entry.message_id,
				parentId: userMessage?.id ?? body.parent_id ?? null,
				childrenIds: [],
				role: 'assistant',
				content: '',
				done: false,
				model: entry.model_id,
				timestamp: now()
			});
		}
	}

	const saveToChat = isSavedChatId(chatId);
	const taskIds: string[] = [];

	for (const [index, entry] of entries.entries()) {
		if (!entry.message_id) continue;
		const taskId = uuid();
		taskIds.push(taskId);
		await startCompletion(c.env, {
			userId: user.id,
			chatId: chatId || `temporary:${body.session_id ?? user.id}`,
			messageId: entry.message_id,
			modelId: entry.model_id,
			taskId,
			saveToChat,
			// Only the first model runs chat-level tasks (title/tags).
			backgroundTasks:
				index === 0
					? backgroundTasks
					: backgroundTasks
						? { follow_up_generation: backgroundTasks.follow_up_generation }
						: null,
			body: { ...body, model: entry.model_id }
		});
	}

	if (taskIds.length) {
		await emitToUser(c.env, user.id, 'events', [
			{
				chat_id: chatId,
				message_id: entries[0].message_id,
				data: { type: 'chat:active', data: { active: true, folder_id: body.folder_id ?? null } }
			}
		]);
	}

	return c.json({ status: true, task_ids: taskIds, chat_id: chatId });
}

app.post('/api/chat/completed', async (c) => {
	verifiedUser(c);
	const body = await c.req.json().catch(() => ({}));
	// Outlet filters and post-processing plugins are not part of this port, so
	// the payload round-trips unchanged.
	return c.json(body);
});

app.post('/api/chat/actions/:id', async (c) => {
	verifiedUser(c);
	const body = await c.req.json().catch(() => ({}));
	return c.json(body);
});

app.post('/api/tasks/stop/:id', async (c) => {
	verifiedUser(c);
	return c.json({ status: true });
});

app.post('/api/tasks/chat/:id/stop', async (c) => {
	verifiedUser(c);
	return c.json({ status: true });
});

app.get('/api/tasks/chat/:id', async (c) => {
	verifiedUser(c);
	return c.json({ task_ids: [] });
});

export default app;
