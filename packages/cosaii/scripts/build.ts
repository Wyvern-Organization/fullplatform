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
const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  plugins: [solidPlugin],
  external,
  minify: true,
  sourcemap: "external",
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
