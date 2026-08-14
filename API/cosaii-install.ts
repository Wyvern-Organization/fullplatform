export function cosaiiShellInstaller(): string {
  return `#!/bin/sh
set -eu
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset="cosaii-linux-x64.tar.gz" ;;
  Linux-aarch64|Linux-arm64) asset="cosaii-linux-arm64.tar.gz" ;;
  Darwin-x86_64) asset="cosaii-macos-x64.tar.gz" ;;
  Darwin-arm64) asset="cosaii-macos-arm64.tar.gz" ;;
  *) echo "Unsupported platform. See https://osaii.wyvernhub.net/products" >&2; exit 1 ;;
esac
version="\${COSAII_VERSION:-latest}"
if [ "$version" != latest ]; then echo "Only the current Cosaii release is available from the Platform installer." >&2; exit 1; fi
base="https://osaii.wyvernhub.net/install"
cache_bust="$(date +%s)"
url="$base/$asset?update=$cache_bust"
install_dir="\${COSAII_INSTALL_DIR:-$HOME/.local/bin}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
curl -fL "$url" -o "$tmp/$asset"
curl -fL "$base/$asset.sha256?update=$cache_bust" -o "$tmp/$asset.sha256"
(cd "$tmp" && sha256sum -c "$asset.sha256")
tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$install_dir"
install -m 0755 "$tmp/cosaii" "$install_dir/cosaii"
install -m 0755 "$tmp/cosaii-app-server" "$install_dir/cosaii-app-server"
echo "Installed Cosaii to $install_dir. Run: cosaii login"
`;
}

export function cosaiiPowerShellInstaller(): string {
  return `$ErrorActionPreference = 'Stop'
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$Asset = "cosaii-windows-$Arch.zip"
$Version = if ($env:COSAII_VERSION) { $env:COSAII_VERSION } else { 'latest' }
if ($Version -ne 'latest') { throw 'Only the current Cosaii release is available from the Platform installer.' }
$Base = "https://osaii.wyvernhub.net/install"
$CacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$Url = "$Base/$Asset?update=$CacheBust"
$InstallDir = if ($env:COSAII_INSTALL_DIR) { $env:COSAII_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Cosaii\\bin' }
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp, $InstallDir -Force | Out-Null
try {
  Invoke-WebRequest $Url -OutFile (Join-Path $Temp $Asset)
  Invoke-WebRequest "$Base/$Asset.sha256?update=$CacheBust" -OutFile (Join-Path $Temp "$Asset.sha256")
  $Expected = ((Get-Content (Join-Path $Temp "$Asset.sha256")) -split '\\s+')[0].ToLower()
  $Actual = (Get-FileHash (Join-Path $Temp $Asset) -Algorithm SHA256).Hash.ToLower()
  if ($Expected -ne $Actual) { throw 'Cosaii checksum verification failed.' }
  Expand-Archive (Join-Path $Temp $Asset) -DestinationPath $Temp -Force
  Copy-Item (Join-Path $Temp 'cosaii.exe'), (Join-Path $Temp 'cosaii-app-server.exe') -Destination $InstallDir -Force
  Write-Host "Installed Cosaii to $InstallDir. Run: cosaii login"
} finally { Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue }
`;
}
