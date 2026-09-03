/** `/api/v1/utils` — small helpers the UI calls directly. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { sha256Hex } from '../lib/crypto';
import { bad } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

app.get('/gravatar', async (c) => {
	const email = (c.req.query('email') ?? '').trim().toLowerCase();
	if (!email) throw bad('An email address is required');
	// Gravatar switched to SHA-256 hashes; the UI only needs the URL back.
	return c.json(`https://www.gravatar.com/avatar/${await sha256Hex(email)}?d=mp`);
});

app.post('/code/format', async (c) => {
	verifiedUser(c);
	const { code } = (await c.req.json()) as { code?: string };
	// Upstream shells out to `black`; there is no Python here, so the code is
	// returned untouched rather than silently mangled.
	return c.json({ code: code ?? '' });
});

app.post('/code/execute', async (c) => {
	verifiedUser(c);
	throw bad(
		'Server-side code execution is unavailable on Workers. Use the in-browser Pyodide interpreter instead.'
	);
});

app.post('/pdf', async (c) => {
	verifiedUser(c);
	throw bad('Server-side PDF export is not available in the Cloudflare Workers build.');
});

app.get('/db/download', async (c) => {
	adminUser(c);
	throw bad('Use `wrangler d1 export open-webui` to download the database.');
});

export default app;
