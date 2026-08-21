#!/usr/bin/env bash
set -euo pipefail

# Full Platform setup — idempotent
# Usage: bash scripts/setup.sh  [--check-only]  [--skip-install]

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# colors
if [[ -t 1 ]]; then
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"
  CYAN="$(printf '\033[36m')"; DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
else
  GREEN=""; YELLOW=""; RED=""; CYAN=""; DIM=""; RESET=""
fi
ok()   { echo "${GREEN}✔${RESET} $*"; }
warn() { echo "${YELLOW}▲${RESET} $*"; }
err()  { echo "${RED}✘${RESET} $*" >&2; }
info() { echo "${CYAN}→${RESET} $*"; }

SKIP_INSTALL=false
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=true ;;
    --check-only)   CHECK_ONLY=true ;;
    --help|-h) echo "Usage: bash scripts/setup.sh [--skip-install] [--check-only]"; exit 0 ;;
  esac
done

echo "${CYAN}━━━ OSAII Full Platform — setup ━━━${RESET}"

# ——— checks ———
MISSING=0
need() {
  local bin="$1" label="$2" hint="$3"
  if command -v "$bin" >/dev/null 2>&1; then ok "$label $( $bin --version 2>&1 | head -n1 | tr -d '\n')";
  else err "missing $label — $hint"; MISSING=$((MISSING+1)); fi
}

# node >= 20
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v | sed 's/^v//')"
  MAJOR="${NODE_V%%.*}"
  if [[ "$MAJOR" -ge 20 ]]; then ok "node $NODE_V"
  else err "node $NODE_V too old (need >=20) — https://nodejs.org"; MISSING=$((MISSING+1)); fi
else err "missing node >=20 — https://nodejs.org"; MISSING=$((MISSING+1)); fi

need npm "npm" "install node 20+"
command -v cargo >/dev/null 2>&1 && ok "cargo $(cargo --version | awk '{print $2}')" || warn "cargo not found — Cosaii Rust builds will be skipped (https://rustup.rs)"
command -v bun   >/dev/null 2>&1 && ok "bun $(bun --version)" || warn "bun not found — Cosaii client builds will be skipped (https://bun.sh)"
command -v docker >/dev/null 2>&1 && ok "docker $(docker --version 2>&1 | head -n1)" || warn "docker not found — MythOS image builds will be skipped"
command -v python3 >/dev/null 2>&1 && ok "python3 $(python3 --version 2>&1)" || warn "python3 not found — MythOS pytest will be skipped"
command -v npx >/dev/null 2>&1 || { err "npx missing"; MISSING=$((MISSING+1)); }

if [[ "$CHECK_ONLY" == true ]]; then
  bash scripts/check-env.sh || true
  [[ $MISSING -eq 0 ]] && ok "check-only: all required tools present" || err "check-only: $MISSING required tool(s) missing"
  exit $MISSING
fi

if [[ $MISSING -ne 0 ]]; then
  err "Fix the missing tools above, then re-run: bash scripts/setup.sh"
  exit 1
fi

# ——— npm install ———
if [[ "$SKIP_INSTALL" == false ]]; then
  if [[ -f package-lock.json ]]; then
    info "npm ci (locked)…"
    npm ci || npm install
  else
    info "npm install…"
    npm install
  fi
  ok "dependencies installed"
else
  info "--skip-install: npm ci skipped"
fi

# ——— .dev.vars ———
if [[ ! -f .dev.vars ]]; then
  if [[ -f .dev.vars.example ]]; then
    cp .dev.vars.example .dev.vars
    ok "created .dev.vars from .dev.vars.example — fill in secrets"
  else
    warn ".dev.vars.example missing — creating empty .dev.vars"
    : > .dev.vars
  fi
else
  ok ".dev.vars exists"
fi
# warn if still empty placeholders
if grep -qE '^\w+=$' .dev.vars 2>/dev/null; then
  warn ".dev.vars still contains empty values — edit it before 'npm run dev'"
fi

# ——— .env helper ———
if [[ ! -f .env && -f .env.example ]]; then
  info "tip: cp .env.example .env  (optional — Worker dev uses .dev.vars)"
fi

# ——— env validation ———
bash scripts/check-env.sh || true

# ——— db migrate (dry) ———
if npx --yes wrangler --version >/dev/null 2>&1; then
  info "wrangler d1 migrations (dry-run)…"
  npx wrangler d1 migrations apply osaii --dry-run --config wrangler.jsonc 2>&1 | tail -n 20 || warn "dry-run skipped (no D1 credentials — expected locally)"
else
  warn "wrangler not found — skipping db:migrate dry-run"
fi

echo ""
echo "${GREEN}━━━ next steps ━━━${RESET}"
echo "  1) Edit ${CYAN}.dev.vars${RESET} and set at least INVITE_SECRET / POOLSIDE_API_KEY (or POOOLSIDE_API_KEY)"
echo "  2) ${CYAN}npm run dev${RESET}            — Worker on :8787"
echo "  3) ${CYAN}npm run dev:studio${RESET}     — Worker on :8788"
echo "  4) ${CYAN}npm test${RESET}               — contract tests"
echo "  5) ${CYAN}npm run db:migrate:local${RESET} — apply D1 migrations locally"
echo "  6) ${CYAN}npm run build${RESET}          — wrangler deploy --dry-run"
echo ""
ok "setup complete"
