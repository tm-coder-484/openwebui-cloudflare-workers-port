/**
 * Rewrites a resource id in wrangler.toml after `deploy-workers.sh` provisions it.
 *
 *   node scripts/set-binding-id.mjs d1 <database-id>
 *   node scripts/set-binding-id.mjs kv <namespace-id>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [kind, id] = process.argv.slice(2);
if (!kind || !id) {
	console.error('usage: set-binding-id.mjs <d1|kv> <id>');
	process.exit(1);
}

const configPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml');
const config = readFileSync(configPath, 'utf8');

const patterns = {
	d1: /(\[\[d1_databases\]\][\s\S]*?database_id = ")[^"]*(")/,
	kv: /(\[\[kv_namespaces\]\][\s\S]*?id = ")[^"]*(")/
};

const pattern = patterns[kind];
if (!pattern) {
	console.error(`unknown binding kind: ${kind}`);
	process.exit(1);
}
if (!pattern.test(config)) {
	console.error(`could not find the ${kind} binding in wrangler.toml`);
	process.exit(1);
}

writeFileSync(configPath, config.replace(pattern, `$1${id}$2`));
console.log(`wrangler.toml: ${kind} id set to ${id}`);
