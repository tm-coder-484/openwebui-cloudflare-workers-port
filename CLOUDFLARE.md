# Open WebUI on Cloudflare Workers

This repository contains the standard Open WebUI SvelteKit frontend plus a
**complete backend port to Cloudflare Workers** in [`workers/`](workers). The
Python/FastAPI backend is still in `backend/` for reference; nothing in it runs
on Cloudflare.

The port is self-contained: no containers, no VM, no Postgres. A deployment is
one Worker, one D1 database, one R2 bucket, one KV namespace and one Durable
Object.

---

## Quick start (local, ~5 minutes)

```bash
git clone <this repo> && cd openwebui-cloudflare-workers-port

# Build the UI, migrate a local D1 database, and start a mock model server
# so you can try everything without an API key:
./start-workers.sh --mock          # Windows: start-workers.bat --mock
```

Then open <http://localhost:8787>. **The first account you create becomes the
administrator.**

Want to talk to a real model instead? Drop `--mock` and put your key in
`workers/.dev.vars`:

```bash
cp workers/.dev.vars.example workers/.dev.vars
# edit: OPENAI_API_BASE_URL=https://api.openai.com/v1
#       OPENAI_API_KEY=sk-...
./start-workers.sh
```

Any OpenAI-compatible endpoint works — OpenAI, OpenRouter, Groq, Together,
vLLM, LM Studio, llama.cpp, or Ollama's `/v1` shim. In local development the
Worker can reach `http://localhost:...`; a deployed Worker cannot (see
[Networking](#networking)).

## Deploy to your Cloudflare account

```bash
npx wrangler login
./deploy-workers.sh
```

The script creates the D1 database, KV namespace and R2 bucket, writes their
ids into `workers/wrangler.toml`, applies migrations, generates a
`WEBUI_SECRET_KEY`, builds the frontend and deploys. It is safe to re-run.

Prefer doing it by hand?

```bash
npm install && npm --prefix workers install

npx wrangler d1 create open-webui             # copy the id into wrangler.toml
npx wrangler kv namespace create CACHE        # copy the id into wrangler.toml
npx wrangler r2 bucket create open-webui-files

npm --prefix workers exec -- wrangler d1 migrations apply open-webui --remote
npx wrangler secret put WEBUI_SECRET_KEY --cwd workers

npm run build:workers                          # SvelteKit -> ./build
npm --prefix workers run deploy
```

---

## Architecture

| Open WebUI (Python)            | This port (Cloudflare)                                  |
| ------------------------------ | ------------------------------------------------------- |
| FastAPI + Uvicorn              | Hono router inside a single Worker (`workers/src`)      |
| SQLite / PostgreSQL            | **D1** (`workers/migrations/0001_init.sql`)             |
| Local disk / S3 uploads        | **R2** (`FILES` binding)                                |
| Redis (sessions, pub/sub)      | **Durable Object** `SocketHub` + KV for caching         |
| python-socketio                | Hand-written Engine.IO v4 / Socket.IO v5 codec in the DO |
| Chroma / pgvector              | **Vectorize** (optional) or keyword scoring over D1     |
| Static files via FastAPI       | **Workers Static Assets** with SPA fallback             |
| `sentence-transformers`, Whisper | **Workers AI** (optional binding)                     |

### How a chat message actually flows

This is the part worth understanding before changing anything:

1. The browser `POST`s `/api/chat/completions`. It does **not** read the
   response body for tokens — it expects `{status, task_ids, chat_id}` back
   immediately.
2. The Worker creates or updates the chat row in D1, then hands the job to the
   `SocketHub` Durable Object (which already owns that user's WebSocket).
3. The Durable Object calls the upstream model, parses the SSE stream, and
   emits Socket.IO `events` frames (`chat:completion`) to every socket in the
   `user:<id>` room. The browser renders tokens from those events.
4. When the stream ends, the DO writes the final message back to D1 and runs
   the background tasks (title, tags, follow-ups) against the task model.

Because the streaming happens inside the Durable Object, no per-token
subrequests are needed and the connection survives the HTTP request that
started it.

### Layout

```
workers/
  wrangler.toml            bindings and vars
  migrations/              D1 schema
  src/
    index.ts               router: mounts every /api/v1/* group
    types.ts               Env bindings + session types
    lib/                   auth, crypto, config, models, completions, retrieval…
    routes/                one module per upstream FastAPI router
    socket/                Engine.IO/Socket.IO codec + SocketHub Durable Object
  scripts/mock-openai.mjs  offline model server for development
  test/                    vitest unit tests
```

---

## Configuration

Runtime settings live in the D1 `config` table and are editable from **Admin
Settings** in the UI. Worker vars only seed the defaults on first read.

| Variable                | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `WEBUI_SECRET_KEY`      | **Required in production.** Signs session JWTs (set as secret) |
| `OPENAI_API_BASE_URL(S)`| Comma-separated OpenAI-compatible endpoints                    |
| `OPENAI_API_KEY(S)`     | Matching keys, positionally paired with the URLs               |
| `ENABLE_WORKERS_AI`     | Expose Workers AI models (needs the `[ai]` binding)            |
| `WORKERS_AI_MODELS`     | Override the built-in Workers AI model list                    |
| `DEFAULT_MODELS`        | Comma-separated default model ids for new chats                |
| `DEFAULT_USER_ROLE`     | `pending` (default), `user`, or `admin` for new signups        |
| `ENABLE_SIGNUP`         | Allow self-service signup after the first admin exists         |
| `JWT_EXPIRES_IN`        | `-1` (never), or `30m`, `12h`, `7d`…                           |
| `WEBUI_NAME`            | Branding shown in the UI                                       |

Secrets go through `wrangler secret put`; plain vars can live in `[vars]` in
`wrangler.toml`.

### Optional bindings

Both are commented out in `wrangler.toml` because `wrangler dev` would then
require Cloudflare credentials:

```toml
[ai]                       # Workers AI: built-in models, Whisper, embeddings
binding = "AI"

[[vectorize]]              # semantic search for knowledge bases
binding = "VECTORIZE"
index_name = "open-webui"
```

Create the index with:

```bash
npx wrangler vectorize create open-webui --dimensions=768 --metric=cosine
```

Without Vectorize, retrieval falls back to TF-IDF-style keyword scoring over the
chunks stored in D1 — good enough for small knowledge bases, and it needs no
extra services.

---

## What works, and what does not

**Working**

- Email/password auth, API keys, JWT sessions, pending-user approval flow
- Users, groups, and the full permission matrix
- Chats: create, edit, delete, folders, tags, pin, archive, share, clone, fork
- Streaming completions from any OpenAI-compatible provider and Workers AI
- Multi-model (side-by-side) responses
- Automatic title, tag and follow-up generation
- Workspace: models (presets and overrides), prompts, knowledge, skills
- Files in R2 with text extraction, chunking and retrieval
- Notes (with realtime collaboration relay) and Channels (realtime messaging)
- Memories, feedback/evaluations, admin usage analytics
- Text-to-speech and transcription (Workers AI Whisper or an OpenAI endpoint)
- Image generation (OpenAI-compatible or Workers AI)

**Not supported (and why)**

| Feature | Reason |
| --- | --- |
| Python tools, functions, pipes, filters, pipelines | The Workers runtime has no Python interpreter. Rows are stored and listed but never executed; `/api/config` reports `enable_plugins: false`. |
| Server-side code execution (Jupyter) | Same. The in-browser Pyodide interpreter still works. |
| LDAP, OAuth/OIDC, SCIM | Not ported. Email/password and API keys cover self-hosting; the admin screens return inert config. |
| Ollama on `localhost` | A deployed Worker cannot reach private addresses — expose Ollama over HTTPS (e.g. Cloudflare Tunnel) and set its URL. |
| Web search providers | The wiring exists but no provider is implemented; URL ingestion (`#https://…`) does work. |
| Socket.IO long-polling | Only the WebSocket transport is implemented; `/api/config` always reports `enable_websocket: true`. |
| Server-side Yjs merge | Note collaboration relays updates between clients instead of merging them server-side. |
| Server-side PDF export, `black` formatting | Both need Python/native binaries. |

---

## Operations

**Migrations**

```bash
npm --prefix workers exec -- wrangler d1 migrations apply open-webui --local
npm --prefix workers exec -- wrangler d1 migrations apply open-webui --remote
```

**Backups**

```bash
npx wrangler d1 export open-webui --remote --output backup.sql
```

**Logs**

```bash
npm --prefix workers exec -- wrangler tail
```

**Tests and typecheck**

```bash
npm --prefix workers test        # vitest
npm --prefix workers run typecheck
```

### Networking

Deployed Workers can only reach public addresses. Anything on your LAN — Ollama,
a local vLLM server, an internal OpenAI gateway — needs a public hostname, most
easily through [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
`wrangler dev` runs locally and *can* reach `localhost`, which is why the mock
model server works out of the box.

### Scaling notes

- All WebSockets live in **one** `SocketHub` Durable Object instance, which
  keeps rooms and fan-out simple. That is fine for a team or a personal
  deployment; for thousands of concurrent sockets, shard the hub by user id and
  add a fan-out path for channel rooms.
- D1 is SQLite: excellent for reads, with a single writer. Chat history is
  stored as one JSON document per conversation, exactly like upstream.
- Static assets are served by Cloudflare's CDN, not the Worker, so the UI costs
  no Worker invocations.

### Limits worth knowing

| Limit | Value |
| --- | --- |
| Worker CPU per request | 30 s (streaming happens in the Durable Object, so long generations are fine) |
| D1 database size | 10 GB |
| R2 object size | 5 TB |
| Static assets | 20,000 files, 25 MiB each (sourcemaps are excluded by `build/.assetsignore`) |

---

## Development

```bash
./start-workers.sh --mock      # full stack with a fake model
npm --prefix workers run dev   # worker only (frontend must already be built)
npm run build:workers          # rebuild the UI after frontend changes
```

Adding an endpoint means adding a handler in the matching `workers/src/routes/*`
module — the file names mirror `backend/open_webui/routers/*`, so the Python
implementation is always one file away when you need to check a response shape.
