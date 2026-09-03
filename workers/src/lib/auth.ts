/** Request authentication: Bearer JWT, `sk-` API key, or the `token` cookie. */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppContext, Env, SessionUser } from '../types';
import { getConfig, secretKey } from './config';
import { decodeToken } from './crypto';
import { forbidden, unauthorized } from './util';
import { getUserByApiKey, getUserById, serializeUser, touchLastActive } from './users';

export async function resolveToken(env: Env, token: string): Promise<SessionUser | null> {
	if (!token) return null;

	if (token.startsWith('sk-')) {
		if (!(await getConfig<boolean>(env, 'auth.enable_api_keys'))) return null;
		const row = await getUserByApiKey(env, token);
		return row ? serializeUser(row) : null;
	}

	const payload = await decodeToken(token, secretKey(env));
	if (!payload?.id) return null;
	const row = await getUserById(env, String(payload.id));
	return row ? serializeUser(row) : null;
}

export function bearerFrom(c: Context<AppContext>): string | null {
	const header = c.req.header('authorization') ?? c.req.header('Authorization');
	if (header) {
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match) return match[1].trim();
	}
	return getCookie(c, 'token') ?? null;
}

/** Populates `c.var.user` when a valid credential is present; never rejects. */
export const authenticate: MiddlewareHandler<AppContext> = async (c, next: Next) => {
	c.set('user', null);
	c.set('token', null);
	const token = bearerFrom(c);
	if (token) {
		c.set('token', token);
		try {
			const user = await resolveToken(c.env, token);
			if (user) {
				c.set('user', user);
				// Best-effort presence tracking; never blocks the response.
				c.executionCtx?.waitUntil?.(touchLastActive(c.env, user.id).catch(() => {}));
			}
		} catch {
			c.set('user', null);
		}
	}
	await next();
};

/** Any signed-in account, including `pending` (upstream: get_current_user). */
export function currentUser(c: Context<AppContext>): SessionUser {
	const user = c.get('user');
	if (!user) throw unauthorized('Not authenticated');
	return user;
}

/** Activated accounts only (upstream: get_verified_user). */
export function verifiedUser(c: Context<AppContext>): SessionUser {
	const user = currentUser(c);
	if (user.role !== 'user' && user.role !== 'admin') {
		throw forbidden('Your account is pending activation.');
	}
	return user;
}

export function adminUser(c: Context<AppContext>): SessionUser {
	const user = currentUser(c);
	if (user.role !== 'admin') throw forbidden('You do not have permission to access this resource.');
	return user;
}

export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
	currentUser(c);
	await next();
};

export const requireVerified: MiddlewareHandler<AppContext> = async (c, next) => {
	verifiedUser(c);
	await next();
};

export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
	adminUser(c);
	await next();
};
