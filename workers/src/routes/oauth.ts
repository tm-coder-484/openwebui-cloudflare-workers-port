/**
 * `/oauth/:provider/login` and `/oauth/:provider/callback`.
 *
 * The login screen links straight at these paths, and the callback finishes by
 * setting a readable `token` cookie and redirecting to `/auth`, where the
 * frontend picks the cookie up. That contract is what upstream implements in
 * `routers/oauth.py`, so no frontend change is needed.
 */

import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext, Env } from '../types';
import { getConfig, getConfigMany, secretKey } from '../lib/config';
import { createToken, hashPassword } from '../lib/crypto';
import {
	FLOW_COOKIE,
	FLOW_TTL,
	codeChallenge,
	domainAllowed,
	exchangeCode,
	fetchGithubEmail,
	fetchUserInfo,
	groupsFromClaims,
	isBlockedGroup,
	oauthProviders,
	oauthSettings,
	openFlowState,
	providerMetadata,
	randomString,
	redirectUriFor,
	roleFromClaims,
	sealFlowState,
	verifyIdToken,
	type OAuthSettings,
	type ProviderConfig
} from '../lib/oauth';
import {
	DEFAULT_PROFILE_IMAGE,
	getUserByEmail,
	hasUsers,
	insertUser,
	updateUser,
	type UserRow
} from '../lib/users';
import { now, parseDuration, parseJSON, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

/** Where the frontend expects to land, honouring an explicit `WEBUI_URL`. */
function frontendBase(c: any, webuiUrl: unknown): string {
	const configured = typeof webuiUrl === 'string' ? webuiUrl.trim() : '';
	const base = configured || new URL(c.req.url).origin;
	return base.replace(/\/$/, '');
}

function failure(c: any, base: string, message: string): Response {
	console.warn('[open-webui] oauth error:', message);
	return c.redirect(`${base}/auth?error=${encodeURIComponent(message)}`, 302);
}

app.get('/:provider/login', async (c) => {
	const settings = await oauthSettings(c.env);
	const providers = await oauthProviders(c.env, settings);
	const provider = providers[c.req.param('provider')];
	if (!provider) return c.json({ detail: 'Not Found' }, 404);

	const webuiUrl = await getConfig<string>(c.env, 'webui.url');
	const base = frontendBase(c, webuiUrl);

	let metadata;
	try {
		metadata = await providerMetadata(c.env, provider);
	} catch (error) {
		return failure(c, base, `Could not reach the identity provider: ${(error as Error).message}`);
	}

	const verifier = randomString();
	const state = randomString(16);
	const nonce = randomString(16);
	const redirectUri = redirectUriFor(provider, c.req.url, webuiUrl);

	const authorizeUrl = new URL(metadata.authorization_endpoint);
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('client_id', provider.clientId);
	authorizeUrl.searchParams.set('redirect_uri', redirectUri);
	authorizeUrl.searchParams.set('scope', provider.scopes);
	authorizeUrl.searchParams.set('state', state);
	authorizeUrl.searchParams.set('code_challenge', await codeChallenge(verifier));
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');
	// GitHub is not an OIDC provider and rejects unknown parameters silently;
	// nonce only belongs on the OIDC flows.
	if (provider.discoveryUrl) authorizeUrl.searchParams.set('nonce', nonce);

	setCookie(
		c,
		FLOW_COOKIE,
		await sealFlowState(
			{ provider: provider.id, verifier, nonce, state, redirect_uri: redirectUri },
			secretKey(c.env)
		),
		{
			httpOnly: true,
			sameSite: 'Lax',
			secure: new URL(c.req.url).protocol === 'https:',
			path: '/',
			maxAge: FLOW_TTL
		}
	);

	return c.redirect(authorizeUrl.toString(), 302);
});

app.get('/:provider/callback', async (c) => {
	const settings = await oauthSettings(c.env);
	const providers = await oauthProviders(c.env, settings);
	const provider = providers[c.req.param('provider')];

	const webuiUrl = await getConfig<string>(c.env, 'webui.url');
	const base = frontendBase(c, webuiUrl);

	if (!provider) return c.json({ detail: 'Not Found' }, 404);

	// The flow cookie is single-use whatever happens next.
	const sealed = getCookie(c, FLOW_COOKIE);
	deleteCookie(c, FLOW_COOKIE, { path: '/' });

	const providerError = c.req.query('error');
	if (providerError) {
		return failure(c, base, c.req.query('error_description') || providerError);
	}

	const flow = sealed ? await openFlowState(sealed, secretKey(c.env)) : null;
	if (!flow || flow.provider !== provider.id) {
		return failure(c, base, 'The sign-in request expired. Please try again.');
	}
	const state = c.req.query('state');
	if (!state || state !== flow.state) {
		return failure(c, base, 'The sign-in request could not be verified. Please try again.');
	}
	const code = c.req.query('code');
	if (!code) return failure(c, base, 'The identity provider returned no authorization code.');

	try {
		const metadata = await providerMetadata(c.env, provider);
		const token = await exchangeCode(provider, metadata, code, flow.verifier, flow.redirect_uri);

		// Claims come from the verified ID token first, then userinfo. Userinfo
		// wins on conflict; ID-token-only claims (roles, groups) are backfilled.
		let claims: Record<string, unknown> = {};
		if (token.id_token) {
			claims = await verifyIdToken(c.env, metadata, provider, token.id_token, flow.nonce);
		}
		const idTokenClaims = { ...claims };

		if (
			token.access_token &&
			(!claims[settings.emailClaim] || !claims[settings.usernameClaim] || !token.id_token)
		) {
			const info = await fetchUserInfo(metadata, token.access_token);
			if (info) {
				claims = { ...info };
				for (const [key, value] of Object.entries(idTokenClaims)) {
					if (!(key in claims)) claims[key] = value;
				}
			}
		}
		if (!Object.keys(claims).length) throw new Error('The identity provider returned no claims.');

		const user = await provisionUser(c, settings, provider, claims, token.access_token);

		const expiry = parseDuration(await getConfig<string>(c.env, 'auth.jwt_expiry'));
		const sessionToken = await createToken({ id: user.id }, secretKey(c.env), expiry);
		// Readable by design: /auth reads document.cookie to finish the login.
		setCookie(c, 'token', sessionToken, {
			httpOnly: false,
			sameSite: 'Lax',
			secure: new URL(c.req.url).protocol === 'https:',
			path: '/',
			...(expiry ? { maxAge: expiry } : {})
		});
		return c.redirect(`${base}/auth`, 302);
	} catch (error) {
		return failure(c, base, (error as Error).message || 'Error during the OAuth process');
	}
});

/** Finds, links or creates the account behind a set of verified claims. */
async function provisionUser(
	c: any,
	settings: OAuthSettings,
	provider: ProviderConfig,
	claims: Record<string, unknown>,
	accessToken?: string
): Promise<UserRow> {
	const env: Env = c.env;
	const subClaim = settings.subClaim || provider.subClaim;
	const sub = claims[subClaim];
	if (sub === undefined || sub === null || sub === '') {
		throw new Error(`The identity provider returned no "${subClaim}" claim.`);
	}
	const subject = String(sub);

	let email = String(claims[settings.emailClaim] ?? '').toLowerCase();
	if (!email && provider.id === 'github' && accessToken) {
		email = (await fetchGithubEmail(accessToken))?.toLowerCase() ?? '';
	}
	if (!email) throw new Error('The identity provider returned no email address.');
	if (!domainAllowed(settings, email)) {
		throw new Error('This email domain is not allowed to sign in.');
	}

	const name = String(claims[settings.usernameClaim] ?? '') || email;
	const picture = String(claims[settings.pictureClaim] ?? '') || DEFAULT_PROFILE_IMAGE;

	// Existing link: match on the stored provider subject, not the email, so a
	// changed address at the IdP still resolves to the same account.
	let row = await getUserByOAuthSub(env, provider.id, subject);

	if (!row && settings.mergeAccountsByEmail) {
		const existing = await getUserByEmail(env, email);
		if (existing) {
			await linkOAuthSub(env, existing, provider.id, subject);
			row = await getUserByOAuthSub(env, provider.id, subject);
		}
	}

	if (row) {
		const role = roleFromClaims(settings, claims, row.role);
		if (role === null) throw new Error('Your account is not authorised to sign in.');

		const updates: Record<string, unknown> = {};
		if (role !== row.role && settings.enableRoleManagement) updates.role = role;
		if (settings.updateNameOnLogin && name && name !== row.name) updates.name = name;
		if (settings.updateEmailOnLogin && email && email !== row.email) {
			const clash = await getUserByEmail(env, email);
			if (!clash || clash.id === row.id) updates.email = email;
		}
		if (settings.updatePictureOnLogin && picture && picture !== row.profile_image_url) {
			updates.profile_image_url = picture;
		}
		if (Object.keys(updates).length) {
			row = (await updateUser(env, row.id, updates)) ?? row;
			if (updates.email) {
				await env.DB.prepare('UPDATE auth SET email = ?1 WHERE id = ?2')
					.bind(updates.email, row.id)
					.run();
			}
		}
		if (settings.enableGroupManagement) await syncGroups(env, settings, claims, row.id);
		return row;
	}

	if (!settings.enableSignup) {
		throw new Error('Account creation through SSO is disabled. Ask an administrator for access.');
	}
	if (await getUserByEmail(env, email)) {
		// A local account already owns this address and merging is off; linking
		// silently would let an IdP take over a password account.
		throw new Error('An account with this email address already exists.');
	}

	const existingUsers = await hasUsers(env);
	const config = await getConfigMany(env, ['ui.default_user_role', 'ui.default_group_id']);
	const defaultRole = existingUsers
		? ((config['ui.default_user_role'] as string) ?? env.DEFAULT_USER_ROLE ?? 'pending')
		: 'admin';
	const role = roleFromClaims(settings, claims, defaultRole);
	if (role === null) throw new Error('Your account is not authorised to sign in.');

	const created = await insertUser(env, {
		email,
		name,
		// The first account is always the admin, exactly as password signup does.
		role: existingUsers ? role : 'admin',
		profile_image_url: picture
	});
	// A random password keeps the auth row shape identical to a local account
	// while making password sign-in impossible for it.
	await env.DB.prepare('INSERT INTO auth (id, email, password, active) VALUES (?1, ?2, ?3, 1)')
		.bind(created.id, email, await hashPassword(uuid() + uuid()))
		.run();
	await linkOAuthSub(env, created, provider.id, subject);

	const defaultGroupId = config['ui.default_group_id'] as string | undefined;
	if (defaultGroupId) {
		await env.DB.prepare(
			'INSERT INTO group_member (id, group_id, user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)'
		)
			.bind(uuid(), defaultGroupId, created.id, now())
			.run()
			.catch(() => {});
	}
	if (settings.enableGroupManagement) await syncGroups(env, settings, claims, created.id);

	return (await getUserByOAuthSub(env, provider.id, subject)) ?? created;
}

async function getUserByOAuthSub(env: Env, provider: string, sub: string): Promise<UserRow | null> {
	const row = await env.DB.prepare(
		`SELECT * FROM "user" WHERE json_extract(oauth, '$.' || ?1 || '.sub') = ?2 LIMIT 1`
	)
		.bind(provider, sub)
		.first<UserRow>();
	return row ?? null;
}

async function linkOAuthSub(env: Env, user: UserRow, provider: string, sub: string): Promise<void> {
	const oauth = parseJSON<Record<string, unknown>>(user.oauth, {});
	oauth[provider] = { sub };
	await updateUser(env, user.id, { oauth });
}

/**
 * Mirrors the IdP's groups onto `group_member`, matching upstream: an empty
 * claim changes nothing, blocked groups are left alone in both directions, and
 * membership otherwise tracks the claim exactly.
 */
async function syncGroups(
	env: Env,
	settings: OAuthSettings,
	claims: Record<string, unknown>,
	userId: string
): Promise<void> {
	const claimed = groupsFromClaims(settings, claims);
	if (!claimed.length) return;

	const all = await env.DB.prepare('SELECT id, name FROM "group"').all<{
		id: string;
		name: string;
	}>();
	const groups = new Map((all.results ?? []).map((group) => [group.name, group.id]));

	if (settings.enableGroupCreation) {
		for (const name of claimed) {
			if (groups.has(name) || isBlockedGroup(name, settings.blockedGroups)) continue;
			const id = uuid();
			await env.DB.prepare(
				`INSERT INTO "group" (id, user_id, name, description, permissions, meta, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?5)`
			)
				.bind(id, userId, name, `Group '${name}' created automatically via OAuth.`, now())
				.run();
			groups.set(name, id);
		}
	}

	const current = await env.DB.prepare(
		'SELECT g.id AS id, g.name AS name FROM group_member m JOIN "group" g ON g.id = m.group_id WHERE m.user_id = ?1'
	)
		.bind(userId)
		.all<{ id: string; name: string }>();

	for (const group of current.results ?? []) {
		if (claimed.includes(group.name)) continue;
		if (isBlockedGroup(group.name, settings.blockedGroups)) continue;
		await env.DB.prepare('DELETE FROM group_member WHERE user_id = ?1 AND group_id = ?2')
			.bind(userId, group.id)
			.run();
	}

	const held = new Set((current.results ?? []).map((group) => group.name));
	for (const name of claimed) {
		const id = groups.get(name);
		if (!id || held.has(name) || isBlockedGroup(name, settings.blockedGroups)) continue;
		await env.DB.prepare(
			'INSERT INTO group_member (id, group_id, user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)'
		)
			.bind(uuid(), id, userId, now())
			.run()
			.catch(() => {});
	}
}

export default app;
