# OSAII Platform

[![Node 22](https://img.shields.io/badge/node-22-brightgreen)](#local-development) [![Wrangler 4](https://img.shields.io/badge/wrangler-4.x-orange)](wrangler.jsonc) [![License GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE) [![Worker](https://img.shields.io/badge/worker-osaii.wyvernhub.net-black)](https://osaii.wyvernhub.net/health)

OSAII Platform is the umbrella for OSAII products and services. Its API and OSS Studio are separate, symbiotic surfaces: the API is for calling models from code, while Studio is the focused workspace for Chat, Agent, Agent Swarm, projects, tools, and deliverables. Masque is the separate character product, and MythOS is the desktop operating system. Shared services remain optional at each product boundary.

Use the [Platform home](https://osaii.wyvernhub.net/) to understand the product boundary, then choose the surface that fits the work.

## ⚡ Single-line installs

```bash
# Full Platform (Worker + Studio + Masque + MythOS + Cosaii)
curl -fsSL https://osaii.wyvernhub.net/install/fullplatform.sh | bash
# Windows PowerShell
irm https://osaii.wyvernhub.net/install/fullplatform.ps1 | iex

# Cosaii CLI only
curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh
# Worker only (from repo)
npm run setup && npm run dev
# MythOS (from MythOS/ dir)
make -C MythOS validate
```

Local dry-run: `bash install.sh --dry-run` → `npm run check:env` → `npm run dev`

```
                    ┌─────────────────────────────────────────┐
                    │           osaii.wyvernhub.net            │
                    │        Cloudflare Worker (osaii)         │
                    └──────┬──────────────┬──────────────┬─────┘
                           │              │              │
              ┌────────────▼─┐  ┌─────────▼─────┐  ┌────▼────────┐
              │  /api/v1/*   │  │ /studio/new   │  │  /masque    │
              │  /api/ask    │  │ /studio/*     │  │  /masque/*  │
              │  OpenAI-compat│  │ Chat/Agent/   │  │  Characters │
              │  Poolside +   │  │ Swarm + VFS/  │  │  DO Session │
              │  Logfare/Bits │  │ MCP/Preview   │  │  Vector/R2  │
              └──────┬───────┘  └──────┬────────┘  └─────┬───────┘
                     │                 │                  │
              ┌──────▼─────────────────▼──────────────────▼──────┐
              │  D1 (osaii)  ·  R2 (osaii-studio)  ·  AI / Vectorize / Browser / DOs  │
              └──────────────────────────────────────────────────┘
         ┌──────────────┐  ┌──────────────┐
         │   Cosaii     │  │   MythOS     │
         │  Rust + TUI  │  │  Debian OS   │
         │  local-first │  │  opt-in apps │
         └──────────────┘  └──────────────┘
```

## Cosaii CLI

Cosaii (pronounced “cozy”) is the Platform's local agent. `cosaii-app-server` is a persistent Rust runtime that owns authentication, encrypted local sessions, agent turns, tools, permissions, and optional remote control. `cosaii` is its thin OpenTUI/Solid client. Conversations stay on the local machine rather than synchronizing into Studio.

```bash
curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh
cosaii login
cosaii
```

Development builds:

```bash
npm run cosaii:check
npm run cosaii:build
```

The browser device flow lives under `/platform/api/cli/*`; scoped inference and Platform operations live under `/cosaii/api/v1/*`. The old browser `/cli` page has been removed.

## Platform API

Create an OSAII Platform account and named API key at the site root. Keys are shown once,
stored only as SHA-256 hashes, and can be revoked from the same dialog. Use it with the
OpenAI-compatible gateway. Anonymous API traffic keeps its current limits; valid OSAII keys
receive 600 RPM for Laguna XS, 300 RPM for other models, 6,000 requests/hour, and 20,000/day.

```bash
curl https://osaii.wyvernhub.net/api/v1/models \
  -H "Authorization: Bearer $OSAII_API_KEY"
```

For a simple GET request, use `/api/ask`. `q` is required; `model` defaults to
`fast` and also accepts `smart` or an exact catalog model ID. `format` defaults
to raw `text` and may be `json`, `ccjson` (Chat Completions JSON), or `rjson`
(Responses-style JSON).

```bash
curl -G https://osaii.wyvernhub.net/api/ask \
  -H "Authorization: Bearer $OSAII_API_KEY" \
  --data-urlencode 'q=Explain the observer pattern in one paragraph' \
  --data-urlencode 'model=smart' \
  --data-urlencode 'format=text'
```

Apply `migrations/0007_api_keys.sql` before deploying this feature.

The current focused interface is served at [`/studio/new`](https://osaii.wyvernhub.net/studio/new). The original Studio remains available at [`/studio`](https://osaii.wyvernhub.net/studio).

### API + Studio

The API and Studio are intentionally separate entry points inside one Platform. Prototype in Studio, then move the same model-backed workflow into `/api/v1` or `/api/ask`; or bring an API-backed service into Studio for inspection and iteration. A Platform account, safety boundary, model catalog, and usage view connect both surfaces.

## MythOS

The MythOS source now lives in [`MythOS/`](MythOS/). Its public overview is at [`/mythos`](https://osaii.wyvernhub.net/mythos), and [`/mythos/release.json`](https://osaii.wyvernhub.net/mythos/release.json) exposes bounded release and service-discovery metadata.

MythOS does not require an OSAII account or ship OSAII launchers in the default application menu. Users may explicitly enable the `osaii-web-apps` feature in System Hub to add browser shortcuts for Platform, Studio, and Masque, then disable it to remove those shortcuts. Local operating-system identity and data are never transferred to the Platform.

## Local development

```bash
npm run setup          # npm ci + cp .dev.vars.example .dev.vars + checks + D1 dry-run
# or
bash install.sh
# or manually:
npm install
cp .dev.vars.example .dev.vars
npm run check:env      # validate secrets (POOLSIDE_API_KEY / POOOLSIDE_API_KEY alias)
npm run db:migrate:local
npm run dev            # wrangler dev on :8787  (npm run dev:studio → :8788)
```

Add the required development credentials to `.dev.vars`. Never commit `.env` or `.dev.vars`. `POOLSIDE_API_KEY` is canonical (2 O's); `POOOLSIDE_API_KEY` (3 O's) is a legacy alias — set either one.

Requires Node 22 (see `.nvmrc` / `.node-version` / `engines`). Also: `cargo` for Cosaii, `bun` for the TUI, `docker` for MythOS images, `python3` for MythOS tests.

## Validation

```bash
npm test               # node --test tests/*.test.mjs
npm run test:all       # + cargo test + MythOS pytest + tsc
npm run typecheck
npm run build          # wrangler deploy --dry-run
make test && make deploy-dry
```

## Deployment

```bash
npx wrangler deploy --config wrangler.jsonc
# or
make deploy-dry && npx wrangler deploy --config wrangler.jsonc
```

## Open source boundary

The only open parts of the OSAII Platform are **OSS Studio** and **Cosaii**. They are
published under GPLv3 in the public [`openplatform`](https://github.com/osai-initiative/openplatform)
repository. Everything else in this repository — the model gateway surface, Masque, MythOS,
the docs site, and the certified catalog — is closed and lives only in this private
`fullplatform` repository.

## License

Licensed under the [GNU General Public License v3.0](LICENSE).
