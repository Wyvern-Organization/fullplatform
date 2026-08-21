import solidPlugin from "@opentui/solid/bun-plugin"
import { copyFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"

await mkdir("dist", { recursive: true })
const platformPackage = `@opentui/core-${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`
const external = [
  "@opentui/core-darwin-x64", "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64", "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl",
  "@opentui/core-win32-x64", "@opentui/core-win32-arm64",
].filter(name => name !== platformPackage)
const target = process.env.COSAII_BUN_TARGET || `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`
const output = process.platform === "win32" ? "./dist/cosaii.exe" : "./dist/cosaii"
const isProd = process.env.NODE_ENV === "production" || process.env.CI === "true";
const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  plugins: [solidPlugin],
  external,
  // Enable full minify (syntax + whitespace) for prod; identifier minify is safe for Solid JSX via opentui plugin
  minify: isProd ? { syntax: true, whitespace: true, identifiers: true } : true,
  sourcemap: isProd ? "none" : "external",
  // Production define ensures dead-code elimination of dev branches
  define: { "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development") },
  // Keep bundle lean: no splitting for single-entry TUI, tree-shaking is default
  splitting: false,
  compile: { target: target as any, outfile: output },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
const serverSource = resolve(import.meta.dir, process.platform === "win32" ? "../../../cosaii/target/release/cosaii-app-server.exe" : "../../../cosaii/target/release/cosaii-app-server")
const serverOutput = resolve(import.meta.dir, process.platform === "win32" ? "../dist/cosaii-app-server.exe" : "../dist/cosaii-app-server")
await copyFile(serverSource, serverOutput).catch(() => {
  console.warn(`Rust release binary not found at ${serverSource}; run npm run cosaii:build from the repository root.`)
})
console.log(`Built ${output}`)
