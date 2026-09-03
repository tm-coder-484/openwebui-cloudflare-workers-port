import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBUI_VERSION } from '../src/lib/version';

describe('version handshake', () => {
	it('matches the frontend build version', () => {
		// The SvelteKit layout reloads the page whenever /api/version disagrees
		// with the version compiled into the bundle, so these must stay in sync.
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
		);
		expect(WEBUI_VERSION).toBe(pkg.version);
	});
});
