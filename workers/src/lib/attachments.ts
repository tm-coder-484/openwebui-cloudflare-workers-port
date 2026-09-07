/**
 * Turning attached images into something a model provider can actually read.
 *
 * The composer uploads an image and stores the file's id as its `url`, and both
 * the chat screen and `messagesFromChat` copy that id straight into an
 * `image_url` part. So the provider was handed a bare UUID, which is not a URL
 * and not an image — vision models saw nothing at all.
 *
 * Inlining as a `data:` URI is the only form that works here. The alternative,
 * handing over a link to our own `/api/v1/files/:id/content`, cannot work for a
 * hosted provider: that route needs the caller's bearer token, and a Worker on
 * a private hostname is not reachable from NVIDIA's network in the first place.
 */

import type { Env } from '../types';
import { parseJSON } from './util';

/** Anything larger would blow the request up; providers cap well below this. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** What providers accept. An SVG is script, and no vision model reads one. */
const RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface FileRow {
	path: string | null;
	meta: string | null;
}

/**
 * Base64 in chunks. `String.fromCharCode(...bytes)` spreads one argument per
 * byte, which throws on a megabyte-sized image long before it runs out of heap.
 */
function toBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/**
 * The id inside whatever the frontend put in `url`.
 *
 * Today that is a bare id, but upstream stores a full `/api/v1/files/:id/content`
 * URL and chats imported from it carry that form, so both are read here.
 */
export function fileIdFromUrl(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) return null;
	const path = trimmed.match(/\/api\/v1\/files\/([^/?#]+)/);
	if (path) return decodeURIComponent(path[1]);
	// A bare id, and nothing that could be a URL or a path.
	if (/^[\w.-]+$/.test(trimmed)) return trimmed;
	return null;
}

/** Reads one of the user's files out of R2 as a `data:` URI, or null. */
async function toDataUri(env: Env, fileId: string, userId: string): Promise<string | null> {
	// Scoped to the owner: the id arrives inside a message body, so an
	// unscoped read would let anyone inline anyone else's file by guessing.
	const row = await env.DB.prepare('SELECT path, meta FROM file WHERE id = ?1 AND user_id = ?2')
		.bind(fileId, userId)
		.first<FileRow>();
	if (!row?.path) return null;

	const meta = parseJSON<{ content_type?: string }>(row.meta, {});
	const contentType = String(meta.content_type ?? '').toLowerCase();
	if (!RENDERABLE.has(contentType)) return null;

	const object = await env.FILES.get(row.path);
	if (!object) return null;

	const buffer = await object.arrayBuffer();
	if (buffer.byteLength > MAX_IMAGE_BYTES) return null;

	return `data:${contentType};base64,${toBase64(new Uint8Array(buffer))}`;
}

/**
 * Rewrites every `image_url` part that names a stored file into a `data:` URI.
 *
 * A part that cannot be resolved is dropped rather than forwarded: a bare id
 * reaches the provider as a malformed URL, and the error that comes back names
 * the URL rather than the image, which is a hard thing to read as "the picture
 * did not arrive". A message left with no content at all keeps its text part so
 * the turn still says something.
 */
export async function inlineImageParts<T extends { role?: string; content?: unknown }>(
	env: Env,
	messages: T[],
	userId: string
): Promise<T[]> {
	const resolved: T[] = [];

	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			resolved.push(message);
			continue;
		}

		const parts: unknown[] = [];
		for (const part of message.content as any[]) {
			if (part?.type !== 'image_url') {
				parts.push(part);
				continue;
			}

			const url = String(part?.image_url?.url ?? '');
			// Already inline, or somewhere the provider can fetch for itself.
			if (/^(data:|https?:)/i.test(url)) {
				parts.push(part);
				continue;
			}

			const fileId = fileIdFromUrl(url);
			const dataUri = fileId ? await toDataUri(env, fileId, userId) : null;
			if (dataUri) parts.push({ ...part, image_url: { ...part.image_url, url: dataUri } });
		}

		resolved.push({ ...message, content: parts } as T);
	}

	return resolved;
}
