#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

FAIL=0
TOTAL=0
run() {
  local label="$1"; shift
  TOTAL=$((TOTAL+1))
  echo ""
  info "━━━ $label ━━━  ${DIM}$*${RESET}"
  if "$@"; then ok "$label passed"
  else err "$label FAILED"; FAIL=$((FAIL+1)); fi
}

echo "${CYAN}━━━ test:all — Worker + Cosaii + MythOS ━━━${RESET}"

run "node contract tests" node --test tests/*.test.mjs

if command -v cargo >/dev/null 2>&1 && [[ -f cosaii/Cargo.toml ]]; then
  run "cargo test" cargo test --manifest-path cosaii/Cargo.toml
else
  warn "cargo test skipped (no cargo or cosaii/Cargo.toml)"
fi

if [[ -d MythOS ]]; then
  if command -v python3 >/dev/null 2>&1; then
    if python3 -m pytest --version >/dev/null 2>&1; then
      run "MythOS pytest" bash -c 'cd MythOS && python3 -m pytest -q'
    else
      warn "MythOS pytest skipped (pytest not installed) — pip install pytest"
    fi
  else
    warn "MythOS pytest skipped (no python3)"
  fi
fi

if command -v npx >/dev/null 2>&1; then
  run "typecheck" npx tsc --noEmit
else
  warn "typecheck skipped (no npx)"
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  ok "test:all — $TOTAL suite(s) passed"
  exit 0
else
  err "test:all — $FAIL/$TOTAL suite(s) failed"
  exit 1
fi
