# Contributing to OSAII Full Platform

## One-line quickstart

```bash
curl -fsSL https://osaii.wyvernhub.net/install/fullplatform.sh | bash
# or locally:
bash install.sh          # clone/update + npm ci + .dev.vars
npm run setup            # same (via npm)
npm run dev              # Worker http://localhost:8787
```

Windows: `irm https://osaii.wyvernhub.net/install/fullplatform.ps1 | iex` or `powershell -File install.ps1`

## Architecture map

```
src/index.ts              Worker router — all HTTP surfaces
API/poolside.ts           Gateway, rate limits, safety (Poolside primary → Groq → Pollinations)
API/studio*.ts            Studio (OSS) — /studio, /studio/new, /studio/preview/a + platform APIs
API/masque*.ts            Masque 18+ — /masque + /masque/api/v1 + DO MasqueSession
API/cosaii.ts + src/cosaii-relay.ts  Cosaii device auth + opaque relay (DO CosaiiRelay)
API/platform.ts + docs.ts + mythos.ts  Platform home, API keys, docs, MythOS pages
cosaii/ + packages/cosaii/ Rust app-server + OpenTUI client
MythOS/                   Debian-based OS (python/pytest)
migrations/               D1 schema (apply with npm run db:migrate:local)
wrangler.jsonc            Worker bindings: DB, STUDIO_FILES, BROWSER, AI, Vectorize, DOs
```

5 surfaces are intentionally separate: Worker API, Studio, Masque, MythOS, Cosaii.

## Dev workflow

```bash
npm install
cp .dev.vars.example .dev.vars   # fill secrets (see that file)
npm run check:env                # validate .dev.vars
npm run db:migrate:local        # local D1
npm run dev                      # :8787  (npm run dev:studio → :8788)
npm test                         # contract tests
npm run test:all                 # + cargo test + MythOS pytest
npm run typecheck && npm run build   # tsc + wrangler --dry-run before deploy
npx wrangler deploy --config wrangler.jsonc
```

Verify after deploy: `/health`, `/`, `/docs`, `/api/v1/models`, `/api/ask`, `/studio/new`, `/masque`, `/mythos`, `/mythos/release.json`.

## Secrets

Local: `.dev.vars` (git-ignored). Production: `wrangler secret put <NAME>`. Never commit `.dev.vars` / `.env`.

| Secret | Purpose |
|---|---|
| `POOLSIDE_API_KEY` (canon) / `POOOLSIDE_API_KEY` (legacy 3-O alias) | Poolside inference |
| `LOGFARE_API_KEY` | Advanced (Kimi/MiniMax/DeepSeek) |
| `GROQ_API_KEY` | Safety fallback chain |
| `POLLINATIONS_API_KEY` | Last-resort safety |
| `INVITE_SECRET` | Legacy auditor signup gate |
| `MASQUE_ADMIN_EMAILS` | Masque admin bootstrap |
| `CLOUDFLARE_API_TOKEN` | Optional account token |

`getPoolsideApiKey(env)` in `API/poolside.ts` handles the alias — don't read the env var directly.

## Make targets

`make install` `make dev` `make test` `make deploy-dry` `make clean` — see `Makefile`.

## Style

- Keep product routes/boundaries stable; don't merge surfaces.
- Preserve streaming (`text/event-stream`), CORS, rate-limit & usage headers.
- Safety fails closed; don't log prompts/keys.
- `apply_patch` for edits; update `tests/*contract.test.mjs` when you change a user-visible route or model.
