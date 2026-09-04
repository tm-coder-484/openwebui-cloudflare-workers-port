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

Want to talk to a real model instead? Drop `--mock` and put an **NVIDIA NIM**
key in `workers/.dev.vars` — NIM is the primary provider, so a key is all the
configuration it needs:

```bash
cp workers/.dev.vars.example workers/.dev.vars
# edit: NVIDIA_API_KEY=nvapi-...        (get one at https://build.nvidia.com)
./start-workers.sh
```

Any OpenAI-compatible endpoint works alongside it — OpenAI, OpenRouter, Groq,
Together, vLLM, LM Studio, llama.cpp, or Ollama's `/v1` shim — configured under
Admin Settings → Connections or with `OPENAI_API_BASE_URL` / `OPENAI_API_KEY`.
In local development the Worker can reach `http://localhost:...`; a deployed
Worker cannot (see [Networking](#networking)).

## Models: NVIDIA NIM first

NIM speaks the OpenAI API, so it needs no special client — but it is wired in as
its own provider so it stays the primary option:

- **Hosted catalogue** — `NVIDIA_API_KEY` (from [build.nvidia.com](https://build.nvidia.com))
  is enough; the model list comes from `https://integrate.api.nvidia.com/v1/models`.
- **Self-hosted NIM microservice** — point `NVIDIA_API_BASE_URL` at your own
  host (`https://nim.internal.example/v1`). No key is required there.
- NIM models are listed **first** in the picker and tagged `NVIDIA NIM`.
- New chats open with the strongest model your endpoint actually serves. The
  catalogue turns over quickly, so nothing is pinned: the Worker walks an
  ordered preference list (DeepSeek V4 Pro, Kimi K2.6, GLM-5, Qwen3 235B,
  DeepSeek V3.2, gpt-oss-120b, Nemotron Super 49B, Llama 4 Maverick…) and takes
  the first id the endpoint returns, falling back to whatever it lists first.
  A retired id costs a step down the list, not a broken first message. The
  answer is cached in KV for an hour, so `/api/config` stays a cheap call. Set
  `nvidia.default_model` to override the choice entirely.
- If the endpoint cannot be listed — some self-hosted deployments do not expose
  `/models` — the same catalogue is offered as a static list instead. Pin an
  exact list with `NVIDIA_MODELS=meta/llama-3.1-8b-instruct,...`.
- Everything is editable at runtime through `/api/v1/configs/connections`
  (`ENABLE_NVIDIA_API`, `NVIDIA_API_BASE_URL`, `NVIDIA_API_KEY`,
  `NVIDIA_MODEL_IDS`), so a deployed instance can be re-pointed without a
  redeploy.

## Deploy from the Cloudflare dashboard (no terminal)

The Worker builds and deploys straight from a GitHub repository, so a
deployment needs nothing installed locally.

**1. Get the code onto your own GitHub account.** Fork this repository, or push
a clone to a new repo of your own. Cloudflare needs read access to it.

**2. Connect it to Cloudflare.** In the dashboard, go to **Workers & Pages** →
**Create** → the **Import a repository** option, authorise GitHub, and pick the
repo. (Cloudflare renames these screens from time to time; you are looking for
the flow that builds a Worker from Git, not the "upload assets" one.)

**3. Set the build settings.** Cloudflare will guess; replace its guesses with:

| Setting        | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| Build command  | `npm ci && npm run build:workers && npm --prefix workers ci` |
| Deploy command | `npx wrangler deploy --config workers/wrangler.toml`         |
| Root directory | leave as the repository root                                 |

The build command builds the SvelteKit frontend into `./build` (which
`wrangler.toml` serves as static assets) and then installs the Worker's own
dependencies. Both commands run from the repository root, which is why the
deploy command needs `--config` — the Worker's config lives in `workers/`, and
paths inside it resolve relative to itself. Leave the root directory alone:
`build:workers` is a root-level script and needs the root `package.json`.

The Node version is pinned by the `.nvmrc` in the repository root. This matters:
the root `.npmrc` sets `engine-strict=true` and `package.json` caps `engines` at
Node 22, so `npm ci` fails outright on a newer build image. If your build errors
with an `EBADENGINE`/unsupported-engine message, set a `NODE_VERSION` build
variable to `22`.

The frontend build is memory-hungry, and `build:workers` already accounts for
it: it raises Node's heap to 4 GB and passes `--sourcemap false`. Measured on
this repo, the build needs between 3.5 and 4 GB of JS heap — 3584 MB still dies
with `Ineffective mark-compacts near heap limit`, 4096 MB succeeds — and the
sourcemaps it no longer generates were worth another 1.6 GB and 20 seconds for
output `.assetsignore` discards on upload. Do not re-enable them for this build.

Cloudflare's builder defaults Node to a 2 GB heap, which is not enough, so a
build there fails without those two settings. If it still fails **after** them,
read the error rather than raising the number: `Ineffective mark-compacts` is
V8 and a larger heap may help, but `Killed` or exit 137 is the kernel, meaning
the container itself is too small and no flag will fix it. In that case build
somewhere with more memory — a GitHub Actions runner, or your own machine with
`npm run build:workers && npm --prefix workers run deploy` — and let Cloudflare
serve the result.

**4. Deploy.** The first build takes a few minutes — most of it is the frontend.

D1, KV and R2 are **created for you**: the bindings in `workers/wrangler.toml`
deliberately carry no resource ids, and Wrangler provisions any missing KV
namespace, R2 bucket or D1 database on deploy, naming them after the Worker.
There is nothing to copy and paste. ([Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/))

**5. Apply the database migrations.** This is the one step the deploy does not
do for you, because a schema change is not something to run implicitly. In the
dashboard open **Storage & Databases** → **D1**, pick the new database, and use
its **Console** to run the contents of each file in `workers/migrations/` in
filename order (`0001_init.sql` first). Alternatively, add them to the deploy
command once and remove it afterwards:

```
npx wrangler d1 migrations apply open-webui --remote --config workers/wrangler.toml &&
  npx wrangler deploy --config workers/wrangler.toml
```

Until this is done every request returns a 503 that says the database is not
initialised, so it is obvious if you skip it.

**6. Set the secrets.** Under the Worker's **Settings** → **Variables and
Secrets**, add:

| Name               | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| `WEBUI_SECRET_KEY` | any long random string — it signs session tokens               |
| `NVIDIA_API_KEY`   | your NIM key from [build.nvidia.com](https://build.nvidia.com) |

Mark both as **Secret** rather than plaintext. `WEBUI_SECRET_KEY` is not
optional: without it the Worker falls back to a signing key that is a constant
in this public repository, so anyone could forge a session token for your
deployment. It warns in the logs when it does this.

You do **not** need to set a URL. OAuth callbacks and the post-login redirect
are derived from the origin of the incoming request, so they follow whatever
hostname the Worker is reached on — `workers.dev` and a custom domain both work
without configuration. To pin them to one host anyway, set it in **Admin
Settings → General → WEBUI_URL** (stored in the database), not as a plaintext
variable: `[vars]` in `wrangler.toml` is reapplied on every deploy, so a
dashboard edit to one is reverted by your next push.

**7. Add your domain** (optional). The Worker's **Settings** → **Domains &
Routes** → **Add** → **Custom domain**. The domain has to be a zone in the same
Cloudflare account; the subdomain record is created for you. Nothing in the app
needs changing — see step 6.

**8. Open it and create your account.** The **first** account to sign up becomes
the administrator, so do this before sharing the URL with anyone.

Redeploys are automatic on every push to the connected branch.

---

## Deploy from a terminal

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

cd workers
npx wrangler d1 create open-webui             # copy the id into wrangler.toml
npx wrangler kv namespace create CACHE        # copy the id into wrangler.toml
npx wrangler r2 bucket create open-webui-files
cd ..

npm --prefix workers run db:remote
(cd workers && npx wrangler secret put WEBUI_SECRET_KEY)

npm run build:workers                          # SvelteKit -> ./build
npm --prefix workers run deploy

# Primary model provider (skip if you configure one in the UI instead):
(cd workers && npx wrangler secret put NVIDIA_API_KEY)
```

Both paths are optional — you can also let Wrangler provision the resources, as
the dashboard flow does, and just run `npm --prefix workers run deploy`.

---

## Architecture

| Open WebUI (Python)              | This port (Cloudflare)                                   |
| -------------------------------- | -------------------------------------------------------- |
| FastAPI + Uvicorn                | Hono router inside a single Worker (`workers/src`)       |
| SQLite / PostgreSQL              | **D1** (`workers/migrations/0001_init.sql`)              |
| Local disk / S3 uploads          | **R2** (`FILES` binding)                                 |
| Redis (sessions, pub/sub)        | **Durable Object** `SocketHub` + KV for caching          |
| python-socketio                  | Hand-written Engine.IO v4 / Socket.IO v5 codec in the DO |
| Chroma / pgvector                | **Vectorize** (optional) or keyword scoring over D1      |
| Static files via FastAPI         | **Workers Static Assets** with SPA fallback              |
| `sentence-transformers`, Whisper | **Workers AI** (optional binding)                        |

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

| Variable                 | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `WEBUI_SECRET_KEY`       | **Required in production.** Signs session JWTs (set as secret) |
| `OPENAI_API_BASE_URL(S)` | Comma-separated OpenAI-compatible endpoints                    |
| `OPENAI_API_KEY(S)`      | Matching keys, positionally paired with the URLs               |
| `ENABLE_WORKERS_AI`      | Expose Workers AI models (needs the `[ai]` binding)            |
| `WORKERS_AI_MODELS`      | Override the built-in Workers AI model list                    |
| `DEFAULT_MODELS`         | Comma-separated default model ids for new chats                |
| `DEFAULT_USER_ROLE`      | `pending` (default), `user`, or `admin` for new signups        |
| `ENABLE_SIGNUP`          | Allow self-service signup after the first admin exists         |
| `JWT_EXPIRES_IN`         | `-1` (never), or `30m`, `12h`, `7d`…                           |
| `WEBUI_NAME`             | Branding shown in the UI                                       |
| `CORS_ALLOW_ORIGIN`      | `*` by default; a `;`-separated allowlist locks browsers down  |

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

### Automations

Scheduled prompts run on a Cloudflare **Cron Trigger** (`crons = ["* * * * *"]`
in `wrangler.toml`). Every minute the Worker looks for automations whose next
run has come due, creates a chat, and runs the prompt through the normal
completion pipeline — so the result is a regular conversation, streamed and
persisted like any other.

Schedules are iCalendar `RRULE` strings (`FREQ`, `INTERVAL`, `BYDAY`, `BYHOUR`,
`BYMINUTE`, `BYMONTHDAY`, `COUNT=1`, `UNTIL`), evaluated in the owner's
timezone so "every day at 09:00" means 09:00 where they are. Failures are
recorded as runs and never block the next occurrence.

To fire the trigger by hand while developing:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

### Calendar

Calendars, events and RSVPs are stored in D1; recurring events are expanded on
read with the same RRULE engine the automations use, so a month view costs one
query plus in-memory expansion. Alongside the user's own calendars, a read-only
**Scheduled Tasks** calendar shows each automation's upcoming occurrences and
its past runs, linking back to the chats they produced.

### Ollama Cloud

`ollama.com` serves the OpenAI API at `/v1`, so it is wired in as an
OpenAI-compatible connection rather than through the native Ollama protocol —
listing, streaming and routing all reuse the same path as every other provider.
Its models are tagged **Ollama** in the picker.

**Adding your keys.** The Connections screen has no field for a pool — it adds
one connection at a time, each with its own key. So add
`https://ollama.com/v1` once per key: **Admin Settings → Connections** →
**Ollama** → **+** → the same URL, a different key each time. The Worker
recognises repeated entries of the same host, pools their keys, and lists the
models once rather than once per entry.

Or set them in one go with a Worker var:

| Setting             | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `ENABLE_OLLAMA_API` | on/off                                                         |
| `OLLAMA_BASE_URL`   | defaults to `https://ollama.com/v1`; point it at your own host |
| `OLLAMA_API_KEYS`   | one key, or many — an array, or a comma/newline separated list |

**More than one key is the point.** Ollama Cloud rate-limits each key
separately, so the Worker picks one at random per request to spread load and
keeps the rest as fallbacks: a `429` (or a `5xx`, which the service also
returns under load) is retried with the next key rather than surfaced. Paste
fifteen keys in and you get roughly fifteen times the headroom, with no change
to how anything else behaves. Duplicates are dropped, since a repeated key adds
no headroom but would skew the random choice toward itself.

The choice is random rather than round-robin because a Worker keeps no state
between requests, and a KV counter would cost a write per message against a
free tier that allows a thousand a day.

A self-hosted Ollama needs no key at all — set `OLLAMA_BASE_URL` and leave the
keys empty. Note that a deployed Worker cannot reach a private address, so it
has to be exposed over HTTPS.

### Web search

Enable it under **Admin Settings → Web Search**, or with the config API. Five
providers ship, all over plain `fetch`:

| `WEB_SEARCH_ENGINE`         | Needs                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `duckduckgo` (default)      | nothing — best-effort HTML scrape, can be rate-limited         |
| `searxng`                   | `WEB_SEARCH_URL` pointing at your instance                     |
| `tavily`, `serper`, `brave` | `WEB_SEARCH_API_KEY`                                           |
| `google_pse`                | `GOOGLE_PSE_API_KEY` **and** `GOOGLE_PSE_ENGINE_ID` (the `cx`) |

Google PSE keeps its key separate from `WEB_SEARCH_API_KEY` so switching
engines does not mean retyping it. Create the engine at
[programmablesearchengine.google.com](https://programmablesearchengine.google.com)
— set it to search the entire web unless you want it scoped to specific sites —
and take the key from the Custom Search JSON API in Google Cloud. The free
quota is 100 queries a day. Google caps `num` at 10 per request, so a larger
result count is clamped rather than silently ignored.

When a chat turn has web search enabled, the Worker searches, fetches the top
results, reports progress through the same `status` events as upstream, injects
the pages as `<source>` context, and stores them as files so the answer carries
citations.

**Fetching one page.** Independently of search, `POST /api/v1/retrieval/process/web`
with `{"url": "..."}` fetches a page, reduces it to text, stores it as a file
and indexes it for retrieval — which is what typing `#https://example.com` in
chat does. Same extraction as the search path, so a page pulled in this way is
citable in exactly the same way.

### OAuth / OIDC sign-in

Four providers ship: `google`, `microsoft`, `github`, and a generic `oidc`
client for anything else (Keycloak, Authentik, Auth0, Okta, Entra ID…). The
login screen renders a button for each configured provider automatically.

The generic client is configurable in **Admin Settings → Authentication**, so a
deployed Worker needs no redeploy to turn SSO on:

| Field         | Value                                                          |
| ------------- | -------------------------------------------------------------- |
| Provider URL  | your IdP's `.well-known/openid-configuration`                  |
| Client ID     | the client you registered                                      |
| Client Secret | its secret                                                     |
| Redirect URI  | leave blank to use `https://<your-worker>/oauth/oidc/callback` |

Register that callback URL with the IdP. The named providers are environment
variables instead, matching upstream: `GOOGLE_CLIENT_ID`/`_SECRET`,
`MICROSOFT_CLIENT_ID`/`_SECRET`/`_TENANT_ID`, `GITHUB_CLIENT_ID`/`_SECRET`.
Their callbacks are `/oauth/<provider>/callback`.

The flow is authorization-code with PKCE (S256). Because a Worker has no
server-side session store, the `state`, the PKCE verifier and the OIDC `nonce`
travel in a short-lived HMAC-signed, HttpOnly cookie instead — so the callback
works whichever colo handles it. ID tokens are verified against the provider's
JWKS (RS256/RS384/RS512, ES256/ES384) with `iss`, `aud`, `exp` and `nonce`
checked; discovery documents and JWKS are cached in KV for an hour.

Account handling mirrors upstream: `ENABLE_OAUTH_SIGNUP` gates account
creation, `OAUTH_MERGE_ACCOUNTS_BY_EMAIL` links an SSO identity to an existing
address, `OAUTH_ALLOWED_DOMAINS` restricts by email domain, and role and group
management map the `roles`/`groups` claims onto Open WebUI roles and groups.
The first account created on a fresh deployment is the administrator, however
it signs up.

Every setting also has a Worker var, matching upstream's environment
variables — `OAUTH_CLIENT_ID`, `OPENID_PROVIDER_URL`, `ENABLE_OAUTH_SIGNUP`,
`OAUTH_ALLOWED_DOMAINS` and the rest — so a deployment can be configured
entirely with `wrangler secret put`. The precedence is stored value → Worker
var → default, so the admin screen takes over the moment someone saves it.

**Trying it locally.** A mock identity provider ships with the port, and the
start script wires it up for you:

```bash
./start-workers.sh --mock --sso        # Windows: start-workers.bat --mock --sso
```

The login page then shows **Continue with Mock IdP**, which signs you in as
`sso.user@example.com` without asking for anything. To drive it by hand instead,
run `npm --prefix workers run mock:oidc` and point the admin screen at
`http://localhost:9500/.well-known/openid-configuration` with client
`open-webui` and secret `open-webui-secret`. The smoke test picks the mock IdP
up automatically and runs the full round trip.

---

## What works, and what does not

**Working**

- Email/password auth, OAuth/OIDC single sign-on (Google, Microsoft, GitHub,
  or any OpenID provider), API keys, JWT sessions, pending-user approval flow
- Users, groups, and the full permission matrix
- Chats: create, edit, delete, folders, tags, pin, archive, share, clone, fork
- Streaming completions from NVIDIA NIM (primary), any OpenAI-compatible
  provider, and Workers AI
- Multi-model (side-by-side) responses
- Automatic title, tag and follow-up generation
- Workspace: models (presets and overrides), prompts with version history and
  diffs, knowledge bases with directories, skills
- Files in R2 with text extraction, chunking and retrieval
- Notes (with realtime collaboration relay) and Channels (realtime messaging
  and outbound webhooks)
- Automations: scheduled prompts driven by a Cron Trigger, with run history
- Calendar: calendars, recurring events, attendees and RSVPs, plus a read-only
  "Scheduled Tasks" calendar showing automation runs
- Memories, feedback/evaluations, admin usage analytics
- Web search in chat (DuckDuckGo, SearXNG, Tavily, Serper, Brave) with page
  retrieval, status updates and citations
- Text-to-speech and transcription (Workers AI Whisper or an OpenAI endpoint)
- Image generation (OpenAI-compatible or Workers AI)

**Not supported (and why)**

| Feature                                            | Reason                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Python tools, functions, pipes, filters, pipelines | The Workers runtime has no Python interpreter. Rows are stored and listed but never executed; `/api/config` reports `enable_plugins: false`. |
| Server-side code execution (Jupyter)               | Same. The in-browser Pyodide interpreter still works.                                                                                        |
| LDAP, SCIM                                         | Not ported. Email/password, API keys and OAuth/OIDC cover self-hosting; the LDAP admin screen returns inert config.                          |
| Ollama on `localhost`                              | A deployed Worker cannot reach private addresses — expose Ollama over HTTPS (e.g. Cloudflare Tunnel) and set its URL.                        |
| Socket.IO long-polling                             | Only the WebSocket transport is implemented; `/api/config` always reports `enable_websocket: true`.                                          |
| Server-side Yjs merge                              | Note collaboration relays updates between clients instead of merging them server-side.                                                       |
| Server-side PDF export, `black` formatting         | Both need Python/native binaries.                                                                                                            |

---

## Operations

**Migrations**

```bash
npm --prefix workers run db:local
npm --prefix workers run db:remote
```

**Backups**

```bash
(cd workers && npx wrangler d1 export open-webui --remote --output ../backup.sql)
```

**Logs**

```bash
(cd workers && npx wrangler tail)
```

**Tests**

```bash
npm --prefix workers test                 # vitest unit tests
npm --prefix workers run typecheck        # tsc --noEmit

# End-to-end check against a running deployment (local or on Cloudflare).
# Signs in, exercises chats, files, knowledge, notes, memories, channels,
# a streamed completion over the socket, and the admin endpoints.
SMOKE_EMAIL=you@example.com SMOKE_PASSWORD=... \
  npm --prefix workers run smoke -- https://open-webui.<subdomain>.workers.dev
```

### Networking

Deployed Workers can only reach public addresses. Anything on your LAN — Ollama,
a local vLLM server, an internal OpenAI gateway — needs a public hostname, most
easily through [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
`wrangler dev` runs locally and _can_ reach `localhost`, which is why the mock
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

| Limit                  | Value                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| Worker CPU per request | 30 s (streaming happens in the Durable Object, so long generations are fine) |
| D1 database size       | 10 GB                                                                        |
| R2 object size         | 5 TB                                                                         |
| Static assets          | 20,000 files, 25 MiB each (sourcemaps are excluded by `build/.assetsignore`) |

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
