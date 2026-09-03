import { describe, expect, it } from 'vitest';
import {
	createToken,
	decodeToken,
	generateApiKey,
	hashPassword,
	sha256Hex,
	verifyPassword
} from '../src/lib/crypto';

const SECRET = 'test-secret';

describe('password hashing', () => {
	it('round-trips a password', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(hash.startsWith('pbkdf2_sha256$')).toBe(true);
		expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
		expect(await verifyPassword('wrong password', hash)).toBe(false);
	});

	it('salts each hash independently', async () => {
		expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
	});

	it('explains bcrypt hashes instead of silently failing', async () => {
		await expect(verifyPassword('x', '$2b$12$abcdefghijklmnopqrstuv')).rejects.toThrow(/bcrypt/);
	});

	it('rejects empty stored hashes', async () => {
		expect(await verifyPassword('x', null)).toBe(false);
		expect(await verifyPassword('x', 'garbage')).toBe(false);
	});
});

describe('json web tokens', () => {
	it('signs and verifies', async () => {
		const token = await createToken({ id: 'user-1' }, SECRET, null);
		const payload = await decodeToken(token, SECRET);
		expect(payload?.id).toBe('user-1');
		expect(payload?.exp).toBeUndefined();
	});

	it('rejects a token signed with another key', async () => {
		const token = await createToken({ id: 'user-1' }, SECRET, null);
		expect(await decodeToken(token, 'other-secret')).toBeNull();
	});

	it('rejects tampered payloads', async () => {
		const token = await createToken({ id: 'user-1' }, SECRET, null);
		const [header, , signature] = token.split('.');
		const forged = btoa(JSON.stringify({ id: 'admin' }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(await decodeToken(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
	});

	it('honours expiry', async () => {
		const token = await createToken({ id: 'user-1' }, SECRET, -10);
		expect(await decodeToken(token, SECRET)).toBeNull();
	});

	it('sets exp when a lifetime is given', async () => {
		const token = await createToken({ id: 'user-1' }, SECRET, 3600);
		const payload = await decodeToken(token, SECRET);
		expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it('rejects malformed tokens', async () => {
		expect(await decodeToken('not-a-token', SECRET)).toBeNull();
		expect(await decodeToken('a.b', SECRET)).toBeNull();
	});
});

describe('misc', () => {
	it('generates prefixed api keys', () => {
		expect(generateApiKey().startsWith('sk-')).toBe(true);
	});

	it('hashes deterministically', async () => {
		expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
		expect(await sha256Hex('abc')).toHaveLength(64);
	});
});
