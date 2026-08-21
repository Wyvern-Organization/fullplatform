#!/usr/bin/env bash
set -euo pipefail

# OSAII Full Platform — single-line installer
#
# Remote:  curl -fsSL https://osaii.wyvernhub.net/install/fullplatform.sh | bash
#          curl -fsSL https://osaii.wyvernhub.net/install/fullplatform.sh | bash -s -- --dry-run
# Local:   bash install.sh
#          bash install.sh --dry-run
# npm:     npm run setup
#
# Idempotent: safe to re-run. Clones if missing, pulls if present.

REPO_URL="https://github.com/osai-initiative/openplatform.git"
REPO_SSH="git@github.com:osai-initiative/openplatform.git"
DEFAULT_DIR="fullplatform"
DRY_RUN=false
USE_SSH=false
TARGET_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --ssh)     USE_SSH=true ;;
    --help|-h)
      echo "Usage: bash install.sh [--dry-run] [--ssh] [target-dir]"
      echo "  --dry-run   validate tools & print next steps without cloning/installing"
      echo "  --ssh       use SSH remote instead of HTTPS"
      echo "  target-dir  directory to clone into (default: ./fullplatform or current repo)"
      exit 0 ;;
    --*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *)   TARGET_DIR="$arg" ;;
  esac
done

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

echo "${CYAN}━━━ OSAII Full Platform — installer ━━━${RESET}"

OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
info "OS: $OS  Arch: $ARCH"

case "$OS-$ARCH" in
  Linux-x86_64|Linux-aarch64|Linux-arm64|Darwin-x86_64|Darwin-arm64) ok "platform supported" ;;
  *) warn "unsupported platform $OS-$ARCH — continuing anyway" ;;
esac

# ——— tool checks ———
MISSING=0
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v | sed 's/^v//')" ; MAJOR="${NODE_V%%.*}"
  if [[ "$MAJOR" -ge 20 ]]; then ok "node $NODE_V (≥20)"
  else err "node $NODE_V too old — need ≥20  https://nodejs.org"; MISSING=$((MISSING+1)); fi
else err "node ≥20 missing — https://nodejs.org"; MISSING=$((MISSING+1)); fi

command -v npm >/dev/null 2>&1 && ok "npm $(npm --version)" || { err "npm missing"; MISSING=$((MISSING+1)); }
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || { err "git missing"; MISSING=$((MISSING+1)); }

command -v cargo >/dev/null 2>&1 && ok "cargo $(cargo --version | awk '{print $2}')" || warn "cargo missing — Cosaii Rust builds skipped (https://rustup.rs)"
command -v bun   >/dev/null 2>&1 && ok "bun $(bun --version)" || warn "bun missing — Cosaii client builds skipped (https://bun.sh)"
command -v docker >/dev/null 2>&1 && ok "docker $(docker --version 2>&1 | head -n1)" || warn "docker missing — MythOS image builds skipped"
command -v python3 >/dev/null 2>&1 && ok "python3 $(python3 --version 2>&1 | awk '{print $2}')" || warn "python3 missing — MythOS tests skipped"

if [[ "$DRY_RUN" == true ]]; then
  info "--dry-run: tool check complete"
  if [[ $MISSING -ne 0 ]]; then err "--dry-run: $MISSING required tool(s) missing"; exit 1; fi
  echo ""
  echo "Would clone/update → ${TARGET_DIR:-$DEFAULT_DIR or current dir if already a repo}"
  echo "Would run       → npm ci && cp .dev.vars.example .dev.vars && wrangler d1 migrations (dry-run)"
  ok "--dry-run ok"
  exit 0
fi

if [[ $MISSING -ne 0 ]]; then err "Fix required tools above, then re-run"; exit 1; fi

# ——— locate repo ———
# If we're already inside a fullplatform checkout, just use it.
if [[ -f package.json ]] && grep -q '"name": "osaii-worker"' package.json 2>/dev/null && [[ -f wrangler.jsonc ]]; then
  ROOT="$(pwd)"
  info "using current directory as repo root: $ROOT"
else
  # otherwise clone or update TARGET_DIR
  if [[ -z "$TARGET_DIR" ]]; then TARGET_DIR="$DEFAULT_DIR"; fi
  REMOTE="$REPO_URL"; [[ "$USE_SSH" == true ]] && REMOTE="$REPO_SSH"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "updating existing checkout: $TARGET_DIR"
    git -C "$TARGET_DIR" pull --ff-only || warn "git pull failed — continuing with existing checkout"
    ROOT="$(cd -- "$TARGET_DIR" && pwd)"
  elif [[ -e "$TARGET_DIR" ]]; then
    err "target '$TARGET_DIR' exists and is not a git repo — remove it or pick another dir"
    exit 1
  else
    info "cloning $REMOTE → $TARGET_DIR"
    git clone "$REMOTE" "$TARGET_DIR"
    ROOT="$(cd -- "$TARGET_DIR" && pwd)"
  fi
  cd "$ROOT"
fi

info "repo root: $ROOT"

# ——— install deps ———
if [[ -f package-lock.json ]]; then
  info "npm ci…"
  npm ci || npm install
else
  info "npm install…"
  npm install
fi
ok "npm dependencies installed"

# ——— .dev.vars ———
if [[ ! -f .dev.vars ]]; then
  cp .dev.vars.example .dev.vars
  ok "created .dev.vars — ${YELLOW}edit it before 'npm run dev'${RESET}"
else
  ok ".dev.vars exists"
fi

# ——— env check ———
if [[ -x scripts/check-env.sh ]]; then
  bash scripts/check-env.sh || true
elif [[ -f scripts/check-env.sh ]]; then
  bash scripts/check-env.sh || true
fi

# ——— wrangler types / dry-run ———
if command -v npx >/dev/null 2>&1; then
  if npx --yes wrangler --version >/dev/null 2>&1; then
    info "wrangler d1 migrations (dry-run)…"
    npx wrangler d1 migrations apply osaii --dry-run --config wrangler.jsonc 2>&1 | tail -n 20 || warn "D1 dry-run skipped (no credentials — expected locally)"
    # optional: regenerate types if wrangler types is available
    # npx wrangler types --config wrangler.jsonc 2>&1 | tail -n 5 || true
  fi
fi

# ——— cargo / bun hints ———
if [[ -f cosaii/Cargo.toml ]] && command -v cargo >/dev/null 2>&1; then
  info "tip: npm run cosaii:check  — validates Rust workspace + TS client"
fi

echo ""
echo "${GREEN}━━━ installed ━━━${RESET}"
echo "  dir:  ${CYAN}$ROOT${RESET}"
echo ""
echo "  next:"
echo "    ${DIM}1)${RESET} edit  ${CYAN}.dev.vars${RESET}  (set INVITE_SECRET and POOLSIDE_API_KEY or POOOLSIDE_API_KEY)"
echo "    ${DIM}2)${RESET} run   ${CYAN}npm run dev${RESET}             — Worker http://localhost:8787"
echo "    ${DIM}3)${RESET} test  ${CYAN}npm test${RESET}                — contract tests"
echo "    ${DIM}4)${RESET} all   ${CYAN}npm run test:all${RESET}        — Worker + Rust + MythOS"
echo "    ${DIM}5)${RESET} db    ${CYAN}npm run db:migrate:local${RESET} — local D1 migrations"
echo "    ${DIM}6)${RESET} build ${CYAN}npm run build${RESET}           — wrangler deploy --dry-run"
echo ""
echo "  docs: ${DIM}CONTRIBUTING.md  README.md  AGENTS.md${RESET}"
ok "done — welcome to OSAII"
