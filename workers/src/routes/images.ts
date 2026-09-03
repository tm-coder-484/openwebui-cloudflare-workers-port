/** `/api/v1/images` — image generation through OpenAI-compatible or Workers AI. */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import { getConfigMany, setConfigMany } from '../lib/config';
import { openaiConnections } from '../lib/models';
import { bad, uuid } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

const IMAGE_KEYS: Record<string, string> = {
	ENABLE_IMAGE_GENERATION: 'image_generation.enable',
	IMAGE_GENERATION_ENGINE: 'image_generation.engine',
	IMAGE_GENERATION_MODEL: 'image_generation.model',
	IMAGE_SIZE: 'image_generation.size',
	IMAGE_STEPS: 'image_generation.steps'
};

app.get('/config', async (c) => {
	adminUser(c);
	const config = await getConfigMany(c.env, Object.values(IMAGE_KEYS));
	const out: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(IMAGE_KEYS)) out[field] = config[key] ?? null;
	return c.json(out);
});

app.post('/config/update', async (c) => {
	adminUser(c);
	const body = (await c.req.json()) as Record<string, unknown>;
	const updates: Record<string, unknown> = {};
	for (const [field, key] of Object.entries(IMAGE_KEYS))
		if (field in body) updates[key] = body[field];
	await setConfigMany(c.env, updates);
	return c.json(body);
});

app.get('/models', async (c) => {
	verifiedUser(c);
	const config = await getConfigMany(c.env, ['image_generation.engine']);
	if (config['image_generation.engine'] === 'workers-ai') {
		return c.json([
			{ id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', name: 'Stable Diffusion XL' },
			{ id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1 [schnell]' }
		]);
	}
	return c.json([
		{ id: 'dall-e-3', name: 'DALL·E 3' },
		{ id: 'gpt-image-1', name: 'GPT Image 1' }
	]);
});

app.post('/generations', async (c) => {
	verifiedUser(c);
	const config = await getConfigMany(c.env, [
		'image_generation.enable',
		'image_generation.engine',
		'image_generation.model',
		'image_generation.size'
	]);
	if (!config['image_generation.enable']) throw bad('Image generation is disabled.');

	const body = (await c.req.json()) as {
		prompt?: string;
		size?: string;
		n?: number;
		model?: string;
	};
	if (!body.prompt) throw bad('A prompt is required');

	if (config['image_generation.engine'] === 'workers-ai') {
		if (!c.env.AI) throw bad('The Workers AI binding is not configured.');
		const model =
			body.model ||
			(config['image_generation.model'] as string) ||
			'@cf/black-forest-labs/flux-1-schnell';
		const result = (await c.env.AI.run(model as any, { prompt: body.prompt } as any)) as any;
		const base64 =
			typeof result?.image === 'string'
				? result.image
				: await new Response(result)
						.arrayBuffer()
						.then((buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))));
		return c.json([{ url: `data:image/png;base64,${base64}` }]);
	}

	const connection = (await openaiConnections(c.env))[0];
	if (!connection) throw bad('Configure an OpenAI-compatible connection for image generation.');
	const response = await fetch(`${connection.url}/images/generations`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {})
		},
		body: JSON.stringify({
			model: body.model || config['image_generation.model'] || 'dall-e-3',
			prompt: body.prompt,
			n: body.n ?? 1,
			size: body.size || config['image_generation.size'] || '1024x1024'
		})
	});
	if (!response.ok) throw bad(await response.text());
	const payload = (await response.json()) as { data?: { url?: string; b64_json?: string }[] };
	return c.json(
		(payload.data ?? []).map((image) => ({
			url: image.url ?? `data:image/png;base64,${image.b64_json}`
		}))
	);
});

export default app;
