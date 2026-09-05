/** `/api/v1/models` — workspace models (presets and base-model overrides). */

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { adminUser, verifiedUser } from '../lib/auth';
import {
	hasAccess,
	listGrants,
	replaceGrants,
	deleteGrants,
	visibleResourceIdsClause
} from '../lib/access';
import { listPage, readListingQuery } from '../lib/listing';
import { hasPermission } from '../lib/permissions';
import {
	getBaseModels,
	getModelRow,
	listModelRows,
	serializeModelRow,
	type ModelRow
} from '../lib/models';
import { DEFAULT_MODEL_IMAGE, profileImageResponse } from '../lib/images';
import { parseJSON } from '../lib/util';
import { bad, forbidden, notFound, now, toJSON } from '../lib/util';

const app = new Hono<AppContext>({ strict: false });

async function withGrants(c: any, rows: ModelRow[]) {
	const grants = await listGrants(
		c.env,
		'model',
		rows.map((row) => row.id)
	);
	return rows.map((row) => serializeModelRow(row, grants.get(row.id) ?? []));
}

app.get('/', async (c) => {
	const user = verifiedUser(c);
	if (user.role === 'admin') return c.json(await withGrants(c, await listModelRows(c.env)));

	const clause = await visibleResourceIdsClause(c.env, user.id, 'model');
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM model WHERE user_id = ? OR id IN (${clause.sql})`
	)
		.bind(user.id, ...clause.bindings)
		.all<ModelRow>();
	return c.json(await withGrants(c, results ?? []));
});

/**
 * The workspace listing: `{items, total, page}`, filtered and sorted. `/` above
 * stays a bare array, which is what the model picker reads.
 */
app.get('/list', async (c) => {
	const user = verifiedUser(c);
	const rows = await listModelRows(c.env);
	const visible: ModelRow[] = [];
	for (const row of rows) {
		if (await hasAccess(c.env, user, 'model', row.id, row.user_id)) visible.push(row);
	}
	return c.json(listPage(await withGrants(c, visible), readListingQuery(c), user.id));
});

app.get('/base', async (c) => {
	adminUser(c);
	return c.json(await withGrants(c, await listModelRows(c.env)));
});

app.get('/tags', async (c) => {
	verifiedUser(c);
	const rows = await listModelRows(c.env);
	const tags = new Set<string>();
	for (const row of rows) {
		const meta = JSON.parse(row.meta ?? '{}');
		for (const tag of meta?.tags ?? []) tags.add(typeof tag === 'string' ? tag : tag?.name);
	}
	return c.json([...tags].filter(Boolean).map((name) => ({ name })));
});

app.get('/base/tags', async (c) => {
	verifiedUser(c);
	const models = await getBaseModels(c.env);
	const tags = new Set<string>();
	for (const model of models) {
		for (const tag of model.tags ?? []) tags.add(typeof tag === 'string' ? tag : tag?.name);
	}
	return c.json([...tags].filter(Boolean).map((name) => ({ name })));
});

app.post('/create', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.models'))) throw forbidden();
	const body = (await c.req.json()) as any;
	if (!body?.id || !body?.name) throw bad('Model id and name are required');
	if (await getModelRow(c.env, body.id)) throw bad('A model with this id already exists.');

	const timestamp = now();
	await c.env.DB.prepare(
		`INSERT INTO model (id, user_id, base_model_id, name, params, meta, is_active, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`
	)
		.bind(
			body.id,
			user.id,
			body.base_model_id ?? null,
			body.name,
			toJSON(body.params ?? {}),
			toJSON(body.meta ?? {}),
			timestamp
		)
		.run();
	if (Array.isArray(body.access_grants)) {
		await replaceGrants(c.env, 'model', body.id, body.access_grants);
	}
	const row = await getModelRow(c.env, body.id);
	return c.json(
		serializeModelRow(
			row!,
			await listGrants(c.env, 'model', [body.id]).then((m) => m.get(body.id) ?? [])
		)
	);
});

app.get('/model/profile/image', async (c) => {
	const id = c.req.query('id');
	const row = id ? await getModelRow(c.env, id) : null;
	const meta = parseJSON<{ profile_image_url?: string }>(row?.meta, {});
	return profileImageResponse(meta.profile_image_url, DEFAULT_MODEL_IMAGE, {
		etag: row?.updated_at
	});
});

app.get('/model', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.query('id');
	if (!id) throw bad('id query parameter is required');
	const row = await getModelRow(c.env, id);
	if (!row) throw notFound('Model not found');
	if (!(await hasAccess(c.env, user, 'model', row.id, row.user_id))) throw forbidden();
	const grants = (await listGrants(c.env, 'model', [row.id])).get(row.id) ?? [];
	return c.json(serializeModelRow(row, grants));
});

app.post('/model/update', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.query('id') ?? '';
	const body = (await c.req.json()) as any;
	const targetId = id || body?.id;
	const row = await getModelRow(c.env, targetId);
	if (!row) throw notFound('Model not found');
	if (!(await hasAccess(c.env, user, 'model', row.id, row.user_id, 'write'))) throw forbidden();

	await c.env.DB.prepare(
		'UPDATE model SET name = ?1, base_model_id = ?2, params = ?3, meta = ?4, is_active = ?5, updated_at = ?6 WHERE id = ?7'
	)
		.bind(
			body.name ?? row.name,
			body.base_model_id ?? row.base_model_id,
			toJSON(body.params ?? JSON.parse(row.params ?? '{}')),
			toJSON(body.meta ?? JSON.parse(row.meta ?? '{}')),
			body.is_active === undefined ? row.is_active : body.is_active ? 1 : 0,
			now(),
			row.id
		)
		.run();
	if (Array.isArray(body.access_grants)) {
		await replaceGrants(c.env, 'model', row.id, body.access_grants);
	}
	const updated = await getModelRow(c.env, row.id);
	const grants = (await listGrants(c.env, 'model', [row.id])).get(row.id) ?? [];
	return c.json(serializeModelRow(updated!, grants));
});

app.post('/model/access/update', async (c) => {
	const user = verifiedUser(c);
	const body = (await c.req.json()) as { id?: string; access_grants?: any[] };
	const id = body.id ?? c.req.query('id');
	if (!id) throw bad('Model id is required');
	const row = await getModelRow(c.env, id);
	if (!row) throw notFound('Model not found');
	if (!(await hasAccess(c.env, user, 'model', row.id, row.user_id, 'write'))) throw forbidden();
	const grants = await replaceGrants(c.env, 'model', row.id, body.access_grants ?? []);
	return c.json(serializeModelRow(row, grants));
});

app.post('/model/toggle', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.query('id');
	if (!id) throw bad('id query parameter is required');
	const row = await getModelRow(c.env, id);
	if (!row) throw notFound('Model not found');
	if (!(await hasAccess(c.env, user, 'model', row.id, row.user_id, 'write'))) throw forbidden();
	await c.env.DB.prepare('UPDATE model SET is_active = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(row.is_active ? 0 : 1, now(), row.id)
		.run();
	const updated = await getModelRow(c.env, row.id);
	return c.json(serializeModelRow(updated!));
});

app.delete('/model/delete', async (c) => {
	const user = verifiedUser(c);
	const id = c.req.query('id');
	if (!id) throw bad('id query parameter is required');
	const row = await getModelRow(c.env, id);
	if (!row) throw notFound('Model not found');
	if (!(await hasAccess(c.env, user, 'model', row.id, row.user_id, 'write'))) throw forbidden();
	await deleteGrants(c.env, 'model', row.id);
	await c.env.DB.prepare('DELETE FROM model WHERE id = ?1').bind(row.id).run();
	return c.json(true);
});

app.delete('/delete/all', async (c) => {
	adminUser(c);
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM access_grant WHERE resource_type = 'model'"),
		c.env.DB.prepare('DELETE FROM model')
	]);
	return c.json(true);
});

app.post('/import', async (c) => {
	const user = verifiedUser(c);
	if (!(await hasPermission(c.env, user, 'workspace.models_import'))) throw forbidden();
	const body = (await c.req.json()) as { models?: any[] };
	const timestamp = now();
	const statements = (body.models ?? [])
		.filter((model) => model?.id && model?.name)
		.map((model) =>
			c.env.DB.prepare(
				`INSERT INTO model (id, user_id, base_model_id, name, params, meta, is_active, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name, params = excluded.params,
					meta = excluded.meta, updated_at = excluded.updated_at`
			).bind(
				model.id,
				user.id,
				model.base_model_id ?? null,
				model.name,
				toJSON(model.params ?? {}),
				toJSON(model.meta ?? {}),
				timestamp
			)
		);
	if (statements.length) await c.env.DB.batch(statements);
	return c.json(await withGrants(c, await listModelRows(c.env)));
});

export default app;
