/**
 * WebCrypto-backed auth primitives.
 *
 * The Python backend signs JWTs with HS256 and hashes passwords with bcrypt.
 * Workers have no bcrypt, so passwords use PBKDF2-SHA256 (native, constant
 * cost, no CPU-limit surprises) with a self-describing prefix so the format can
 * evolve. Bcrypt hashes imported from an existing Open WebUI install are
 * detected and rejected with a clear message rather than silently failing.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PBKDF2_ITERATIONS = 100_000;

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = '';
	for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

const b64Encode = (bytes: Uint8Array): string => {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
};

const b64Decode = (value: string): Uint8Array => {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};

/** Constant-time comparison so hash checks don't leak timing information. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		key,
		256
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${b64Encode(salt)}$${b64Encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	if (!stored) return false;
	if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
		throw new Error(
			'This account uses a bcrypt password hash from a self-hosted Open WebUI install. ' +
				'Reset the password (admin panel) to re-hash it for the Workers runtime.'
		);
	}
	const parts = stored.split('$');
	if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
	const iterations = parseInt(parts[1], 10);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;
	const salt = b64Decode(parts[2]);
	const expected = b64Decode(parts[3]);
	const actual = await pbkdf2(password, salt, iterations);
	return timingSafeEqual(actual, expected);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
}

export interface JWTPayload {
	id: string;
	exp?: number;
	iat?: number;
	[key: string]: unknown;
}

export async function createToken(
	payload: JWTPayload,
	secret: string,
	expiresInSeconds: number | null
): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const iat = Math.floor(Date.now() / 1000);
	const body: JWTPayload = { ...payload, iat };
	if (expiresInSeconds !== null) body.exp = iat + expiresInSeconds;

	const unsigned = `${b64urlEncode(encoder.encode(JSON.stringify(header)))}.${b64urlEncode(
		encoder.encode(JSON.stringify(body))
	)}`;
	const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(unsigned));
	return `${unsigned}.${b64urlEncode(signature)}`;
}

/** Returns the payload, or null when the token is malformed, unsigned or expired. */
export async function decodeToken(token: string, secret: string): Promise<JWTPayload | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [headerPart, payloadPart, signaturePart] = parts;

	let valid = false;
	try {
		valid = await crypto.subtle.verify(
			'HMAC',
			await hmacKey(secret),
			b64urlDecode(signaturePart) as BufferSource,
			encoder.encode(`${headerPart}.${payloadPart}`)
		);
	} catch {
		return null;
	}
	if (!valid) return null;

	let payload: JWTPayload;
	try {
		payload = JSON.parse(decoder.decode(b64urlDecode(payloadPart)));
	} catch {
		return null;
	}
	if (typeof payload?.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
	return payload;
}

export function generateApiKey(): string {
	return `sk-${b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
	const input =
		typeof data === 'string'
			? encoder.encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data);
	const digest = await crypto.subtle.digest('SHA-256', input as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
