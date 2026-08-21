export function mythosShellInstaller(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# MythOS — single-line installer (served from https://osaii.wyvernhub.net/install/mythos.sh)
#
#   curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash
#   curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- --dry-run
#   curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- --iso --yes
#
# Local copy lives at MythOS/install.sh in the openplatform repo.

REPO_URL="https://github.com/osai-initiative/openplatform.git"
REPO_SSH="git@github.com:osai-initiative/openplatform.git"
DEFAULT_DIR="MythOS-work"
RELEASE_JSON="https://osaii.wyvernhub.net/mythos/release.json"

DRY_RUN=false
USE_SSH=false
DO_ISO=false
DO_DEV=false
ASSUME_YES=false
TARGET_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --ssh)     USE_SSH=true ;;
    --iso)     DO_ISO=true ;;
    --dev)     DO_DEV=true ;;
    --yes|-y)  ASSUME_YES=true ;;
    --help|-h)
      cat <<'EOS'
MythOS installer — installs MythOS build deps and prepares a build checkout.

Usage:
  curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash
  curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- [opts] [target-dir]

Options:
  --dry-run   Validate system and print what would be done
  --iso       Also build package + ISO guidance (needs Docker + 25 GiB tmp)
  --dev       Create/refresh Python venv at MythOS/.venv
  --yes       Non-interactive
  --ssh       Use SSH remote when cloning
  --help      Show this help

Docs: MythOS/README.md  https://osaii.wyvernhub.net/mythos  https://osaii.wyvernhub.net/mythos/release.json
EOS
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
die()  { err "$*"; exit 1; }

echo "\${CYAN}━━━ MythOS — single-line installer ━━━\${RESET}"

OS_ID="unknown"; OS_VER="unknown"; OS_PRETTY="unknown"
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release || true
  OS_ID="\${ID:-unknown}"
  OS_VER="\${VERSION_ID:-unknown}"
  OS_PRETTY="\${PRETTY_NAME:-$OS_ID $OS_VER}"
elif [[ "$UNAME_S" == "Darwin" ]]; then
  OS_ID="macos"
  OS_VER="$(sw_vers -productVersion 2>/dev/null || uname -r 2>/dev/null || echo unknown)"
  OS_PRETTY="macOS \${OS_VER}"
else
  OS_PRETTY="\${UNAME_S} $(uname -r 2>/dev/null || echo unknown)"
fi
ARCH="$(uname -m 2>/dev/null || echo unknown)"
info "System: \${OS_PRETTY}  arch: \${ARCH}"

supports_apt=false
case "$OS_ID" in
  debian|ubuntu|mythos|linuxmint|pop) supports_apt=true ;;
esac

is_mythos_checkout=false
resolve_mythos_root() {
  local dir="$1"
  if [[ -f "$dir/VERSION" && -f "$dir/pyproject.toml" && -f "$dir/Makefile" && -d "$dir/src/mythos" ]]; then echo "$dir"; return 0; fi
  if [[ -f "$dir/MythOS/VERSION" && -f "$dir/MythOS/pyproject.toml" ]]; then echo "$dir/MythOS"; return 0; fi
  return 1
}

MYTHOS_ROOT=""
if MYTHOS_ROOT="$(resolve_mythos_root "$(pwd)" 2>/dev/null)"; then
  is_mythos_checkout=true
  info "Using existing checkout: \${MYTHOS_ROOT}"
fi

if [[ "$DRY_RUN" == true ]]; then info "--dry-run: no changes will be made"; fi

info "Checking tools…"
have_python=false; have_git=false; have_make=false; have_docker=false
if command -v python3 >/dev/null 2>&1; then
  have_python=true
  PY_VER="$(python3 --version 2>&1 | awk '{print $2}')"
  if python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)'; then
    ok "python3 $PY_VER (≥3.11)"
  else
    warn "python3 $PY_VER too old — MythOS requires ≥3.11"
  fi
else err "python3 missing — required for validate"; fi
command -v git >/dev/null 2>&1 && { have_git=true; ok "git $(git --version | awk '{print $3}')"; } || err "git missing"
command -v make >/dev/null 2>&1 && { have_make=true; ok "make $(make --version 2>&1 | head -n1)"; } || err "make missing"
command -v docker >/dev/null 2>&1 && { have_docker=true; ok "docker $(docker --version 2>&1 | head -n1)"; } || warn "docker missing — ISO builds will be skipped"

if [[ "$supports_apt" == true ]]; then ok "apt-based distro detected ($OS_ID)"; else
  if [[ "$OS_ID" == "macos" ]]; then warn "macOS detected — apt install skipped; Python validate still works, but full ISO builds need Debian 13 (use Docker Desktop + Debian container or a VM)"; elif [[ "$UNAME_S" == "MINGW"* || "$UNAME_S" == "MSYS"* || "$UNAME_S" == "CYGWIN"* ]]; then warn "Windows detected — use WSL2 Debian 13: wsl --install -d Debian && wsl -d Debian -- bash -c 'curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash'"; else warn "Not Debian/Ubuntu ($OS_ID) — apt install will be skipped"; fi; fi

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  info "Would do: apt deps (if Debian/Ubuntu) → clone/update → make quick/validate → print ISO steps"
  echo "  curl -fsSL $RELEASE_JSON | python3 -m json.tool"
  ok "--dry-run ok — re-run without --dry-run to execute"
  exit 0
fi

# Install apt deps on Debian/Ubuntu
if [[ "$supports_apt" == true ]]; then
  need_apt=false
  for bin in python3 make git; do command -v "$bin" >/dev/null 2>&1 || need_apt=true; done
  if [[ "$need_apt" == true || "$DO_DEV" == true ]]; then
    if command -v sudo >/dev/null 2>&1 && [[ "\${EUID:-\$(id -u)}" -ne 0 ]]; then SUDO="sudo"; elif [[ "\${EUID:-\$(id -u)}" -eq 0 ]]; then SUDO=""; else SUDO=""; warn "sudo not available — skipping apt install"; fi
    if [[ -n "\${SUDO:-}" ]] || [[ "\${EUID:-\$(id -u)}" -eq 0 ]]; then
      deps=(git make python3 python3-venv python3-pip ca-certificates curl shellcheck)
      if [[ "$DO_ISO" == true ]]; then deps+=(docker.io qemu-system-x86 ovmf); fi
      info "Installing host deps: \${deps[*]}"
      set +e
      \$SUDO apt-get update; rc=$?
      set -e
      if [[ \$rc -ne 0 ]]; then warn "apt-get update failed — continuing"; else
        if [[ "$ASSUME_YES" == true ]]; then \$SUDO apt-get install -y "\${deps[@]}" || warn "apt install failed"; else \$SUDO apt-get install "\${deps[@]}" || warn "apt install cancelled"; fi
      fi
      command -v docker >/dev/null 2>&1 && have_docker=true
    fi
  fi
fi

if [[ "$is_mythos_checkout" == false ]]; then
  if [[ -z "$TARGET_DIR" ]]; then TARGET_DIR="$DEFAULT_DIR"; fi
  REMOTE="$REPO_URL"; [[ "$USE_SSH" == true ]] && REMOTE="$REPO_SSH"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "Updating existing checkout: $TARGET_DIR"
    git -C "$TARGET_DIR" pull --ff-only || warn "git pull failed"
    if MYTHOS_ROOT="$(resolve_mythos_root "$TARGET_DIR" 2>/dev/null)"; then :; elif [[ -d "$TARGET_DIR/MythOS" ]]; then MYTHOS_ROOT="$TARGET_DIR/MythOS"; else MYTHOS_ROOT="$TARGET_DIR"; fi
  elif [[ -e "$TARGET_DIR" ]]; then die "target '$TARGET_DIR' exists and is not a git repo"; else
    info "Cloning $REMOTE → $TARGET_DIR"
    git clone "$REMOTE" "$TARGET_DIR"
    if MYTHOS_ROOT="$(resolve_mythos_root "$TARGET_DIR" 2>/dev/null)"; then :; elif [[ -d "$TARGET_DIR/MythOS" ]]; then MYTHOS_ROOT="$TARGET_DIR/MythOS"; else MYTHOS_ROOT="$TARGET_DIR"; fi
  fi
fi
if [[ -f "$MYTHOS_ROOT/MythOS/VERSION" ]]; then MYTHOS_ROOT="$MYTHOS_ROOT/MythOS"; fi
if [[ ! -f "$MYTHOS_ROOT/VERSION" ]]; then die "MythOS checkout not found at $MYTHOS_ROOT"; fi
cd "$MYTHOS_ROOT"
info "Working in: $(pwd)"
if [[ -f VERSION ]]; then ok "MythOS version $(tr -d '[:space:]' < VERSION)"; fi

if [[ "$DO_DEV" == true ]]; then
  info "Setting up Python venv at .venv…"
  [[ -d .venv ]] || python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate || true
  pip install --upgrade pip setuptools 2>&1 | tail -n 5 || true
  pip install -e ".[dev]" 2>&1 | tail -n 20 || pip install -e . 2>&1 | tail -n 20 || warn "pip install failed"
  ok "venv ready (.venv)"
fi

echo ""
info "Running MythOS validation…"
run_make() { local t="$1"; info "make $t"; if make "$t"; then ok "make $t passed"; return 0; else err "make $t failed"; return 1; fi; }
VALIDATE_RC=0
if [[ "$DO_ISO" == true ]]; then
  run_make validate || VALIDATE_RC=$?
  if [[ \$VALIDATE_RC -eq 0 && "$have_docker" == true ]]; then run_make package || warn "make package failed"; fi
  echo ""; info "ISO: make iso (Docker + 25 GiB tmp + network) → .build/artifacts/mythos-*-amd64.iso"
else
  if grep -q "^quick:" Makefile 2>/dev/null; then run_make quick || VALIDATE_RC=$?; else run_make validate || VALIDATE_RC=$?; fi
fi
if [[ \$VALIDATE_RC -ne 0 ]]; then err "Validation failed — cd $MYTHOS_ROOT && make validate"; exit \$VALIDATE_RC; fi
echo ""
ok "MythOS checkout ready at \${CYAN}$MYTHOS_ROOT\${RESET}"
echo ""
echo "\${GREEN}━━━ next steps ━━━\${RESET}"
echo "  make quick    — fast validate (no ISO)"
echo "  make validate — full project validation"
echo "  make package  — Debian package (needs Docker)"
echo "  make iso      — hybrid live ISO (Docker + 25 GiB tmp)"
echo "  make smoke    — UEFI boot smoke test (QEMU)"
echo "  mythosctl doctor / python3 -m mythos.cli doctor"
echo "  curl -fsSL $RELEASE_JSON | python3 -m json.tool"
echo ""
ok "done — welcome to MythOS"
`;
}

export function mythosPowerShellInstaller(): string {
  return `# MythOS — Windows installer (PowerShell, best-effort: WSL2 + Docker Desktop recommended)
#
#   irm https://osaii.wyvernhub.net/install/mythos.ps1 | iex
#
# MythOS ISO builds require Debian + Docker. On Windows the recommended path is
# WSL2 (Debian 13) with Docker Desktop. This script validates tools and clones
# the repo; ISO assembly itself runs inside Docker under WSL2.

param(
  [switch]$DryRun,
  [switch]$UseSsh,
  [switch]$Iso,
  [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/osai-initiative/openplatform.git"
$RepoSsh = "git@github.com:osai-initiative/openplatform.git"
$DefaultDir = "MythOS-work"
$ReleaseJson = "https://osaii.wyvernhub.net/mythos/release.json"

function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[..] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[!!] $m" -ForegroundColor Red }
function Info($m) { Write-Host "[->] $m" -ForegroundColor Cyan }

Write-Host "━━━ MythOS — installer (Windows) ━━━" -ForegroundColor Cyan
Info "For full ISO builds use WSL2 Debian 13 + Docker Desktop. This script clones and validates Python code where possible."
$missing = 0
try { $v = (python --version 2>$null).Trim(); Ok $v } catch { try { $v = (python3 --version 2>$null).Trim(); Ok $v } catch { Warn "python missing — MythOS pytest skipped" } }
try { $v = (git --version 2>$null).Trim(); Ok $v } catch { Err "git missing — https://git-scm.com"; $missing++ }
try { $v = (docker --version 2>$null).Trim(); Ok $v } catch { Warn "docker missing — ISO builds will be skipped" }
try { $v = (wsl --version 2>$null | Select-Object -First 1).Trim(); Ok "wsl $v" } catch { Warn "wsl missing — install WSL2 for ISO builds: wsl --install -d Debian" }

if ($DryRun) {
  Info "--DryRun: tool check complete"
  if ($missing -ne 0) { Err "--DryRun: $missing required tool(s) missing"; exit 1 }
  Write-Host "Would clone/update -> $($TargetDir ? $TargetDir : $DefaultDir)"
  Write-Host "  git clone $RepoUrl"
  Write-Host "  cd MythOS && python -m compileall -q src tests ; python -m pytest -q (if available)"
  if ($Iso) { Write-Host "  make iso needs Docker (WSL2 Debian)" }
  Ok "--DryRun ok"
  exit 0
}
if ($missing -ne 0) { Err "Fix required tools above, then re-run"; exit 1 }

$root = $null
if ((Test-Path "VERSION") -and (Test-Path "pyproject.toml") -and (Test-Path "src/mythos/cli.py")) {
  $root = (Get-Location).Path; Info "using current directory as MythOS root: $root"
} elseif ((Test-Path "MythOS/VERSION") -and (Test-Path "MythOS/pyproject.toml")) {
  $root = (Resolve-Path "MythOS").Path; Info "using MythOS subdir: $root"
}
if (-not $root) {
  if (-not $TargetDir) { $TargetDir = $DefaultDir }
  $remote = $RepoUrl; if ($UseSsh) { $remote = $RepoSsh }
  if (Test-Path "$TargetDir/.git") {
    Info "updating existing checkout: $TargetDir"
    try { git -C $TargetDir pull --ff-only } catch { Warn "git pull failed" }
    if (Test-Path "$TargetDir/MythOS/VERSION") { $root = (Resolve-Path "$TargetDir/MythOS").Path } else { $root = (Resolve-Path $TargetDir).Path }
  } elseif (Test-Path $TargetDir) {
    Err "target '$TargetDir' exists and is not a git repo"; exit 1
  } else {
    Info "cloning $remote -> $TargetDir"
    git clone $remote $TargetDir
    if (Test-Path "$TargetDir/MythOS/VERSION") { $root = (Resolve-Path "$TargetDir/MythOS").Path } else { $root = (Resolve-Path $TargetDir).Path }
  }
  Set-Location $root
  $root = (Get-Location).Path
}
Info "MythOS root: $root"
if (Test-Path "VERSION") { Ok "MythOS version $((Get-Content VERSION).Trim())" }

# Python compile check
try {
  python -m compileall -q src tests 2>&1 | Out-Null; Ok "python compile check passed"
} catch { try { python3 -m compileall -q src tests 2>&1 | Out-Null; Ok "python3 compile check passed" } catch { Warn "compile check skipped" } }

Write-Host ""
Write-Host "━━━ next steps ━━━" -ForegroundColor Green
Write-Host "  WSL2 Debian 13 (recommended for ISO):"
Write-Host "    wsl --install -d Debian"
Write-Host "    wsl -d Debian -- bash -c 'curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash'"
Write-Host ""
Write-Host "  Local Python (Windows):"
Write-Host "    python -m pytest -q"
Write-Host "    python -m mythos.cli doctor"
Write-Host ""
Write-Host "  Release metadata: $ReleaseJson"
Write-Host "  Docs: MythOS/README.md  docs/architecture.md"
Ok "done — welcome to MythOS"
`;
}
