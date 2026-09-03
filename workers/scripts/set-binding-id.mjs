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

/**
 * The committed config carries no ids, so that a dashboard or `wrangler deploy`
 * run provisions the resources itself. Each kind therefore needs both a
 * replace (id already written) and an insert (the usual case).
 */
const bindings = {
	d1: {
		existing: /(\[\[d1_databases\]\][\s\S]*?database_id = ")[^"]*(")/,
		anchor: /(\[\[d1_databases\]\]\nbinding = "DB"\n)/,
		line: (value) => `database_id = "${value}"\n`
	},
	kv: {
		existing: /(\[\[kv_namespaces\]\][\s\S]*?\bid = ")[^"]*(")/,
		anchor: /(\[\[kv_namespaces\]\]\nbinding = "CACHE"\n)/,
		line: (value) => `id = "${value}"\n`
	}
};

const binding = bindings[kind];
if (!binding) {
	console.error(`unknown binding kind: ${kind}`);
	process.exit(1);
}

let updated;
if (binding.existing.test(config)) {
	updated = config.replace(binding.existing, `$1${id}$2`);
} else if (binding.anchor.test(config)) {
	updated = config.replace(binding.anchor, `$1${binding.line(id)}`);
} else {
	console.error(`could not find the ${kind} binding in wrangler.toml`);
	process.exit(1);
}

writeFileSync(configPath, updated);
console.log(`wrangler.toml: ${kind} id set to ${id}`);
