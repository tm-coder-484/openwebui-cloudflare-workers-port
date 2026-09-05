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
extra services. When a query shares no term at all with the document — "summarise
the attached document" usually does not — the opening chunks are returned rather
than nothing, so an attachment always contributes something.

**How much of an attached document reaches the model.** By default, retrieval,
which means `rag.top_k` chunks of `rag.chunk_size` characters each: **three
thousand characters**, however long the file is. That is the right trade for a
knowledge base of hundreds of files and the wrong one for "read this and
summarise it".

Two switches under **Admin Settings → Documents** hand over whole documents
instead, and mean the same thing here:

| Setting                        | Config key             |
| ------------------------------ | ---------------------- |
| Full Context Mode              | `rag.full_context`     |
| Bypass Embedding and Retrieval | `rag.bypass_embedding` |

With either on, every attached file — and every file in an attached knowledge
base — is passed in full. There is no cap: that is what the setting means, so a
document larger than the model's context window is rejected by the provider,
which reports it as a context-length error. Raising **Top K** and **Chunk Size**
is the middle ground if you want more than three thousand characters without
sending everything.

**Only text is extracted.** A `.txt`, `.md`, `.csv`, `.json`, source file and
similar are decoded and indexed; a PDF, `.docx` or image is stored in R2 and
served back intact, but contributes no text to a conversation, because
extracting it needs native libraries that do not run on Workers. Convert to text
before uploading, or paste the content.

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

### Setting up Ollama Cloud: models, search and fetch

One key pool drives all three. Get keys from
[ollama.com/settings/keys](https://ollama.com/settings/keys) (a free account is
enough for search).

**1. Put every key in one place.** In the Worker's **Settings** → **Variables
and Secrets**, add a secret `OLLAMA_API_KEYS` holding all of them, comma or
newline separated:

```
OLLAMA_API_KEYS = key-one,key-two,key-three
```

This one variable feeds the model connection _and_ web search — nothing else
needs the keys typed again. Each request starts at a randomly chosen key with
the rest behind it as fallbacks, so a pool of fifteen is fifteen times the
per-key rate limit rather than one key doing all the work.

**2. Turn the models on.** Admin Settings → **Connections** → enable **Ollama
API**. This step is required: the Ollama connection is **off by default** and no
environment variable turns it on, so keys alone give you no models. The base URL
defaults to `https://ollama.com/v1`, which is Ollama's OpenAI-compatible
endpoint — leave it alone unless you are pointing at your own server.

**3. Turn web search on.** Admin Settings → **Web Search** → toggle **Web
Search** on, set **Web Search Engine** to `ollama_cloud`, and **leave the Ollama
Cloud API Key field blank** — it falls back to the pool from step 1. Fill it in
only to give search its own keys. Then **Save**.

Search does not go through the Connections toggle, so it works even with the
Ollama model connection switched off — useful if you run models on NIM and want
Ollama only for search.

**4. Use it.** In a chat, click the web-search control in the composer before
sending. The Worker turns the conversation into search queries, searches, and
returns the pages as citable sources.

Fetching a single page needs no setup: type `#https://example.com` in a chat, or
`POST /api/v1/retrieval/process/web` with `{"url": "..."}`. Result pages inside
a search are loaded automatically, through Ollama's fetch API when a key is
available.

**Doing it over the API instead of the screens** — both calls need an admin
token in `Authorization: Bearer …`:

```bash
curl -X POST "$WEBUI/api/v1/configs/connections" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ENABLE_OLLAMA_API":true,"OLLAMA_BASE_URL":"https://ollama.com/v1",
       "OLLAMA_API_KEYS":["key-one","key-two"]}'

curl -X POST "$WEBUI/api/v1/retrieval/config/update" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"web":{"ENABLE_WEB_SEARCH":true,"WEB_SEARCH_ENGINE":"ollama_cloud",
              "WEB_SEARCH_RESULT_COUNT":3}}'
```

`OLLAMA_API_KEYS` set this way is stored in the database and takes the same path
as the secret; use whichever you prefer. Adding the same host several times
under Connections, once per key, also works and is pooled the same way — it is
just far more clicking for fifteen keys.

### Web search

Enable it under **Admin Settings → Web Search**, or with the config API. Seven
providers ship, all over plain `fetch`:

| `WEB_SEARCH_ENGINE`         | Needs                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `ollama_cloud`              | an Ollama API key — the same one that runs the models          |
| `duckduckgo` (default)      | nothing — best-effort HTML scrape, can be rate-limited         |
| `searxng`                   | the URL of a SearXNG instance you host                         |
| `tavily`, `serper`, `brave` | `WEB_SEARCH_API_KEY`                                           |
| `google_pse`                | `GOOGLE_PSE_API_KEY` **and** `GOOGLE_PSE_ENGINE_ID` (the `cx`) |

Anything else the dropdown offers is refused with a message naming these seven,
rather than quietly searching a different engine.

**`ollama_cloud` is the one to start with.** It needs no second account: the
Ollama key already entered under **Admin Settings → Connections** is reused, so
selecting the engine is the whole setup. A key may also be pasted into the
screen's own field, and several may be given (newline or comma separated). Each
call starts at a **randomly chosen** key with the rest of the pool behind it as
fallbacks for a 429 — the same spreading chat completions do, and it matters
here because one chat turn can make three searches plus a page load per result;
walking a fixed order would put all of that on the first key.

`/api/web_search` returns the **full text of each page**, not a one-line
snippet — measured at 3k to 22k characters on an ordinary documentation query —
so results go straight to the model and the loader is skipped. When an engine
does return a short snippet, pages are loaded through Ollama's `/api/web_fetch`
instead of directly from the Worker, which matters because a plain Worker
request arrives from a shared Cloudflare IP with no browser fingerprint and a
good share of sites answer that with a bot check. The direct fetch stays as the
fallback.

**`duckduckgo` is the one to avoid on Cloudflare.** It has no API — the results
come from scraping the HTML endpoint — and DuckDuckGo rate-limits datacentre
IPs hard, so a deployed Worker frequently gets an empty page back and the chat
reports "No web results found" with nothing to explain it. It is the default
only because it needs no key.

**SearXNG** is software you run, not a hosted API, so it needs the URL of an
instance you can reach: `http://your-host:8080` (a URL already ending in
`/search` is accepted as-is). Two things to know. First, a stock instance does
_not_ serve JSON — `search.formats` in its `settings.yml` must include `json`,
or every query comes back 403; the Worker says exactly that rather than
reporting a bare status. Second, several instances may be listed comma
separated, and they are tried in order. To try it locally,
`node scripts/mock-search.mjs` serves the same JSON contract on port 9600.

Plan on hosting your own. Probing all 81 public HTTPS instances listed on
[searx.space](https://searx.space) for a working JSON API found **two**; of the
rest, 51 answered 429, nine returned a "verifying your browser" page with a
200, seven had the JSON format disabled (403) and four returned 418. Public
instances defend themselves against exactly the traffic pattern a Worker
produces, which is why the engine takes a list and moves on rather than
treating the first URL as the only one.

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

**Three search modes**, set by **Search Mode** under Admin Settings → Web Search
(`WEB_SEARCH_MODE`, or `web.search.mode`):

| Mode               | What happens                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `always` (default) | One search before the model runs, on a query the task model writes from the conversation. |
| `tool`             | The model is given `web_search` and `web_fetch` as functions and calls them itself.       |
| `combo`            | Both: search first, and the model keeps the tools to search again.                        |

`always` is predictable and costs one search per turn whether or not the
question needs one. `tool` lets the model skip the search entirely when it
already knows the answer, choose its own query, read a specific result with
`web_fetch`, and search again with what it learned — up to three rounds, after
which it has to answer.

`combo` is the two together, and the mode to pick when you want search to be
reliable rather than cheap: the model starts with pages already retrieved, so it
answers immediately when they cover the question, and it still holds the tools
for when they do not. `always` cannot do the second; `tool` pays a round trip
before it has anything to read, and depends on the model choosing to search at
all. The injected context says outright that the tools are still available, so
"these pages do not answer it" leads to another search rather than an apology.
Cost is the same one search per turn as `always`, plus whatever the model adds.

All three modes emit the same status and source events, so citations render
identically.

`tool` and `combo` need a model that supports tool calling, and an
OpenAI-compatible connection: the Workers AI binding has no tool-calling shape,
so Workers AI models stay on `always`. If the endpoint rejects the request
because the model cannot do tool calling, the turn does not fail — it falls back
to searching first and asks again without tools, which is why these are safe to
leave on for a mixed set of models. In `combo` that fallback costs nothing
extra, since the search has already run.

### Tools the model can call

Beyond web search, a model that supports tool calling is offered three more
groups. All act **only on the calling user's own data** — every statement behind
them is scoped to the id of the account whose turn it is, so a model naming
another user's file gets "not found" — and none is a shell: there is no
filesystem and no command execution anywhere in this port.

| Group  | Tools                                                 | Config key            |
| ------ | ----------------------------------------------------- | --------------------- |
| Memory | `remember`, `recall`, `forget`                        | `tools.memory.enable` |
| Files  | `list_files`, `read_file`, `create_file`, `edit_file` | `tools.files.enable`  |
| Search | `glob_files`, `grep_files`, `search_chats`            | `tools.search.enable` |

A turn allows **three rounds of tool calls** before the model has to answer —
enough for search, read a result, search again. Raise it with `tools.max_rounds`
for longer chains; file work in particular can want more, since glob, grep, read
and edit are four rounds on their own. The value is clamped to 1-20 rather than
trusted: a round is a whole model call plus its tool work, so an unbounded value
is a turn that never ends and a bill to match.

All default to on. There is no settings screen for them, so they are set either
as **Worker variables** (Settings → Variables and Secrets) or through the config
API — the variable seeds the value on first read, the API changes it at runtime
without a redeploy:

| Variable              | Config key            | Value           |
| --------------------- | --------------------- | --------------- |
| `TOOLS_MAX_ROUNDS`    | `tools.max_rounds`    | 1-20, default 3 |
| `ENABLE_MEMORY_TOOLS` | `tools.memory.enable` | true / false    |
| `ENABLE_FILE_TOOLS`   | `tools.files.enable`  | true / false    |
| `ENABLE_SEARCH_TOOLS` | `tools.search.enable` | true / false    |

````bash
curl -X POST "$WEBUI/api/v1/configs/tools" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"TOOLS_MAX_ROUNDS": 8, "ENABLE_FILE_TOOLS": false}'
``` They do **not**
require web search to be enabled for the turn — the search mode governs the
search tools only.

**Memory** makes the existing per-user memories something the model reaches for
rather than something injected: it saves a fact when the user tells it one, and
looks it up when an answer depends on their setup or preferences. `recall`
returns each memory with its id, which is what `forget` takes, so removing a
memory the user says is wrong takes two calls and no guessing.

**Files** operate on the same uploads as the Files list: a "file" is a row in D1
with its bytes in R2, so anything the model writes shows up in the UI, can be
attached to a later chat, and is indexed for retrieval like any other upload.
Two deliberate refusals:

- `create_file` will not overwrite an existing name — silently replacing a file
  would lose whatever was in it. The model is told to use `edit_file` or pick
  another name.
- `edit_file` replaces an _exact_ passage and refuses when that passage appears
  more than once, naming the count, rather than guessing which one was meant.
  Whole-file rewrites are not offered at all: a model rewriting a document from
  memory silently drops the parts it did not think to repeat.

**Search** is the read-only half of the same idea. `glob_files` finds files by
name pattern and `grep_files` runs a regular expression over their contents,
returning each hit as `file:line: text` — which `read_file` can then read
around, since it takes `offset` and `limit` and numbers the lines it returns.
Together they let a model work through a workspace of many files without
reading all of them into the context window.

`search_chats` has no shell equivalent and is the most useful of the three: it
searches the user's own past messages, so "what did we decide about X" resolves
against real history rather than being answered from nothing. Matching rows are
prefiltered in SQL and then ranked with the same scorer retrieval uses, so a
long history never loads into memory.

A `grep_files` pattern is a user-supplied regular expression, which is worth one
guard: patterns are capped at 200 characters, and an invalid one is reported
back to the model rather than thrown. A catastrophically backtracking pattern is
ended by the Worker's CPU limit, which fails that request and nothing else.

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
````

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
- Web search in chat (Ollama Cloud, Google PSE, SearXNG, Tavily, Serper, Brave,
  DuckDuckGo) with model-generated queries, page retrieval, status updates and
  citations
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
