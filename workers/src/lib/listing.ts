/**
 * The shape the workspace listings read.
 *
 * Every workspace screen — models, prompts, skills, knowledge — asks for a page
 * of rows with the same six query parameters and then does `res.items` and
 * `res.total`. A bare array leaves both undefined, which the screens render as
 * "No … found" while the tab counter, which falls back to `array.length`, shows
 * the real number. That split is the tell.
 *
 * The filtering and sorting run in the Worker rather than in SQL. These are
 * per-user lists of tens of rows, already loaded to check access grants against
 * them; a second query per sort order would buy nothing and would have to
 * duplicate the access clause.
 */

import type { Context } from 'hono';

export const PAGE_SIZE = 30;

export interface ListingQuery {
	query: string;
	viewOption: string;
	tag: string;
	source: string;
	orderBy: string;
	direction: 'asc' | 'desc';
	page: number;
}

export function readListingQuery(c: Context<any>): ListingQuery {
	return {
		query: (c.req.query('query') ?? '').trim().toLowerCase(),
		viewOption: c.req.query('view_option') ?? '',
		tag: c.req.query('tag') ?? '',
		source: c.req.query('source') ?? '',
		orderBy: c.req.query('order_by') ?? '',
		direction: c.req.query('direction') === 'asc' ? 'asc' : 'desc',
		page: Math.max(1, Number(c.req.query('page') ?? 1) || 1)
	};
}

interface Row {
	user_id?: string;
	[key: string]: unknown;
}

const textOf = (row: Row, fields: string[]) =>
	fields
		.map((field) => String(row[field] ?? ''))
		.join(' ')
		.toLowerCase();

const tagsOf = (row: Row): string[] => {
	const tags = row.tags;
	if (!Array.isArray(tags)) return [];
	return tags.map((tag: any) => String(tag?.name ?? tag ?? ''));
};

/**
 * Filters, sorts and slices a list of already-serialised rows.
 *
 * `viewOption` splits the list into what the caller made and what was shared
 * with them, which is why the caller's id is needed rather than just the rows.
 */
export function listPage<T extends Row>(
	rows: T[],
	options: ListingQuery,
	userId: string,
	searchFields: string[] = ['name', 'title', 'description', 'command']
): { items: T[]; total: number; page: number } {
	let matched = rows;

	if (options.query) {
		matched = matched.filter((row) => textOf(row, searchFields).includes(options.query));
	}
	if (options.viewOption === 'created') {
		matched = matched.filter((row) => row.user_id === userId);
	} else if (options.viewOption === 'shared') {
		matched = matched.filter((row) => row.user_id !== userId);
	}
	if (options.tag) {
		matched = matched.filter((row) => tagsOf(row).includes(options.tag));
	}

	if (options.orderBy) {
		const key = options.orderBy;
		const sign = options.direction === 'asc' ? 1 : -1;
		// A copy: the caller's array is often a cached list, and sorting in place
		// would reorder it for whoever holds it next.
		matched = [...matched].sort((a, b) => {
			const left = a[key];
			const right = b[key];
			if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
			return String(left ?? '').localeCompare(String(right ?? '')) * sign;
		});
	}

	return {
		items: matched.slice((options.page - 1) * PAGE_SIZE, options.page * PAGE_SIZE),
		total: matched.length,
		page: options.page
	};
}
