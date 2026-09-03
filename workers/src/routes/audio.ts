/** `/api/v1/audio` — speech-to-text and text-to-speech proxying. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { openaiConnections } from '../lib/models';
import { bad } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const AUDIO_KEYS: Record<string, string> = {
	TTS_ENGINE: 'audio.tts.engine',
	TTS_MODEL: 'audio.tts.model',
	TTS_VOICE: 'audio.tts.voice',
	TTS_SPLIT_ON: 'audio.tts.split_on',
	STT_ENGINE: 'audio.stt.engine',
	STT_MODEL: 'audio.stt.model'
};

app.get('/config', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, Object.values(AUDIO_KEYS));
	const tts: Record<string, unknown> = {};
	const stt: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(AUDIO_KEYS)) {
		(field.startsWith('TTS') ? tts : stt)[field] = config[key] ?? null;
	}
	return c.json({ tts, stt });
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as { tts?: Record<string, unknown>; stt?: Record<string, unknown> };
	const flat = { ...(body.tts ?? {}), ...(body.stt ?? {}) };
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(AUDIO_KEYS)) if (field in flat) updates[key] = flat[field];
	await setConfigMany(c.env, updates);
	return c.json(body);
});

app.get('/voices', async (c) => {
	verifiedUser(c);
	return c.json({
		voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((id) => ({ id, name: id }))
	});
});

app.get('/models', async (c) => {
	verifiedUser(c);
	return c.json({ models: [{ id: 'tts-1', name: 'tts-1' }, { id: 'tts-1-hd', name: 'tts-1-hd' }] });
});

app.post('/speech', async (c) => {
	verifiedUser(c);
	const config = await getConfigMany(c.env, ['audio.tts.engine', 'audio.tts.model', 'audio.tts.voice']);
	const connection = (await openaiConnections(c.env))[0];
	if (!connection) throw bad('Configure an OpenAI-compatible connection to enable text-to-speech.');

	const body = (await c.req.json()) as Record<string, unknown>;
	const response = await fetch(`${connection.url}/audio/speech`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {})
		},
		body: JSON.stringify({
			model: body.model ?? config['audio.tts.model'] ?? 'tts-1',
			voice: body.voice ?? config['audio.tts.voice'] ?? 'alloy',
			input: body.input ?? ''
		})
	});
	if (!response.ok) throw bad(await response.text());
	return new Response(response.body, {
		headers: { 'Content-Type': response.headers.get('content-type') ?? 'audio/mpeg' }
	});
});

app.post('/transcriptions', async (c) => {
	verifiedUser(c);
	const form = await c.req.formData();
	const file = form.get('file') as unknown as File | null;
	if (!file || typeof file === 'string') throw bad('An audio file is required');

	// Workers AI hosts Whisper, so transcription works without any external key.
	if (c.env.AI) {
		try {
			const audio = [...new Uint8Array(await file.arrayBuffer())];
			const result = (await c.env.AI.run('@cf/openai/whisper' as any, { audio } as any)) as any;
			if (result?.text) return c.json({ text: result.text });
		} catch (error) {
			console.warn('[open-webui] Workers AI transcription failed:', error);
		}
	}

	const connection = (await openaiConnections(c.env))[0];
	if (!connection) throw bad('Configure Workers AI or an OpenAI-compatible connection for transcription.');
	const upstream = new FormData();
	upstream.append('file', file);
	upstream.append('model', (form.get('model') as string) ?? 'whisper-1');
	const response = await fetch(`${connection.url}/audio/transcriptions`, {
		method: 'POST',
		headers: connection.key ? { Authorization: `Bearer ${connection.key}` } : {},
		body: upstream
	});
	if (!response.ok) throw bad(await response.text());
	return c.json(await response.json());
});

export default app;
