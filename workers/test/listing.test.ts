import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, listPage, type ListingQuery } from '../src/lib/listing';
import { collectShareables, writeAccessChecker } from '../src/lib/shareable';

const query = (overrides: Partial<ListingQuery> = {}): ListingQuery => ({
	query: '',
	viewOption: '',
	tag: '',
	source: '',
	orderBy: '',
	direction: 'desc',
	page: 1,
	...overrides
});

const rows = [
	{ id: 'a', name: 'Alpha', user_id: 'me', updated_at: 3, tags: [{ name: 'draft' }] },
	{ id: 'b', name: 'Beta', user_id: 'you', updated_at: 1, tags: [] },
	{ id: 'c', name: 'Gamma', user_id: 'me', updated_at: 2, tags: ['draft'] }
];

describe('workspace listings', () => {
	it('answers with the shape the screens read', () => {
		const page = listPage(rows, query(), 'me');
		expect(page).toEqual({ items: rows, total: 3, page: 1 });
	});

	it('splits what I made from what was shared with me', () => {
		expect(listPage(rows, query({ viewOption: 'created' }), 'me').items.map((r) => r.id)).toEqual([
			'a',
			'c'
		]);
		expect(listPage(rows, query({ viewOption: 'shared' }), 'me').items.map((r) => r.id)).toEqual([
			'b'
		]);
	});

	it('searches the fields the row displays', () => {
		expect(listPage(rows, query({ query: 'gam' }), 'me').items.map((r) => r.id)).toEqual(['c']);
		expect(listPage(rows, query({ query: 'nothing' }), 'me').total).toBe(0);
	});

	it('accepts a tag written either way', () => {
		// Prompts carry `[{name}]`, some rows carry plain strings.
		expect(listPage(rows, query({ tag: 'draft' }), 'me').items.map((r) => r.id)).toEqual([
			'a',
			'c'
		]);
	});

	it('sorts by a number and by a name, in both directions', () => {
		const by = (o: Partial<ListingQuery>) => listPage(rows, query(o), 'me').items.map((r) => r.id);
		expect(by({ orderBy: 'updated_at', direction: 'desc' })).toEqual(['a', 'c', 'b']);
		expect(by({ orderBy: 'updated_at', direction: 'asc' })).toEqual(['b', 'c', 'a']);
		expect(by({ orderBy: 'name', direction: 'asc' })).toEqual(['a', 'b', 'c']);
		expect(by({ orderBy: 'name', direction: 'desc' })).toEqual(['c', 'b', 'a']);
	});

	it('leaves the caller`s array in the order it was given', () => {
		const original = [...rows];
		listPage(rows, query({ orderBy: 'name', direction: 'asc' }), 'me');
		expect(rows).toEqual(original);
	});

	it('reports the full count while returning one page of it', () => {
		const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({
			id: String(i),
			name: `Row ${i}`,
			user_id: 'me'
		}));
		const first = listPage(many, query(), 'me');
		expect(first.items).toHaveLength(PAGE_SIZE);
		expect(first.total).toBe(PAGE_SIZE + 5);

		const second = listPage(many, query({ page: 2 }), 'me');
		expect(second.items).toHaveLength(5);
		expect(second.page).toBe(2);
	});
});

describe('finding shareable resources in a response', () => {
	it('picks out anything carrying access grants, at any nesting the port uses', () => {
		const body = {
			items: [{ id: 'a', access_grants: [] }],
			directories: [{ id: 'not-a-resource' }],
			total: 1
		};
		expect(collectShareables(body).map((r) => r.id)).toEqual(['a']);
	});

	it('finds them in a bare array too', () => {
		expect(collectShareables([{ id: 'x', access_grants: [] }, { id: 'y' }])).toHaveLength(1);
	});

	it('leaves everything else alone', () => {
		expect(collectShareables({ ok: true, data: 'a string' })).toEqual([]);
		expect(collectShareables(null)).toEqual([]);
		expect(collectShareables('text')).toEqual([]);
	});

	it('stops rather than following a cycle forever', () => {
		const loop: any = { items: [] };
		loop.items.push(loop);
		expect(() => collectShareables(loop)).not.toThrow();
	});
});

describe('who may write a resource', () => {
	const me = { id: 'me', role: 'user' };
	const admin = { id: 'root', role: 'admin' };
	const groups = new Set(['engineering']);

	const can = writeAccessChecker(me, groups);

	it('lets the owner write their own', () => {
		expect(can('me', [])).toBe(true);
	});

	it('lets an admin write anyone`s', () => {
		expect(writeAccessChecker(admin, new Set())('someone-else', [])).toBe(true);
	});

	it('refuses a read grant and accepts a write one', () => {
		const grant = (permission: string) => [
			{ principal_type: 'user', principal_id: 'me', permission }
		];
		expect(can('someone-else', grant('read'))).toBe(false);
		expect(can('someone-else', grant('write'))).toBe(true);
	});

	it('honours a grant to a group I am in, and ignores one I am not', () => {
		const toGroup = (id: string) => [
			{ principal_type: 'group', principal_id: id, permission: 'write' }
		];
		expect(can('someone-else', toGroup('engineering'))).toBe(true);
		expect(can('someone-else', toGroup('finance'))).toBe(false);
	});

	it('treats a public write grant as writable', () => {
		expect(
			can('someone-else', [{ principal_type: 'user', principal_id: '*', permission: 'write' }])
		).toBe(true);
	});

	it('says no when there is nothing to go on', () => {
		expect(can('someone-else', [])).toBe(false);
		expect(can(undefined, undefined)).toBe(false);
	});
});
