import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { constants, openSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { RpcClient } from "./rpc"

// Snap/Flatpak launchers may rewrite HOME to an app-specific directory. The
// OS account record remains the stable location users expect across terminals,
// editors, and desktop launchers.
const accountHome = userInfo().homedir || homedir()
const defaultConfigRoot = process.platform === "win32"
  ? process.env.LOCALAPPDATA || join(accountHome, "AppData", "Local")
  : process.platform === "darwin" ? join(accountHome, "Library", "Application Support") : join(accountHome, ".config")
const defaultDataRoot = process.platform === "win32"
  ? process.env.LOCALAPPDATA || join(accountHome, "AppData", "Local")
  : process.platform === "darwin" ? join(accountHome, "Library", "Application Support") : join(accountHome, ".local", "share")
export const cosaiiHome = process.env.COSAII_HOME || join(defaultConfigRoot, "cosaii")
export const cosaiiDataDir = process.env.COSAII_DATA_DIR || join(defaultDataRoot, "cosaii")
const windowsUser = (process.env.USERNAME || "user").replace(/[^a-z0-9]/gi, "-")
export const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\cosaii-app-server-${windowsUser}` : join(cosaiiHome, "app-server.sock")
const pidPath = join(cosaiiHome, "app-server.pid")

export async function socketResponds(): Promise<boolean> {
  const rpc = new RpcClient()
  try {
    await Promise.race([
      rpc.connect(socketPath),
      Bun.sleep(750).then(() => { throw new Error("status timeout") }),
    ])
    const status = await rpc.call("server/status")
    return Boolean(status?.version && status?.protocol)
  } catch { return false }
  finally { rpc.close() }
}

export function serverBinary(): string {
  if (process.env.COSAII_APP_SERVER_BIN) return process.env.COSAII_APP_SERVER_BIN
  const executable = process.execPath
  const sibling = join(dirname(executable), process.platform === "win32" ? "cosaii-app-server.exe" : "cosaii-app-server")
  return sibling
}

export async function ensureDaemon(): Promise<void> {
  if (await socketResponds()) return
  await mkdir(cosaiiHome, { recursive: true, mode: 0o700 })
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim())
    if (pid && processIsAlive(pid)) throw new Error(`Cosaii app-server process ${pid} is alive but unavailable. Run cosaii daemon restart.`)
    await rm(socketPath, { force: true })
  } catch (error:any) {
    if (error.code !== "ENOENT" && !String(error.message).includes("is alive")) throw error
    if (String(error.message).includes("is alive")) throw error
  }
  const binary = serverBinary()
  await access(binary, constants.X_OK).catch(() => { throw new Error(`Cannot find ${binary}. Install a release containing both cosaii and cosaii-app-server, or set COSAII_APP_SERVER_BIN.`) })
  const logFd = openSync(join(cosaiiHome, "app-server.log"), "a", 0o600)
  const child = spawn(binary, [], { detached: true, stdio: ["ignore", logFd, logFd], env:{...process.env,COSAII_HOME:cosaiiHome,COSAII_DATA_DIR:cosaiiDataDir} })
  child.unref()
  for (let attempt=0; attempt<50; attempt++) {
    await Bun.sleep(100)
    if (await socketResponds()) return
  }
  throw new Error("Cosaii app-server did not become ready. Run cosaii daemon logs.")
}

export async function daemonPid(): Promise<number|null> { try { return Number((await readFile(pidPath,"utf8")).trim()) || null } catch { return null } }
export function processIsAlive(pid:number):boolean { try { process.kill(pid,0); return true } catch { return false } }
export async function stopDaemon():Promise<boolean> { const pid=await daemonPid(); if(!pid||!processIsAlive(pid)) return false; process.kill(pid,"SIGTERM"); return true }
export function daemonLogPath():string { return join(cosaiiHome,"app-server.log") }

function run(command:string,args:string[]):Promise<void>{return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:"inherit"});child.once("exit",code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));child.once("error",reject)})}

export async function installDaemonService():Promise<void>{
  const binary=serverBinary()
  await access(binary,constants.X_OK)
  if(process.platform==="linux"){
    const unitDir=join(homedir(),".config","systemd","user"),unit=join(unitDir,"cosaii-app-server.service")
    await mkdir(unitDir,{recursive:true,mode:0o700})
    await writeFile(unit,`[Unit]\nDescription=Cosaii local app-server\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=COSAII_SERVICE=1\nEnvironment=COSAII_HOME=${cosaiiHome.replaceAll("%","%%")}\nEnvironment=COSAII_DATA_DIR=${cosaiiDataDir.replaceAll("%","%%")}\nExecStart=${binary.replaceAll("%","%%")}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`,{mode:0o600})
    await run("systemctl",["--user","daemon-reload"]);await run("systemctl",["--user","enable","--now","cosaii-app-server.service"]);return
  }
  if(process.platform==="darwin"){
    const dir=join(homedir(),"Library","LaunchAgents"),plist=join(dir,"net.wyvernhub.cosaii-app-server.plist")
    await mkdir(dir,{recursive:true})
    await writeFile(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>net.wyvernhub.cosaii-app-server</string><key>ProgramArguments</key><array><string>${binary.replaceAll("&","&amp;").replaceAll("<","&lt;")}</string></array><key>EnvironmentVariables</key><dict><key>COSAII_SERVICE</key><string>1</string><key>COSAII_HOME</key><string>${cosaiiHome.replaceAll("&","&amp;").replaceAll("<","&lt;")}</string><key>COSAII_DATA_DIR</key><string>${cosaiiDataDir.replaceAll("&","&amp;").replaceAll("<","&lt;")}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>`,{mode:0o600})
    await run("launchctl",["bootstrap",`gui/${process.getuid?.()}`,plist]);return
  }
  if(process.platform==="win32"){
    await run("schtasks",["/Create","/TN","Cosaii App Server","/SC","ONLOGON","/TR",`\"${binary}\"`,`/F`]);return
  }
  throw new Error("Daemon service installation is unsupported on this platform")
}

export async function uninstallDaemonService():Promise<void>{
  if(process.platform==="linux"){await run("systemctl",["--user","disable","--now","cosaii-app-server.service"]).catch(()=>{});await rm(join(homedir(),".config","systemd","user","cosaii-app-server.service"),{force:true});await run("systemctl",["--user","daemon-reload"]);return}
  if(process.platform==="darwin"){const plist=join(homedir(),"Library","LaunchAgents","net.wyvernhub.cosaii-app-server.plist");await run("launchctl",["bootout",`gui/${process.getuid?.()}`,plist]).catch(()=>{});await rm(plist,{force:true});return}
  if(process.platform==="win32"){await run("schtasks",["/Delete","/TN","Cosaii App Server","/F"]);return}
  throw new Error("Daemon service uninstallation is unsupported on this platform")
}
