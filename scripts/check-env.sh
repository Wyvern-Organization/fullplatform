#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="${1:-$ROOT/.dev.vars}"
EXAMPLE="$ROOT/.dev.vars.example"

if [[ -t 1 ]]; then
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"
  CYAN="$(printf '\033[36m')"; DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
else
  GREEN=""; YELLOW=""; RED=""; CYAN=""; DIM=""; RESET=""
fi
ok()   { echo "${GREEN}✔${RESET} $*"; }
warn() { echo "${YELLOW}▲${RESET} $*"; }
err()  { echo "${RED}✘${RESET} $*"; }
info() { echo "${CYAN}→${RESET} $*"; }

echo "${CYAN}━━━ env check ${DIM}(${FILE})${RESET}${CYAN} ━━━${RESET}"

if [[ ! -f "$FILE" ]]; then
  warn "missing $FILE — copy from $EXAMPLE"
  [[ -f "$EXAMPLE" ]] && echo "  cp .dev.vars.example .dev.vars"
  exit 1
fi

# required keys — at least one poolside spelling must be present
REQUIRED=("INVITE_SECRET" "GROQ_API_KEY")
POOL_OK=false
if grep -qE '^(POOLSIDE_API_KEY|POOOLSIDE_API_KEY)=' "$FILE"; then
  # check at least one has a non-empty value
  if grep -qE '^POOLSIDE_API_KEY=.+' "$FILE" || grep -qE '^POOOLSIDE_API_KEY=.+' "$FILE"; then
    POOL_OK=true
  fi
fi

OPTIONAL=("LOGFARE_API_KEY" "POLLINATIONS_API_KEY" "CLOUDFLARE_API_TOKEN" "MASQUE_ADMIN_EMAILS")

MISSING=0
for key in "${REQUIRED[@]}"; do
  if grep -qE "^${key}=.+" "$FILE"; then
    ok "$key set"
  else
    err "$key empty or missing in $FILE"
    MISSING=$((MISSING+1))
  fi
done

if [[ "$POOL_OK" == true ]]; then
  if grep -qE '^POOLSIDE_API_KEY=.+' "$FILE"; then ok "POOLSIDE_API_KEY set (canonical)"; fi
  if grep -qE '^POOOLSIDE_API_KEY=.+' "$FILE"; then ok "POOOLSIDE_API_KEY set (legacy alias)"; fi
  if grep -qE '^POOLSIDE_API_KEY=.+' "$FILE" && grep -qE '^POOOLSIDE_API_KEY=.+' "$FILE"; then
    warn "both POOLSIDE and POOOLSIDE set — legacy POOOLSIDE_API_KEY wins at runtime"
  fi
else
  err "POOLSIDE_API_KEY / POOOLSIDE_API_KEY — at least one must be set"
  echo "  ${DIM}tip: canonical is POOLSIDE_API_KEY (2 O's); legacy POOOLSIDE_API_KEY (3 O's) still works${RESET}"
  MISSING=$((MISSING+1))
fi

for key in "${OPTIONAL[@]}"; do
  if grep -qE "^${key}=.+" "$FILE"; then
    ok "$key set (optional)"
  else
    warn "$key not set (optional — some surfaces degrade gracefully)"
  fi
done

# sanity: MASQUE_ADMIN_EMAILS format
if grep -qE '^MASQUE_ADMIN_EMAILS=.+' "$FILE"; then
  VAL="$(grep -E '^MASQUE_ADMIN_EMAILS=' "$FILE" | cut -d= -f2-)"
  if [[ "$VAL" == *","* ]] || [[ "$VAL" == *"@"* ]]; then ok "MASQUE_ADMIN_EMAILS looks plausible"
  else warn "MASQUE_ADMIN_EMAILS should be comma-separated emails"; fi
fi

# check for .dev.vars vs .env drift
if [[ -f "$ROOT/.env.example" && -f "$ROOT/.dev.vars.example" ]]; then
  if ! diff -q <(grep -E '^[A-Z_]+=' "$ROOT/.env.example" | cut -d= -f1 | sort) <(grep -E '^[A-Z_]+=' "$ROOT/.dev.vars.example" | cut -d= -f1 | sort) >/dev/null 2>&1; then
    warn ".env.example and .dev.vars.example keys differ — run: diff .env.example .dev.vars.example"
  else
    ok ".env.example ↔ .dev.vars.example keys consistent"
  fi
fi

echo ""
if [[ $MISSING -eq 0 ]]; then
  ok "env check passed"
  exit 0
else
  err "env check: $MISSING required key(s) missing — edit $FILE"
  exit 1
fi
