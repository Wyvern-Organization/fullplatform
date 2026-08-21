# OSAII Full Platform — Windows installer (PowerShell)
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
    if ($pkg -match '"name"\s*:\s*"osaii-worker"') { $root = (Get-Location).Path; Info "using current directory as repo root: $root" }
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
