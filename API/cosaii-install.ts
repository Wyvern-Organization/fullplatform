export function cosaiiShellInstaller(): string {
  return `#!/bin/sh
# Cosaii single-line installer — verifies checksums, supports version pinning, and prints verification steps.
# Usage: curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh
#        COSAII_VERSION=0.1.0 sh install/cosaii.sh --help  # pin a version or show help
# Verification after install: cosaii --version && cosaii doctor
# Uninstall: rm "$HOME/.local/bin/cosaii" "$HOME/.local/bin/cosaii-app-server"; cosaii daemon uninstall 2>/dev/null || true
set -eu
if [ "\${1:-}" = "--help" ] || [ "\${1:-}" = "-h" ]; then
  echo "Cosaii installer"
  echo "Usage: curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh [--help]"
  echo "Env: COSAII_VERSION (default latest, e.g. 0.1.0), COSAII_INSTALL_DIR (default ~/.local/bin)"
  echo "Verification: cosaii --version && cosaii doctor"
  echo "Uninstall: rm \\"\$COSAII_INSTALL_DIR/cosaii\\" \\"\$COSAII_INSTALL_DIR/cosaii-app-server\\"; cosaii daemon uninstall 2>/dev/null || true"
  exit 0
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset="cosaii-linux-x64.tar.gz" ;;
  Linux-aarch64|Linux-arm64) asset="cosaii-linux-arm64.tar.gz" ;;
  Darwin-x86_64) asset="cosaii-macos-x64.tar.gz" ;;
  Darwin-arm64) asset="cosaii-macos-arm64.tar.gz" ;;
  *) echo "Unsupported platform. See https://osaii.wyvernhub.net/products" >&2; exit 1 ;;
esac
version="\${COSAII_VERSION:-latest}"
# Version pinning: COSAII_VERSION can be 'latest' or a semver like 0.1.0
if [ "$version" != "latest" ]; then
  if ! printf "%s" "$version" | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9._-]+)?$'; then
    echo "COSAII_VERSION must be 'latest' or a semver (e.g. 0.1.0), got: $version" >&2; exit 1
  fi
  echo "Installing Cosaii version $version (from COSAII_VERSION)…"
else
  echo "Installing Cosaii (latest)…"
fi
base="https://osaii.wyvernhub.net/install"
# When a specific version is requested, the Platform serves versioned assets if published;
# otherwise this falls back to latest and the checksum still verifies the exact bytes.
if [ "$version" != "latest" ]; then
  url="$base/$asset?version=$version&update=$(date +%s)"
  checksum_url="$base/$asset.sha256?version=$version&update=$(date +%s)"
else
  cache_bust="$(date +%s)"
  url="$base/$asset?update=$cache_bust"
  checksum_url="$base/$asset.sha256?update=$cache_bust"
fi
install_dir="\${COSAII_INSTALL_DIR:-$HOME/.local/bin}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Downloading $url …"
curl -fL "$url" -o "$tmp/$asset"
curl -fL "$checksum_url" -o "$tmp/$asset.sha256"
# Checksum verification (required — do not skip)
(cd "$tmp" && sha256sum -c "$asset.sha256")
tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$install_dir"
install -m 0755 "$tmp/cosaii" "$install_dir/cosaii"
install -m 0755 "$tmp/cosaii-app-server" "$install_dir/cosaii-app-server"
echo "Installed Cosaii to $install_dir. Verifying…"
"$install_dir/cosaii" --version
echo "Verification: cosaii --version && cosaii doctor"
echo "Next: cosaii login  (or cosaii doctor for diagnostics)"
echo "Uninstall: rm \\"$install_dir/cosaii\\" \\"$install_dir/cosaii-app-server\\"; cosaii daemon uninstall 2>/dev/null || true"
`;
}

export function cosaiiPowerShellInstaller(): string {
  return `$ErrorActionPreference = 'Stop'
# Cosaii PowerShell installer — checksum-verified, version-pinning aware
# Usage: irm https://osaii.wyvernhub.net/install/cosaii.ps1 | iex
# Env: $env:COSAII_VERSION (latest or 0.1.0), $env:COSAII_INSTALL_DIR
# Verification: cosaii --version; cosaii doctor
# Uninstall: Remove-Item $env:LOCALAPPDATA\\Cosaii\\bin\\cosaii*.exe; cosaii daemon uninstall
if ($args -contains '--help' -or $args -contains '-h') {
  Write-Host "Cosaii installer"
  Write-Host "Usage: irm https://osaii.wyvernhub.net/install/cosaii.ps1 | iex  [--help]"
  Write-Host "Env: COSAII_VERSION (default latest), COSAII_INSTALL_DIR"
  Write-Host "Verification: cosaii --version && cosaii doctor"
  Write-Host "Uninstall: Remove-Item \$env:LOCALAPPDATA\\Cosaii\\bin\\cosaii*.exe; cosaii daemon uninstall"
  exit 0
}
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$Asset = "cosaii-windows-$Arch.zip"
$Version = if ($env:COSAII_VERSION) { $env:COSAII_VERSION } else { 'latest' }
if ($Version -ne 'latest' -and $Version -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9._-]+)?$') { throw "COSAII_VERSION must be 'latest' or semver (e.g. 0.1.0), got: $Version" }
$Base = "https://osaii.wyvernhub.net/install"
$CacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if ($Version -ne 'latest') { $Url = "$Base/$Asset?version=$Version&update=$CacheBust"; $ChecksumUrl = "$Base/$Asset.sha256?version=$Version&update=$CacheBust" } else { $Url = "$Base/$Asset?update=$CacheBust"; $ChecksumUrl = "$Base/$Asset.sha256?update=$CacheBust" }
$InstallDir = if ($env:COSAII_INSTALL_DIR) { $env:COSAII_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Cosaii\\bin' }
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp, $InstallDir -Force | Out-Null
try {
  Write-Host "Downloading $Url …"
  Invoke-WebRequest $Url -OutFile (Join-Path $Temp $Asset)
  Invoke-WebRequest $ChecksumUrl -OutFile (Join-Path $Temp "$Asset.sha256")
  $Expected = ((Get-Content (Join-Path $Temp "$Asset.sha256")) -split '\\s+')[0].ToLower()
  $Actual = (Get-FileHash (Join-Path $Temp $Asset) -Algorithm SHA256).Hash.ToLower()
  if ([string]::IsNullOrWhiteSpace($Expected) -or $Expected.Length -ne 64 -or $Expected -ne $Actual) { throw 'Cosaii checksum verification failed.' }
  Expand-Archive (Join-Path $Temp $Asset) -DestinationPath $Temp -Force
  Copy-Item (Join-Path $Temp 'cosaii.exe'), (Join-Path $Temp 'cosaii-app-server.exe') -Destination $InstallDir -Force
  Write-Host "Installed Cosaii to $InstallDir. Verifying…"
  & (Join-Path $InstallDir 'cosaii.exe') --version
  Write-Host "Verification: cosaii --version && cosaii doctor"
  Write-Host "Next: cosaii login"
  Write-Host "Uninstall: Remove-Item \\"$InstallDir\\cosaii*.exe\\"; cosaii daemon uninstall"
} finally { Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue }
`;
}
