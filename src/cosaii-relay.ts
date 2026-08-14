import { DurableObject } from "cloudflare:workers";

type RelayAttachment = {
  role: "host" | "client";
  connectionId: string;
  accountId: number;
  connectedAt: number;
};

const MAX_RELAY_FRAME_BYTES = 256 * 1024;

/**
 * One relay instance coordinates one enrolled Cosaii environment. Frames are
 * already end-to-end encrypted by clients. This object deliberately stores no
 * frame or transcript content and can therefore hibernate safely.
 */
export class CosaiiRelay extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 });
    if (request.headers.get("x-cosaii-relay-authorized") !== "1")
      return new Response("Forbidden", { status: 403 });

    const role = request.headers.get("x-cosaii-relay-role");
    const connectionId = request.headers.get("x-cosaii-connection-id") || "";
    const accountId = Number(request.headers.get("x-cosaii-account-id") || 0);
    if ((role !== "host" && role !== "client") || !connectionId || !accountId)
      return new Response("Invalid relay identity", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role, `account:${accountId}`]);
    server.serializeAttachment({
      role,
      connectionId,
      accountId,
      connectedAt: Date.now(),
    } satisfies RelayAttachment);

    this.sendPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(source: WebSocket, message: string | ArrayBuffer): void {
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_RELAY_FRAME_BYTES) {
      source.close(1009, "Encrypted relay frame too large");
      return;
    }
    const sender = source.deserializeAttachment() as RelayAttachment | null;
    if (!sender) {
      source.close(1008, "Missing relay identity");
      return;
    }
    for (const socket of this.ctx.getWebSockets(sender.role === "host" ? "client" : "host")) {
      try {
        socket.send(message);
      } catch {
        // A hibernated socket can disappear between enumeration and send.
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    try {
      socket.close(code, reason);
    } finally {
      void wasClean;
      this.sendPresence();
    }
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "Relay connection failed");
    } finally {
      this.sendPresence();
    }
  }

  private sendPresence(): void {
    const hosts = this.ctx.getWebSockets("host").length;
    const clients = this.ctx.getWebSockets("client").length;
    const payload = JSON.stringify({ type: "relay.presence", hosts, clients });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Presence is advisory; never retain it for replay.
      }
    }
  }
}
