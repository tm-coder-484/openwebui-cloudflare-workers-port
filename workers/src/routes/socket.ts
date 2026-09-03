/** `/ws/socket.io` — hands the WebSocket upgrade to the SocketHub. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { hubStub } from '../lib/hub';

const app = new Hono<AppContext>({ strict: false });

app.all('/socket.io', handleSocket);
app.all('/socket.io/', handleSocket);
app.all('/socket.io/*', handleSocket);

async function handleSocket(c: any) {
	const upgrade = c.req.header('upgrade');
	if (upgrade?.toLowerCase() !== 'websocket') {
		// The client only falls back to HTTP long-polling when websockets are
		// disabled in config; this build always advertises websocket support.
		return c.json(
			{
				detail:
					'This deployment serves Socket.IO over WebSocket only. ' +
					'Make sure `features.enable_websocket` stays true.'
			},
			400
		);
	}

	const url = new URL(c.req.url);
	const target = new URL('https://hub/connect');
	const token = url.searchParams.get('token') ?? c.get('token');
	if (token) target.searchParams.set('token', token);

	return hubStub(c.env).fetch(new Request(target.toString(), c.req.raw));
}

export default app;
