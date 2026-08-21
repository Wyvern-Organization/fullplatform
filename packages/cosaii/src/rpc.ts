import { EventEmitter } from "node:events"
import net, { type Socket } from "node:net"
import { randomBytes } from "node:crypto"
import type { RpcId, RpcNotification, RpcResponse } from "./protocol"

/** Small RFC 6455 client for the permission-restricted Unix socket. */
class UnixWebSocket extends EventEmitter {
  private socket?: Socket
  private buffer = Buffer.alloc(0)
  private upgraded = false

  async connect(socketPath:string):Promise<void> {
    await new Promise<void>((resolve,reject)=>{
      const socket=net.createConnection(socketPath)
      this.socket=socket
      const key=randomBytes(16).toString("base64")
      socket.once("connect",()=>socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
      socket.once("error",reject)
      socket.on("data",chunk=>{
        this.buffer=Buffer.concat([this.buffer,Buffer.from(chunk)])
        if(!this.upgraded){const end=this.buffer.indexOf("\r\n\r\n");if(end<0)return;const headers=this.buffer.subarray(0,end).toString();if(!headers.startsWith("HTTP/1.1 101")){reject(new Error(`App-server WebSocket handshake failed: ${headers.split("\r\n")[0]}`));socket.destroy();return}this.buffer=this.buffer.subarray(end+4);this.upgraded=true;resolve()}
        this.parseFrames()
      })
      socket.on("close",()=>this.emit("close"))
    })
  }
   send(text:string):void { this.socket?.write(frame(Buffer.from(text),1)) }
  ping():void { if(this.socket&&!this.socket.destroyed){this.socket.write(frame(Buffer.alloc(0),9))} }
  close():void { if(this.socket&&!this.socket.destroyed){this.socket.write(frame(Buffer.alloc(0),8));this.socket.end()} }
  private parseFrames():void {
    while(this.buffer.length>=2){const first=this.buffer[0],second=this.buffer[1];let offset=2,length=second&0x7f;if(length===126){if(this.buffer.length<4)return;length=this.buffer.readUInt16BE(2);offset=4}else if(length===127){if(this.buffer.length<10)return;const value=this.buffer.readBigUInt64BE(2);if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("WebSocket frame is too large");length=Number(value);offset=10}const masked=Boolean(second&0x80);if(masked)offset+=4;if(this.buffer.length<offset+length)return;let payload=this.buffer.subarray(offset,offset+length);if(masked){const mask=this.buffer.subarray(offset-4,offset);payload=Buffer.from(payload.map((byte,i)=>byte^mask[i%4]))}this.buffer=this.buffer.subarray(offset+length);const opcode=first&0x0f;if(opcode===1)this.emit("message",payload.toString());else if(opcode===8){this.socket?.end();return}else if(opcode===9)this.socket?.write(frame(payload,10))}
  }
}

function frame(payload:Buffer,opcode:number):Buffer {
  const mask=randomBytes(4),length=payload.length
  const header=length<126?Buffer.alloc(2):length<=0xffff?Buffer.alloc(4):Buffer.alloc(10)
  header[0]=0x80|opcode
  if(length<126)header[1]=0x80|length
  else if(length<=0xffff){header[1]=0x80|126;header.writeUInt16BE(length,2)}
  else{header[1]=0x80|127;header.writeBigUInt64BE(BigInt(length),2)}
  const masked=Buffer.alloc(length);for(let i=0;i<length;i++)masked[i]=payload[i]^mask[i%4]
  return Buffer.concat([header,mask,masked])
}

export class RpcClient extends EventEmitter {
  private ws?: UnixWebSocket
  private nextId = 1
  private pending = new Map<number, { resolve(value:any):void; reject(error:Error):void }>()
  private heartbeat?: ReturnType<typeof setInterval>
  private reconnectAttempts = 0

  async connect(socketPath: string, attempt = 0): Promise<void> {
    const ws=new UnixWebSocket();this.ws=ws
    ws.on("message",raw=>this.onMessage(raw))
    ws.on("close",()=>{this.emit("disconnect"); this.stopHeartbeat()})
    try {
      await ws.connect(socketPath)
    } catch (error) {
      if (attempt < 3) {
        const delay = Math.min(200 * Math.pow(2, attempt), 2000)
        await Bun.sleep(delay)
        return this.connect(socketPath, attempt+1)
      }
      throw error
    }
    await this.call("initialize", {
      protocol_version: 1,
      client_name: "cosaii",
      client_version: "0.1.0",
      capabilities: { tui: process.stdout.isTTY, reverse_requests: true },
      notifications: ["thread/*", "turn/*", "item/*", "account/*", "fs/*"],
    })
    this.notify("initialized", {})
    this.startHeartbeat()
    this.reconnectAttempts = 0
  }

  private startHeartbeat():void {
    this.stopHeartbeat()
    // heartbeat ping every 25s, plus application-level health probe every 30s is handled by caller
    this.heartbeat = setInterval(()=>{ try{ (this.ws as any)?.ping?.() } catch{} }, 25_000)
    // Don't block process exit
    ;(this.heartbeat as any)?.unref?.()
  }
  private stopHeartbeat():void { if(this.heartbeat){ clearInterval(this.heartbeat); this.heartbeat=undefined } }

  /** Reconnect with exponential backoff (used by TUI if needed) */
  async reconnect(socketPath: string): Promise<void> {
    this.close()
    let delay = 200
    for (let i=0; i<5; i++) {
      try { await this.connect(socketPath); return } catch { await Bun.sleep(delay); delay = Math.min(delay*2, 2000) }
    }
    throw new Error("Could not reconnect to cosaii-app-server (try cosaii daemon restart)")
  }

  call<T=any>(method: string, params: unknown = {}): Promise<T> {
    if (!this.ws) return Promise.reject(new Error("Cosaii app-server is not connected"))
    const id = this.nextId++
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  notify(method: string, params: unknown = {}): void { this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method, params })) }
  respond(id:RpcId, result:unknown):void { this.ws?.send(JSON.stringify({jsonrpc:"2.0",id,result})) }
  close(): void { this.stopHeartbeat(); this.ws?.close(); for(const [,p] of this.pending) p.reject(new Error("Cosaii app-server disconnected")); this.pending.clear() }
  private onMessage(raw: string): void {
    let message: RpcResponse | RpcNotification
    try { message = JSON.parse(raw) } catch { return }
    if ("id" in message && "method" in message) { this.emit("request",message);return }
    if ("id" in message) { const id=Number(message.id),pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);if(message.error)pending.reject(Object.assign(new Error(message.error.message),message.error));else pending.resolve(message.result);return }
    this.emit("notification", message);this.emit(message.method,message.params)
  }
}
