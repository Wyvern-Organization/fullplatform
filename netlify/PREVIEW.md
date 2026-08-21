# OSAII Studio Preview ƒ — Netlify + Worker preview handling

## What is Preview f?

Preview f is the font-preview + T3 clone served at `/studio/preview`, `/studio/preview/a`, and `/studio/preview/*`.

- **Flag:** `PREVIEW_F` environment variable. Default **enabled** (`"1"`). Set to `"0"` or `"false"` to disable.
- **Worker route:** `src/index.ts:542-562` handles `/studio/preview*` and calls `studioT3Page()` (`API/studio-t3.ts`).
- **In-app polish:** Font stack switcher (Manrope, Instrument Sans, Geist, Fragment Mono, DM Mono, Playfair Display), metrics overlay, command palette (Cmd+K), mobile drawer, preview banner.
- **Isolation:** CSP `sandbox` for published project previews (`API/studio.ts:studioPreview`), `isPreviewOrigin` + CORS for Codex adapter.

## Netlify Deploy Previews

Netlify Deploy Previews build every PR at `https://deploy-preview-<pr>--osaii-codex-adapter.netlify.app`.

### netlify.toml context

```toml
[build.environment]
  NODE_VERSION = "22"

[context.production.environment]
  PREVIEW_F = "1"

[context.deploy-preview]
  command = "npm ci --ignore-scripts"
[context.deploy-preview.environment]
  NODE_ENV = "preview"
  PREVIEW_F = "1"
  DEPLOY_CONTEXT = "deploy-preview"
  NETLIFY_PREVIEW = "true"

[context.branch-deploy.environment]
  PREVIEW_F = "1"
```

- `publish = "netlify/public"` and `functions = "netlify/functions"` are unchanged.
- Build command is intentionally `npm ci --ignore-scripts` — the adapter has no build step; this keeps preview deploys fast and deterministic.

### Caching policy (optimizer headers preserved)

The optimizer's 8–9 durable headers for static assets (`/osaii.png`, `/*.js`, `/*.css`, `/mythos/release.json`, `/docs`, `/`, `/api/v1/models`, `/health`) are **preserved** at the top of `netlify.toml`.

Preview-specific overrides follow and are **additive** (they target only preview paths, so production durability is untouched):

```toml
[[headers]]
  for = "/studio/preview/*"
  Cache-Control = "no-store, must-revalidate"
  Netlify-CDN-Cache-Control = "no-store, durable=false"
  X-Robots-Tag = "noindex, nofollow"

[[headers]]
  for = "/studio/new/*"
  Cache-Control = "no-store"
```

Production keeps `public, max-age=300, s-maxage=3600` for `/`; preview HTML is `no-store` so PR commits are always visible. Static assets stay `immutable` even in previews.

### SPA fallback (deep links must not 404)

Worker already handles `/studio/preview/*` → `studioT3Page`. Netlify's static fallback needs the same rewrite:

```toml
[[redirects]]
  from = "/studio/preview"
  to = "/index.html"
  status = 200

[[redirects]]
  from = "/studio/preview/*"
  to = "/index.html"
  status = 200
```

This ensures `/studio/preview`, `/studio/preview/a`, `/studio/preview/foo?font=Instrument+Sans` all serve the shell with 200.

## Codex adapter preview handling

`netlify/functions/codex.ts`:

- `ALLOWED_ORIGIN = "https://osaii.wyvernhub.net"` plus `isPreviewOrigin(origin)` that allows `*.netlify.app`, `localhost`, and `*.osaii.wyvernhub.net`.
- `resolveAllowedOrigin(request)` returns `request.headers.get("origin")` when preview, else `ALLOWED_ORIGIN`.
- `cors(request, headers)` now:
  - `Vary: Origin`
  - `Access-Control-Allow-Credentials: true`
  - propagates `X-Nf-Preview` / `X-Nf-Deploy-Context` → `X-Preview-Context` for observability
  - sets `X-Netlify-Preview: true` when host is `deploy-preview--*`
- All `json()` calls now pass `request` so CORS is preview-aware.
- `CODEX_ADAPTER_URL` is set via `wrangler.jsonc` vars (`https://osaii-codex-adapter.netlify.app` in prod, `DEPLOY_PRIME_URL` in preview if overridden via Netlify env). No hard-coded URL in codex.ts.

## Worker preview handling

`src/index.ts`:

- `isNetlifyPreviewRequest(request)` checks:
  - `?preview=1` or `?preview_f=1`
  - host `deploy-preview--*` or `--*.netlify.app`
  - headers `X-Nf-Deploy-Context`, `X-Netlify-Context`, `X-Nf-Preview`
- `previewBannerHtml(request)` injects a sticky gradient banner: "⬢ Preview deploy — not production · Open production".
- `withPreviewBanner(html, request)` injects after `<body>`.
- `previewHeaders(request, headers)` overrides `Cache-Control` to `no-store` + `X-Robots-Tag: noindex`.
- `function html(body, headers, request?)` is now preview-aware; all 19 `return html(..., request)` calls pass `request` so preview deploys automatically get banner + no-store.
- `API/studio.ts:studioPreview` already handles `?font=` injection for font-preview isolation; its `no-store` + `sandbox` CSP correctly prevents previewed projects from reading Studio cookies.

## Local testing

```bash
# Force preview banner + no-store locally
curl -H "X-Nf-Preview: true" http://localhost:8787/studio/preview
curl "http://localhost:8787/studio/preview?preview=1"

# Netlify preview host simulation
curl -H "Host: deploy-preview-123--osaii-codex-adapter.netlify.app" http://localhost:8787/

# Disable Preview f
PREVIEW_F=0 npm run dev   # then GET /studio/preview → 404 { error: "preview_disabled" }
```

## Checklist for PR authors

- [ ] Studio preview (`/studio/preview`) loads, font switcher works, no durable cache.
- [ ] Codex adapter CORS allows `Origin: https://deploy-preview-…--osaii-codex-adapter.netlify.app`.
- [ ] Netlify Deploy Preview URL is `noindex` and `no-store` for `/studio/preview/*`.
- [ ] SPA deep link `/studio/preview/a?font=Geist` does not 404.
- [ ] Production still caches `/` and `/docs` durably (check `Netlify-CDN-Cache-Control: durable`).

