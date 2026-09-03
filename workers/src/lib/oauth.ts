/**
 * OAuth 2.0 / OpenID Connect sign-in.
 *
 * Mirrors `backend/open_webui/utils/oauth.py`: the same provider set (google,
 * microsoft, github and a generic `oidc` client), the same claim names, and the
 * same account-provisioning rules (signup gate, merge-by-email, allowed
 * domains, role management).
 *
 * Two things differ because Workers has no server-side session store:
 *
 *  - The CSRF `state`, the PKCE verifier and the OIDC `nonce` travel in a
 *    short-lived HMAC-signed cookie instead of a server session. Nothing is
 *    stored server-side, so the flow survives any colo handling the callback.
 *  - Discovery documents and JWKS are cached in KV. A cache miss just refetches,
 *    so KV's eventual consistency cannot make the flow incorrect.
 */

import type { Env } from '../types';
import { getConfigMany } from './config';
import { b64urlDecode, b64urlEncode, createToken, decodeToken } from './crypto';
import { csv, toBool } from './util';

export interface ProviderConfig {
	id: string;
	/** Label shown by the frontend for the generic `oidc` button. */
	label: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	/** OIDC discovery document URL; absent for plain OAuth2 providers. */
	discoveryUrl?: string;
	authorizeUrl?: string;
	tokenUrl?: string;
	userinfoUrl?: string;
	/** Overrides the auto-derived `${origin}/oauth/${id}/callback`. */
	redirectUri?: string;
	/** Provider-specific default when OAUTH_SUB_CLAIM is unset. */
	subClaim: string;
}

export interface OAuthSettings {
	enable: boolean;
	providerName: string;
	clientId: string;
	clientSecret: string;
	openidProviderUrl: string;
	openidRedirectUri: string;
	scopes: string;
	emailClaim: string;
	usernameClaim: string;
	pictureClaim: string;
	subClaim: string;
	groupClaim: string;
	rolesClaim: string;
	enableSignup: boolean;
	mergeAccountsByEmail: boolean;
	autoRedirect: boolean;
	allowedDomains: string[];
	enableRoleManagement: boolean;
	enableGroupManagement: boolean;
	enableGroupCreation: boolean;
	allowedRoles: string[];
	adminRoles: string[];
	blockedGroups: string[];
	updateNameOnLogin: boolean;
	updateEmailOnLogin: boolean;
	updatePictureOnLogin: boolean;
}

/**
 * Config-store keys behind each field the admin Authentication screen binds.
 * The screen round-trips these exact names, so the map is also the wire format
 * of `GET/POST /api/v1/auths/admin/config/oauth`.
 */
export const OAUTH_CONFIG_KEYS: Record<string, string> = {
	ENABLE_OAUTH: 'oauth.enable',
	OAUTH_PROVIDER_NAME: 'oauth.provider_name',
	OAUTH_CLIENT_ID: 'oauth.client_id',
	OAUTH_CLIENT_SECRET: 'oauth.client_secret',
	OPENID_PROVIDER_URL: 'oauth.openid_provider_url',
	OPENID_REDIRECT_URI: 'oauth.openid_redirect_uri',
	OAUTH_SCOPES: 'oauth.scopes',
	OAUTH_EMAIL_CLAIM: 'oauth.email_claim',
	OAUTH_USERNAME_CLAIM: 'oauth.username_claim',
	OAUTH_PICTURE_CLAIM: 'oauth.picture_claim',
	OAUTH_SUB_CLAIM: 'oauth.sub_claim',
	OAUTH_GROUP_CLAIM: 'oauth.group_claim',
	OAUTH_ROLES_CLAIM: 'oauth.roles_claim',
	ENABLE_OAUTH_SIGNUP: 'oauth.enable_signup',
	OAUTH_MERGE_ACCOUNTS_BY_EMAIL: 'oauth.merge_accounts_by_email',
	OAUTH_AUTO_REDIRECT: 'oauth.auto_redirect',
	OAUTH_ALLOWED_DOMAINS: 'oauth.allowed_domains',
	ENABLE_OAUTH_ROLE_MANAGEMENT: 'oauth.enable_role_management',
	ENABLE_OAUTH_GROUP_MANAGEMENT: 'oauth.enable_group_management',
	ENABLE_OAUTH_GROUP_CREATION: 'oauth.enable_group_creation',
	OAUTH_ALLOWED_ROLES: 'oauth.allowed_roles',
	OAUTH_ADMIN_ROLES: 'oauth.admin_roles',
	OAUTH_BLOCKED_GROUPS: 'oauth.blocked_groups',
	OAUTH_UPDATE_NAME_ON_LOGIN: 'oauth.update_name_on_login',
	OAUTH_UPDATE_EMAIL_ON_LOGIN: 'oauth.update_email_on_login',
	OAUTH_UPDATE_PICTURE_ON_LOGIN: 'oauth.update_picture_on_login'
};

const text = (value: unknown, fallback = ''): string =>
	value === null || value === undefined ? fallback : String(value);

/**
 * Reads every OAuth setting. Upstream reads all of these from the environment,
 * so each one resolves stored value -> Worker var -> documented default: a
 * deployment can be configured entirely by `wrangler secret`, and an admin who
 * saves the Authentication screen takes over from there.
 */
export async function oauthSettings(env: Env): Promise<OAuthSettings> {
	const config = await getConfigMany(env, Object.values(OAUTH_CONFIG_KEYS));

	/**
	 * These keys are deliberately absent from `DEFAULT_CONFIG`: an unwritten row
	 * must read as undefined here so the Worker var below can supply the value.
	 */
	const written = (key: string) => {
		const value = config[key];
		return value === null || value === undefined ? undefined : value;
	};
	const str = (key: string, variable: string | undefined, fallback = '') =>
		text(written(key) ?? variable ?? fallback, fallback);
	const bool = (key: string, variable: string | undefined, fallback = false) => {
		const stored = written(key);
		if (stored !== undefined) return toBool(stored);
		return variable === undefined ? fallback : toBool(variable);
	};

	return {
		// Defaults on, as upstream does: with no credentials configured there are
		// no providers to show, and setting only the client id/secret is enough
		// to switch SSO on without a second toggle.
		enable: bool('oauth.enable', env.ENABLE_OAUTH, true),
		providerName: str('oauth.provider_name', env.OAUTH_PROVIDER_NAME, 'SSO') || 'SSO',
		clientId: str('oauth.client_id', env.OAUTH_CLIENT_ID),
		clientSecret: str('oauth.client_secret', env.OAUTH_CLIENT_SECRET),
		openidProviderUrl: str('oauth.openid_provider_url', env.OPENID_PROVIDER_URL),
		openidRedirectUri: str('oauth.openid_redirect_uri', env.OPENID_REDIRECT_URI),
		scopes: str('oauth.scopes', env.OAUTH_SCOPES, 'openid email profile') || 'openid email profile',
		emailClaim: str('oauth.email_claim', env.OAUTH_EMAIL_CLAIM, 'email') || 'email',
		usernameClaim: str('oauth.username_claim', env.OAUTH_USERNAME_CLAIM, 'name') || 'name',
		pictureClaim: str('oauth.picture_claim', env.OAUTH_PICTURE_CLAIM, 'picture') || 'picture',
		subClaim: str('oauth.sub_claim', env.OAUTH_SUB_CLAIM),
		groupClaim: str('oauth.group_claim', env.OAUTH_GROUPS_CLAIM, 'groups') || 'groups',
		rolesClaim: str('oauth.roles_claim', env.OAUTH_ROLES_CLAIM, 'roles') || 'roles',
		enableSignup: bool('oauth.enable_signup', env.ENABLE_OAUTH_SIGNUP),
		mergeAccountsByEmail: bool('oauth.merge_accounts_by_email', env.OAUTH_MERGE_ACCOUNTS_BY_EMAIL),
		autoRedirect: bool('oauth.auto_redirect', env.OAUTH_AUTO_REDIRECT),
		allowedDomains: csv(str('oauth.allowed_domains', env.OAUTH_ALLOWED_DOMAINS, '*') || '*').map(
			(domain) => domain.toLowerCase()
		),
		enableRoleManagement: bool('oauth.enable_role_management', env.ENABLE_OAUTH_ROLE_MANAGEMENT),
		enableGroupManagement: bool('oauth.enable_group_management', env.ENABLE_OAUTH_GROUP_MANAGEMENT),
		enableGroupCreation: bool('oauth.enable_group_creation', env.ENABLE_OAUTH_GROUP_CREATION),
		allowedRoles: csv(
			str('oauth.allowed_roles', env.OAUTH_ALLOWED_ROLES, 'user,admin') || 'user,admin'
		),
		adminRoles: csv(str('oauth.admin_roles', env.OAUTH_ADMIN_ROLES, 'admin') || 'admin'),
		blockedGroups: parseBlockedGroups(written('oauth.blocked_groups') ?? env.OAUTH_BLOCKED_GROUPS),
		updateNameOnLogin: bool('oauth.update_name_on_login', env.OAUTH_UPDATE_NAME_ON_LOGIN),
		updateEmailOnLogin: bool('oauth.update_email_on_login', env.OAUTH_UPDATE_EMAIL_ON_LOGIN),
		updatePictureOnLogin: bool('oauth.update_picture_on_login', env.OAUTH_UPDATE_PICTURE_ON_LOGIN)
	};
}

/** `OAUTH_BLOCKED_GROUPS` is a JSON array upstream but admins paste bare lists. */
function parseBlockedGroups(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((entry) => String(entry));
	const raw = text(value).trim();
	if (!raw || raw === '[]') return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
	} catch {
		/* fall through to a comma-separated list */
	}
	return csv(raw);
}

/**
 * The admin Authentication screen's payload, derived from the same resolution
 * the runtime uses — so what the screen shows is what sign-in will do.
 */
export function oauthConfigPayload(settings: OAuthSettings): Record<string, unknown> {
	return {
		ENABLE_OAUTH: settings.enable,
		OAUTH_PROVIDER_NAME: settings.providerName,
		OAUTH_CLIENT_ID: settings.clientId,
		OAUTH_CLIENT_SECRET: settings.clientSecret,
		OPENID_PROVIDER_URL: settings.openidProviderUrl,
		OPENID_REDIRECT_URI: settings.openidRedirectUri,
		OAUTH_SCOPES: settings.scopes,
		OAUTH_EMAIL_CLAIM: settings.emailClaim,
		OAUTH_USERNAME_CLAIM: settings.usernameClaim,
		OAUTH_PICTURE_CLAIM: settings.pictureClaim,
		OAUTH_SUB_CLAIM: settings.subClaim,
		OAUTH_GROUP_CLAIM: settings.groupClaim,
		OAUTH_ROLES_CLAIM: settings.rolesClaim,
		ENABLE_OAUTH_SIGNUP: settings.enableSignup,
		OAUTH_MERGE_ACCOUNTS_BY_EMAIL: settings.mergeAccountsByEmail,
		OAUTH_AUTO_REDIRECT: settings.autoRedirect,
		OAUTH_ALLOWED_DOMAINS: settings.allowedDomains.join(','),
		ENABLE_OAUTH_ROLE_MANAGEMENT: settings.enableRoleManagement,
		ENABLE_OAUTH_GROUP_MANAGEMENT: settings.enableGroupManagement,
		ENABLE_OAUTH_GROUP_CREATION: settings.enableGroupCreation,
		OAUTH_ALLOWED_ROLES: settings.allowedRoles.join(','),
		OAUTH_ADMIN_ROLES: settings.adminRoles.join(','),
		OAUTH_BLOCKED_GROUPS: JSON.stringify(settings.blockedGroups),
		OAUTH_UPDATE_NAME_ON_LOGIN: settings.updateNameOnLogin,
		OAUTH_UPDATE_EMAIL_ON_LOGIN: settings.updateEmailOnLogin,
		OAUTH_UPDATE_PICTURE_ON_LOGIN: settings.updatePictureOnLogin
	};
}

/**
 * The providers that are fully configured. Named providers come from env vars
 * (as upstream); the generic `oidc` client is admin-editable.
 */
export async function oauthProviders(
	env: Env,
	settings?: OAuthSettings
): Promise<Record<string, ProviderConfig>> {
	const config = settings ?? (await oauthSettings(env));
	const providers: Record<string, ProviderConfig> = {};
	if (!config.enable) return providers;

	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
		providers.google = {
			id: 'google',
			label: 'Google',
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			scopes: env.GOOGLE_OAUTH_SCOPE || 'openid email profile',
			discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
			redirectUri: env.GOOGLE_REDIRECT_URI || undefined,
			subClaim: 'sub'
		};
	}

	if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_CLIENT_TENANT_ID) {
		const base = env.MICROSOFT_CLIENT_LOGIN_BASE_URL || 'https://login.microsoftonline.com';
		providers.microsoft = {
			id: 'microsoft',
			label: 'Microsoft',
			clientId: env.MICROSOFT_CLIENT_ID,
			clientSecret: env.MICROSOFT_CLIENT_SECRET,
			scopes: env.MICROSOFT_OAUTH_SCOPE || 'openid email profile',
			discoveryUrl:
				`${base.replace(/\/$/, '')}/${env.MICROSOFT_CLIENT_TENANT_ID}/v2.0/.well-known/` +
				`openid-configuration?appid=${env.MICROSOFT_CLIENT_ID}`,
			redirectUri: env.MICROSOFT_REDIRECT_URI || undefined,
			subClaim: 'sub'
		};
	}

	if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
		// GitHub is plain OAuth2 — no discovery document and no ID token.
		providers.github = {
			id: 'github',
			label: 'GitHub',
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET,
			scopes: env.GITHUB_CLIENT_SCOPE || 'user:email',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			userinfoUrl: 'https://api.github.com/user',
			redirectUri: env.GITHUB_CLIENT_REDIRECT_URI || undefined,
			subClaim: 'id'
		};
	}

	if (config.clientId && config.clientSecret && config.openidProviderUrl) {
		providers.oidc = {
			id: 'oidc',
			label: config.providerName,
			clientId: config.clientId,
			clientSecret: config.clientSecret,
			scopes: config.scopes,
			discoveryUrl: config.openidProviderUrl,
			redirectUri: config.openidRedirectUri || undefined,
			subClaim: 'sub'
		};
	}

	return providers;
}

/** The `oauth.providers` map `/api/config` hands the login screen. */
export function providerButtons(providers: Record<string, ProviderConfig>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, provider] of Object.entries(providers)) out[id] = provider.label;
	return out;
}

interface ProviderMetadata {
	issuer?: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
}

const DISCOVERY_TTL = 3600;

/** Endpoint set for a provider: discovery for OIDC, static URLs otherwise. */
export async function providerMetadata(
	env: Env,
	provider: ProviderConfig
): Promise<ProviderMetadata> {
	if (!provider.discoveryUrl) {
		if (!provider.authorizeUrl || !provider.tokenUrl) {
			throw new Error(`Provider ${provider.id} has no endpoints configured`);
		}
		return {
			authorization_endpoint: provider.authorizeUrl,
			token_endpoint: provider.tokenUrl,
			userinfo_endpoint: provider.userinfoUrl
		};
	}

	const cacheKey = `oauth:discovery:${provider.discoveryUrl}`;
	const cached = await env.CACHE?.get(cacheKey, 'json').catch(() => null);
	if (cached) return cached as ProviderMetadata;

	const response = await fetch(provider.discoveryUrl, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(10_000)
	});
	if (!response.ok) {
		throw new Error(`Discovery failed for ${provider.id} (HTTP ${response.status})`);
	}
	const metadata = (await response.json()) as ProviderMetadata;
	if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
		throw new Error(`Discovery document for ${provider.id} is missing required endpoints`);
	}
	await env.CACHE?.put(cacheKey, JSON.stringify(metadata), {
		expirationTtl: DISCOVERY_TTL
	}).catch(() => {});
	return metadata;
}

/** Resolves the redirect URI: explicit override, else `${origin}/oauth/<id>/callback`. */
export function redirectUriFor(provider: ProviderConfig, requestUrl: string, webuiUrl?: string) {
	if (provider.redirectUri) return provider.redirectUri;
	const base = webuiUrl?.trim() ? webuiUrl.trim() : new URL(requestUrl).origin;
	return `${base.replace(/\/$/, '')}/oauth/${provider.id}/callback`;
}

const encoder = new TextEncoder();

export function randomString(bytes = 32): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256 challenge for the PKCE verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
	return b64urlEncode(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
}

export interface FlowState {
	provider: string;
	verifier: string;
	nonce: string;
	state: string;
	redirect_uri: string;
}

/** The signed cookie standing in for a server-side session, valid 10 minutes. */
export const FLOW_COOKIE = 'oauth_flow';
export const FLOW_TTL = 600;

/**
 * The flow token shares the session JWT's signing key, so it is tagged and the
 * tag is checked on the way back in: a flow cookie must never be usable as a
 * session token, nor a session token as a flow cookie.
 */
const FLOW_TYPE = 'oauth_flow';

export async function sealFlowState(state: FlowState, secret: string): Promise<string> {
	return createToken({ id: FLOW_TYPE, typ: FLOW_TYPE, ...state }, secret, FLOW_TTL);
}

export async function openFlowState(token: string, secret: string): Promise<FlowState | null> {
	const payload = await decodeToken(token, secret);
	if (!payload || payload.typ !== FLOW_TYPE) return null;
	const state = payload as unknown as FlowState;
	if (!state.provider || !state.state || !state.verifier || !state.redirect_uri) return null;
	return state;
}

export interface TokenResponse {
	access_token?: string;
	id_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
}

/** Exchanges the authorization code. Confidential client, PKCE, POST body auth. */
export async function exchangeCode(
	provider: ProviderConfig,
	metadata: ProviderMetadata,
	code: string,
	verifier: string,
	redirectUri: string
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: provider.clientId,
		client_secret: provider.clientSecret,
		code_verifier: verifier
	});
	const response = await fetch(metadata.token_endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			// GitHub returns form-encoded unless JSON is requested explicitly.
			Accept: 'application/json'
		},
		body,
		signal: AbortSignal.timeout(15_000)
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`Token exchange failed (HTTP ${response.status}): ${raw.slice(0, 200)}`);
	}
	let payload: TokenResponse & { error?: string; error_description?: string };
	try {
		payload = JSON.parse(raw);
	} catch {
		payload = Object.fromEntries(new URLSearchParams(raw)) as TokenResponse;
	}
	if (payload.error) {
		throw new Error(payload.error_description || payload.error);
	}
	if (!payload.access_token && !payload.id_token) {
		throw new Error('The token endpoint returned neither an access token nor an ID token');
	}
	return payload;
}

/** Fetches the userinfo endpoint with the access token. */
export async function fetchUserInfo(
	metadata: ProviderMetadata,
	accessToken: string
): Promise<Record<string, unknown> | null> {
	if (!metadata.userinfo_endpoint) return null;
	const response = await fetch(metadata.userinfo_endpoint, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			// GitHub rejects requests without a User-Agent.
			'User-Agent': 'open-webui-workers'
		},
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) return null;
	return (await response.json()) as Record<string, unknown>;
}

/** GitHub only exposes a verified address through a second call. */
export async function fetchGithubEmail(accessToken: string): Promise<string | null> {
	const response = await fetch('https://api.github.com/user/emails', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			'User-Agent': 'open-webui-workers'
		},
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) return null;
	const emails = (await response.json()) as { email: string; primary?: boolean }[];
	return emails.find((entry) => entry.primary)?.email ?? emails[0]?.email ?? null;
}

interface Jwk extends JsonWebKey {
	kid?: string;
	alg?: string;
}

const JWT_ALGORITHMS: Record<string, { name: string; hash: string; namedCurve?: string }> = {
	RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
	RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
	RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
	ES256: { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256' },
	ES384: { name: 'ECDSA', hash: 'SHA-384', namedCurve: 'P-384' }
};

async function jwks(env: Env, uri: string): Promise<Jwk[]> {
	const cacheKey = `oauth:jwks:${uri}`;
	const cached = (await env.CACHE?.get(cacheKey, 'json').catch(() => null)) as {
		keys?: Jwk[];
	} | null;
	if (cached?.keys) return cached.keys;

	const response = await fetch(uri, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(10_000)
	});
	if (!response.ok) throw new Error(`Could not fetch JWKS (HTTP ${response.status})`);
	const payload = (await response.json()) as { keys?: Jwk[] };
	if (!payload.keys?.length) throw new Error('The JWKS document contains no keys');
	await env.CACHE?.put(cacheKey, JSON.stringify(payload), {
		expirationTtl: DISCOVERY_TTL
	}).catch(() => {});
	return payload.keys;
}

/**
 * Verifies an ID token against the provider's JWKS and checks iss/aud/exp/nonce.
 *
 * Returns the claims. Unsupported algorithms (or a missing `jwks_uri`) throw
 * rather than silently trusting the token.
 */
export async function verifyIdToken(
	env: Env,
	metadata: ProviderMetadata,
	provider: ProviderConfig,
	idToken: string,
	nonce: string
): Promise<Record<string, unknown>> {
	const parts = idToken.split('.');
	if (parts.length !== 3) throw new Error('The ID token is malformed');
	const [headerPart, payloadPart, signaturePart] = parts;

	const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerPart))) as {
		alg?: string;
		kid?: string;
	};
	const algorithm = JWT_ALGORITHMS[header.alg ?? ''];
	if (!algorithm) throw new Error(`Unsupported ID token algorithm: ${header.alg}`);
	if (!metadata.jwks_uri) throw new Error('The provider published no jwks_uri');

	const keys = await jwks(env, metadata.jwks_uri);
	const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys;
	const signature = b64urlDecode(signaturePart);
	const signed = encoder.encode(`${headerPart}.${payloadPart}`);

	let verified = false;
	for (const jwk of candidates.length ? candidates : keys) {
		try {
			const key = await crypto.subtle.importKey(
				'jwk',
				{ ...jwk, alg: header.alg, ext: true },
				algorithm.namedCurve
					? { name: algorithm.name, namedCurve: algorithm.namedCurve }
					: { name: algorithm.name, hash: algorithm.hash },
				false,
				['verify']
			);
			const parameters = algorithm.namedCurve
				? { name: algorithm.name, hash: algorithm.hash }
				: { name: algorithm.name };
			if (await crypto.subtle.verify(parameters, key, signature as BufferSource, signed)) {
				verified = true;
				break;
			}
		} catch {
			// Try the next key: a JWKS commonly mixes signing and encryption keys.
		}
	}
	if (!verified) throw new Error('The ID token signature could not be verified');

	const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadPart))) as Record<
		string,
		unknown
	>;

	const skew = 60;
	const seconds = Math.floor(Date.now() / 1000);
	if (typeof claims.exp === 'number' && claims.exp + skew < seconds) {
		throw new Error('The ID token has expired');
	}
	if (typeof claims.nbf === 'number' && claims.nbf - skew > seconds) {
		throw new Error('The ID token is not valid yet');
	}
	if (metadata.issuer && claims.iss !== metadata.issuer) {
		throw new Error('The ID token issuer does not match the discovery document');
	}
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audience.includes(provider.clientId)) {
		throw new Error('The ID token was not issued for this client');
	}
	// A provider that echoes no nonce is accepted; one that echoes the wrong
	// nonce is a replay.
	if (claims.nonce !== undefined && claims.nonce !== nonce) {
		throw new Error('The ID token nonce does not match');
	}

	return claims;
}

/** Picks the role for a fresh or returning user from the configured claim. */
export function roleFromClaims(
	settings: OAuthSettings,
	claims: Record<string, unknown>,
	fallback: string
): string | null {
	if (!settings.enableRoleManagement) return fallback;
	const raw = claims[settings.rolesClaim];
	const roles = (Array.isArray(raw) ? raw : csv(text(raw))).map((role) => String(role));
	if (roles.some((role) => settings.adminRoles.includes(role))) return 'admin';
	if (roles.some((role) => settings.allowedRoles.includes(role))) return 'user';
	// Role management on with no matching role means the IdP did not authorise
	// this user for the deployment.
	return null;
}

/**
 * Group names from the configured claim. The claim name may be a dotted path
 * (`resource_access.open-webui.roles`), the value either an array or a
 * `;`-separated string, exactly as upstream reads it.
 */
export function groupsFromClaims(
	settings: OAuthSettings,
	claims: Record<string, unknown>
): string[] {
	let value: unknown = claims;
	for (const segment of settings.groupClaim.split('.')) {
		value =
			value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
	}
	if (Array.isArray(value)) return value.map((group) => String(group));
	const raw = text(value).trim();
	if (!raw) return [];
	return raw.includes(';')
		? raw
				.split(';')
				.map((group) => group.trim())
				.filter(Boolean)
		: [raw];
}

/**
 * Blocked-group matching: exact name, then regex when the pattern carries
 * regex metacharacters, then shell-style wildcards. Mirrors upstream's
 * `is_in_blocked_groups`, so the same patterns behave the same way.
 */
export function isBlockedGroup(name: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (!pattern) continue;
		if (name === pattern) return true;
		if (/[\^$[\](){}+\\|]/.test(pattern)) {
			try {
				if (new RegExp(pattern).test(name)) return true;
			} catch {
				// An invalid regex falls through to the wildcard check.
			}
		}
		if (pattern.includes('*') || pattern.includes('?')) {
			const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			const expression = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
			try {
				if (new RegExp(expression).test(name)) return true;
			} catch {
				// Unreachable in practice; a bad pattern simply blocks nothing.
			}
		}
	}
	return false;
}

export function domainAllowed(settings: OAuthSettings, email: string): boolean {
	if (settings.allowedDomains.includes('*')) return true;
	const domain = email.split('@').pop()?.toLowerCase() ?? '';
	return settings.allowedDomains.includes(domain);
}
