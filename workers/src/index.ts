/**
 * Open WebUI on Cloudflare Workers.
 *
 * The SvelteKit frontend is served from Workers Static Assets; every API path
 * listed in `run_worker_first` (wrangler.toml) lands here instead. Route modules
 * mirror the FastAPI routers of the Python backend one-for-one.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext, Env } from './types';
import { authenticate } from './lib/auth';
import { HttpError, resolveAllowedOrigin } from './lib/util';
import { runDueAutomations } from './lib/automations';

import main from './routes/main';
import auths from './routes/auths';
import users from './routes/users';
import chats from './routes/chats';
import folders from './routes/folders';
import models from './routes/models';
import prompts from './routes/prompts';
import files from './routes/files';
import knowledge from './routes/knowledge';
import memories from './routes/memories';
import notes from './routes/notes';
import channels from './routes/channels';
import groups from './routes/groups';
import configs from './routes/configs';
import tools from './routes/tools';
import functions from './routes/functions';
import evaluations from './routes/evaluations';
import analytics from './routes/analytics';
import automations from './routes/automations';
import calendar from './routes/calendar';
import notifications from './routes/notifications';
import tasks from './routes/tasks';
import utils from './routes/utils';
import openai from './routes/openai';
import ollama from './routes/ollama';
import retrieval from './routes/retrieval';
import audio from './routes/audio';
import images from './routes/images';
import skills from './routes/skills';
import terminals from './routes/terminals';
import socket from './routes/socket';

export { SocketHub } from './socket/hub';

const app = new Hono<AppContext>({ strict: false });

/**
 * CORS mirrors upstream's default (`CORS_ALLOW_ORIGIN=*`, credentials allowed);
 * set `CORS_ALLOW_ORIGIN` to a `;`-separated allowlist to lock it down. The
 * session cookie is SameSite=Lax, so it is not sent on cross-site requests
 * regardless — cross-origin API clients authenticate with a Bearer token.
 */
app.use('*', (c, next) =>
	cors({
		origin: (origin) => resolveAllowedOrigin(c.env.CORS_ALLOW_ORIGIN, origin),
		credentials: true
	})(c, next)
);
app.use('*', authenticate);

// Realtime transport (socket.io) — must be registered before the API groups so
// the WebSocket upgrade is never swallowed by a JSON handler.
app.route('/ws', socket);

app.route('/api/v1/auths', auths);
app.route('/api/v1/users', users);
app.route('/api/v1/chats', chats);
app.route('/api/v1/folders', folders);
app.route('/api/v1/models', models);
app.route('/api/v1/prompts', prompts);
app.route('/api/v1/files', files);
app.route('/api/v1/knowledge', knowledge);
app.route('/api/v1/memories', memories);
app.route('/api/v1/notes', notes);
app.route('/api/v1/channels', channels);
app.route('/api/v1/groups', groups);
app.route('/api/v1/configs', configs);
app.route('/api/v1/tools', tools);
app.route('/api/v1/skills', skills);
app.route('/api/v1/terminals', terminals);
app.route('/api/v1/functions', functions);
app.route('/api/v1/evaluations', evaluations);
app.route('/api/v1/analytics', analytics);
app.route('/api/v1/automations', automations);
app.route('/api/v1/calendars', calendar);
app.route('/api/v1/notifications', notifications);
app.route('/api/v1/tasks', tasks);
app.route('/api/v1/utils', utils);
app.route('/api/v1/retrieval', retrieval);
app.route('/api/v1/audio', audio);
app.route('/api/v1/images', images);
app.route('/openai', openai);
app.route('/ollama', ollama);
app.route('/', main);

app.onError((err, c) => {
	if (err instanceof HttpError) {
		return c.json({ detail: err.message }, err.status as 400);
	}
	// A missing table means the D1 migrations were never applied — say so
	// instead of returning an opaque 500 on the very first request.
	if (/no such table|D1_ERROR.*no such table/i.test(err.message ?? '')) {
		console.error('[open-webui] database not initialised', err);
		return c.json(
			{
				detail:
					'The database is not initialised. Apply the D1 migrations: ' +
					'`npm --prefix workers run db:remote` (or `db:local` for wrangler dev).'
			},
			503
		);
	}
	console.error('[open-webui] unhandled error', err);
	return c.json({ detail: 'Internal server error' }, 500);
});

app.notFound(async (c) => {
	const path = new URL(c.req.url).pathname;
	if (
		path.startsWith('/api/') ||
		path.startsWith('/openai') ||
		path.startsWith('/ollama') ||
		path.startsWith('/ws')
	) {
		return c.json({ detail: 'Not Found' }, 404);
	}
	// Anything else is a frontend route: hand it back to the SPA shell.
	if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
	return c.text('Not Found', 404);
});

/**
 * Cron Trigger entry point. Scheduled automations are the Workers-native
 * replacement for the Python scheduler loop.
 */
async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
	ctx.waitUntil(
		runDueAutomations(env).catch((error) =>
			console.error('[open-webui] scheduled run failed', error)
		)
	);
}

export default {
	fetch: app.fetch,
	scheduled
};
