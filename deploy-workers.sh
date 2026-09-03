#!/usr/bin/env bash
# Provision Cloudflare resources and deploy Open WebUI to your account.
#
#   ./deploy-workers.sh                 # create D1 + KV + R2 (if missing), migrate, deploy
#   ./deploy-workers.sh --skip-build    # deploy without rebuilding the frontend
#
# Requires: `npx wrangler login` (or CLOUDFLARE_API_TOKEN in the environment).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SKIP_BUILD=0
for arg in "$@"; do
	case "$arg" in
		--skip-build) SKIP_BUILD=1 ;;
		-h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
wrangler() { npm --prefix workers exec -- wrangler "$@"; }

[ -d workers/node_modules ] || npm --prefix workers install --no-audit --no-fund
[ -d node_modules ] || CYPRESS_INSTALL_BINARY=0 npm install --no-audit --no-fund

step "Checking Cloudflare authentication"
wrangler whoami >/dev/null || { echo "Run 'npx wrangler login' first."; exit 1; }

step "Creating the D1 database (skipped if it already exists)"
DB_OUTPUT="$(wrangler d1 create open-webui 2>&1 || true)"
echo "$DB_OUTPUT" | tail -5
DB_ID="$(echo "$DB_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
if [ -z "$DB_ID" ]; then
	DB_ID="$(wrangler d1 info open-webui --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).uuid??"")}catch{console.log("")}})' || true)"
fi
[ -n "$DB_ID" ] && node workers/scripts/set-binding-id.mjs d1 "$DB_ID"

step "Creating the KV namespace (skipped if it already exists)"
KV_OUTPUT="$(wrangler kv namespace create CACHE 2>&1 || true)"
echo "$KV_OUTPUT" | tail -5
KV_ID="$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
[ -n "$KV_ID" ] && node workers/scripts/set-binding-id.mjs kv "$KV_ID"

step "Creating the R2 bucket (skipped if it already exists)"
wrangler r2 bucket create open-webui-files 2>&1 | tail -3 || true

step "Applying D1 migrations to the remote database"
wrangler d1 migrations apply open-webui --remote

if [ "$SKIP_BUILD" = "0" ]; then
	step "Building the SvelteKit frontend"
	npm run build:workers
fi

if ! wrangler secret list 2>/dev/null | grep -q WEBUI_SECRET_KEY; then
	step "Setting WEBUI_SECRET_KEY (JWT signing key)"
	node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' | wrangler secret put WEBUI_SECRET_KEY
fi

step "Deploying"
cd workers
npx wrangler deploy

cat <<'DONE'

Deployed. Next steps:
  1. Open the workers.dev URL printed above and create the first account (it becomes the admin).
  2. Add a model provider: Admin Settings -> Connections, or uncomment the [ai]
     binding in workers/wrangler.toml to use Workers AI.
DONE
