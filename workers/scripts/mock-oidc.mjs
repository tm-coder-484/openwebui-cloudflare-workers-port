#!/usr/bin/env node
/**
 * A minimal OpenID Connect provider for local development and the smoke tests.
 *
 * It implements just enough of the spec to exercise the Worker's sign-in path
 * for real: discovery, authorization code + PKCE (S256), an RS256-signed ID
 * token published through a JWKS, and a userinfo endpoint.
 *
 *   node scripts/mock-oidc.mjs [--port 9500] [--email you@example.com]
 *
 * Point the Worker at http://localhost:<port>/.well-known/openid-configuration
 * with client id `open-webui` and secret `open-webui-secret`.
 */

import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};

const PORT = Number(flag('port', 9500));
const ISSUER = flag('issuer', `http://localhost:${PORT}`);
const CLIENT_ID = flag('client-id', 'open-webui');
const CLIENT_SECRET = flag('client-secret', 'open-webui-secret');

const USER = {
	sub: flag('sub', 'mock-user-1'),
	email: flag('email', 'sso.user@example.com'),
	name: flag('name', 'SSO User'),
	picture: flag('picture', 'https://example.com/avatar.png'),
	groups: (flag('groups', '') || '')
		.split(',')
		.map((group) => group.trim())
		.filter(Boolean),
	roles: (flag('roles', '') || '')
		.split(',')
		.map((role) => role.trim())
		.filter(Boolean)
};

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'mock-oidc-key';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

const b64url = (input) =>
	Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(claims) {
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
	const payload = b64url(JSON.stringify(claims));
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${payload}`);
	const signature = signer.sign(privateKey).toString('base64url');
	return `${header}.${payload}.${signature}`;
}

/** code -> { challenge, nonce, redirect_uri } */
const codes = new Map();

const json = (response, status, body) => {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload)
	});
	response.end(payload);
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url, ISSUER);

	if (url.pathname === '/.well-known/openid-configuration') {
		return json(response, 200, {
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}/authorize`,
			token_endpoint: `${ISSUER}/token`,
			userinfo_endpoint: `${ISSUER}/userinfo`,
			jwks_uri: `${ISSUER}/jwks`,
			response_types_supported: ['code'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['RS256'],
			code_challenge_methods_supported: ['S256'],
			scopes_supported: ['openid', 'email', 'profile']
		});
	}

	if (url.pathname === '/jwks') {
		return json(response, 200, { keys: [jwk] });
	}

	if (url.pathname === '/authorize') {
		const redirectUri = url.searchParams.get('redirect_uri');
		const state = url.searchParams.get('state');
		if (url.searchParams.get('client_id') !== CLIENT_ID || !redirectUri) {
			return json(response, 400, { error: 'invalid_request' });
		}
		// No consent screen: this stands in for a user who is already signed in
		// at the IdP and has previously approved the client.
		const code = randomUUID();
		codes.set(code, {
			challenge: url.searchParams.get('code_challenge'),
			nonce: url.searchParams.get('nonce'),
			redirect_uri: redirectUri
		});
		const target = new URL(redirectUri);
		target.searchParams.set('code', code);
		if (state) target.searchParams.set('state', state);
		response.writeHead(302, { Location: target.toString() });
		return response.end();
	}

	if (url.pathname === '/token' && request.method === 'POST') {
		const body = await new Promise((resolve) => {
			let raw = '';
			request.on('data', (chunk) => (raw += chunk));
			request.on('end', () => resolve(new URLSearchParams(raw)));
		});

		if (body.get('client_id') !== CLIENT_ID || body.get('client_secret') !== CLIENT_SECRET) {
			return json(response, 401, { error: 'invalid_client' });
		}
		const entry = codes.get(body.get('code'));
		if (!entry) return json(response, 400, { error: 'invalid_grant' });
		codes.delete(body.get('code'));

		if (entry.challenge) {
			const verifier = body.get('code_verifier') ?? '';
			const computed = createHash('sha256').update(verifier).digest('base64url');
			if (computed !== entry.challenge) {
				return json(response, 400, {
					error: 'invalid_grant',
					error_description: 'PKCE verification failed'
				});
			}
		}
		if (body.get('redirect_uri') !== entry.redirect_uri) {
			return json(response, 400, { error: 'invalid_grant' });
		}

		const issuedAt = Math.floor(Date.now() / 1000);
		const idToken = signJwt({
			iss: ISSUER,
			aud: CLIENT_ID,
			sub: USER.sub,
			iat: issuedAt,
			exp: issuedAt + 3600,
			...(entry.nonce ? { nonce: entry.nonce } : {}),
			email: USER.email,
			email_verified: true,
			name: USER.name,
			picture: USER.picture,
			...(USER.groups.length ? { groups: USER.groups } : {}),
			...(USER.roles.length ? { roles: USER.roles } : {})
		});
		return json(response, 200, {
			access_token: `mock-access-${randomUUID()}`,
			id_token: idToken,
			token_type: 'Bearer',
			expires_in: 3600
		});
	}

	if (url.pathname === '/userinfo') {
		if (!(request.headers.authorization ?? '').startsWith('Bearer ')) {
			return json(response, 401, { error: 'invalid_token' });
		}
		return json(response, 200, {
			sub: USER.sub,
			email: USER.email,
			email_verified: true,
			name: USER.name,
			picture: USER.picture,
			...(USER.groups.length ? { groups: USER.groups } : {}),
			...(USER.roles.length ? { roles: USER.roles } : {})
		});
	}

	return json(response, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
	console.log(`[mock-oidc] issuer   ${ISSUER}`);
	console.log(`[mock-oidc] discovery ${ISSUER}/.well-known/openid-configuration`);
	console.log(`[mock-oidc] client   ${CLIENT_ID} / ${CLIENT_SECRET}`);
	console.log(`[mock-oidc] user     ${USER.email} (${USER.sub})`);
});
