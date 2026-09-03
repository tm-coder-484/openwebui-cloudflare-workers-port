# Open WebUI — Cloudflare Workers backend

This directory is the Cloudflare Workers port of the Open WebUI backend. The
full guide (deployment, configuration, feature matrix, limits) lives in
[`../CLOUDFLARE.md`](../CLOUDFLARE.md).

## Commands

```bash
npm install                  # worker dependencies
npm run dev                  # wrangler dev (the frontend must be built first)
npm test                     # vitest unit tests
npm run typecheck            # tsc --noEmit
npm run db:local             # apply D1 migrations locally
npm run db:remote            # apply D1 migrations to Cloudflare
npm run deploy               # wrangler deploy
npm run smoke                # end-to-end API smoke test against a running deployment
node scripts/mock-openai.mjs # offline OpenAI-compatible model server
```

Run wrangler from this directory (it resolves bindings, migrations and the
assets path relative to `wrangler.toml`). From the repository root,
`./start-workers.sh --mock` does all of the above in one step.

## Source map

| Path                     | What lives there                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `src/index.ts`           | Router. Mounts one module per upstream FastAPI router.                                    |
| `src/types.ts`           | `Env` bindings and the session user type.                                                 |
| `src/lib/auth.ts`        | Bearer/API-key/cookie authentication middleware.                                          |
| `src/lib/crypto.ts`      | PBKDF2 password hashing and HS256 JWTs via WebCrypto.                                     |
| `src/lib/config.ts`      | The persisted config table, defaults, and env seeding.                                    |
| `src/lib/models.ts`      | Model registry: NVIDIA NIM (primary), OpenAI-compatible connections, Workers AI, presets. |
| `src/lib/completions.ts` | The chat pipeline: history, upstream call, SSE parsing, background tasks.                 |
| `src/lib/retrieval.ts`   | Chunking, keyword ranking, optional Vectorize search.                                     |
| `src/socket/hub.ts`      | `SocketHub` Durable Object: rooms, presence, streaming.                                   |
| `src/socket/protocol.ts` | Engine.IO v4 / Socket.IO v5 codec.                                                        |
| `src/routes/*.ts`        | One module per `backend/open_webui/routers/*.py`.                                         |

## Conventions

- Errors are thrown as `HttpError` and serialized as `{"detail": "..."}`, which
  is what the frontend's `fetch` wrappers expect.
- JSON columns are stored as TEXT and read through `parseJSON`/`toJSON`.
- Route modules use `new Hono({ strict: false })` because the frontend calls
  some paths with a trailing slash and some without.
- Anything the runtime genuinely cannot do (Python execution, LDAP) returns a
  clear error or an inert payload rather than a 404, so the UI stays usable.
