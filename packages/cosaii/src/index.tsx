#!/usr/bin/env bun
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { access, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { RpcClient } from "./rpc"
import { daemonLogPath, daemonPid, ensureDaemon, installDaemonService, processIsAlive, socketPath, socketResponds, stopDaemon, uninstallDaemonService } from "./daemon"
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

async function main(): Promise<void> {
  if (process.env.COSAII_DEBUG_ARGS) console.error(JSON.stringify(process.argv))
  const rawArgs = process.argv.slice(1)
  const scriptIndex = rawArgs.findIndex(value => /(?:^|\/)(?:index\.tsx|cosaii)$/.test(value) || value.includes("/$bunfs/"))
  const args = scriptIndex >= 0 ? rawArgs.slice(scriptIndex + 1) : rawArgs
  if (!args.length) {
    const rpc = await connect()
    await refreshModelCatalog(rpc)
    return startTui(rpc)
  }
  const [command, ...rest] = args
  if (command === "--version" || command === "-V" || command === "version") return void console.log(`cosaii ${VERSION}`)
  if (command === "--help" || command === "-h" || command === "help") return void printHelp()
  if (command === "daemon") return daemonCommand(rest)
  if (command === "update") return update(rest)
  const rpc = await connect()
  try {
    const refreshedModels = await refreshModelCatalog(rpc)
    if (command === "login") return await login(rpc, rest)
    if (command === "logout") return print(await rpc.call("account/logout"))
    if (command === "whoami") return print(await rpc.call("account/read"))
    if (command === "run") return await runTask(rpc, rest)
    if (command === "session") return await sessionCommand(rpc, rest)
    if (command === "models") return print(refreshedModels ?? await rpc.call("model/list"))
    if (command === "permission") return await permissionCommand(rpc, rest)
    if (command === "config") return await configCommand(rpc, rest)
    if (command === "doctor") return await doctor(rpc)
    if (command === "remote") return await remoteCommand(rpc, rest)
    if (["mcp","skills","agents","tools"].includes(command)) return print(await rpc.call(`${command}/list`))
    if (command === "platform") return print(await rpc.call(`platform/${rest[0] || "usage"}`))
    if (command === "app-server") return void console.error("Run cosaii-app-server directly for server options.")
    throw new Error(`Unknown command: ${command}`)
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
  }finally{await rm(staging,{recursive:true,force:true}).catch(()=>{})}
}

function releaseArtifact():string|undefined{
  if(process.platform==="linux"&&process.arch==="x64") return "cosaii-linux-x64.tar.gz"
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
  const task = args.filter((_,i)=>!(["--format"].includes(args[i-1])||args[i]==="--format")).join(" ").trim()
  if (!task) throw new Error('Usage: cosaii run "task" --format text|json|jsonl')
  const thread = (await rpc.call("thread/start", { workspace:process.cwd(), title:task.slice(0,72), model:"auto", permission_profile:"always_ask" })).thread
  const events:any[]=[]
  let failure=""
  const completed = new Promise<void>((resolve,reject) => rpc.on("notification",(event:RpcNotification)=>{
    if (event.params?.thread_id !== thread.id) return
    events.push(event)
    if (format === "jsonl") console.log(JSON.stringify(event))
    if (format === "text" && event.method === "item/agentMessage/delta") process.stdout.write(event.params.delta)
    if (event.method === "item/completed" && event.params.status === "failed") failure=event.params.error||failure
    if (event.method === "turn/completed") event.params.status === "completed" ? resolve() : reject(new Error(event.params.error || failure || "Turn failed"))
  }))
  await rpc.call("thread/subscribe", { thread_ids:[thread.id] })
  await rpc.call("turn/start", { thread_id:thread.id, input:task, interactive:false })
  await completed
  if (format === "text") process.stdout.write("\n")
  if (format === "json") console.log(JSON.stringify({ thread_id:thread.id, events },null,2))
}

async function sessionCommand(rpc:RpcClient,args:string[]):Promise<void> {
  const action=args[0]||"list", id=args[1]
  if(action==="list") return print(await rpc.call("thread/list",{archived:args.includes("--archived"),query:option(args,"--query")||""}))
  if(!id) throw new Error(`Usage: cosaii session ${action} THREAD_ID`)
  const methods:Record<string,string>={resume:"thread/read",fork:"thread/fork",delete:"thread/delete",archive:"thread/archive",unarchive:"thread/unarchive"}
  if(action==="export") return print(await rpc.call("thread/export",{thread_id:id,format:option(args,"--format")||"json",path:option(args,"--output")}))
  if(action==="import") return print(await rpc.call("thread/import",{path:id,workspace:process.cwd()}))
  if(!methods[action]) throw new Error(`Unknown session action: ${action}`)
  print(await rpc.call(methods[action],{thread_id:id}))
}

async function permissionCommand(rpc:RpcClient,args:string[]):Promise<void>{if(!args.length)return print(await rpc.call("permissionProfile/list"));print(await rpc.call("permissionProfile/set",{profile:normalizePermission(args[0]),workspace:option(args,"--workspace")}))}
async function configCommand(rpc:RpcClient,args:string[]):Promise<void>{const action=args[0]||"read",key=args[1];if(!key)throw new Error("Usage: cosaii config read KEY | write KEY JSON_VALUE");if(action==="read")return print(await rpc.call("config/read",{scope:"global",key}));if(action==="write")return print(await rpc.call("config/write",{scope:"global",key,value:parseValue(args.slice(2).join(" "))}));throw new Error(`Unknown config action: ${action}`)}
async function doctor(rpc:RpcClient):Promise<void>{const status=await rpc.call("server/status");const account=await rpc.call("account/read");console.log(`App-server: ready (${status.version}, pid ${status.pid})\nProtocol: ${status.protocol.min}-${status.protocol.max}\nData: ${status.data_dir}\nAccount: ${account.email || "not signed in"}\nWorkspace: ${process.cwd()}`)}
async function remoteCommand(rpc:RpcClient,args:string[]):Promise<void>{const action=args[0]||"status";if(action==="enable")return print(await rpc.call("remoteControl/enable",{name:option(args,"--name")}));if(action==="disable")return print(await rpc.call("remoteControl/disable"));if(action==="status")return print(await rpc.call("remoteControl/status"));if(action==="pair")return print(await rpc.call("remoteControl/pairing/start"));if(action==="devices")return print(await rpc.call("remoteControl/client/list"));throw new Error(`Unknown remote action: ${action}`)}

async function daemonCommand(args:string[]):Promise<void>{const action=args[0]||"status";if(action==="status"){const pid=await daemonPid();console.log(await socketResponds()?`running (pid ${pid})`:pid&&processIsAlive(pid)?`process ${pid} alive, socket unavailable`:"stopped");return}if(action==="start"){await ensureDaemon();console.log("Cosaii app-server started.");return}if(action==="stop"){console.log(await stopDaemon()?"Cosaii app-server stopping.":"Cosaii app-server is not running.");return}if(action==="restart"){await stopDaemon();await Bun.sleep(300);await ensureDaemon();console.log("Cosaii app-server restarted.");return}if(action==="logs"){console.log(await readFile(daemonLogPath(),"utf8").catch(()=>"No app-server log yet."));return}if(action==="install"){await installDaemonService();console.log("Cosaii app-server installed as a user service.");return}if(action==="uninstall"){await uninstallDaemonService();console.log("Cosaii app-server user service removed.");return}throw new Error(`Unknown daemon action: ${action}`)}

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
    const reload=async()=>{try{const result=await rpc.call("thread/list",{});setThreads(result.threads);if(!active()&&result.threads[0])await openThread(result.threads[0])}catch(error:any){setStatus(`Could not load sessions · ${error.message||error}`)}}
    const openThread=async(thread:Thread)=>{setStatus("Loading conversation");setActive(thread);setActivity([]);const result=await rpc.call("thread/read",{thread_id:thread.id});setItems(result.items||[]);setStream("");setStatus(thread.status==="running"?"Running":"Ready");await rpc.call("thread/subscribe",{thread_ids:[thread.id]});queueMicrotask(followLatest)}
    const changeSetting=async(key:"model"|"reasoning"|"permission_profile",values:string[])=>{const thread=active();const current=thread?String(thread[key]):key==="model"?draftModel():key==="reasoning"?draftReasoning():draftPermission();const next=values[(values.indexOf(current)+1)%values.length];if(!thread){if(key==="model")setDraftModel(next);else if(key==="reasoning")setDraftReasoning(next);else setDraftPermission(next);setStatus(`Next chat · ${next.replaceAll("_"," ")}`);return}const result=await rpc.call("thread/settings/set",{thread_id:thread.id,[key]:next});setActive(result.thread)}
    const send=async()=>{const text=composer?.plainText.trim();if(!text||status()==="Running")return;let thread=active();try{if(!thread){thread=(await rpc.call("thread/start",{workspace:process.cwd(),title:text.slice(0,72),model:draftModel(),reasoning:draftReasoning(),permission_profile:draftPermission()})).thread;setThreads(v=>[thread!,...v]);await openThread(thread!)}composer!.setText?.("");setStream("");setActivity([]);setStatus("Running");setItems(v=>[...v,{kind:"user_message",content:{text},status:"completed",id:crypto.randomUUID()}]);followLatest();await rpc.call("turn/start",{thread_id:thread!.id,input:text,interactive:true})}catch(error:any){setStatus(`Send failed · ${error.message||error}`)}}
    const updateActivity=(event:any,state:"running"|"done"|"failed",detail:string)=>{const id=String(event.params?.item_id||event.params?.tool_call_id||event.params?.name||"tool");setActivity(current=>{const found=current.find(entry=>entry.id===id);return found?current.map(entry=>entry.id===id?{...entry,detail:detail||entry.detail,state}:entry):[...current,{id,name:event.params?.name||event.params?.tool||"Tool",detail,state}]});if(following())queueMicrotask(followLatest)}
    onMount(()=>{void reload();void rpc.call("model/list").then(result=>setCatalogModels(Array.isArray(result?.data)?result.data:Array.isArray(result?.models)?result.models:[])).catch(()=>{});composer?.focus();rpc.on("request",(request:any)=>{if(request.method==="item/approval/request"){setApproval({id:request.id,params:request.params});setStatus("Approval required")}});rpc.on("notification",(event:RpcNotification)=>{if(event.params?.thread_id&&event.params?.thread_id!==active()?.id)return;if(event.method==="item/agentMessage/delta"){setStream(v=>v+event.params.delta);if(following())queueMicrotask(followLatest)}if(event.method==="item/toolCall/argumentsDelta"){setStatus(`Using ${event.params.name||"tool"}`);updateActivity(event,"running",event.params.delta||"")}if(event.method==="item/toolCall/outputDelta")updateActivity(event,"done",event.params.delta?.trim()||"Completed");if(event.method==="item/completed"&&event.params?.status==="failed")updateActivity(event,"failed",event.params.error||"Failed");if(event.method==="turn/completed"){setStatus(event.params.status==="completed"?"Ready":"Turn failed");const thread=active();if(thread)void openThread(thread).then(reload)}})})
    onCleanup(()=>rpc.close())
    const handleShortcut=(key:any):boolean=>{if(key.defaultPrevented)return false;const model=key.name==="f2"||(key.meta&&key.name==="m");const reasoning=key.name==="f3"||((key.ctrl||key.meta)&&key.name==="r");const permission=key.name==="f4"||((key.ctrl||key.meta)&&key.name==="p");if(!model&&!reasoning&&!permission)return false;key.preventDefault();key.stopPropagation();if(model)void changeSetting("model",modelChoices());if(reasoning)void changeSetting("reasoning",["none","light","medium","max"]);if(permission)void changeSetting("permission_profile",["deny_all","allow_low_risk","always_ask","full_access"]);return true}
    useKeyboard(key=>{const pending=approval();if(pending&&(key.name==="y"||key.name==="n")){key.preventDefault();rpc.respond(pending.id,{approved:key.name==="y"});setApproval(null);setStatus("Running");return}if(handleShortcut(key))return;if(key.name==="escape"){key.preventDefault();renderer.destroy()}if(key.ctrl&&key.name==="n"){key.preventDefault();setActive(null);setItems([]);setStream("");setActivity([]);setStatus("New conversation");composer?.focus()}if(key.name==="pageup"){setFollowing(false)}if(key.ctrl&&key.name==="l"){key.preventDefault();followLatest()}})
    return <box flexDirection="column" width="100%" height="100%" backgroundColor="#080a09">
      <box height={3} paddingLeft={2} paddingRight={2} alignItems="center" justifyContent="space-between" borderColor="#233129" border={["bottom"]}>
        <text fg="#f3f6f3"><strong>cosaii</strong> / {active()?.title||"new conversation"}</text><text fg={status().includes("failed")||status().includes("Could not")?"#ff8e78":"#62dfa0"}>● {status()}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <Show when={!narrow()}><box width={29} flexDirection="column" borderColor="#233129" border={["right"]} paddingLeft={1} paddingRight={1}>
          <box height={3} alignItems="center" justifyContent="space-between"><text fg="#8d9a91">Conversations</text><text fg="#62dfa0" onMouseDown={()=>{setActive(null);setItems([]);setActivity([]);composer?.focus()}}>+ New</text></box>
          <scrollbox flexGrow={1} focused={false} scrollY={true}><Show when={!threads().length}><text fg="#657169">No saved conversations yet.</text></Show><For each={threads()}>{thread=><box paddingLeft={1} paddingRight={1} marginBottom={1} backgroundColor={active()?.id===thread.id?"#142219":"transparent"} onMouseDown={()=>void openThread(thread)}><text fg={active()?.id===thread.id?"#72e8a9":"#bac3bd"}>{active()?.id===thread.id?"› ":"  "}{thread.title}</text></box>}</For></scrollbox>
          <box height={2} alignItems="center"><text fg="#657169">Ctrl+N new · Esc quit</text></box>
        </box></Show>
        <box flexDirection="column" flexGrow={1} paddingLeft={narrow()?1:3} paddingRight={narrow()?1:3}>
          <Show when={active()}>{thread=><box height={3} alignItems="center" justifyContent="space-between"><text fg="#a7b1aa">{thread().workspace}</text><text fg="#657169">{visibleItems().length} messages</text></box>}</Show>
          <scrollbox ref={conversation} flexGrow={1} scrollY={true} stickyScroll={following()} stickyStart="bottom" verticalScrollbarOptions={{visible:true}} onMouseScroll={()=>setFollowing(false)}>
            <Show when={!active()&&!visibleItems().length}><box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center"><text fg="#edf2ee"><strong>What are we working on?</strong></text><text fg="#819087">Ask a question, change a file, run a command, or inspect this workspace.</text><text fg="#657169">Your conversations stay on this machine.</text></box></Show>
            <For each={visibleItems()}>{item=><box flexDirection="column" marginBottom={2} paddingLeft={1} borderColor={item.kind==="user_message"?"#28553b":"#233129"} border={["left"]}><text fg={itemColor(item)}><strong>{itemLabel(item)}</strong>{item.status==="failed"?" · failed":""}</text><text fg={item.kind==="user_message"?"#d7ded9":"#f1f4f2"}>{displayText(item)}</text></box>}</For>
            <Show when={activity().length}><box flexDirection="column" marginBottom={2} paddingLeft={1} borderColor="#6e5635" border={["left"]}><text fg="#d4ad72"><strong>Agent activity</strong></text><For each={activity()}>{entry=><text fg={entry.state==="failed"?"#ff8e78":"#9da9a1"}>{entry.state==="running"?"◌":entry.state==="failed"?"×":"✓"} {entry.name}{entry.detail?` · ${entry.detail}`:""}</text>}</For></box></Show>
            <Show when={status()==="Running"&&!stream()}><box marginBottom={2} paddingLeft={1}><text fg="#839087">Cosaii is thinking…</text></box></Show>
            <Show when={stream()}><box flexDirection="column" marginBottom={2} paddingLeft={1} borderColor="#35734e" border={["left"]}><text fg="#f2f5f2"><strong>Cosaii</strong></text><text fg="#f1f4f2">{stream()}</text></box></Show>
          </scrollbox>
          <Show when={!following()}><box height={1} justifyContent="center"><text fg="#62dfa0" onMouseDown={followLatest}>↓ New activity · Ctrl+L</text></box></Show>
          <Show when={approval()}>{request=><box border={true} borderColor="#f2a35e" padding={1} flexDirection="column"><text fg="#f2a35e"><strong>Approval required</strong> · {request().params.tool}</text><text>{JSON.stringify(request().params.arguments)}</text><text fg="#d6b28e">Y allow once · N deny and let the agent continue</text></box>}</Show>
          <box border={true} borderColor="#316b49" padding={1} flexDirection="column" height={7} marginTop={1}>
            <textarea ref={composer} flexGrow={1} placeholder="Message Cosaii…" onSubmit={send} onKeyDown={handleShortcut} keyBindings={[{name:"return",action:"submit"},{name:"return",shift:true,action:"newline"},{name:"return",meta:true,action:"newline"}]} cursorColor="#65e6a0" />
            <box flexDirection="row" gap={2}><text fg="#8a968e" onMouseDown={()=>changeSetting("model",modelChoices())}>{modelLabel(currentModel())} · F2</text><text fg="#8a968e" onMouseDown={()=>changeSetting("reasoning",["none","light","medium","max"])}>{currentReasoning()} · F3</text><text fg={currentPermission()==="full_access"?"#f2a35e":"#8a968e"} onMouseDown={()=>changeSetting("permission_profile",["deny_all","allow_low_risk","always_ask","full_access"])}>{currentPermission().replaceAll("_"," ")} · F4</text><text fg="#657169">Enter send · Alt+Enter newline</text></box>
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
function printHelp():void{console.log(`Cosaii (cozy) — OSAII's local agent\n\nUsage:\n  cosaii                         Open the TUI\n  cosaii run "task" [--format text|json|jsonl]\n  cosaii login [--no-browser] | logout | whoami\n  cosaii session list|resume|fork|export|delete\n  cosaii models list\n  cosaii permission [deny-all|allow-low-risk|always-ask|full-access]\n  cosaii config read|write\n  cosaii mcp|skills|agents|tools\n  cosaii platform usage|keys|projects\n  cosaii daemon status|start|stop|restart|logs|install|uninstall\n  cosaii doctor | update | completion | remote\n`)}

try {
  await main()
} catch (error:any) {
  console.error(`cosaii: ${error.message || error}`)
  if (error.data) console.error(JSON.stringify(error.data,null,2))
  process.exitCode=1
}
