/**
 * Unified diff, in the shape Python's `difflib.unified_diff` produces, so the
 * prompt-history UI renders version comparisons the same way it does upstream.
 */

interface Op {
	type: 'equal' | 'delete' | 'insert';
	line: string;
}

/** Longest-common-subsequence walk over lines. */
function diffLines(from: string[], to: string[]): Op[] {
	const rows = from.length;
	const cols = to.length;
	const table: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));

	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i][j] =
				from[i] === to[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (from[i] === to[j]) {
			ops.push({ type: 'equal', line: from[i] });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			ops.push({ type: 'delete', line: from[i++] });
		} else {
			ops.push({ type: 'insert', line: to[j++] });
		}
	}
	while (i < rows) ops.push({ type: 'delete', line: from[i++] });
	while (j < cols) ops.push({ type: 'insert', line: to[j++] });
	return ops;
}

export function unifiedDiff(
	fromText: string,
	toText: string,
	fromLabel = 'a',
	toLabel = 'b',
	context = 3
): string[] {
	const from = fromText.split('\n');
	const to = toText.split('\n');
	const ops = diffLines(from, to);
	if (ops.every((op) => op.type === 'equal')) return [];

	// Group changes into hunks with `context` unchanged lines around them.
	const changed = ops.map((op) => op.type !== 'equal');
	const keep = new Array(ops.length).fill(false);
	for (let i = 0; i < ops.length; i++) {
		if (!changed[i]) continue;
		for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
			keep[j] = true;
		}
	}

	const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
	let fromLine = 1;
	let toLine = 1;
	let index = 0;

	while (index < ops.length) {
		if (!keep[index]) {
			if (ops[index].type !== 'insert') fromLine++;
			if (ops[index].type !== 'delete') toLine++;
			index++;
			continue;
		}

		const hunkStartFrom = fromLine;
		const hunkStartTo = toLine;
		const body: string[] = [];
		let fromCount = 0;
		let toCount = 0;

		while (index < ops.length && keep[index]) {
			const op = ops[index++];
			if (op.type === 'equal') {
				body.push(` ${op.line}`);
				fromCount++;
				toCount++;
				fromLine++;
				toLine++;
			} else if (op.type === 'delete') {
				body.push(`-${op.line}`);
				fromCount++;
				fromLine++;
			} else {
				body.push(`+${op.line}`);
				toCount++;
				toLine++;
			}
		}

		lines.push(`@@ -${hunkStartFrom},${fromCount} +${hunkStartTo},${toCount} @@`, ...body);
	}

	return lines;
}
