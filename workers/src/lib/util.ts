/** Small helpers shared across route modules. */

export const now = (): number => Math.floor(Date.now() / 1000);
export const nowNs = (): number => Date.now() * 1_000_000;

export const uuid = (): string => crypto.randomUUID();

/** FastAPI-style error body: `{ "detail": "..." }`. */
export class HttpError extends Error {
	status: number;
	constructor(status: number, detail: string) {
		super(detail);
		this.status = status;
	}
}

export const bad = (detail: string) => new HttpError(400, detail);
export const unauthorized = (detail = 'Invalid token') => new HttpError(401, detail);
export const forbidden = (detail = 'You do not have permission to access this resource.') =>
	new HttpError(403, detail);
export const notFound = (detail = 'Not found') => new HttpError(404, detail);

/** Parse a TEXT column that holds JSON, tolerating nulls and legacy plain text. */
export function parseJSON<T>(value: unknown, fallback: T): T {
	if (value === null || value === undefined || value === '') return fallback;
	if (typeof value === 'object') return value as T;
	try {
		const parsed = JSON.parse(String(value));
		return (parsed ?? fallback) as T;
	} catch {
		return fallback;
	}
}

export const toJSON = (value: unknown): string | null =>
	value === undefined || value === null ? null : JSON.stringify(value);

export const toBool = (value: unknown): boolean =>
	value === true || value === 1 || value === '1' || value === 'true';

export const fromBool = (value: unknown): number => (toBool(value) ? 1 : 0);

/** `a.b.c` lookup used by the config store and permission merging. */
export function getPath(obj: any, path: string): any {
	return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function setPath(obj: any, path: string, value: unknown): void {
	const keys = path.split('.');
	let cursor = obj;
	for (const key of keys.slice(0, -1)) {
		if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
		cursor = cursor[key];
	}
	cursor[keys[keys.length - 1]] = value;
}

/** Recursive merge where `override` wins; used for settings/permission payloads. */
export function deepMerge<T extends Record<string, any>>(
	base: T,
	override: Record<string, any>
): T {
	const out: Record<string, any> = { ...base };
	for (const [key, value] of Object.entries(override ?? {})) {
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			out[key] &&
			typeof out[key] === 'object' &&
			!Array.isArray(out[key])
		) {
			out[key] = deepMerge(out[key], value);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'string' ? parseInt(value, 10) : (value as number);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** `1h`, `30m`, `7d`, `-1` (never expires) — matches upstream's parse_duration. */
export function parseDuration(value: string | null | undefined): number | null {
	if (!value) return null;
	const trimmed = String(value).trim();
	if (trimmed === '-1' || trimmed.toLowerCase() === 'none' || trimmed === '') return null;
	const match = /^(\d+(?:\.\d+)?)\s*([smhdw])?$/i.exec(trimmed);
	if (!match) return null;
	const amount = parseFloat(match[1]);
	const unit = (match[2] ?? 's').toLowerCase();
	const seconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
	return Math.floor(amount * (seconds[unit] ?? 1));
}

export const validateEmail = (email: string): boolean =>
	/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

export const csv = (value: string | undefined | null): string[] =>
	(value ?? '')
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter(Boolean);
