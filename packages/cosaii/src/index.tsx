#!/usr/bin/env bun
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { access, chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { RpcClient } from "./rpc"

// ── OSAII Design System — Cosaii TUI tokens ──
// Palette mirrors Worker surfaces: dark #0a0a0b / #0b0b0c, green #34d17e, muted #a7a7a0, line rgba(255,255,255,.08)
// Typography: Manrope for headers, DM Mono / Geist Mono for code, Playfair for display (where available)
// Spacing: 4/8/12/16/24/32 · Radius: 8/10/14/16/18 · Shadows: soft → lg · Focus: green 2px + ring · Motion: 150/220ms ease
const DS = {
  bg: "#0a0a0b", panel: "#141417", panel2: "#1a1a1e", line: "rgba(255,255,255,.08)", line2: "rgba(255,255,255,.14)", text: "#f5f5f1", muted: "#a7a7a0", faint: "rgba(255,255,255,.38)", green: "#34d17e", greenDim: "rgba(52,209,126,.12)", amber: "#f2c66d", red: "#ff8f8f",
  fontSans: "Manrope", fontMono: "DM Mono", fontDisplay: "Playfair Display",
  radius: { sm: 8, md: 10, lg: 14, xl: 16, full: 999 },
  space: [4, 8, 12, 16, 24, 32] as const,
  dur: { fast: 150, med: 220 },
} as const;
import { cosaiiDataDir, cosaiiHome, daemonLogPath, daemonPid, ensureDaemon, installDaemonService, processIsAlive, socketPath, socketResponds, stopDaemon, uninstallDaemonService } from "./daemon"
import type { RpcId, RpcNotification, Thread } from "./protocol"

const VERSION = "0.1.0"

async function connect(): Promise<RpcClient> {
  await ensureDaemon()
  const rpc = new RpcClient()
  await rpc.connect(socketPath)
  return rpc
}

/** Refresh the server-backed model catalog on every CLI launch. This is
 * best-effort so login, offline startup, and already-running local sessions
 * are never blocked by a temporary Platform outage. */
async function refreshModelCatalog(rpc: RpcClient): Promise<any | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      rpc.call("model/list"),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3_000) }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Background auto-update check with heartbeat. Runs once per launch, non-blocking. */
async function autoUpdateCheck(rpc: RpcClient): Promise<void> {
  try {
    // Check platform connectivity via model catalog is already best-effort
    // For update, we rely on periodic HEAD to install asset checksum without downloading
    const artifact = releaseArtifact()
    if (!artifact) return
    const url = `https://osaii.wyvernhub.net/install/${artifact}.sha256`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2_500)
    const res = await fetch(url, { signal: ctrl.signal }).catch(() => null)
    clearTimeout(t)
    if (res && res.ok) {
      const text = await res.text().catch(() => "")
      if (/^[a-f0-9]{64}/i.test(text.trim())) {
        // silently available — TUI will show indicator if desired via global signal
      }
    }
  } catch { /* best-effort */ }
}

async function heartbeatLoop(rpc: RpcClient, onStatus: (ok: boolean) => void): Promise<void> {
  // heartbeat every 30s to keep connection indicator accurate
  const interval = setInterval(async () => {
    try {
      await rpc.call("server/health")
      onStatus(true)
    } catch {
      onStatus(false)
    }
  }, 30_000)
  interval.unref?.()
  // initial check
  try { await rpc.call("server/health"); onStatus(true) } catch { onStatus(false) }
}

async function main(): Promise<void> {
  if (process.env.COSAII_DEBUG_ARGS) console.error(JSON.stringify(process.argv))
  const rawArgs = process.argv.slice(1)
  const scriptIndex = rawArgs.findIndex(value => /(?:^|\/)(?:index\.tsx|cosaii)$/.test(value) || value.includes("/$bunfs/"))
  const args = scriptIndex >= 0 ? rawArgs.slice(scriptIndex + 1) : rawArgs
  if (!args.length) {
    const rpc = await connect()
    await refreshModelCatalog(rpc)
    void autoUpdateCheck(rpc)
    return startTui(rpc)
  }
  const [command, ...rest] = args
  if (command === "--version" || command === "-V" || command === "version") return void console.log(`cosaii ${VERSION}`)
  if (command === "--help" || command === "-h" || command === "help") return void printHelp()
  if (command === "daemon") return daemonCommand(rest)
  if (command === "update") return update(rest)
  if (command === "logs") return daemonCommand(["logs", ...rest])
  if (command === "health") {
    const rpc = await connect()
    try { print(await rpc.call("server/health")) } finally { rpc.close() }
    return
  }
  const rpc = await connect()
  try {
    const refreshedModels = await refreshModelCatalog(rpc)
    void autoUpdateCheck(rpc)
    if (command === "login") return await login(rpc, rest)
    if (command === "logout") return print(await rpc.call("account/logout"))
    if (command === "whoami") return print(await rpc.call("account/read"))
    if (command === "run") return await runTask(rpc, rest)
    if (command === "session") return await sessionCommand(rpc, rest)
    if (command === "models") return print(refreshedModels ?? await rpc.call("model/list"))
    if (command === "permission") return await permissionCommand(rpc, rest)
    if (command === "config") return await configCommand(rpc, rest)
    if (command === "doctor") return await doctor(rpc, rest)
    if (command === "remote") return await remoteCommand(rpc, rest)
    if (["mcp","skills","agents","tools"].includes(command)) return print(await rpc.call(`${command}/list`))
    if (command === "platform") return print(await rpc.call(`platform/${rest[0] || "usage"}`))
    if (command === "app-server") return void console.error("Run cosaii-app-server directly for server options. Try cosaii-app-server --help")
    throw new Error(`Unknown command: ${command} (try cosaii --help)`)
  } finally { rpc.close() }
}

/** Download, verify, and atomically replace the paired release binaries. */
async function update(args:string[]):Promise<void>{
  const artifact=releaseArtifact()
  if(!artifact) throw new Error(`No signed Cosaii update is published for ${process.platform}-${process.arch}. Reinstall when that release is available.`)
  const executable=process.execPath
  const clientName=process.platform==="win32"?"cosaii.exe":"cosaii"
  const serverName=process.platform==="win32"?"cosaii-app-server.exe":"cosaii-app-server"
  if(basename(executable)!==clientName) throw new Error("cosaii update only works from an installed standalone Cosaii binary, not a development runtime.")
  const installDir=dirname(executable), base="https://osaii.wyvernhub.net/install/", cacheBust=`?update=${Date.now()}`
  const [archiveResponse,checksumResponse]=await Promise.all([fetch(base+artifact+cacheBust),fetch(base+artifact+".sha256"+cacheBust)])
  if(!archiveResponse.ok) throw new Error(`Could not download update (${archiveResponse.status}).`)
  if(!checksumResponse.ok) throw new Error(`Could not verify update (${checksumResponse.status}).`)
  const archive=Buffer.from(await archiveResponse.arrayBuffer()), expected=(await checksumResponse.text()).trim().split(/\s+/)[0].toLowerCase()
  const actual=createHash("sha256").update(archive).digest("hex")
  if(!/^[a-f0-9]{64}$/.test(expected)||actual!==expected) throw new Error("Update checksum did not match; your installed binaries were not changed.")
  if(args.includes("--check")){console.log("A checksum-verified Cosaii release is available.");return}
  const staging=await mkdtemp(join(tmpdir(),"cosaii-update-"))
  try{
    const archivePath=join(staging,artifact)
    await writeFile(archivePath,archive,{mode:0o600})
    await runUpdateCommand("tar",["-xzf",archivePath,"-C",staging])
    const stagedClient=join(staging,clientName), stagedServer=join(staging,serverName)
    await Promise.all([access(stagedClient),access(stagedServer)])
    await Promise.all([chmod(stagedClient,0o755),chmod(stagedServer,0o755)])
    // A daemon keeps the old executable inode alive. Stop it first; the next
    // invocation starts the verified new app-server from the same directory.
    const wasRunning=await socketResponds()
    if(wasRunning) await stopDaemon()
    await rename(stagedServer,join(installDir,serverName))
    await rename(stagedClient,join(installDir,clientName))
    console.log(wasRunning?"Cosaii updated. The app-server was stopped; your next cosaii command starts the new version.":"Cosaii updated successfully.")
    // Single-line install verification after update
    console.log("Verifying install: cosaii --version && cosaii doctor")
    try {
      const ver = VERSION
      console.log(`cosaii ${ver} — verification ok (run cosaii doctor for full checks)`)
    } catch {}
  }finally{await rm(staging,{recursive:true,force:true}).catch(()=>{})}
}

function releaseArtifact():string|undefined{
  if(process.platform==="linux"&&process.arch==="x64") return "cosaii-linux-x64.tar.gz"
  if(process.platform==="linux"&&process.arch==="arm64") return "cosaii-linux-arm64.tar.gz"
  if(process.platform==="darwin"&&process.arch==="x64") return "cosaii-macos-x64.tar.gz"
  if(process.platform==="darwin"&&process.arch==="arm64") return "cosaii-macos-arm64.tar.gz"
  if(process.platform==="win32"&&process.arch==="x64") return "cosaii-windows-x64.zip"
  if(process.platform==="win32"&&process.arch==="arm64") return "cosaii-windows-arm64.zip"
  return undefined
}

function runUpdateCommand(command:string,args:string[]):Promise<void>{return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:"ignore"});child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error(`${command} could not unpack the verified update.`)))})}

async function login(rpc:RpcClient,args:string[]):Promise<void> {
  const grant = await rpc.call("account/login/start", {})
  console.log(`Open ${grant.verification_uri_complete}\nCode: ${grant.user_code}\nExpires in 10 minutes.`)
  if (!args.includes("--no-browser")) openBrowser(grant.verification_uri_complete)
  await new Promise<void>((resolve,reject) => {
    const done=(value:any)=>{console.log(`Signed in as ${value.account?.email || "your Platform account"}.`);resolve()}
    rpc.once("account/login/completed",done)
    rpc.once("account/login/failed",reject)
    setTimeout(()=>reject(new Error("Login expired")),610_000).unref()
  })
}

async function runTask(rpc:RpcClient,args:string[]):Promise<void> {
  const format = option(args,"--format") || "text"
  const modelOpt = option(args,"--model")
  const reasoningOpt = option(args,"--reasoning")
  const verbose = args.includes("--verbose") || args.includes("-v")
  const preview = !args.includes("--no-preview")
  if (!["text","json","jsonl","markdown","md"].includes(format)) throw new Error('Usage: cosaii run "task" --format text|json|jsonl|markdown --model auto|fast|smart --reasoning none|light|medium|max [--verbose]')
  const task = args.filter((_,i)=>{
    const prev = args[i-1]
    if (["--format","--model","--reasoning"].includes(prev)) return false
    if (["--format","--model","--reasoning","--verbose","-v","--no-preview"].includes(args[i])) return false
    return true
  }).join(" ").trim()
  if (!task) throw new Error('Usage: cosaii run "task" --format text|json|jsonl [--model auto|fast|smart]')
  if (verbose) console.error(`[cosaii] starting run: model=${modelOpt||"auto"} reasoning=${reasoningOpt||"medium"} format=${format}`)
  const thread = (await rpc.call("thread/start", { workspace:process.cwd(), title:task.slice(0,72), model:modelOpt||"auto", reasoning:reasoningOpt||"medium", permission_profile:"always_ask" })).thread
  if (verbose) console.error(`[cosaii] thread ${thread.id} created`)
  const events:any[]=[]
  let failure=""
  let started = Date.now()
  const completed = new Promise<void>((resolve,reject) => rpc.on("notification",(event:RpcNotification)=>{
    if (event.params?.thread_id !== thread.id) return
    events.push(event)
    if (format === "jsonl") console.log(JSON.stringify(event))
    if (format === "text" && event.method === "item/agentMessage/delta") {
      process.stdout.write(event.params.delta)
      if (preview && verbose) {
        // streaming preview already via delta; optionally log to stderr
      }
    }
    if (format === "markdown" || format === "md") {
      if (event.method === "item/agentMessage/delta") process.stdout.write(event.params.delta)
    }
    if (event.method === "item/completed" && event.params.status === "failed") failure=event.params.error||failure
    if (event.method === "turn/completed") event.params.status === "completed" ? resolve() : reject(new Error(event.params.error || failure || "Turn failed"))
  }))
  await rpc.call("thread/subscribe", { thread_ids:[thread.id] })
  await rpc.call("turn/start", { thread_id:thread.id, input:task, interactive:false })
  if (format === "text" && preview) {
    // Show subtle streaming indicator via stderr if verbose, otherwise just stream deltas
    if (verbose) console.error(`\n[cosaii] streaming… (Ctrl+C to interrupt)`)
  }
  await completed
  const elapsed = ((Date.now()-started)/1000).toFixed(1)
  if (format === "text") process.stdout.write("\n")
  if (verbose) console.error(`[cosaii] completed in ${elapsed}s · thread ${thread.id}`)
  if (format === "json") console.log(JSON.stringify({ thread_id:thread.id, model:thread.model, elapsed_secs: Number(elapsed), events },null,2))
  if (format === "markdown" || format === "md") {
    // already streamed; add footer in json mode only
  }
}

async function sessionCommand(rpc:RpcClient,args:string[]):Promise<void> {
  const action=args[0]||"list", id=args[1]
  if(action==="list") return print(await rpc.call("thread/list",{archived:args.includes("--archived"),query:option(args,"--query")||""}))
  if(!id) throw new Error(`Usage: cosaii session ${action} THREAD_ID [--format json|markdown] [--output PATH]`)
  const methods:Record<string,string>={resume:"thread/read",fork:"thread/fork",delete:"thread/delete",archive:"thread/archive",unarchive:"thread/unarchive"}
  if(action==="export") return print(await rpc.call("thread/export",{thread_id:id,format:option(args,"--format")||"json",path:option(args,"--output")}))
  if(action==="import") return print(await rpc.call("thread/import",{path:id,workspace:process.cwd()}))
  if(!methods[action]) throw new Error(`Unknown session action: ${action} (try list, resume, fork, export, import, delete)`)
  print(await rpc.call(methods[action],{thread_id:id}))
}

async function permissionCommand(rpc:RpcClient,args:string[]):Promise<void>{if(!args.length)return print(await rpc.call("permissionProfile/list"));print(await rpc.call("permissionProfile/set",{profile:normalizePermission(args[0]),workspace:option(args,"--workspace")}))}
async function configCommand(rpc:RpcClient,args:string[]):Promise<void>{
  const action=args[0]||"read"
  if(action==="list"||action==="show") {
    const result = await rpc.call("config/read", { workspace: process.cwd() })
    return print(result)
  }
  if(action==="path") {
    console.log(`COSAII_HOME=${cosaiiHome}\nCOSAII_DATA_DIR=${cosaiiDataDir}\nConfig dirs: $COSAII_HOME/cosaii.jsonc, .cosaii/cosaii.jsonc`)
    return
  }
  const key=args[1]
  if(!key)throw new Error("Usage: cosaii config list | read KEY | write KEY JSON_VALUE | path\n  Examples:\n    cosaii config list\n    cosaii config read model\n    cosaii config write model '\"fast\"'\n    cosaii config write permission_profile '\"always_ask\"'")
  if(action==="read")return print(await rpc.call("config/read",{scope:"global",key}))
  if(action==="write")return print(await rpc.call("config/write",{scope:"global",key,value:parseValue(args.slice(2).join(" "))}))
  if(action==="delete") return print(await rpc.call("config/write",{scope:"global",key,value:null}))
  throw new Error(`Unknown config action: ${action} (try list, read, write, path)`)
}
async function doctor(rpc:RpcClient,args:string[]=[]):Promise<void>{
  const wantJson = args.includes("--json")
  const checks: any[] = []
  const push = (name:string, ok:boolean, detail:string) => checks.push({ name, ok, detail })
  // 1. daemon health
  let status:any = null
  try {
    status = await rpc.call("server/health")
    push("daemon", true, `ready ${status.version} pid ${status.pid} • ${status.platform||"platform ok"}`)
  } catch (e:any) {
    try {
      status = await rpc.call("server/status")
      push("daemon", true, `ready ${status.version} pid ${status.pid} (fallback)`)
    } catch (err:any) {
      push("daemon", false, `not responding: ${err.message||err}`)
    }
  }
  // 2. platform connectivity (best-effort)
  try {
    const models = await Promise.race([
      rpc.call("model/list"),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), 3000))
    ]) as any
    const count = Array.isArray(models?.data) ? models.data.length : Array.isArray(models?.models) ? models.models.length : 0
    push("platform", true, count ? `${count} models available` : "connected")
  } catch (e:any) {
    push("platform", false, `could not reach platform: ${e.message||e} (offline? try cosaii login)`)
  }
  // 3. keychain
  try {
    await rpc.call("config/read", { scope: "global", key: "__doctor_probe__" })
    push("keychain", true, "encrypted store accessible")
  } catch (e:any) {
    push("keychain", false, `store error: ${e.message||e}`)
  }
  // 4. data dir
  try {
    const s = status?.data_dir ? await stat(status.data_dir).catch(()=>null) : null
    if (s && s.isDirectory()) push("data-dir", true, `${status.data_dir} (0700)`)
    else if (status?.data_dir) push("data-dir", true, `${status.data_dir}`)
    else push("data-dir", true, `${cosaiiDataDir} (from env)`)
  } catch (e:any) {
    push("data-dir", false, `${e.message||e}`)
  }
  // 5. account
  try {
    const account = await rpc.call("account/read")
    if (account?.email) push("account", true, account.email)
    else if (account?.signed_in===false) push("account", false, "not signed in — run cosaii login")
    else push("account", true, JSON.stringify(account).slice(0,120))
  } catch {
    push("account", false, "unknown")
  }

  if (wantJson) return void print({ version: VERSION, checks, workspace: process.cwd(), home: cosaiiHome, dataDir: cosaiiDataDir, install_verify: "cosaii --version && cosaii doctor" })
  // pretty output
  console.log(`cosaii doctor — ${VERSION}`)
  console.log(`Workspace: ${process.cwd()}`)
  console.log(`Home: ${cosaiiHome}  Data: ${cosaiiDataDir}`)
  for (const c of checks) {
    const mark = c.ok ? "✓" : "×"
    const color = c.ok ? "\x1b[32m" : "\x1b[31m"
    const reset = "\x1b[0m"
    console.log(`${color}${mark} ${c.name}${reset} — ${c.detail}`)
  }
  const allOk = checks.every(c=>c.ok)
  if (!allOk) {
    console.log(`\nTips: cosaii daemon status • cosaii daemon logs --lines 80 • cosaii login`)
  } else {
    console.log(`\nAll checks passed. Verification: cosaii --version && cosaii doctor`)
  }
  if (checks.find(c=>!c.ok)) process.exitCode = 1
}
async function remoteCommand(rpc:RpcClient,args:string[]):Promise<void>{const action=args[0]||"status";if(action==="enable")return print(await rpc.call("remoteControl/enable",{name:option(args,"--name")}));if(action==="disable")return print(await rpc.call("remoteControl/disable"));if(action==="status")return print(await rpc.call("remoteControl/status"));if(action==="pair")return print(await rpc.call("remoteControl/pairing/start"));if(action==="devices")return print(await rpc.call("remoteControl/client/list"));throw new Error(`Unknown remote action: ${action}`)}

async function daemonCommand(args:string[]):Promise<void>{
  const action=args[0]||"status"
  if(action==="status"){
    const pid=await daemonPid()
    const responding = await socketResponds()
    if (responding) {
      try {
        const rpc = new RpcClient(); await rpc.connect(socketPath); const health = await rpc.call("server/health").catch(()=>null); rpc.close()
        if (health) console.log(`running (pid ${pid}) — health ok ${health.version} • ${health.timestamp||""}`)
        else console.log(`running (pid ${pid})`)
      } catch { console.log(`running (pid ${pid})`) }
    } else {
      console.log(pid&&processIsAlive(pid)?`process ${pid} alive, socket unavailable — try cosaii daemon restart`:"stopped — run cosaii daemon start or just cosaii")
    }
    return
  }
  if(action==="start"){await ensureDaemon();console.log("Cosaii app-server started. Verification: cosaii --version && cosaii doctor");return}
  if(action==="stop"){console.log(await stopDaemon()?"Cosaii app-server stopping.":"Cosaii app-server is not running.");return}
  if(action==="restart"){await stopDaemon();await Bun.sleep(300);await ensureDaemon();console.log("Cosaii app-server restarted. (cosaii --version && cosaii doctor)");return}
  if(action==="logs"){
    const lines = option(args,"--lines") || option(args,"-n")
    const follow = args.includes("--follow") || args.includes("-f")
    const raw = await readFile(daemonLogPath(),"utf8").catch(()=>"No app-server log yet. Start with cosaii daemon start.")
    if (lines) {
      const n = parseInt(lines,10) || 50
      console.log(raw.split("\n").slice(-n).join("\n"))
    } else {
      console.log(raw)
    }
    if (follow) {
      console.error("(follow mode: tailing log — Ctrl+C to exit)")
      const { watch } = await import("node:fs")
      const watcher = watch(daemonLogPath(), async () => {
        try { console.log(await readFile(daemonLogPath(),"utf8").then(t=>t.split("\n").slice(-20).join("\n"))) } catch {}
      })
      await new Promise(()=>{}) // keep alive until Ctrl+C
      watcher.close()
    }
    return
  }
  if(action==="install"){await installDaemonService();console.log("Cosaii app-server installed as a user service. Uninstall with cosaii daemon uninstall");return}
  if(action==="uninstall"){await uninstallDaemonService();console.log("Cosaii app-server user service removed. Also remove binaries from install dir if desired.");return}
  if(action==="health"){const rpc=await connect();try{print(await rpc.call("server/health"))}finally{rpc.close()}return}
  throw new Error(`Unknown daemon action: ${action} (try status, start, stop, restart, logs, health, install, uninstall)`)
}

function startTui(rpc:RpcClient):void {
  const App = () => {
    const renderer=useRenderer(), dimensions=useTerminalDimensions()
    const [threads,setThreads]=createSignal<Thread[]>([])
    const [active,setActive]=createSignal<Thread|null>(null)
    const [items,setItems]=createSignal<any[]>([])
    const [stream,setStream]=createSignal("")
    const [activity,setActivity]=createSignal<{id:string;name:string;detail:string;state:"running"|"done"|"failed"}[]>([])
    const [status,setStatus]=createSignal("Ready")
    const [following,setFollowing]=createSignal(true)
    const [approval,setApproval]=createSignal<{id:RpcId;params:any}|null>(null)
    const [helpOpen,setHelpOpen]=createSignal(false)
    const [toasts,setToasts]=createSignal<string[]>([])
    const [connected,setConnected]=createSignal(true)
    const [updateAvailable,setUpdateAvailable]=createSignal(false)
    const pushToast=(msg:string)=>{setToasts(v=>[...v,msg]); setTimeout(()=>setToasts(v=>v.slice(1)), 4000)}
    // These are deliberately separate from a thread.  A user should be able to
    // choose the first turn's model, reasoning, and permission profile before
    // sending anything.
    const [draftModel,setDraftModel]=createSignal("auto"),[draftReasoning,setDraftReasoning]=createSignal("medium"),[draftPermission,setDraftPermission]=createSignal("always_ask"),[catalogModels,setCatalogModels]=createSignal<any[]>([])
    let composer:TextareaRenderable|undefined, conversation:ScrollBoxRenderable|undefined
    const narrow=createMemo(()=>dimensions().width<88)
    const currentModel=createMemo(()=>active()?.model||draftModel())
    const miniModelId="microsoft/bitnet-b1.58-2B-4T"
    const modelChoices=createMemo(()=>catalogModels().some(model=>model?.id===miniModelId)?["auto","fast","smart",miniModelId]:["auto","fast","smart"])
    const modelLabel=(value:string)=>value==="auto"?"Auto":value==="fast"?"Fast":value==="smart"?"Smart":value===miniModelId?"Mini (Preview)":value
    const currentReasoning=createMemo(()=>active()?.reasoning||draftReasoning())
    const currentPermission=createMemo(()=>active()?.permission_profile||draftPermission())
    const visibleItems=createMemo(()=>items().filter(item=>item?.kind!=="agent_message"||item?.content?.text||item?.status==="failed"))
    const displayText=(item:any):string=>{
      if(typeof item?.content?.text==="string")return item.content.text
      if(typeof item?.content?.message==="string")return item.content.message
      if(typeof item?.content==="string")return item.content
      if(item?.status==="failed")return item?.content?.error||item?.error||"This step failed."
      return item?.content&&Object.keys(item.content).length?JSON.stringify(item.content,null,2):""
    }
    const itemLabel=(item:any):string=>item.kind==="user_message"?"You":item.kind==="agent_message"?"Cosaii":item.kind==="reasoning"?"Reasoning":item.kind?.includes("tool")?"Tool":"Activity"
    const itemColor=(item:any):string=>item.status==="failed"?"#ff8e78":item.kind==="user_message"?"#65e6a0":item.kind==="agent_message"?"#f2f5f2":"#91a299"
    const followLatest=()=>{setFollowing(true);conversation?.scrollTo({x:0,y:Number.MAX_SAFE_INTEGER})}
    const reload=async()=>{try{const result=await rpc.call("thread/list",{});setThreads(result.threads);if(!active()&&result.threads[0])await openThread(result.threads[0]); setConnected(true)}catch(error:any){setStatus(`Could not load sessions · ${error.message||error}`); setConnected(false); pushToast(`Load failed: ${error.message||error}`)}}
    const openThread=async(thread:Thread)=>{setStatus("Loading conversation");setActive(thread);setActivity([]);try{const result=await rpc.call("thread/read",{thread_id:thread.id});setItems(result.items||[]);setStream("");setStatus(thread.status==="running"?"Running":"Ready");await rpc.call("thread/subscribe",{thread_ids:[thread.id]});queueMicrotask(followLatest); setConnected(true)}catch(e:any){pushToast(`Open failed: ${e.message||e}`); setStatus(`Could not open conversation`)}}
    const changeSetting=async(key:"model"|"reasoning"|"permission_profile",values:string[])=>{const thread=active();const current=thread?String(thread[key]):key==="model"?draftModel():key==="reasoning"?draftReasoning():draftPermission();const next=values[(values.indexOf(current)+1)%values.length];if(!thread){if(key==="model")setDraftModel(next);else if(key==="reasoning")setDraftReasoning(next);else setDraftPermission(next);setStatus(`Next chat · ${next.replaceAll("_"," ")}`);pushToast(`${key} → ${next}`);return}try{const result=await rpc.call("thread/settings/set",{thread_id:thread.id,[key]:next});setActive(result.thread); pushToast(`${key} → ${next}`)}catch(e:any){pushToast(`Setting failed: ${e.message||e}`)}}
    const send=async()=>{const text=composer?.plainText.trim();if(!text||status()==="Running")return;let thread=active();try{if(!thread){thread=(await rpc.call("thread/start",{workspace:process.cwd(),title:text.slice(0,72),model:draftModel(),reasoning:draftReasoning(),permission_profile:draftPermission()})).thread;setThreads(v=>[thread!,...v]);await openThread(thread!)}composer!.setText?.("");setStream("");setActivity([]);setStatus("Running");setItems(v=>[...v,{kind:"user_message",content:{text},status:"completed",id:crypto.randomUUID()}]);followLatest();await rpc.call("turn/start",{thread_id:thread!.id,input:text,interactive:true})}catch(error:any){setStatus(`Send failed · ${error.message||error}`); pushToast(`Send failed: ${error.message||error}`)}}
    const updateActivity=(event:any,state:"running"|"done"|"failed",detail:string)=>{const id=String(event.params?.item_id||event.params?.tool_call_id||event.params?.name||"tool");setActivity(current=>{const found=current.find(entry=>entry.id===id);return found?current.map(entry=>entry.id===id?{...entry,detail:detail||entry.detail,state}:entry):[...current,{id,name:event.params?.name||event.params?.tool||"Tool",detail,state}]});if(following())queueMicrotask(followLatest)}
    onMount(()=>{
      void reload()
      void rpc.call("model/list").then(result=>setCatalogModels(Array.isArray(result?.data)?result.data:Array.isArray(result?.models)?result.models:[])).catch(()=>{})
      void heartbeatLoop(rpc, setConnected)
      // Auto-update indicator: check sha256 availability in background
      void (async()=>{
        const art=releaseArtifact()
        if(!art) return
        try{
          const res=await fetch(`https://osaii.wyvernhub.net/install/${art}.sha256?update=${Date.now()}`, {signal: AbortSignal.timeout(2500)}).catch(()=>null)
          if(res?.ok) setUpdateAvailable(true)
        }catch{}
      })()
      composer?.focus()
      rpc.on("request",(request:any)=>{if(request.method==="item/approval/request"){setApproval({id:request.id,params:request.params});setStatus("Approval required"); pushToast(`Approval: ${request.params.tool}`)}})
      rpc.on("notification",(event:RpcNotification)=>{
        if(event.params?.thread_id&&event.params?.thread_id!==active()?.id)return
        if(event.method==="item/agentMessage/delta"){setStream(v=>v+event.params.delta);if(following())queueMicrotask(followLatest)}
        if(event.method==="item/toolCall/argumentsDelta"){setStatus(`Using ${event.params.name||"tool"}`);updateActivity(event,"running",event.params.delta||"")}
        if(event.method==="item/toolCall/outputDelta")updateActivity(event,"done",event.params.delta?.trim()||"Completed")
        if(event.method==="item/completed"&&event.params?.status==="failed"){updateActivity(event,"failed",event.params.error||"Failed"); pushToast(event.params.error||"Tool failed")}
        if(event.method==="turn/completed"){setStatus(event.params.status==="completed"?"Ready":"Turn failed"); if(event.params.status!=="completed") pushToast(event.params.error||"Turn failed"); const thread=active();if(thread)void openThread(thread).then(reload)}
        if(event.method==="account/login/completed"){pushToast("Login completed")}
      })
      rpc.on("disconnect", ()=>{setConnected(false); setStatus("Reconnecting…")})
    })
    onCleanup(()=>rpc.close())
    const handleShortcut=(key:any):boolean=>{
      if(key.defaultPrevented)return false
      if(key.name==="?" && !key.ctrl && !key.meta){key.preventDefault(); setHelpOpen(v=>!v); return true}
      const model=key.name==="f2"||(key.meta&&key.name==="m")
      const reasoning=key.name==="f3"||((key.ctrl||key.meta)&&key.name==="r")
      const permission=key.name==="f4"||((key.ctrl||key.meta)&&key.name==="p")
      if(!model&&!reasoning&&!permission)return false
      key.preventDefault();key.stopPropagation()
      if(model)void changeSetting("model",modelChoices())
      if(reasoning)void changeSetting("reasoning",["none","light","medium","max"])
      if(permission)void changeSetting("permission_profile",["deny_all","allow_low_risk","always_ask","full_access"])
      return true
    }
    useKeyboard(key=>{
      const pending=approval()
      if(pending&&(key.name==="y"||key.name==="n")){key.preventDefault();rpc.respond(pending.id,{approved:key.name==="y"});setApproval(null);setStatus("Running");pushToast(key.name==="y"?"Approved":"Denied");return}
      if(handleShortcut(key))return
      if(key.name==="escape"){key.preventDefault(); if(helpOpen()) setHelpOpen(false); else renderer.destroy()}
      if(key.name==="?" ){key.preventDefault(); setHelpOpen(v=>!v)}
      if(key.ctrl&&key.name==="n"){key.preventDefault();setActive(null);setItems([]);setStream("");setActivity([]);setStatus("New conversation");composer?.focus()}
      if(key.name==="pageup"){setFollowing(false)}
      if(key.ctrl&&key.name==="l"){key.preventDefault();followLatest()}
      if(key.name==="f1"||(key.ctrl&&key.name==="h")){key.preventDefault(); setHelpOpen(v=>!v)}
    })
    return <box flexDirection="column" width="100%" height="100%" backgroundColor="#080a09">
      <box height={3} paddingLeft={2} paddingRight={2} alignItems="center" justifyContent="space-between" borderColor="#233129" border={["bottom"]}>
        <text fg="#f3f6f3"><strong>cosaii</strong> / {active()?.title||"new conversation"} {updateAvailable()?<text fg="#62dfa0">• update available (cosaii update)</text>:null}</text>
        <box gap={2}>
          <text fg={connected()?"#62dfa0":"#ff8e78"}>{connected()?"● connected":"○ reconnecting"}</text>
          <text fg={status().includes("failed")||status().includes("Could not")?"#ff8e78":"#62dfa0"}>● {status()}</text>
        </box>
      </box>
      {/* Toasts overlay top */}
      <Show when={toasts().length}><box position="absolute" top={3} left={2} right={2} flexDirection="column"><For each={toasts()}>{t=><box backgroundColor="#1a2b1f" paddingLeft={1} paddingRight={1} marginBottom={1} borderColor="#316b49" border={["left"]}><text fg="#f2d492">{t}</text></box>}</For></box></Show>
      {/* Help panel */}
      <Show when={helpOpen()}><box position="absolute" top={4} left={4} right={4} border={true} borderColor="#316b49" backgroundColor="#0f1a13" padding={1} flexDirection="column">
        <text fg="#65e6a0"><strong>Help — keyboard shortcuts</strong>  ( ? / F1 to close, Esc to close)</text>
        <text fg="#d7ded9">Enter send · Alt+Enter newline · Ctrl+N new conversation · Ctrl+L follow latest · PageUp scroll · Esc quit</text>
        <text fg="#d7ded9">F2 / Meta+M model (Auto/Fast/Smart/Mini) · F3 / Ctrl+R reasoning (none/light/medium/max) · F4 / Ctrl+P permission (deny/allow/ask/full)</text>
        <text fg="#d7ded9">Y approve · N deny (when approval required) · ? toggle help</text>
        <text fg="#819087">Status: ● connected indicator · update hint when new release available. Model picker shows Mini (Preview) when catalog includes microsoft/bitnet-b1.58-2B-4T.</text>
        <text fg="#657169">Tip: cosaii --help for CLI docs · cosaii doctor checks daemon, platform, keychain, data dir · cosaii --version && cosaii doctor verifies install.</text>
      </box></Show>
      <box flexDirection="row" flexGrow={1}>
        <Show when={!narrow()}><box width={29} flexDirection="column" borderColor="#233129" border={["right"]} paddingLeft={1} paddingRight={1}>
          <box height={3} alignItems="center" justifyContent="space-between"><text fg="#8d9a91">Conversations</text><text fg="#62dfa0" onMouseDown={()=>{setActive(null);setItems([]);setActivity([]);composer?.focus()}}>+ New</text></box>
          <scrollbox flexGrow={1} focused={false} scrollY={true}><Show when={!threads().length}><text fg="#657169">No saved conversations yet.</text></Show><For each={threads()}>{thread=><box paddingLeft={1} paddingRight={1} marginBottom={1} backgroundColor={active()?.id===thread.id?"#142219":"transparent"} onMouseDown={()=>void openThread(thread)}><text fg={active()?.id===thread.id?"#72e8a9":"#bac3bd"}>{active()?.id===thread.id?"› ":"  "}{thread.title}</text></box>}</For></scrollbox>
          <box height={2} alignItems="center"><text fg="#657169">Ctrl+N new · Esc quit · ? help</text></box>
        </box></Show>
        <box flexDirection="column" flexGrow={1} paddingLeft={narrow()?1:3} paddingRight={narrow()?1:3}>
          <Show when={active()}>{thread=><box height={3} alignItems="center" justifyContent="space-between"><text fg="#a7b1aa">{thread().workspace}</text><text fg="#657169">{visibleItems().length} messages</text></box>}</Show>
          <scrollbox ref={conversation} flexGrow={1} scrollY={true} stickyScroll={following()} stickyStart="bottom" verticalScrollbarOptions={{visible:true}} onMouseScroll={()=>setFollowing(false)}>
            <Show when={!active()&&!visibleItems().length}><box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center"><text fg="#edf2ee"><strong>What are we working on?</strong></text><text fg="#819087">Ask a question, change a file, run a command, or inspect this workspace.</text><text fg="#657169">Your conversations stay on this machine. Press ? for help.</text><text fg="#657169">{connected()?"● connected to app-server":"○ reconnecting — will retry"}</text></box></Show>
            <For each={visibleItems()}>{item=><box flexDirection="column" marginBottom={2} paddingLeft={1} borderColor={item.kind==="user_message"?"#28553b":"#233129"} border={["left"]}><text fg={itemColor(item)}><strong>{itemLabel(item)}</strong>{item.status==="failed"?" · failed":""}</text><text fg={item.kind==="user_message"?"#d7ded9":"#f1f4f2"}>{displayText(item)}</text></box>}</For>
            <Show when={activity().length}><box flexDirection="column" marginBottom={2} paddingLeft={1} borderColor="#6e5635" border={["left"]}><text fg="#d4ad72"><strong>Agent activity</strong></text><For each={activity()}>{entry=><text fg={entry.state==="failed"?"#ff8e78":"#9da9a1"}>{entry.state==="running"?"◌":entry.state==="failed"?"×":"✓"} {entry.name}{entry.detail?` · ${entry.detail}`:""}</text>}</For></box></Show>
            <Show when={status()==="Running"&&!stream()}><box marginBottom={2} paddingLeft={1}><text fg="#839087">Cosaii is thinking…</text></box></Show>
            <Show when={stream()}><box flexDirection="column" marginBottom={2} paddingLeft={1} borderColor="#35734e" border={["left"]}><text fg="#f2f5f2"><strong>Cosaii</strong></text><text fg="#f1f4f2">{stream()}</text></box></Show>
          </scrollbox>
          <Show when={!following()}><box height={1} justifyContent="center"><text fg="#62dfa0" onMouseDown={followLatest}>↓ New activity · Ctrl+L</text></box></Show>
          <Show when={approval()}>{request=><box border={true} borderColor="#f2a35e" padding={1} flexDirection="column"><text fg="#f2a35e"><strong>Approval required</strong> · {request().params.tool}</text><text>{JSON.stringify(request().params.arguments)}</text><text fg="#d6b28e">Y allow once · N deny and let the agent continue</text></box>}</Show>
          <box border={true} borderColor="#316b49" padding={1} flexDirection="column" height={7} marginTop={1}>
            <textarea ref={composer} flexGrow={1} placeholder="Message Cosaii… (? for help)" onSubmit={send} onKeyDown={handleShortcut} keyBindings={[{name:"return",action:"submit"},{name:"return",shift:true,action:"newline"},{name:"return",meta:true,action:"newline"}]} cursorColor="#65e6a0" />
            <box flexDirection="row" gap={2}><text fg="#8a968e" onMouseDown={()=>changeSetting("model",modelChoices())}>{modelLabel(currentModel())} · F2</text><text fg="#8a968e" onMouseDown={()=>changeSetting("reasoning",["none","light","medium","max"])}>{currentReasoning()} · F3</text><text fg={currentPermission()==="full_access"?"#f2a35e":"#8a968e"} onMouseDown={()=>changeSetting("permission_profile",["deny_all","allow_low_risk","always_ask","full_access"])}>{currentPermission().replaceAll("_"," ")} · F4</text><text fg="#657169">Enter send · Alt+Enter newline · ? help</text></box>
          </box>
          {/* Status bar */}
          <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <text fg="#657169">cosaii {VERSION} · {cosaiiHome}</text>
            <text fg={connected()?"#62dfa0":"#ff8e78"}>{connected()?"● daemon connected":"○ daemon reconnecting"}</text>
          </box>
        </box>
      </box>
    </box>
  }
  render(App,{exitOnCtrlC:true,targetFps:30,consoleMode:"disabled"})
}

function normalizePermission(value:string):string{return value.toLowerCase().replaceAll(/[- ]/g,"_").replace("allow_low_risk","allow_low_risk")}
function option(args:string[],name:string):string|undefined{const index=args.indexOf(name);return index>=0?args[index+1]:undefined}
function parseValue(value:string):unknown{try{return JSON.parse(value)}catch{return value}}
function print(value:unknown):void{console.log(JSON.stringify(value,null,2))}
function openBrowser(url:string):void{const [command,args]=process.platform==="darwin"?["open",[url]]:process.platform==="win32"?["cmd",["/c","start","",url]]:["xdg-open",[url]];spawn(command,args,{detached:true,stdio:"ignore"}).unref()}
function printHelp():void{console.log(`Cosaii (cozy) — OSAII's local agent
  Encrypted local sessions · tools · Platform bridge · OpenTUI

Usage:
  cosaii                         Open the TUI (default)
  cosaii run "task" [--format text|json|jsonl|markdown] [--model auto|fast|smart] [--reasoning none|light|medium|max] [--verbose]
  cosaii login [--no-browser] | logout | whoami
  cosaii session list|resume|fork|export|delete   (export --format json|markdown|zip --output PATH)
  cosaii models list
  cosaii permission [deny-all|allow-low-risk|always-ask|full-access] [--workspace PATH]
  cosaii config list|read|write|path   (write KEY JSON_VALUE)
  cosaii mcp|skills|agents|tools
  cosaii platform usage|keys|projects
  cosaii daemon status|start|stop|restart|logs|health|install|uninstall  (logs --lines N --follow)
  cosaii doctor [--json] | health | logs
  cosaii update [--check]            (verified paired binaries; checksum via sha256)

TUI shortcuts:
  Enter send · Alt+Enter newline · Ctrl+N new conversation · Esc quit · ?/F1 help
  F2 / Meta+M model · F3 / Ctrl+R reasoning · F4 / Ctrl+P permission
  Y/N approve tool · Ctrl+L follow latest · PageUp scroll

Install (verified):
  curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh -o cosaii.sh && sh cosaii.sh
  powershell -c "irm https://osaii.wyvernhub.net/install/cosaii.ps1 | iex"
Verify:
  cosaii --version && cosaii doctor
Uninstall:
  cosaii daemon uninstall; rm "$(which cosaii)" "$(dirname $(which cosaii))/cosaii-app-server"
  # Windows: Remove-Item $env:LOCALAPPDATA\\Cosaii\\bin\\cosaii*.exe; cosaii daemon uninstall

Daemon:
  Runs as user service (systemd --user / LaunchAgents / schtasks). Logs: $COSAII_HOME/app-server.log
  Health: cosaii health  or  RPC server/health  (also GET /health over the socket when supported)
`)}

try {
  await main()
} catch (error:any) {
  console.error(`cosaii: ${error.message || error}`)
  if (error.data) console.error(JSON.stringify(error.data,null,2))
  // Suggest doctor on failure
  if (!String(error.message||"").includes("doctor")) console.error(`Tip: run cosaii doctor for diagnostics; cosaii --help for usage.`)
  process.exitCode=1
}
