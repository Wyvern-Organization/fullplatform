export function fullplatformShellInstaller(): string {
  return `#!/usr/bin/env bash
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
  GREEN="$(printf '\\033[32m')"; YELLOW="$(printf '\\033[33m')"; RED="$(printf '\\033[31m')"
  CYAN="$(printf '\\033[36m')"; DIM="$(printf '\\033[2m')"; RESET="$(printf '\\033[0m')"
else
  GREEN=""; YELLOW=""; RED=""; CYAN=""; DIM=""; RESET=""
fi
ok()   { echo "\${GREEN}✔\${RESET} $*"; }
warn() { echo "\${YELLOW}▲\${RESET} $*"; }
err()  { echo "\${RED}✘\${RESET} $*" >&2; }
info() { echo "\${CYAN}→\${RESET} $*"; }

echo "\${CYAN}━━━ OSAII Full Platform — installer ━━━\${RESET}"

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
  NODE_V="$(node -v | sed 's/^v//')" ; MAJOR="\${NODE_V%%.*}"
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
  echo "Would clone/update → \${TARGET_DIR:-$DEFAULT_DIR or current dir if already a repo}"
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
  ok "created .dev.vars — \${YELLOW}edit it before 'npm run dev'\${RESET}"
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
echo "\${GREEN}━━━ installed ━━━\${RESET}"
echo "  dir:  \${CYAN}$ROOT\${RESET}"
echo ""
echo "  next:"
echo "    \${DIM}1)\${RESET} edit  \${CYAN}.dev.vars\${RESET}  (set INVITE_SECRET and POOLSIDE_API_KEY or POOOLSIDE_API_KEY)"
echo "    \${DIM}2)\${RESET} run   \${CYAN}npm run dev\${RESET}             — Worker http://localhost:8787"
echo "    \${DIM}3)\${RESET} test  \${CYAN}npm test\${RESET}                — contract tests"
echo "    \${DIM}4)\${RESET} all   \${CYAN}npm run test:all\${RESET}        — Worker + Rust + MythOS"
echo "    \${DIM}5)\${RESET} db    \${CYAN}npm run db:migrate:local\${RESET} — local D1 migrations"
echo "    \${DIM}6)\${RESET} build \${CYAN}npm run build\${RESET}           — wrangler deploy --dry-run"
echo ""
echo "  docs: \${DIM}CONTRIBUTING.md  README.md  AGENTS.md\${RESET}"
ok "done — welcome to OSAII"
`;
}

export function fullplatformPowerShellInstaller(): string {
  return `# OSAII Full Platform — Windows installer (PowerShell)
#
# Remote:  irm https://osaii.wyvernhub.net/install/fullplatform.ps1 | iex
# Local:   powershell -ExecutionPolicy Bypass -File install.ps1
#          powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
#
# Idempotent: safe to re-run.

param(
  [switch]$DryRun,
  [switch]$UseSsh,
  [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/osai-initiative/openplatform.git"
$RepoSsh = "git@github.com:osai-initiative/openplatform.git"
$DefaultDir = "fullplatform"

function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[..] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[!!] $m" -ForegroundColor Red }
function Info($m) { Write-Host "[->] $m" -ForegroundColor Cyan }

Write-Host "━━━ OSAII Full Platform — installer (Windows) ━━━" -ForegroundColor Cyan
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Info "OS: Windows  Arch: $arch"

$missing = 0
try { $v = (node --version 2>$null).Trim(); $major = [int]($v.TrimStart('v').Split('.')[0]); if ($major -ge 20) { Ok "node $v (>=20)" } else { Err "node $v too old — need >=20"; $missing++ } } catch { Err "node >=20 missing — https://nodejs.org"; $missing++ }
try { $v = (npm --version 2>$null).Trim(); Ok "npm $v" } catch { Err "npm missing"; $missing++ }
try { $v = (git --version 2>$null).Trim(); Ok $v } catch { Err "git missing — https://git-scm.com"; $missing++ }

try { $v = (cargo --version 2>$null).Trim(); Ok $v } catch { Warn "cargo missing — Cosaii Rust builds skipped (https://rustup.rs)" }
try { $v = (bun --version 2>$null).Trim(); Ok "bun $v" } catch { Warn "bun missing — Cosaii client builds skipped (https://bun.sh)" }
try { $v = (docker --version 2>$null).Trim(); Ok $v } catch { Warn "docker missing — MythOS image builds skipped" }
try { $v = (python --version 2>$null).Trim(); Ok $v } catch { Warn "python missing — MythOS tests skipped" }

if ($DryRun) {
  Info "--DryRun: tool check complete"
  if ($missing -ne 0) { Err "--DryRun: $missing required tool(s) missing"; exit 1 }
  Write-Host "Would clone/update -> $($TargetDir ? $TargetDir : $DefaultDir) or current dir if already a repo"
  Write-Host "Would run         -> npm ci ; copy .dev.vars.example .dev.vars ; wrangler d1 migrations (dry-run)"
  Ok "--DryRun ok"
  exit 0
}
if ($missing -ne 0) { Err "Fix required tools above, then re-run"; exit 1 }

# locate repo
$root = $null
if ((Test-Path "package.json") -and (Test-Path "wrangler.jsonc")) {
  try {
    $pkg = Get-Content "package.json" -Raw
    if ($pkg -match '"name"\\s*:\\s*"osaii-worker"') { $root = (Get-Location).Path; Info "using current directory as repo root: $root" }
  } catch {}
}
if (-not $root) {
  if (-not $TargetDir) { $TargetDir = $DefaultDir }
  $remote = $RepoUrl; if ($UseSsh) { $remote = $RepoSsh }
  if (Test-Path "$TargetDir/.git") {
    Info "updating existing checkout: $TargetDir"
    try { git -C $TargetDir pull --ff-only } catch { Warn "git pull failed — continuing" }
    $root = (Resolve-Path $TargetDir).Path
  } elseif (Test-Path $TargetDir) {
    Err "target '$TargetDir' exists and is not a git repo"; exit 1
  } else {
    Info "cloning $remote -> $TargetDir"
    git clone $remote $TargetDir
    $root = (Resolve-Path $TargetDir).Path
  }
  Set-Location $root
}
Info "repo root: $root"

# npm install
if (Test-Path "package-lock.json") {
  Info "npm ci…"
  try { npm ci } catch { npm install }
} else {
  Info "npm install…"
  npm install
}
Ok "npm dependencies installed"

# .dev.vars
if (-not (Test-Path ".dev.vars")) {
  Copy-Item ".dev.vars.example" ".dev.vars"
  Ok "created .dev.vars — edit it before 'npm run dev'"
} else {
  Ok ".dev.vars exists"
}

# env check (via bash if available, else simple)
if (Test-Path "scripts/check-env.sh") {
  try { bash scripts/check-env.sh } catch { Warn "bash not available — skipping env check; edit .dev.vars manually" }
}

# wrangler dry-run
try {
  $null = npx --yes wrangler --version 2>$null
  Info "wrangler d1 migrations (dry-run)…"
  try { npx wrangler d1 migrations apply osaii --dry-run --config wrangler.jsonc } catch { Warn "D1 dry-run skipped (no credentials)" }
} catch {}

Write-Host ""
Write-Host "━━━ installed ━━━" -ForegroundColor Green
Write-Host "  dir: $root" -ForegroundColor Cyan
Write-Host ""
Write-Host "  next:"
Write-Host "    1) edit  .dev.vars  (set INVITE_SECRET and POOLSIDE_API_KEY or POOOLSIDE_API_KEY)"
Write-Host "    2) run   npm run dev              — Worker http://localhost:8787"
Write-Host "    3) test  npm test                 — contract tests"
Write-Host "    4) all   npm run test:all         — Worker + Rust + MythOS"
Write-Host "    5) db    npm run db:migrate:local — local D1 migrations"
Write-Host "    6) build npm run build            — wrangler deploy --dry-run"
Write-Host ""
Write-Host "  docs: CONTRIBUTING.md  README.md  AGENTS.md"
Ok "done — welcome to OSAII"
`;
}
