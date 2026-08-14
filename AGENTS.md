# OSAII Platform repository guide

This repository is the Cloudflare Worker for **OSAII Platform**. The Platform is the umbrella product; its three primary surfaces are deliberately separate but share model access, accounts, safety policy, and usage accounting:

- **Platform/API** is the programmable surface for applications and scripts.
- **OSS Studio** is the hands-on workspace for normal Chat, Agent, Agent Swarm, projects, tools, and deliverables.
- **Masque** is the 18+ character product for creation, discovery, immersive conversations, rooms, memory, imports, exports, voice, and embeds.
- **MythOS** is the desktop operating-system product. It is independently useful and exposes OSAII web apps only through an explicit optional feature.
- **Cosaii** is the local agentic CLI. Its Rust app-server owns agent behavior and encrypted local state; its OpenTUI client is deliberately thin.

Do not collapse these surfaces into one route or silently change their access rules. Changes should preserve the existing black/white/green visual identity and the focused conversation-first Studio shell.

## Product map

### Platform homepage

- Route: `/`
- Source: `API/platform.ts`
- Served by: `src/index.ts` (`platformPage()` plus umbrella copy transformations)
- Purpose: explain the Platform, API, Studio relationship, account entry, and API-key creation.
- API keys are created through `/platform/api/keys`; secrets are shown once and stored as hashes.

### Platform API

- OpenAI-compatible gateway: `/api/v1/chat/completions`
- Responses-compatible gateway: `/api/v1/responses`
- Model catalog: `/api/v1/models`
- Simple GET endpoint: `/api/ask?q=...`
- `/api/ask` parameters:
  - `q` required input
  - `model`: `fast`, `smart`, or a catalog model ID
  - `format`: `text` (default), `json`, `ccjson`, or `rjson`
- API keys are optional for basic access. Valid OSAII keys provide higher limits and usage attribution.
- CORS, rate limits, provider routing, safety screening, and response forwarding live primarily in `API/poolside.ts` and `src/index.ts`.

### OSS Studio

- Current focused interface: `/studio/new`
- Legacy/original interface: `/studio`
- Source: `API/studio-next.ts` for the focused shell and `API/app.ts` for the original shell.
- Studio modes: Chat, Agent, and Agent Swarm.
- Agent and Swarm require an OSAII Platform account. Guests may use standard Chat.
- Advanced models require an account.
- Studio keeps conversation history in browser storage and synchronizes platform state through `API/studio-platform.ts` when signed in.
- Projects, VFS, plugins/MCP, audit logs, usage, deployments, research, attachments, data workspaces, voice, and background capabilities are implemented behind Studio platform APIs. Preserve permission checks and audit recording for writes, external calls, builds, and deploys.

### Masque

- Product: `/masque`; operator console: `/masque/admin`; PWA manifest/service worker: `/masque/manifest.webmanifest` and `/masque/sw.js`.
- Public REST/SSE surface: `/masque/api/v1`.
- Sources: `API/masque.ts` (consumer/admin UI), `API/masque-api.ts` (REST resources, imports/exports, media, search, flags, schedules), and `src/masque-session.ts` (SQLite-backed Agent per conversation).
- Masque is separate from Studio. Add Masque entry points to the Platform homepage and docs, never to Studio navigation.
- Masque exposes only Auto, Fast, and Smart. Auto visibly reports the selected Fast/Smart family.
- Guests can browse and use 20 local, non-durable messages per device/day. Platform sign-in unlocks durable Masque profiles, characters, sessions, memory, imports/exports, and collaboration.
- Masque profiles have unique case-insensitive usernames and an independent adult attestation. Data contribution remains account-wide and off by default.
- Character cards use structured fields compiled into a protected server-side runtime prompt. Never expose or accept a raw runtime system prompt.
- Character revisions, collaboration, remix lineage, imports, reports, consent, flags, schedules, API mutations, and moderation decisions are audited in Masque-specific tables.
- Public-link imports use ordinary fetch and optional Browser Rendering only for public Character.AI/JanitorAI pages. Never request source credentials or use private APIs.
- Character assets, import scratch data, exports, generated media, and snapshots use `STUDIO_FILES` only under `masque/` prefixes.
- Masque API-key scopes are `masque:read`, `masque:chat`, `masque:write`, `masque:embed`, and `masque:webhook`. Existing keys have no Masque privileges until explicitly granted.
- Every risky runtime capability has a D1 feature flag. The global flag is a hard kill switch; voice, images, rooms, schedules, embeds, public API, and notifications are independently controlled.
- `MASQUE_ADMIN_EMAILS` bootstraps administrators; persisted roles live in D1. Never expose the allowlist in client payloads.

### MythOS

- Product page: `/mythos`; release discovery: `/mythos/release.json`; authored source: `MythOS/`.
- MythOS local users, files, administrator credentials, diagnostics, and system settings are never Platform account data.
- OSAII browser shortcuts are absent by default. The `osaii-web-apps` System Hub feature installs and removes only the optional Platform, Studio, and Masque desktop entries.
- Do not add OSAII apps to the base application menu, autostart, first-run required flow, or default browser session.
- Generated MythOS build artifacts remain under the ignored `MythOS/.build/`. Its prior standalone Git metadata is preserved locally under the ignored `MythOS/.git-source/`.

### Developer documentation

- Route: `/docs`
- Source: `API/docs.ts`
- Documents API routes, models, limits, safety, and Studio.
- Documents Masque separately without adding Masque characters to `/api/v1/models`.
- “Ask about docs” must answer only from the bounded route/context map. Do not allow invented endpoints or links. Unknown links are removed before display.

### Cosaii

- Browser authorization: `/platform/cli/authorize`; device grants: `/platform/api/cli/*`.
- Scoped inference and Platform facade: `/cosaii/api/v1/*`; install scripts: `/install/cosaii.sh` and `/install/cosaii.ps1`.
- `cosaii-app-server` is the only writer to the encrypted local SQLite database and owns authentication, threads, turns, items, tools, permissions, processes, and remote attachment.
- `cosaii` is a thin OpenTUI/Solid client. Do not move agent loops, token refresh, persistence, or permission policy into it.
- Every connection initializes the versioned bidirectional JSON-RPC protocol before any other method and explicitly subscribes to thread events.
- Never infer health from the socket file. Validate `server/status`, and remove a stale socket only when the recorded process is dead.
- Platform tokens are hashes in D1; raw refresh tokens belong in the local OS credential store or encrypted passphrase fallback.
- Conversations stay local and are not synchronized into Studio. Remote relay frames must remain end-to-end encrypted ciphertext with no transcript storage.
- OpenCode configuration is imported first; native `cosaii.jsonc` overrides it at the same scope; managed policy is highest priority.
- Sources: `cosaii/` (Rust protocol/app-server), `packages/cosaii/` (client/launcher), `API/cosaii.ts` (cloud API), and `src/cosaii-relay.ts` (opaque relay).

### Other surfaces

- Static project previews: `/studio/site/SITE_ID_OR_NAME`.
- Health check: `/health`.
- Favicon: `/osaii.png` and `/favicon.ico`.

## Models and routing

Friendly model families must stay separate from provider details in normal UI:

- Fast → `poolside/laguna-xs-2.1`
- Smart → `poolside/laguna-s-2.1`
- Advanced → Logfare models such as Kimi K3, MiniMax M3, DeepSeek V4 Flash, and DeepSeek V4 Pro
- ChatGPT/Codex → browser OAuth-backed models when the user connects ChatGPT
- Auto → Studio task-based routing between Fast and Smart
- Masque Auto → per-turn routing between the same Fast and Smart families, reported in SSE metadata

Reasoning controls are `None`, `Light`, `Medium`, and `Max`. Poolside and Logfare do not necessarily accept identical inference fields; keep provider-specific translation in the gateway and fail gracefully when a setting is unsupported.

Fast mode includes a conservative, short-lived semantic cache in `src/lib/semantic-cache.ts`. It is model-scoped, excludes prompts that appear personal/private, expires quickly, and exposes `x-osaii-cache: semantic-hit`. Do not cache private conversations, tool calls, agent work, or Advanced responses without an explicit privacy design.

## Safety

- Safety screening occurs before model inference and on final output where applicable.
- The primary remote classifier is Poolside Laguna XS with minimal reasoning. The ordered Groq chain and Pollinations classifier remain availability fallbacks in `API/poolside.ts`.
- If safety service availability is required for a surface, fail closed rather than sending unscreened content.
- Swarm screens the user task once and the final synthesis once; do not screen every internal researcher call.
- Self-harm blocks use the dedicated support UI in Studio.
- Logfare Advanced requests include the additional under-18 policy check.
- Masque screens creation/import/publishing/discovery metadata, user input, and final output; explicit sexual content remains disabled. Real-person characters are limited to labeled public-figure simulations.
- Masque self-harm handling should preserve character tone while clearly providing real-world help and the Platform support experience.
- Never log raw prompts, uploaded files, API keys, OAuth credentials, or provider secrets.

## Accounts, storage, and permissions

- OSAII Platform accounts are separate from Wyvern accounts.
- Auth routes are under `/studio/api/auth/*` and use the D1 database binding `DB`.
- Cloud project metadata/revisions use D1; project files/artifacts use R2 binding `STUDIO_FILES`.
- Browser File System Access mode must not upload files unless the user imports or deploys them.
- Agent permission options are Deny All, Allow low-risk, Always Ask, and Full Access.
- Every write, external call, build, deploy, plugin/MCP action, and relevant failure should be represented in the audit trail.

## Cloudflare configuration

The Worker is configured in `wrangler.jsonc`:

- Worker name: `osaii`
- Entry point: `src/index.ts`
- D1: `DB` → database `osaii`
- R2: `STUDIO_FILES` → bucket `osaii-studio`
- Browser Rendering: `BROWSER`
- Scheduled trigger: every five minutes for Studio tasks
- Durable Object: `MASQUE_SESSIONS` → SQLite `MasqueSession` Agent
- Durable Object: `COSAII_RELAYS` → SQLite `CosaiiRelay` opaque WebSocket relay
- Workers AI: `AI` → `@cf/baai/bge-m3` embeddings (1,024 dimensions)
- Vectorize: `MASQUE_SEARCH` → `osaii-masque-search`, cosine metric
- Scheduled trigger also handles Masque proactive messages, cleanup, retries, and audit retention
- Custom domain: `osaii.wyvernhub.net`

Secrets belong in local `.dev.vars` or Cloudflare Worker secrets. Never commit `.env`, `.dev.vars`, API keys, OAuth tokens, or generated credentials.

## Development workflow

Install and run locally:

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler dev --config wrangler.jsonc
```

Validate before deployment:

```bash
node --test tests/studio-contract.test.mjs
npm test --if-present
npx tsc
node --test tests/masque-contract.test.mjs
npx wrangler deploy --dry-run --config wrangler.jsonc
```

Deploy only after tests and dry-run pass:

```bash
npx wrangler deploy --config wrangler.jsonc
```

After deploying, verify `/health`, `/`, `/docs`, `/api/v1/models`, `/api/ask`, `/studio/new`, `/masque`, `/masque/admin`, `/masque/manifest.webmanifest`, and the Masque API bootstrap over `https://osaii.wyvernhub.net`. Verify unchanged Studio/API routes and record the Worker version in the handoff.

## Editing rules

- Use `apply_patch` for edits.
- Keep route boundaries stable unless the user explicitly requests a migration.
- Preserve streaming (`text/event-stream`) and request cancellation behavior.
- Preserve OpenAI-compatible request/response shapes and tool/function-call fields.
- Keep provider IDs out of friendly UI unless the user is in Advanced/API contexts.
- Do not replace the focused Studio shell with a dashboard-heavy redesign.
- Update contract tests when changing a route, model, safety behavior, persistence behavior, or user-visible product boundary.
- Inspect the actual implementation before describing a feature as complete; then run tests and a live route check.

## Important files

- `src/index.ts` — Worker routing, API endpoints, auth routing, HTML response handling.
- `API/poolside.ts` — provider calls, model validation, safety, rate limits, streaming.
- `API/studio-next.ts` — current OSS Studio UI and client behavior.
- `API/studio.ts` — Studio API, chat/agent/swarm gates, projects and VFS.
- `API/studio-platform.ts` — durable Studio state, tools, research, memory, schedules, and platform APIs.
- `API/app.ts` — original Studio UI.
- `API/platform.ts` — Platform homepage and API-key modal.
- `API/docs.ts` — developer docs page.
- `API/masque.ts` — Masque PWA and operator UI.
- `API/masque-api.ts` — Masque REST/SSE, characters, imports/exports, discovery, media, flags, and scheduled work.
- `API/mythos.ts` — MythOS product page and release/service discovery metadata.
- `MythOS/` — MythOS OS source, Debian packaging, image build, validation, and optional OSAII shortcut integration.
- `src/masque-session.ts` — per-conversation SQLite Agent, branch revisions, messages, and resumable SSE events.
- `cosaii/` — Rust app-server workspace and shared JSON-RPC schema.
- `packages/cosaii/` — OpenTUI/Solid CLI, daemon lifecycle, and npm launcher package.
- `API/cosaii.ts`, `src/cosaii-relay.ts` — CLI device auth, scoped Platform facade, inference, pairing, and ciphertext relay.
- `src/lib/semantic-cache.ts` — Fast-mode semantic cache.
- `src/lib/auth.ts`, `src/lib/api-keys.ts` — account/session and API-key helpers.
- `src/lib/token-usage.ts` — provider-neutral usage tracking.
- `migrations/` — ordered D1 schema migrations.
- `tests/studio-contract.test.mjs` — repository contract and regression tests.
- `tests/masque-contract.test.mjs` — Masque route, schema, UI, API, and Cloudflare binding contracts.
