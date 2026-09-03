import { describe, expect, it } from 'vitest';
import {
	codeChallenge,
	domainAllowed,
	groupsFromClaims,
	isBlockedGroup,
	openFlowState,
	providerButtons,
	redirectUriFor,
	roleFromClaims,
	sealFlowState,
	verifyIdToken,
	type OAuthSettings,
	type ProviderConfig
} from '../src/lib/oauth';
import { b64urlEncode } from '../src/lib/crypto';

const settings = (overrides: Partial<OAuthSettings> = {}): OAuthSettings => ({
	enable: true,
	providerName: 'SSO',
	clientId: 'client',
	clientSecret: 'secret',
	openidProviderUrl: 'https://idp.test/.well-known/openid-configuration',
	openidRedirectUri: '',
	scopes: 'openid email profile',
	emailClaim: 'email',
	usernameClaim: 'name',
	pictureClaim: 'picture',
	subClaim: '',
	groupClaim: 'groups',
	rolesClaim: 'roles',
	enableSignup: true,
	mergeAccountsByEmail: false,
	autoRedirect: false,
	allowedDomains: ['*'],
	enableRoleManagement: false,
	enableGroupManagement: false,
	enableGroupCreation: false,
	allowedRoles: ['user', 'admin'],
	adminRoles: ['admin'],
	blockedGroups: [],
	updateNameOnLogin: false,
	updateEmailOnLogin: false,
	updatePictureOnLogin: false,
	...overrides
});

const provider: ProviderConfig = {
	id: 'oidc',
	label: 'SSO',
	clientId: 'client',
	clientSecret: 'secret',
	scopes: 'openid email profile',
	discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
	subClaim: 'sub'
};

describe('codeChallenge', () => {
	it('produces the S256 challenge from RFC 7636 appendix B', async () => {
		expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
			'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
		);
	});
});

describe('flow state cookie', () => {
	const state = {
		provider: 'oidc',
		verifier: 'verifier',
		nonce: 'nonce',
		state: 'state',
		redirect_uri: 'https://app.test/oauth/oidc/callback'
	};

	it('round-trips through a signed token', async () => {
		const sealed = await sealFlowState(state, 'secret');
		expect(await openFlowState(sealed, 'secret')).toMatchObject(state);
	});

	it('rejects a token signed with another key', async () => {
		const sealed = await sealFlowState(state, 'secret');
		expect(await openFlowState(sealed, 'other-secret')).toBeNull();
	});

	it('rejects a session token presented as a flow cookie', async () => {
		const { createToken } = await import('../src/lib/crypto');
		const session = await createToken({ id: 'user-1' }, 'secret', 3600);
		expect(await openFlowState(session, 'secret')).toBeNull();
	});
});

describe('redirectUriFor', () => {
	it('derives the callback from the request origin', () => {
		expect(redirectUriFor(provider, 'https://app.test/oauth/oidc/login')).toBe(
			'https://app.test/oauth/oidc/callback'
		);
	});

	it('prefers a configured WEBUI_URL over the request origin', () => {
		expect(
			redirectUriFor(provider, 'https://internal.test/oauth/oidc/login', 'https://app.test/')
		).toBe('https://app.test/oauth/oidc/callback');
	});

	it('uses an explicit provider redirect URI when set', () => {
		expect(
			redirectUriFor({ ...provider, redirectUri: 'https://fixed.test/cb' }, 'https://app.test/x')
		).toBe('https://fixed.test/cb');
	});
});

describe('domainAllowed', () => {
	it('allows everything when the list is "*"', () => {
		expect(domainAllowed(settings(), 'someone@anywhere.test')).toBe(true);
	});

	it('accepts a listed domain and rejects the rest', () => {
		const config = settings({ allowedDomains: ['example.com'] });
		expect(domainAllowed(config, 'someone@example.com')).toBe(true);
		expect(domainAllowed(config, 'someone@evil.test')).toBe(false);
	});
});

describe('roleFromClaims', () => {
	it('keeps the fallback role when role management is off', () => {
		expect(roleFromClaims(settings(), { roles: ['admin'] }, 'pending')).toBe('pending');
	});

	it('promotes a user carrying an admin role', () => {
		const config = settings({ enableRoleManagement: true });
		expect(roleFromClaims(config, { roles: ['admin'] }, 'pending')).toBe('admin');
	});

	it('grants "user" for an allowed non-admin role', () => {
		const config = settings({ enableRoleManagement: true });
		expect(roleFromClaims(config, { roles: ['user'] }, 'pending')).toBe('user');
	});

	it('refuses a user with no matching role', () => {
		const config = settings({ enableRoleManagement: true });
		expect(roleFromClaims(config, { roles: ['guest'] }, 'pending')).toBeNull();
	});
});

describe('groupsFromClaims', () => {
	it('reads an array claim', () => {
		expect(groupsFromClaims(settings(), { groups: ['a', 'b'] })).toEqual(['a', 'b']);
	});

	it('splits a semicolon-separated string, matching upstream', () => {
		expect(groupsFromClaims(settings(), { groups: 'a;b ; c' })).toEqual(['a', 'b', 'c']);
	});

	it('treats a plain string as one group', () => {
		expect(groupsFromClaims(settings(), { groups: 'engineering' })).toEqual(['engineering']);
	});

	it('follows a dotted claim path', () => {
		const config = settings({ groupClaim: 'resource_access.open-webui.roles' });
		const claims = { resource_access: { 'open-webui': { roles: ['staff'] } } };
		expect(groupsFromClaims(config, claims)).toEqual(['staff']);
	});

	it('returns nothing when the claim is absent', () => {
		expect(groupsFromClaims(settings(), {})).toEqual([]);
	});
});

describe('isBlockedGroup', () => {
	it('matches an exact name', () => {
		expect(isBlockedGroup('admins', ['admins'])).toBe(true);
	});

	it('matches a shell-style wildcard', () => {
		expect(isBlockedGroup('team-eng', ['team-*'])).toBe(true);
		expect(isBlockedGroup('other', ['team-*'])).toBe(false);
	});

	it('matches a regex pattern', () => {
		expect(isBlockedGroup('int-42', ['^int-[0-9]+$'])).toBe(true);
	});

	it('blocks nothing when no patterns are configured', () => {
		expect(isBlockedGroup('anything', [])).toBe(false);
	});
});

describe('providerButtons', () => {
	it('maps provider ids to their display labels', () => {
		expect(providerButtons({ oidc: { ...provider, label: 'Keycloak' } })).toEqual({
			oidc: 'Keycloak'
		});
	});
});

// A real RS256 key pair exercises the same code path a live IdP would.
async function signedIdToken(
	claims: Record<string, unknown>,
	key: CryptoKey,
	kid = 'test-key'
): Promise<string> {
	const encoder = new TextEncoder();
	const header = b64urlEncode(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
	const payload = b64urlEncode(encoder.encode(JSON.stringify(claims)));
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		encoder.encode(`${header}.${payload}`)
	);
	return `${header}.${payload}.${b64urlEncode(signature)}`;
}

describe('verifyIdToken', () => {
	const metadata = {
		issuer: 'https://idp.test',
		authorization_endpoint: 'https://idp.test/authorize',
		token_endpoint: 'https://idp.test/token',
		jwks_uri: 'https://idp.test/jwks'
	};

	async function fixture() {
		const pair = await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256'
			},
			true,
			['sign', 'verify']
		);
		const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
		// A KV stub keeps the JWKS local: the test never leaves the process.
		const env = {
			CACHE: {
				get: async () => ({ keys: [{ ...jwk, kid: 'test-key' }] }),
				put: async () => {}
			}
		} as any;
		const base = {
			iss: 'https://idp.test',
			aud: 'client',
			sub: 'subject-1',
			nonce: 'nonce',
			exp: Math.floor(Date.now() / 1000) + 300
		};
		return { env, key: pair.privateKey, base };
	}

	it('accepts a correctly signed token', async () => {
		const { env, key, base } = await fixture();
		const token = await signedIdToken({ ...base, email: 'a@b.test' }, key);
		const claims = await verifyIdToken(env, metadata, provider, token, 'nonce');
		expect(claims.sub).toBe('subject-1');
		expect(claims.email).toBe('a@b.test');
	});

	it('rejects a tampered payload', async () => {
		const { env, key, base } = await fixture();
		const token = await signedIdToken(base, key);
		const [header, , signature] = token.split('.');
		const forged = b64urlEncode(
			new TextEncoder().encode(JSON.stringify({ ...base, sub: 'someone-else' }))
		);
		await expect(
			verifyIdToken(env, metadata, provider, `${header}.${forged}.${signature}`, 'nonce')
		).rejects.toThrow(/signature/i);
	});

	it('rejects a token issued for another client', async () => {
		const { env, key, base } = await fixture();
		const token = await signedIdToken({ ...base, aud: 'another-client' }, key);
		await expect(verifyIdToken(env, metadata, provider, token, 'nonce')).rejects.toThrow(
			/not issued for this client/i
		);
	});

	it('rejects a token from another issuer', async () => {
		const { env, key, base } = await fixture();
		const token = await signedIdToken({ ...base, iss: 'https://evil.test' }, key);
		await expect(verifyIdToken(env, metadata, provider, token, 'nonce')).rejects.toThrow(/issuer/i);
	});

	it('rejects a replayed token carrying the wrong nonce', async () => {
		const { env, key, base } = await fixture();
		const token = await signedIdToken({ ...base, nonce: 'stale' }, key);
		await expect(verifyIdToken(env, metadata, provider, token, 'nonce')).rejects.toThrow(/nonce/i);
	});

	it('rejects an expired token', async () => {
		const { env, key, base } = await fixture();
		const token = await signedIdToken({ ...base, exp: Math.floor(Date.now() / 1000) - 3600 }, key);
		await expect(verifyIdToken(env, metadata, provider, token, 'nonce')).rejects.toThrow(
			/expired/i
		);
	});

	it('refuses an unsigned ("alg: none") token', async () => {
		const { env } = await fixture();
		const encoder = new TextEncoder();
		const header = b64urlEncode(encoder.encode(JSON.stringify({ alg: 'none', typ: 'JWT' })));
		const payload = b64urlEncode(encoder.encode(JSON.stringify({ sub: 'x', aud: 'client' })));
		await expect(
			verifyIdToken(env, metadata, provider, `${header}.${payload}.`, 'nonce')
		).rejects.toThrow(/unsupported id token algorithm/i);
	});
});
