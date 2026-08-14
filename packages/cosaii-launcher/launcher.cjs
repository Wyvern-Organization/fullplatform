#!/usr/bin/env node
const { spawnSync } = require("node:child_process")
const path = require("node:path")

const arch = process.arch === "arm64" ? "arm64" : "x64"
const platform = process.platform
const packageName = `@osaii/cosaii-${platform}-${arch}`
let packageRoot
try { packageRoot = path.dirname(require.resolve(`${packageName}/package.json`)) }
catch { console.error(`Cosaii does not have an installed binary for ${platform}-${arch}. Reinstall cosaii or use https://osaii.wyvernhub.net/install/cosaii.sh`); process.exit(1) }
const binary = path.join(packageRoot, "bin", platform === "win32" ? "cosaii.exe" : "cosaii")
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" })
if (result.error) { console.error(result.error.message); process.exit(1) }
process.exit(result.status ?? 1)
