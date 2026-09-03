/**
 * Profile image serving.
 *
 * Upstream streams files from disk; here the fallbacks live in the static asset
 * bundle, so a redirect keeps the bytes on Cloudflare's cache instead of
 * round-tripping through the Worker.
 */

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Turns a stored `profile_image_url` into a response. Data URIs are decoded and
 * served inline (raster only — an inline SVG would run script on our origin);
 * remote URLs and anything unrecognised fall back to the bundled default.
 */
export function profileImageResponse(
	profileImageUrl: string | null | undefined,
	fallback: string,
	options: { etag?: string | number | null } = {}
): Response {
	if (profileImageUrl?.startsWith('data:image')) {
		const [header, base64Data] = profileImageUrl.split(',', 2);
		const mediaType = header.slice(5).split(';')[0].toLowerCase();
		if (base64Data && ALLOWED_IMAGE_TYPES.has(mediaType)) {
			try {
				const binary = atob(base64Data);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				return new Response(bytes, {
					headers: {
						'Content-Type': mediaType,
						'Content-Disposition': 'inline',
						'X-Content-Type-Options': 'nosniff',
						'Cache-Control': 'private, max-age=60',
						...(options.etag ? { ETag: `"${options.etag}"` } : {})
					}
				});
			} catch {
				// Malformed base64 — fall through to the default image.
			}
		}
	}

	if (profileImageUrl?.startsWith('http')) {
		return Response.redirect(profileImageUrl, 302);
	}

	if (profileImageUrl && profileImageUrl.startsWith('/') && profileImageUrl !== fallback) {
		return new Response(null, { status: 302, headers: { Location: profileImageUrl } });
	}

	return new Response(null, { status: 302, headers: { Location: fallback } });
}

export const DEFAULT_USER_IMAGE = '/user.png';
// LICENSE covers this Open WebUI fallback logo.
export const DEFAULT_MODEL_IMAGE = '/static/favicon.png';
