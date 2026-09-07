import { describe, expect, it } from 'vitest';
import { fileIdFromUrl, inlineImageParts } from '../src/lib/attachments';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

/**
 * A stand-in for the two bindings this reads: the file table, scoped by owner,
 * and the bucket the bytes live in.
 */
const envWith = (
	files: Record<string, { path: string; userId: string; contentType: string; bytes?: Uint8Array }>
) =>
	({
		DB: {
			prepare: (_sql: string) => ({
				bind: (id: string, userId: string) => ({
					first: async () => {
						const row = files[id];
						if (!row || row.userId !== userId) return null;
						return { path: row.path, meta: JSON.stringify({ content_type: row.contentType }) };
					}
				})
			})
		},
		FILES: {
			get: async (path: string) => {
				const row = Object.values(files).find((file) => file.path === path);
				if (!row) return null;
				const bytes = row.bytes ?? PNG_BYTES;
				return {
					arrayBuffer: async () =>
						bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
				};
			}
		}
	}) as any;

const imageMessage = (url: string) => ({
	role: 'user',
	content: [
		{ type: 'text', text: 'what is this' },
		{ type: 'image_url', image_url: { url } }
	]
});

const urlsOf = (message: any) =>
	(message.content as any[]).filter((p) => p.type === 'image_url').map((p) => p.image_url.url);

describe('fileIdFromUrl', () => {
	it('reads the bare id the composer stores', () => {
		// `fileItem.url = `${uploadedFile.id}`` — not a URL, despite the name.
		expect(fileIdFromUrl('4cc55792-7577-4c7b-a085-f02b461c5c7a')).toBe(
			'4cc55792-7577-4c7b-a085-f02b461c5c7a'
		);
	});

	it('reads the id out of the path upstream stores', () => {
		// Chats imported from upstream carry the full route instead.
		expect(fileIdFromUrl('/api/v1/files/abc123/content')).toBe('abc123');
		expect(fileIdFromUrl('https://host.test/api/v1/files/abc123/content/x.png')).toBe('abc123');
	});

	it('claims nothing that is already a usable URL', () => {
		expect(fileIdFromUrl('data:image/png;base64,AAAA')).toBeNull();
		expect(fileIdFromUrl('https://example.test/cat.png')).toBeNull();
		expect(fileIdFromUrl('   ')).toBeNull();
	});
});

describe('inlineImageParts', () => {
	const env = envWith({
		'file-1': { path: 'uploads/1', userId: 'u1', contentType: 'image/png' }
	});

	it('replaces a stored file reference with the bytes', async () => {
		// The bug: the provider was sent the id itself, which is not a URL and
		// not an image, so a vision model received nothing.
		const [message] = await inlineImageParts(env, [imageMessage('file-1')], 'u1');
		const [url] = urlsOf(message);

		expect(url.startsWith('data:image/png;base64,')).toBe(true);
		expect(atob(url.split(',')[1])).toBe(String.fromCharCode(...PNG_BYTES));
	});

	it('resolves the upstream path form too', async () => {
		const [message] = await inlineImageParts(
			env,
			[imageMessage('/api/v1/files/file-1/content')],
			'u1'
		);
		expect(urlsOf(message)[0].startsWith('data:image/png;base64,')).toBe(true);
	});

	it('leaves a data URI and a remote URL alone', async () => {
		// A temporary chat never uploads, so its images are already inline.
		const inline = 'data:image/png;base64,AAAA';
		const remote = 'https://example.test/cat.png';
		const [a] = await inlineImageParts(env, [imageMessage(inline)], 'u1');
		const [b] = await inlineImageParts(env, [imageMessage(remote)], 'u1');
		expect(urlsOf(a)).toEqual([inline]);
		expect(urlsOf(b)).toEqual([remote]);
	});

	it('will not read a file belonging to someone else', async () => {
		// The id arrives inside a message body, so it is attacker-controlled.
		const [message] = await inlineImageParts(env, [imageMessage('file-1')], 'someone-else');
		expect(urlsOf(message)).toEqual([]);
	});

	it('drops a reference it cannot resolve rather than forwarding the id', async () => {
		// Forwarding it produces a provider error naming a malformed URL, which
		// reads as anything except "the picture did not arrive".
		const [message] = await inlineImageParts(env, [imageMessage('no-such-file')], 'u1');
		expect(urlsOf(message)).toEqual([]);
		expect((message.content as any[])[0]).toEqual({ type: 'text', text: 'what is this' });
	});

	it('refuses a file that is not a renderable image', async () => {
		const pdfEnv = envWith({
			'file-1': { path: 'uploads/1', userId: 'u1', contentType: 'application/pdf' }
		});
		const [message] = await inlineImageParts(pdfEnv, [imageMessage('file-1')], 'u1');
		expect(urlsOf(message)).toEqual([]);
	});

	it('refuses an image too large to send', async () => {
		const huge = envWith({
			'file-1': {
				path: 'uploads/1',
				userId: 'u1',
				contentType: 'image/png',
				bytes: new Uint8Array(13 * 1024 * 1024)
			}
		});
		const [message] = await inlineImageParts(huge, [imageMessage('file-1')], 'u1');
		expect(urlsOf(message)).toEqual([]);
	});

	it('leaves an ordinary text turn exactly as it was', async () => {
		const messages = [
			{ role: 'system', content: 'be helpful' },
			{ role: 'user', content: 'hello' }
		];
		expect(await inlineImageParts(env, messages, 'u1')).toEqual(messages);
	});
});
