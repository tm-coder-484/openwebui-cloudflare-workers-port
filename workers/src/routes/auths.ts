/** `/api/v1/auths` — sign in/up, session, profile, API keys, admin config. */

import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppContext, Env, SessionUser } from '../types';
import { adminUser, bearerFrom, currentUser, verifiedUser } from '../lib/auth';
import { getConfig, getConfigMany, secretKey, setConfigMany } from '../lib/config';
import { createToken, decodeToken, generateApiKey, hashPassword, verifyPassword } from '../lib/crypto';
import { resolvePermissions } from '../lib/permissions';
import {
	countUsers,
	getUserByEmail,
	getUserById,
	hasUsers,
	insertUser,
	serializeUser,
	updateUser
} from '../lib/users';
import { bad, forbidden, notFound, now, parseDuration, unauthorized, uuid, validateEmail } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const ADMIN_CONFIG_KEYS: Record<string, string> = {
	SHOW_ADMIN_DETAILS: 'auth.admin.show',
	ADMIN_EMAIL: 'auth.admin.email',
	WEBUI_URL: 'webui.url',
	ENABLE_SIGNUP: 'ui.enable_signup',
	ENABLE_API_KEYS: 'auth.enable_api_keys',
	ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS: 'auth.api_key.endpoint_restrictions',
	API_KEYS_ALLOWED_ENDPOINTS: 'auth.api_key.allowed_endpoints',
	DEFAULT_USER_ROLE: 'ui.default_user_role',
	DEFAULT_GROUP_ID: 'ui.default_group_id',
	DEFAULT_INTERFACE_SETTINGS: 'ui.default_interface_settings',
	JWT_EXPIRES_IN: 'auth.jwt_expiry',
	ENABLE_COMMUNITY_SHARING: 'ui.enable_community_sharing',
	ENABLE_MESSAGE_RATING: 'ui.enable_message_rating',
	ENABLE_FOLDERS: 'folders.enable',
	FOLDER_MAX_FILE_COUNT: 'folders.max_file_count',
	AUTOMATION_MAX_COUNT: 'automations.max_count',
	AUTOMATION_MIN_INTERVAL: 'automations.min_interval',
	ENABLE_AUTOMATIONS: 'automations.enable',
	ENABLE_CHANNELS: 'channels.enable',
	CHANNEL_MODEL_RESPONSE_MODE: 'channels.model_response_mode',
	ENABLE_CALENDAR: 'calendar.enable',
	ENABLE_MEMORIES: 'memories.enable',
	ENABLE_MEMORY_SYSTEM_CONTEXT: 'memories.system_context.enable',
	ENABLE_NOTES: 'notes.enable',
	ENABLE_USER_WEBHOOKS: 'ui.enable_user_webhooks',
	ENABLE_USER_STATUS: 'users.enable_status',
	PENDING_USER_OVERLAY_TITLE: 'ui.pending_user_overlay_title',
	PENDING_USER_OVERLAY_CONTENT: 'ui.pending_user_overlay_content',
	RESPONSE_WATERMARK: 'ui.watermark'
};

async function sessionResponse(
	c: any,
	user: SessionUser,
	options: { setCookie?: boolean } = {}
): Promise<Response> {
	const expiry = parseDuration(await getConfig<string>(c.env, 'auth.jwt_expiry'));
	const expiresAt = expiry ? now() + expiry : null;
	const token = await createToken({ id: user.id }, secretKey(c.env), expiry);

	if (options.setCookie) {
		setCookie(c, 'token', token, {
			httpOnly: true,
			sameSite: 'Lax',
			secure: new URL(c.req.url).protocol === 'https:',
			path: '/',
			...(expiry ? { maxAge: expiry } : {})
		});
	}

	return c.json({
		token,
		token_type: 'Bearer',
		expires_at: expiresAt,
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		profile_image_url: user.profile_image_url,
		bio: user.bio,
		gender: user.gender,
		date_of_birth: user.date_of_birth,
		status_emoji: user.status_emoji,
		status_message: user.status_message,
		status_expires_at: user.status_expires_at,
		permissions: await resolvePermissions(c.env, user.id)
	});
}

app.get('/', async (c) => {
	const user = currentUser(c);
	const token = bearerFrom(c);
	let expiresAt: number | null = null;
	if (token && !token.startsWith('sk-')) {
		const payload = await decodeToken(token, secretKey(c.env));
		expiresAt = (payload?.exp as number) ?? null;
	}
	return c.json({
		token,
		token_type: 'Bearer',
		expires_at: expiresAt,
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		profile_image_url: user.profile_image_url,
		bio: user.bio,
		gender: user.gender,
		date_of_birth: user.date_of_birth,
		status_emoji: user.status_emoji,
		status_message: user.status_message,
		status_expires_at: user.status_expires_at,
		permissions: await resolvePermissions(c.env, user.id)
	});
});

app.post('/signin', async (c) => {
	const { email, password } = (await c.req.json()) as { email?: string; password?: string };
	if (!email || !password) throw bad('Email and password are required');

	const row = await getUserByEmail(c.env, email);
	const auth = row
		? await c.env.DB.prepare('SELECT * FROM auth WHERE id = ?1 AND active = 1')
				.bind(row.id)
				.first<{ id: string; password: string }>()
		: null;

	if (!row || !auth || !(await verifyPassword(password, auth.password))) {
		throw bad('Incorrect email or password.');
	}
	return sessionResponse(c, serializeUser(row), { setCookie: true });
});

app.post('/signup', async (c) => {
	const body = (await c.req.json()) as {
		name?: string;
		email?: string;
		password?: string;
		profile_image_url?: string;
	};
	const email = (body.email ?? '').toLowerCase().trim();
	const name = (body.name ?? '').trim();
	const password = body.password ?? '';

	const existingUsers = await hasUsers(c.env);
	const config = await getConfigMany(c.env, [
		'ui.enable_signup',
		'ui.enable_login_form',
		'ui.default_user_role',
		'ui.default_group_id'
	]);

	if (existingUsers && !config['ui.enable_signup']) {
		throw forbidden('Sign up is disabled.');
	}
	if (!validateEmail(email)) throw bad('Invalid email format.');
	if (!name) throw bad('A name is required.');
	if (password.length < 8) throw bad('Password must be at least 8 characters long.');
	if (await getUserByEmail(c.env, email)) throw bad('Email is already taken.');

	// The very first account always becomes the admin, matching upstream.
	const role = existingUsers
		? ((config['ui.default_user_role'] as string) ?? c.env.DEFAULT_USER_ROLE ?? 'pending')
		: 'admin';

	const row = await insertUser(c.env, {
		email,
		name,
		role,
		profile_image_url: body.profile_image_url ?? '/user.png'
	});
	await c.env.DB.prepare('INSERT INTO auth (id, email, password, active) VALUES (?1, ?2, ?3, 1)')
		.bind(row.id, email, await hashPassword(password))
		.run();

	const defaultGroupId = config['ui.default_group_id'] as string | undefined;
	if (defaultGroupId) {
		await c.env.DB.prepare(
			'INSERT INTO group_member (id, group_id, user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)'
		)
			.bind(uuid(), defaultGroupId, row.id, now())
			.run()
			.catch(() => {});
	}

	return sessionResponse(c, serializeUser(row), { setCookie: true });
});

app.get('/signout', async (c) => {
	deleteCookie(c, 'token', { path: '/' });
	return c.json({ status: true });
});

app.post('/signout', async (c) => {
	deleteCookie(c, 'token', { path: '/' });
	return c.json({ status: true });
});

app.post('/update/profile', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const updated = await updateUser(c.env, user.id, {
		name: body.name,
		profile_image_url: body.profile_image_url,
		bio: body.bio,
		gender: body.gender,
		date_of_birth: body.date_of_birth
	});
	if (!updated) throw bad('Failed to update profile');
	return c.json(serializeUser(updated));
});

app.post('/update/timezone', async (c) => {
	const user = currentUser(c);
	const { timezone } = (await c.req.json()) as { timezone?: string };
	await updateUser(c.env, user.id, { timezone: timezone ?? null });
	return c.json({ status: true });
});

app.post('/update/password', async (c) => {
	const user = verifiedUser(c);
	if (!(await getConfig<boolean>(c.env, 'ui.enable_password_change_form'))) {
		throw forbidden('Password changes are disabled.');
	}
	const { password, new_password } = (await c.req.json()) as {
		password?: string;
		new_password?: string;
	};
	const auth = await c.env.DB.prepare('SELECT * FROM auth WHERE id = ?1')
		.bind(user.id)
		.first<{ password: string }>();
	if (!auth || !(await verifyPassword(password ?? '', auth.password))) {
		throw bad('Incorrect password.');
	}
	if (!new_password || new_password.length < 8) {
		throw bad('Password must be at least 8 characters long.');
	}
	await c.env.DB.prepare('UPDATE auth SET password = ?1 WHERE id = ?2')
		.bind(await hashPassword(new_password), user.id)
		.run();
	return c.json(true);
});

app.post('/add', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as {
		name?: string;
		email?: string;
		password?: string;
		role?: string;
	};
	const email = (body.email ?? '').toLowerCase().trim();
	if (!validateEmail(email)) throw bad('Invalid email format.');
	if (await getUserByEmail(c.env, email)) throw bad('Email is already taken.');
	if (!body.password || body.password.length < 8) {
		throw bad('Password must be at least 8 characters long.');
	}

	const row = await insertUser(c.env, {
		email,
		name: body.name ?? email,
		role: body.role ?? 'pending'
	});
	await c.env.DB.prepare('INSERT INTO auth (id, email, password, active) VALUES (?1, ?2, ?3, 1)')
		.bind(row.id, email, await hashPassword(body.password))
		.run();
	return sessionResponse(c, serializeUser(row));
});

app.get('/admin/details', async (c) => {
	const config = await getConfigMany(c.env, ['auth.admin.show', 'auth.admin.email']);
	if (!config['auth.admin.show']) return c.json({ name: null, email: null });
	const admin = await c.env.DB.prepare(
		"SELECT * FROM \"user\" WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
	).first<{ name: string; email: string }>();
	return c.json({
		name: admin?.name ?? null,
		email: (config['auth.admin.email'] as string) || admin?.email || null
	});
});

app.get('/admin/config', async (c) => {
	adminUser(c);
	return c.json(await adminConfigValues(c.env));
});

app.post('/admin/config', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(ADMIN_CONFIG_KEYS)) {
		if (field in body) updates[key] = body[field];
	}
	if ('DEFAULT_USER_ROLE' in body && !['pending', 'user', 'admin'].includes(String(body.DEFAULT_USER_ROLE))) {
		delete updates['ui.default_user_role'];
	}
	if (
		'JWT_EXPIRES_IN' in body &&
		!/^(-1|0|(-?\d+(\.\d+)?)(ms|s|m|h|d|w))$/.test(String(body.JWT_EXPIRES_IN))
	) {
		delete updates['auth.jwt_expiry'];
	}
	await setConfigMany(c.env, updates);
	return c.json(await adminConfigValues(c.env));
});

async function adminConfigValues(env: Env): Promise<Record<string, unknown>> {
	const config = await getConfigMany(env, Object.values(ADMIN_CONFIG_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(ADMIN_CONFIG_KEYS)) out[field] = config[key] ?? null;
	out.SHOW_ADMIN_DETAILS = out.SHOW_ADMIN_DETAILS ?? true;
	out.WEBUI_URL = out.WEBUI_URL || env.WEBUI_URL || '';
	out.DEFAULT_USER_ROLE = out.DEFAULT_USER_ROLE || env.DEFAULT_USER_ROLE || 'pending';
	out.JWT_EXPIRES_IN = out.JWT_EXPIRES_IN || '-1';
	out.CHANNEL_MODEL_RESPONSE_MODE = out.CHANNEL_MODEL_RESPONSE_MODE || 'thread';
	out.API_KEYS_ALLOWED_ENDPOINTS = out.API_KEYS_ALLOWED_ENDPOINTS || '';
	out.DEFAULT_GROUP_ID = out.DEFAULT_GROUP_ID || '';
	out.ADMIN_EMAIL = out.ADMIN_EMAIL ?? null;
	return out;
}

// LDAP and OAuth are not implemented in the Workers port; the admin screens
// still fetch these, so return inert-but-well-formed payloads.
app.get('/admin/config/ldap', async (c) => {
	adminUser(c);
	return c.json({ ENABLE_LDAP: false });
});
app.post('/admin/config/ldap', async (c) => {
	adminUser(c);
	return c.json({ ENABLE_LDAP: false });
});
app.get('/admin/config/ldap/server', async (c) => {
	adminUser(c);
	return c.json({});
});
app.post('/admin/config/ldap/server', async (c) => {
	adminUser(c);
	return c.json({});
});
app.get('/admin/config/oauth', async (c) => {
	adminUser(c);
	return c.json({ ENABLE_OAUTH: false, OAUTH_PROVIDERS: {} });
});
app.post('/admin/config/oauth', async (c) => {
	adminUser(c);
	return c.json({ ENABLE_OAUTH: false, OAUTH_PROVIDERS: {} });
});
app.post('/ldap', async () => {
	throw bad('LDAP authentication is not available in the Cloudflare Workers build.');
});
app.get('/oauth/sessions/:id', async (c) => c.json([]));

app.get('/api_key', async (c) => {
	const user = verifiedUser(c);
	const row = await c.env.DB.prepare(
		'SELECT key FROM api_key WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1'
	)
		.bind(user.id)
		.first<{ key: string }>();
	if (!row) throw notFound('API key not found');
	return c.json({ api_key: row.key });
});

app.post('/api_key', async (c) => {
	const user = verifiedUser(c);
	if (!(await getConfig<boolean>(c.env, 'auth.enable_api_keys'))) {
		throw forbidden('API keys are disabled.');
	}
	const key = generateApiKey();
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM api_key WHERE user_id = ?1').bind(user.id),
		c.env.DB.prepare(
			'INSERT INTO api_key (id, user_id, key, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
		).bind(uuid(), user.id, key, 'default', now())
	]);
	return c.json({ api_key: key });
});

app.delete('/api_key', async (c) => {
	const user = verifiedUser(c);
	await c.env.DB.prepare('DELETE FROM api_key WHERE user_id = ?1').bind(user.id).run();
	return c.json(true);
});

export default app;
