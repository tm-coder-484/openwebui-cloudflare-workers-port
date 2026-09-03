/**
 * `/api/v1/terminals` — terminal servers.
 *
 * Open Terminal runs containers next to the Python backend; there is no
 * equivalent on Workers, so the list is always empty and the UI hides the
 * terminal affordances.
 */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { verifiedUser } from '../lib/auth';

const app = new Hono<AppContext>({ strict: false });

app.get('/', async (c) => {
	verifiedUser(c);
	return c.json([]);
});

export default app;
