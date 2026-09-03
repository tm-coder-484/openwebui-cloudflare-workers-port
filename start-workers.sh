#!/usr/bin/env bash
# Open WebUI on Cloudflare Workers — local development in one command.
#
#   ./start-workers.sh              # build the UI (if needed) and run wrangler dev
#   ./start-workers.sh --mock       # ...and start a mock model server, so no API key is needed
#   ./start-workers.sh --rebuild    # force a fresh frontend build
#
# Open http://localhost:8787 and create the first account: it becomes the admin.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MOCK=0
REBUILD=0
PORT="${PORT:-8787}"
for arg in "$@"; do
	case "$arg" in
		--mock) MOCK=1 ;;
		--rebuild) REBUILD=1 ;;
		--port=*) PORT="${arg#*=}" ;;
		-h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }

command -v node >/dev/null || { echo "Node.js 18+ is required (https://nodejs.org)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node.js 18 or newer is required (found $(node -v))"; exit 1; }

if [ ! -d node_modules ]; then
	step "Installing frontend dependencies (this takes a few minutes the first time)"
	CYPRESS_INSTALL_BINARY=0 npm install --no-audit --no-fund
fi

if [ ! -d workers/node_modules ]; then
	step "Installing worker dependencies"
	npm --prefix workers install --no-audit --no-fund
fi

if [ "$REBUILD" = "1" ] || [ ! -f build/index.html ]; then
	step "Building the SvelteKit frontend into ./build"
	npm run build:workers
fi

if [ ! -f workers/.dev.vars ]; then
	step "Creating workers/.dev.vars with a development signing key"
	SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
	cat > workers/.dev.vars <<VARS
# Local development secrets. Never commit this file.
WEBUI_SECRET_KEY=$SECRET
# Primary provider — NVIDIA NIM (get a key at https://build.nvidia.com):
# NVIDIA_API_KEY=nvapi-...
# Or any other OpenAI-compatible API:
# OPENAI_API_BASE_URL=https://api.openai.com/v1
# OPENAI_API_KEY=sk-...
VARS
fi

step "Applying D1 migrations to the local database"
npm --prefix workers run db:local

MOCK_PID=""
if [ "$MOCK" = "1" ]; then
	step "Starting the mock model server on http://127.0.0.1:11435/v1"
	node workers/scripts/mock-openai.mjs &
	MOCK_PID=$!
	if ! grep -q '^OPENAI_API_BASE_URL=' workers/.dev.vars; then
		printf 'OPENAI_API_BASE_URL=http://127.0.0.1:11435/v1\nOPENAI_API_KEY=mock-key\n' >> workers/.dev.vars
	fi
	trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
fi

step "Starting wrangler dev on http://localhost:$PORT"
echo "   The first account you create becomes the administrator."
cd workers
exec npx wrangler dev --port "$PORT"
