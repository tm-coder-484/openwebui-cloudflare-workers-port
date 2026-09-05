/**
 * `Map.prototype.getOrInsert` and `getOrInsertComputed` for pdf.js.
 *
 * pdfjs-dist 5.4 calls both — nine times in `pdf.mjs`, six in the worker — but
 * they are a Stage 3 proposal that no shipping browser implements yet, and
 * pdf.js bundles no fallback of its own. The result is not a load failure,
 * which would at least be obvious: `getDocument` resolves, and the *render*
 * throws `getOrInsertComputed is not a function`, so every PDF preview in the
 * app showed "Failed to load PDF." on a file that was perfectly readable.
 *
 * The semantics are the proposal's: look the key up, insert if absent, return
 * what is now stored. `getOrInsertComputed` calls its callback only on a miss.
 *
 * This runs on the main thread; pdf.js's worker has its own global scope and
 * does not see it. That has been enough in practice — rendering and text
 * extraction of a real document both work — so the worker is left alone rather
 * than wrapped, which would mean shipping a second worker entry point to patch
 * a global that the code paths in use do not reach.
 *
 * Delete this once browsers ship the proposal, or once pdf.js guards its use.
 */

type Insertable = {
	has(key: any): boolean;
	get(key: any): any;
	set(key: any, value: any): any;
};

for (const Ctor of [Map, WeakMap] as unknown as { prototype: Insertable }[]) {
	const proto = Ctor.prototype as Insertable & {
		getOrInsert?: (key: any, value: any) => any;
		getOrInsertComputed?: (key: any, callback: (key: any) => any) => any;
	};

	if (typeof proto.getOrInsert !== 'function') {
		proto.getOrInsert = function (key: any, value: any) {
			if (!this.has(key)) this.set(key, value);
			return this.get(key);
		};
	}

	if (typeof proto.getOrInsertComputed !== 'function') {
		proto.getOrInsertComputed = function (key: any, callback: (key: any) => any) {
			if (!this.has(key)) this.set(key, callback(key));
			return this.get(key);
		};
	}
}
