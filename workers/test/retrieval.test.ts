import { describe, expect, it } from 'vitest';
import { chunkText, scoreChunks, tokenize } from '../src/lib/retrieval';

describe('chunkText', () => {
	it('returns a single chunk for short text', () => {
		expect(chunkText('hello world', 1000, 100)).toEqual(['hello world']);
	});

	it('splits long text with overlap', () => {
		const text = Array.from({ length: 200 }, (_, i) => `sentence number ${i}.`).join(' ');
		const chunks = chunkText(text, 200, 50);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(220);
		expect(chunks.join(' ')).toContain('sentence number 199.');
	});

	it('ignores empty input', () => {
		expect(chunkText('   ')).toEqual([]);
	});
});

describe('scoreChunks', () => {
	it('ranks the chunk that shares rare terms highest', () => {
		const chunks = [
			{ id: 'a', content: 'the cat sat on the mat' },
			{ id: 'b', content: 'quantum entanglement in superconductors' },
			{ id: 'c', content: 'the dog sat on the log' }
		];
		const ranked = scoreChunks('quantum entanglement', chunks);
		expect(ranked[0].id).toBe('b');
	});

	it('drops chunks with no overlap', () => {
		const ranked = scoreChunks('zebra', [{ id: 'a', content: 'nothing relevant here' }]);
		expect(ranked).toHaveLength(0);
	});

	it('ignores stop words when tokenizing', () => {
		expect(tokenize('The quick brown fox')).toEqual(['quick', 'brown', 'fox']);
	});
});
