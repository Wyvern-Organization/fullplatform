#!/usr/bin/env bash
set -euo pipefail

# MythOS — single-line installer
#
# Quick start (host):
#   curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash
#   curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- --dry-run
#
# Local:
#   bash MythOS/install.sh
#   bash MythOS/install.sh --help
#   bash MythOS/install.sh --dry-run
#   bash MythOS/install.sh --quick      # validate only (no ISO)
#   bash MythOS/install.sh --iso        # full validate + package + iso hints
#   bash MythOS/install.sh --yes --dev  # non-interactive + venv setup
#
# Idempotent: safe to re-run. Installs host deps (Debian/Ubuntu), clones/updates
# the repo, runs make validate/package or prints ISO production steps.

REPO_URL="https://github.com/osai-initiative/openplatform.git"
REPO_SSH="git@github.com:osai-initiative/openplatform.git"
DEFAULT_DIR="MythOS-work"
MYTHOS_SUBDIR="MythOS"
RELEASE_JSON="https://osaii.wyvernhub.net/mythos/release.json"
VERSION_FILE="VERSION"

# flags
DRY_RUN=false
USE_SSH=false
DO_ISO=false
DO_QUICK=true
DO_DEV=false
ASSUME_YES=false
TARGET_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --ssh)     USE_SSH=true ;;
    --iso)     DO_ISO=true; DO_QUICK=false ;;
    --quick)   DO_ISO=false; DO_QUICK=true ;;
    --dev)     DO_DEV=true ;;
    --yes|-y)  ASSUME_YES=true ;;
    --help|-h)
      cat <<'EOF'
MythOS installer — installs MythOS build deps and prepares a build checkout.

Usage:
  curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash
  curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash -s -- [opts] [target-dir]
  bash install.sh [opts] [target-dir]

Options:
  --dry-run   Validate system and print what would be done without changing anything.
  --iso       Also build package + ISO guidance (needs Docker + 25 GiB tmp)
  --quick     Only validate (default: compile, lint, unit tests)
  --dev       Create/refresh local Python venv at MythOS/.venv
  --yes       Non-interactive (assume yes for apt prompts where applicable)
  --ssh       Use SSH remote instead of HTTPS when cloning
  --help      Show this help
  target-dir  Directory to clone into (default: ./MythOS-work). If already inside
              a MythOS checkout, that directory is used and cloning is skipped.

What it does:
  1) Detects Debian/Ubuntu (others print guidance but still clone if possible)
  2) Installs build deps via apt (Debian/Ubuntu only, with sudo)
  3) Clones or updates the openplatform repo
  4) Runs 'make validate' or 'make quick' inside MythOS/
  5) Prints ISO/package next steps and MythOS release metadata URL

Requirements:
  - Debian 13 trixie (recommended) or Ubuntu 22.04+ / Debian 12 (best-effort)
  - Docker required only for ISO: make iso / make package / make smoke
  - ISO build needs ~25 GiB temp, network access to Debian mirrors

Release metadata:
  GET https://osaii.wyvernhub.net/mythos/release.json
EOF
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
die()  { err "$*"; exit 1; }

echo "${CYAN}━━━ MythOS — single-line installer ━━━${RESET}"

OS_ID="unknown"; OS_VER="unknown"; OS_PRETTY="unknown"
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release || true
  OS_ID="${ID:-unknown}"
  OS_VER="${VERSION_ID:-unknown}"
  OS_PRETTY="${PRETTY_NAME:-$OS_ID $OS_VER}"
elif [[ "$UNAME_S" == "Darwin" ]]; then
  OS_ID="macos"
  OS_VER="$(sw_vers -productVersion 2>/dev/null || uname -r 2>/dev/null || echo unknown)"
  OS_PRETTY="macOS ${OS_VER}"
else
  OS_PRETTY="${UNAME_S} $(uname -r 2>/dev/null || echo unknown)"
fi
ARCH="$(uname -m 2>/dev/null || echo unknown)"
info "System: ${OS_PRETTY}  arch: ${ARCH}"

supports_apt=false
case "$OS_ID" in
  debian|ubuntu|mythos|linuxmint|pop) supports_apt=true ;;
esac

is_mythos_checkout=false
# If we're already inside a MythOS checkout, use it.
resolve_mythos_root() {
  local dir="$1"
  if [[ -f "$dir/VERSION" && -f "$dir/pyproject.toml" && -f "$dir/Makefile" && -d "$dir/src/mythos" ]]; then
    echo "$dir"
    return 0
  fi
  # nested under fullplatform?
  if [[ -f "$dir/MythOS/VERSION" && -f "$dir/MythOS/pyproject.toml" ]]; then
    echo "$dir/MythOS"
    return 0
  fi
  return 1
}

MYTHOS_ROOT=""
if MYTHOS_ROOT="$(resolve_mythos_root "$(pwd)")"; then
  is_mythos_checkout=true
  info "Using existing checkout: ${MYTHOS_ROOT}"
elif [[ -n "$TARGET_DIR" ]] && MYTHOS_ROOT="$(resolve_mythos_root "$TARGET_DIR" 2>/dev/null)"; then
  is_mythos_checkout=true
  info "Using target checkout: ${MYTHOS_ROOT}"
else
  MYTHOS_ROOT=""
fi

if [[ "$DRY_RUN" == true ]]; then
  info "--dry-run: no changes will be made"
fi

# ——— dependency pre-check ———
info "Checking tools…"
have_python=false; have_pip=false; have_docker=false; have_git=false; have_make=false
if command -v python3 >/dev/null 2>&1; then
  have_python=true
  PY_VER="$(python3 --version 2>&1 | awk '{print $2}')"
  # need >=3.11
  if python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)'; then
    ok "python3 $PY_VER (≥3.11)"
  else
    warn "python3 $PY_VER too old — MythOS requires ≥3.11"
  fi
else
  err "python3 missing — required for validate/pytest (https://www.python.org)"
fi

command -v git >/dev/null 2>&1 && { have_git=true; ok "git $(git --version | awk '{print $3}')"; } || err "git missing — required to clone"
command -v make >/dev/null 2>&1 && { have_make=true; ok "make $(make --version 2>&1 | head -n1)"; } || err "make missing — required"
command -v docker >/dev/null 2>&1 && { have_docker=true; ok "docker $(docker --version 2>&1 | head -n1)"; } || warn "docker missing — ISO/package builds will be skipped (https://docs.docker.com/engine/install/)"
command -v shellcheck >/dev/null 2>&1 && ok "shellcheck $(shellcheck --version 2>&1 | head -n1)" || warn "shellcheck missing — lint-shell will skip shellcheck (apt install shellcheck)"

if [[ "$supports_apt" == true ]]; then
  ok "apt-based distro detected ($OS_ID) — host deps can be installed automatically"
else
  if [[ "$OS_ID" == "macos" ]]; then
    warn "macOS detected — apt install skipped; Python validate still works, but full ISO builds need Debian 13 (use Docker Desktop + Debian container or a VM)"
    warn "  Quick check: make quick   |   Full host setup: see docs/troubleshooting.md#host-build---macos"
  elif [[ "$UNAME_S" == "MINGW"* || "$UNAME_S" == "MSYS"* || "$UNAME_S" == "CYGWIN"* ]]; then
    warn "Windows detected — use WSL2 Debian 13 for full builds: wsl --install -d Debian && wsl -d Debian -- bash -c 'curl -fsSL https://osaii.wyvernhub.net/install/mythos.sh | bash'"
  else
    warn "Not Debian/Ubuntu ($OS_ID) — automatic apt install will be skipped; clone + Python validate still works where possible"
    warn "  For full ISO builds use Debian 13 trixie (recommended) or Ubuntu 22.04+ with Docker"
  fi
fi

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  info "Would do:"
  if [[ "$supports_apt" == true && "$have_python" == false ]]; then echo "  - sudo apt update && sudo apt install python3 python3-venv python3-pip"; fi
  if [[ "$is_mythos_checkout" == true ]]; then
    echo "  - cd $MYTHOS_ROOT && make $([[ "$DO_ISO" == true ]] && echo "validate package" || echo "quick")"
  else
    echo "  - git clone ${REPO_URL} ${TARGET_DIR:-$DEFAULT_DIR}"
    echo "  - cd <clone>/MythOS && make $([[ "$DO_ISO" == true ]] && echo "validate package" || echo "quick")"
  fi
  echo "  - fetch release metadata: curl -fsSL $RELEASE_JSON"
  if [[ "$DO_DEV" == true ]]; then echo "  - python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' || pip install -e ."; fi
  if [[ "$DO_ISO" == true ]]; then
    echo "  - make iso needs Docker + 25 GiB tmp + network (Debian mirrors)"
    echo "  - make smoke needs qemu/kvm (optional)"
  fi
  ok "--dry-run ok — re-run without --dry-run to execute"
  exit 0
fi

# ——— install apt deps on Debian/Ubuntu ———
if [[ "$supports_apt" == true ]]; then
  need_apt=false
  for bin in python3 make git; do
    command -v "$bin" >/dev/null 2>&1 || need_apt=true
  done
  if [[ "$need_apt" == true || "$DO_DEV" == true ]]; then
    if command -v sudo >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
      SUDO="sudo"
    elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      SUDO=""
    else
      SUDO=""
      warn "sudo not available and not running as root — skipping apt install; install deps manually:"
      warn "  apt update && apt install -y git make python3 python3-venv python3-pip python3-pytest shellcheck docker.io"
    fi
    if [[ -n "${SUDO:-}" ]] || [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      deps=(git make python3 python3-venv python3-pip ca-certificates curl)
      # optional but recommended for full validate
      deps+=(shellcheck)
      if [[ "$DO_ISO" == true ]]; then
        deps+=(docker.io qemu-system-x86 ovmf)
      fi
      info "Installing host deps: ${deps[*]}"
      if [[ "$ASSUME_YES" == true ]]; then APT_YES="-y"; else APT_YES=""; fi
      set +e
      $SUDO apt-get update
      apt_update_rc=$?
      set -e
      if [[ $apt_update_rc -ne 0 ]]; then
        warn "apt-get update failed — continuing anyway (offline or permission issue)"
      else
        if [[ "$ASSUME_YES" == true ]]; then
          $SUDO apt-get install -y "${deps[@]}" || warn "apt install failed — continuing; install manually if validate fails"
        else
          $SUDO apt-get install "${deps[@]}" || {
            warn "apt install cancelled or failed — continuing; install manually if validate fails"
          }
        fi
      fi
      # ensure host's docker service if installed now
      if command -v docker >/dev/null 2>&1; then
        have_docker=true
        ok "docker now available"
      fi
      if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
        have_python=true
      fi
    fi
  else
    ok "host deps look present — skipping apt install"
  fi
else
  if [[ "$have_python" == false || "$have_git" == false ]]; then
    die "Missing required tools on non-apt system. Install python3 ≥3.11, git, make manually, then re-run."
  fi
fi

# ——— locate / clone repo ———
if [[ "$is_mythos_checkout" == false ]]; then
  if [[ -z "$TARGET_DIR" ]]; then
    # If no target given and we are inside a git repo that is not MythOS, don't clobber.
    # Use default dir.
    TARGET_DIR="$DEFAULT_DIR"
  fi
  REMOTE="$REPO_URL"; [[ "$USE_SSH" == true ]] && REMOTE="$REPO_SSH"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "Updating existing checkout: $TARGET_DIR"
    git -C "$TARGET_DIR" pull --ff-only || warn "git pull failed — continuing with existing checkout"
    # After pull, try to resolve MythOS root inside
    if MYTHOS_ROOT="$(resolve_mythos_root "$TARGET_DIR" 2>/dev/null)"; then
      :
    else
      # maybe fullplatform root?
      if [[ -d "$TARGET_DIR/MythOS" ]]; then
        MYTHOS_ROOT="$TARGET_DIR/MythOS"
      else
        MYTHOS_ROOT="$TARGET_DIR"
      fi
    fi
  elif [[ -e "$TARGET_DIR" ]]; then
    die "target '$TARGET_DIR' exists and is not a git repo — remove it or pick another dir"
  else
    info "Cloning $REMOTE → $TARGET_DIR"
    git clone "$REMOTE" "$TARGET_DIR"
    if MYTHOS_ROOT="$(resolve_mythos_root "$TARGET_DIR" 2>/dev/null)"; then
      :
    elif [[ -d "$TARGET_DIR/MythOS" ]]; then
      MYTHOS_ROOT="$TARGET_DIR/MythOS"
    else
      MYTHOS_ROOT="$TARGET_DIR"
    fi
  fi
  # ensure we're in repo for subsequent steps
  if [[ -d "$MYTHOS_ROOT" ]]; then
    info "MythOS root: $MYTHOS_ROOT"
  else
    die "Could not locate MythOS checkout after clone. Expected $TARGET_DIR/MythOS or $TARGET_DIR with VERSION present."
  fi
else
  # already have MYTHOS_ROOT from earlier resolve
  :
fi

# Normalize: if MYTHOS_ROOT points to fullplatform root, adjust to MythOS subdir
if [[ -f "$MYTHOS_ROOT/MythOS/VERSION" ]]; then
  MYTHOS_ROOT="$MYTHOS_ROOT/MythOS"
fi

if [[ ! -f "$MYTHOS_ROOT/VERSION" ]]; then
  die "MythOS checkout not found at $MYTHOS_ROOT (missing VERSION). Check clone target."
fi

cd "$MYTHOS_ROOT"
info "Working in: $(pwd)"
if [[ -f VERSION ]]; then
  MYTHOS_VER="$(tr -d '[:space:]' < VERSION)"
  ok "MythOS version $MYTHOS_VER"
fi

# ——— venv / dev setup ———
if [[ "$DO_DEV" == true ]]; then
  info "Setting up Python venv at .venv…"
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv || die "python3 -m venv failed (apt install python3-venv ?)"
  fi
  # shellcheck disable=SC1091
  source .venv/bin/activate || true
  pip install --upgrade pip setuptools 2>&1 | tail -n 5 || true
  if pip install -e ".[dev]" 2>&1 | tail -n 20; then
    ok "venv ready (.venv) — installed with [dev] extras"
  else
    pip install -e . 2>&1 | tail -n 20 || warn "pip install -e . failed — try manually: .venv/bin/pip install -e ."
    ok "venv ready (.venv)"
  fi
fi

# ——— validate / package hints ———
echo ""
info "Running MythOS validation…"

# Helper: run make target with nice error
run_make() {
  local target="$1"
  info "make $target"
  if make "$target"; then
    ok "make $target passed"
    return 0
  else
    err "make $target failed (see output above)"
    return 1
  fi
}

VALIDATE_RC=0
if [[ "$DO_ISO" == true ]]; then
  run_make validate || VALIDATE_RC=$?
  if [[ $VALIDATE_RC -eq 0 ]]; then
    info "Building Debian package (needs Docker)…"
    if [[ "$have_docker" == true ]]; then
      run_make package || warn "make package failed — ensure Docker is running and you have 2–5 GiB free"
    else
      warn "Skipping 'make package' — Docker not available. Install docker.io and re-run with --iso"
    fi
    echo ""
    info "ISO build (optional — heavy):"
    echo "  ${DIM}make iso${RESET}    — hybrid BIOS/UEFI ISO (~25 GiB tmp, network to deb.debian.org, Docker privileged)"
    echo "  ${DIM}make smoke${RESET}  — boot smoke test inside QEMU (needs Docker + KVM)"
    echo "  Artifacts: ${DIM}.build/artifacts/${RESET}  (mythos-\${VERSION}-amd64.iso, .sha256)"
    if [[ "$have_docker" == false ]]; then
      warn "Docker is required for 'make iso'. Install: sudo apt install docker.io && sudo usermod -aG docker \$USER && newgrp docker"
    fi
  fi
else
  # quick validate (no ISO) — use make quick if available, else make validate
  if grep -q "^quick:" Makefile 2>/dev/null; then
    run_make quick || VALIDATE_RC=$?
  else
    run_make validate || VALIDATE_RC=$?
  fi
fi

if [[ $VALIDATE_RC -ne 0 ]]; then
  err "Validation failed — fix errors above and re-run: cd $MYTHOS_ROOT && make validate"
  echo ""
  info "Troubleshooting:"
  echo "  python3 -m compileall -q src tests   — syntax check"
  echo "  python3 -m pytest -q                 — unit tests"
  echo "  ./scripts/lint-shell                 — shell scripts (needs shellcheck)"
  echo "  python3 scripts/validate-project     — project invariants"
  exit $VALIDATE_RC
fi

# ——— release metadata ———
echo ""
ok "MythOS checkout ready at ${CYAN}$MYTHOS_ROOT${RESET}"
echo ""
echo "${GREEN}━━━ next steps ━━━${RESET}"
echo "  validate:  ${CYAN}make quick${RESET}   or  ${CYAN}make validate${RESET}"
echo "  package:   ${CYAN}make package${RESET}  — Debian package at .build/artifacts/mythos-core_*_all.deb"
echo "  iso:       ${CYAN}make iso${RESET}      — hybrid live ISO (Docker + 25 GiB tmp + network)"
echo "  smoke:     ${CYAN}make smoke${RESET}    — UEFI boot smoke test (QEMU)"
echo "  install:   ${CYAN}make vm${RESET}       — VM helper  |  ${CYAN}sudo ./scripts/install-mythos-in-place --help${RESET}"
echo ""
echo "  release metadata: ${CYAN}$RELEASE_JSON${RESET}"
if command -v curl >/dev/null 2>&1; then
  echo "  ${DIM}curl -fsSL $RELEASE_JSON | python3 -m json.tool${RESET}"
  curl -fsSL "$RELEASE_JSON" 2>/dev/null | python3 -m json.tool 2>/dev/null | head -n 20 || true
elif command -v wget >/dev/null 2>&1; then
  echo "  ${DIM}wget -qO- $RELEASE_JSON | python3 -m json.tool${RESET}"
fi
echo ""
echo "  docs: ${DIM}docs/architecture.md  docs/security.md  docs/release-acceptance.md  README.md${RESET}"
echo "  doctor: ${CYAN}python3 -m mythos.cli doctor${RESET}  or  ${CYAN}mythosctl doctor${RESET}  (after pip install -e .)"
echo ""
ok "done — welcome to MythOS"
