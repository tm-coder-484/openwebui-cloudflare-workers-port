import { beforeEach, describe, expect, it } from 'vitest';
import { FILE_TOOLS, MEMORY_TOOLS, SEARCH_TOOLS, runToolCall, toolsFor } from '../src/lib/tools';
import { globToRegExp } from '../src/lib/workspace';

/**
 * A D1 + R2 stub backed by plain arrays, enough for the memory and file tools.
 * It enforces the thing that matters most: every statement carries a user id,
 * and rows belonging to another user are invisible.
 */
function fakeEnv() {
	const memories: any[] = [];
	const files: any[] = [];

	const run = (sql: string, args: any[]) => {
		const s = sql.replace(/\s+/g, ' ').trim();

		if (s.startsWith('SELECT * FROM memory WHERE user_id')) {
			return memories.filter((m) => m.user_id === args[0]);
		}
		if (s.startsWith('INSERT INTO memory')) {
			memories.unshift({
				id: args[0],
				user_id: args[1],
				type: args[2],
				path: args[3],
				content: args[4],
				meta: args[5],
				created_at: args[6],
				updated_at: args[6]
			});
			return [];
		}
		if (s.startsWith('SELECT * FROM memory WHERE id')) {
			return memories.filter((m) => m.id === args[0]);
		}
		if (s.startsWith('SELECT id FROM memory WHERE id')) {
			return memories.filter((m) => m.id === args[0] && m.user_id === args[1]);
		}
		if (s.startsWith('DELETE FROM memory')) {
			const index = memories.findIndex((m) => m.id === args[0] && m.user_id === args[1]);
			if (index >= 0) memories.splice(index, 1);
			return [];
		}

		if (s.includes('FROM file WHERE user_id = ?1 ORDER BY')) {
			return files.filter((f) => f.user_id === args[0]);
		}
		if (s.includes('FROM file') && s.includes('id = ?2 OR filename = ?2')) {
			return files.filter(
				(f) =>
					f.user_id === args[0] &&
					(f.id === args[1] || String(f.filename).toLowerCase() === String(args[1]).toLowerCase())
			);
		}
		if (s.startsWith('SELECT path FROM file')) {
			return files.filter((f) => f.id === args[0] && f.user_id === args[1]);
		}
		if (s.startsWith('INSERT INTO file')) {
			files.unshift({
				id: args[0],
				user_id: args[1],
				filename: args[3],
				path: args[4],
				data: args[5],
				updated_at: args[7]
			});
			return [];
		}
		if (s.startsWith('UPDATE file SET data')) {
			const row = files.find((f) => f.id === args[2] && f.user_id === args[3]);
			if (row) {
				row.data = args[0];
				row.updated_at = args[1];
			}
			return [];
		}
		if (s.startsWith('DELETE FROM file_chunk') || s.startsWith('INSERT INTO file_chunk')) return [];
		return [];
	};

	const statement = (sql: string) => ({
		bind: (...args: any[]) => ({
			all: async () => ({ results: run(sql, args) }),
			first: async () => run(sql, args)[0] ?? null,
			run: async () => run(sql, args)
		}),
		// Config reads come through unbound `.all()`.
		all: async () => ({ results: [] }),
		first: async () => null,
		run: async () => []
	});

	return {
		memories,
		files,
		env: {
			DB: { prepare: statement, batch: async () => [] },
			FILES: { put: async () => {}, get: async () => null }
		} as any
	};
}

const call = (name: string, args: Record<string, unknown>) => ({
	id: 'c1',
	name,
	arguments: JSON.stringify(args)
});

describe('tool groups', () => {
	it('offers only the groups that are enabled', () => {
		expect(toolsFor({})).toEqual([]);
		expect((toolsFor({ memory: true }) as any[]).map((t) => t.function.name)).toEqual([
			'remember',
			'recall',
			'forget'
		]);
		expect((toolsFor({ files: true }) as any[]).map((t) => t.function.name)).toEqual([
			'list_files',
			'read_file',
			'create_file',
			'edit_file'
		]);
		expect((toolsFor({ search: true }) as any[]).map((t) => t.function.name)).toEqual([
			'glob_files',
			'grep_files',
			'search_chats'
		]);
	});

	it('describes every tool in the OpenAI function shape', () => {
		for (const tool of [...MEMORY_TOOLS, ...FILE_TOOLS, ...SEARCH_TOOLS]) {
			expect(tool.type).toBe('function');
			expect(tool.function.description.length).toBeGreaterThan(20);
			expect(tool.function.parameters.type).toBe('object');
		}
	});
});

describe('memory tools', () => {
	let fake: ReturnType<typeof fakeEnv>;
	beforeEach(() => {
		fake = fakeEnv();
	});

	it('remembers a fact and recalls it', async () => {
		await runToolCall(fake.env, call('remember', { content: 'Prefers TypeScript over Python' }), {
			userId: 'u1'
		});
		const out = await runToolCall(fake.env, call('recall', { query: 'language preference' }), {
			userId: 'u1'
		});
		expect(out.content).toContain('Prefers TypeScript over Python');
	});

	it('recalls recent memories when the query matches nothing', async () => {
		// Same reasoning as retrieval: something recent beats nothing at all.
		await runToolCall(fake.env, call('remember', { content: 'Lives in Melbourne' }), {
			userId: 'u1'
		});
		const out = await runToolCall(fake.env, call('recall', { query: 'zzzz unrelated' }), {
			userId: 'u1'
		});
		expect(out.content).toContain('Lives in Melbourne');
	});

	it('says so plainly when there is nothing remembered', async () => {
		const out = await runToolCall(fake.env, call('recall', {}), { userId: 'u1' });
		expect(out.content).toMatch(/nothing has been remembered/i);
	});

	it('refuses to remember an empty fact', async () => {
		const out = await runToolCall(fake.env, call('remember', { content: '  ' }), { userId: 'u1' });
		expect(fake.memories).toHaveLength(0);
		expect(out.content).toMatch(/nothing to remember/i);
	});

	it('forgets by the id recall hands out', async () => {
		await runToolCall(fake.env, call('remember', { content: 'Uses NVIDIA NIM' }), {
			userId: 'u1'
		});
		const id = fake.memories[0].id;
		const out = await runToolCall(fake.env, call('forget', { id }), { userId: 'u1' });
		expect(out.content).toMatch(/forgot/i);
		expect(fake.memories).toHaveLength(0);
	});

	it('cannot recall or forget another user’s memories', async () => {
		await runToolCall(fake.env, call('remember', { content: 'Secret about user one' }), {
			userId: 'u1'
		});
		const id = fake.memories[0].id;

		const recalled = await runToolCall(fake.env, call('recall', { query: 'secret' }), {
			userId: 'u2'
		});
		expect(recalled.content).not.toContain('Secret about user one');

		const forgotten = await runToolCall(fake.env, call('forget', { id }), { userId: 'u2' });
		expect(forgotten.content).toMatch(/no memory with id/i);
		expect(fake.memories).toHaveLength(1);
	});
});

describe('file tools', () => {
	let fake: ReturnType<typeof fakeEnv>;
	beforeEach(() => {
		fake = fakeEnv();
	});

	const create = (name: string, content: string, userId = 'u1') =>
		runToolCall(fake.env, call('create_file', { name, content }), { userId });

	it('creates a file and reads it back', async () => {
		await create('notes.md', '# Notes\n\nEdge computing is fast.');
		const out = await runToolCall(fake.env, call('read_file', { name: 'notes.md' }), {
			userId: 'u1'
		});
		expect(out.content).toContain('Edge computing is fast.');
		expect(out.sources).toHaveLength(1);
	});

	it('lists what it created', async () => {
		await create('a.md', 'one');
		await create('b.md', 'two');
		const out = await runToolCall(fake.env, call('list_files', {}), { userId: 'u1' });
		expect(out.content).toContain('a.md');
		expect(out.content).toContain('b.md');
	});

	it('refuses to overwrite an existing file with create', async () => {
		// Silently replacing it would lose whatever was there.
		await create('notes.md', 'original');
		const out = await create('notes.md', 'replacement');
		const read = await runToolCall(fake.env, call('read_file', { name: 'notes.md' }), {
			userId: 'u1'
		});
		expect(out.content).toMatch(/already exists/i);
		expect(read.content).toContain('original');
	});

	it('edits an exact passage and leaves the rest alone', async () => {
		await create('notes.md', 'Alpha\nBravo\nCharlie');
		const out = await runToolCall(
			fake.env,
			call('edit_file', { name: 'notes.md', old_text: 'Bravo', new_text: 'Delta' }),
			{ userId: 'u1' }
		);
		expect(out.content).toMatch(/edited/i);
		const read = await runToolCall(fake.env, call('read_file', { name: 'notes.md' }), {
			userId: 'u1'
		});
		expect(read.content).toContain('1\tAlpha');
		expect(read.content).toContain('2\tDelta');
		expect(read.content).toContain('3\tCharlie');
	});

	it('refuses an ambiguous edit rather than guessing', async () => {
		await create('notes.md', 'todo\ntodo\ntodo');
		const out = await runToolCall(
			fake.env,
			call('edit_file', { name: 'notes.md', old_text: 'todo', new_text: 'done' }),
			{ userId: 'u1' }
		);
		expect(out.content).toMatch(/appears 3 times/i);
		const read = await runToolCall(fake.env, call('read_file', { name: 'notes.md' }), {
			userId: 'u1'
		});
		expect(read.content).toContain('1\ttodo');
		expect(read.content).toContain('3\ttodo');
		expect(read.content).not.toContain('done');
	});

	it('replaces every occurrence when told to', async () => {
		await create('notes.md', 'todo\ntodo');
		await runToolCall(
			fake.env,
			call('edit_file', {
				name: 'notes.md',
				old_text: 'todo',
				new_text: 'done',
				replace_all: true
			}),
			{ userId: 'u1' }
		);
		const read = await runToolCall(fake.env, call('read_file', { name: 'notes.md' }), {
			userId: 'u1'
		});
		expect(read.content).toContain('1\tdone');
		expect(read.content).toContain('2\tdone');
	});

	it('tells the model to copy the passage exactly when nothing matched', async () => {
		await create('notes.md', 'Alpha');
		const out = await runToolCall(
			fake.env,
			call('edit_file', { name: 'notes.md', old_text: 'Zulu', new_text: 'X' }),
			{ userId: 'u1' }
		);
		expect(out.content).toMatch(/not found/i);
	});

	it('cannot read or edit another user’s files', async () => {
		await create('private.md', 'user one only', 'u1');

		const read = await runToolCall(fake.env, call('read_file', { name: 'private.md' }), {
			userId: 'u2'
		});
		expect(read.content).toMatch(/no file called/i);
		expect(read.content).not.toContain('user one only');

		const edit = await runToolCall(
			fake.env,
			call('edit_file', { name: 'private.md', old_text: 'user one only', new_text: 'hacked' }),
			{ userId: 'u2' }
		);
		expect(edit.content).toMatch(/no file called/i);

		const listed = await runToolCall(fake.env, call('list_files', {}), { userId: 'u2' });
		expect(listed.content).toMatch(/no files/i);
	});
});

describe('glob matching', () => {
	it('translates the glob syntax people actually type', () => {
		expect(globToRegExp('*.md').test('notes.md')).toBe(true);
		expect(globToRegExp('*.md').test('notes.txt')).toBe(false);
		expect(globToRegExp('notes-*').test('notes-2026.md')).toBe(true);
		expect(globToRegExp('report?.csv').test('report1.csv')).toBe(true);
		expect(globToRegExp('report?.csv').test('report12.csv')).toBe(false);
	});

	it('keeps `*` inside one path segment and lets `**` cross them', () => {
		expect(globToRegExp('*.md').test('docs/notes.md')).toBe(false);
		expect(globToRegExp('**/*.md').test('docs/notes.md')).toBe(true);
	});

	it('treats regex metacharacters in a glob as literals', () => {
		// `notes.md` must not match `notesXmd` just because `.` is a regex dot.
		expect(globToRegExp('notes.md').test('notesXmd')).toBe(false);
		expect(globToRegExp('a+b.txt').test('a+b.txt')).toBe(true);
	});
});

describe('search tools', () => {
	let fake: ReturnType<typeof fakeEnv>;
	beforeEach(() => {
		fake = fakeEnv();
	});

	const create = (name: string, content: string, userId = 'u1') =>
		runToolCall(fake.env, call('create_file', { name, content }), { userId });

	it('finds files by name pattern', async () => {
		await create('notes.md', 'x');
		await create('data.csv', 'y');
		const out = await runToolCall(fake.env, call('glob_files', { pattern: '*.md' }), {
			userId: 'u1'
		});
		expect(out.content).toContain('notes.md');
		expect(out.content).not.toContain('data.csv');
	});

	it('greps contents and reports file and line', async () => {
		await create('notes.md', 'alpha\nbravo TODO fix\ncharlie');
		const out = await runToolCall(fake.env, call('grep_files', { pattern: 'TODO' }), {
			userId: 'u1'
		});
		expect(out.content).toContain('notes.md:2:');
		expect(out.content).toContain('bravo TODO fix');
	});

	it('narrows a grep with a glob', async () => {
		await create('notes.md', 'needle');
		await create('data.csv', 'needle');
		const out = await runToolCall(
			fake.env,
			call('grep_files', { pattern: 'needle', glob: '*.csv' }),
			{ userId: 'u1' }
		);
		expect(out.content).toContain('data.csv');
		expect(out.content).not.toContain('notes.md');
	});

	it('reports an invalid regex instead of throwing', async () => {
		await create('notes.md', 'anything');
		const out = await runToolCall(fake.env, call('grep_files', { pattern: '([' }), {
			userId: 'u1'
		});
		expect(out.content).toMatch(/not a valid regular expression/i);
	});

	it('refuses a pattern too long to be a search', async () => {
		const out = await runToolCall(fake.env, call('grep_files', { pattern: 'a'.repeat(300) }), {
			userId: 'u1'
		});
		expect(out.content).toMatch(/longer than 200/i);
	});

	it('cannot glob or grep another user’s files', async () => {
		await create('private.md', 'user one secret', 'u1');
		const globbed = await runToolCall(fake.env, call('glob_files', { pattern: '*' }), {
			userId: 'u2'
		});
		expect(globbed.content).not.toContain('private.md');
		const grepped = await runToolCall(fake.env, call('grep_files', { pattern: 'secret' }), {
			userId: 'u2'
		});
		expect(grepped.content).not.toContain('user one secret');
	});
});

describe('read_file ranges', () => {
	let fake: ReturnType<typeof fakeEnv>;
	beforeEach(() => {
		fake = fakeEnv();
	});

	it('numbers lines so a grep hit can be cited', async () => {
		await runToolCall(fake.env, call('create_file', { name: 'a.md', content: 'one\ntwo\nthree' }), {
			userId: 'u1'
		});
		const out = await runToolCall(fake.env, call('read_file', { name: 'a.md' }), { userId: 'u1' });
		expect(out.content).toContain('1\tone');
		expect(out.content).toContain('3\tthree');
	});

	it('reads a window of a long file and says which lines it gave', async () => {
		const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
		await runToolCall(fake.env, call('create_file', { name: 'long.md', content }), {
			userId: 'u1'
		});
		const out = await runToolCall(
			fake.env,
			call('read_file', { name: 'long.md', offset: 10, limit: 3 }),
			{ userId: 'u1' }
		);
		expect(out.content).toContain('10\tline 10');
		expect(out.content).toContain('12\tline 12');
		expect(out.content).not.toContain('13\tline 13');
		expect(out.status).toContain('lines 10-12 of 50');
	});
});
