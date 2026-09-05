import { describe, expect, it } from 'vitest';
import { buildFileContext } from '../src/lib/completions';

/**
 * A D1 stub holding one long document, chunked the way the uploader chunks it.
 * `config` decides what the config table answers.
 */
const envWith = (config: Record<string, unknown>, documentLength = 40_000) => {
	const document = Array.from({ length: Math.ceil(documentLength / 60) }, (_, i) =>
		`Paragraph ${i} about edge computing and databases.`.padEnd(60, ' ')
	).join('');

	const chunks = [];
	for (let i = 0; i < document.length; i += 1000) {
		chunks.push({
			id: `chunk-${chunks.length}`,
			file_id: 'file-1',
			knowledge_id: null,
			idx: chunks.length,
			content: document.slice(i, i + 1000)
		});
	}

	return {
		document,
		env: {
			DB: {
				prepare: (sql: string) => ({
					bind: (...args: unknown[]) => ({
						all: async () => {
							if (sql.includes('FROM file_chunk')) return { results: chunks };
							if (sql.includes('FROM knowledge_file')) return { results: [] };
							if (sql.includes('FROM file WHERE id IN')) {
								return {
									results: [
										{
											id: 'file-1',
											filename: 'report.md',
											data: JSON.stringify({ content: document })
										}
									]
								};
							}
							return { results: [] };
						}
					}),
					all: async () => ({
						results: Object.entries(config).map(([key, value]) => ({
							key,
							value: JSON.stringify(value)
						}))
					})
				})
			}
		} as any
	};
};

const attachment = [{ type: 'file', id: 'file-1', name: 'report.md' }] as any;

describe('attached documents', () => {
	it('retrieves only top_k chunks by default — which is why a long file looks truncated', async () => {
		// Not a bug on its own: it is the retrieval trade-off, and the reason the
		// full-context switch has to work.
		const { env } = envWith({ 'rag.top_k': 3 });
		const { context } = await buildFileContext(env, attachment, 'edge computing');
		expect(context.length).toBeLessThan(4000);
		expect(context.match(/<source /g)).toHaveLength(3);
	});

	it('passes the whole document when full context is on', async () => {
		const { env, document } = envWith({ 'rag.full_context': true });
		const { context, sources } = await buildFileContext(env, attachment, 'edge computing');
		expect(context).toContain(document);
		expect(context.match(/<source /g)).toHaveLength(1);
		expect(sources[0].document).toEqual([document]);
	});

	it('does the same for the bypass switch, which means the same thing', async () => {
		const { env, document } = envWith({ 'rag.bypass_embedding': true });
		const { context } = await buildFileContext(env, attachment, 'edge computing');
		expect(context).toContain(document);
	});

	it('names the source after the attachment, so citations still read properly', async () => {
		const { env } = envWith({ 'rag.full_context': true });
		const { context } = await buildFileContext(env, attachment, 'edge computing');
		expect(context).toContain('name="report.md"');
	});

	it('still returns nothing when no file is attached', async () => {
		const { env } = envWith({ 'rag.full_context': true });
		expect(await buildFileContext(env, [], 'anything')).toEqual({ context: '', sources: [] });
	});
});

describe('a query that shares no words with the document', () => {
	it('still returns the opening chunks rather than nothing', async () => {
		// "Summarise the attached document" has no term in common with most
		// documents. Returning nothing meant the attachment contributed nothing,
		// with no error to explain it.
		const { env } = envWith({ 'rag.top_k': 3 });
		const { context, sources } = await buildFileContext(
			env,
			attachment,
			'Summarise the attached document.'
		);
		expect(sources.length).toBe(3);
		expect(context).toContain('Paragraph 0');
	});

	it('prefers the chunks that do match when there is any overlap', async () => {
		const { env } = envWith({ 'rag.top_k': 3 });
		const { context } = await buildFileContext(env, attachment, 'edge computing databases');
		expect(context).toContain('edge computing');
	});
});
