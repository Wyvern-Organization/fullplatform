// Generated from cosaii-protocol. Kept in-tree so the thin client can bootstrap.
export type RpcId = number | string
export interface RpcRequest { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown }
export interface RpcResponse { jsonrpc: "2.0"; id: RpcId; result?: any; error?: { code: number; message: string; data?: unknown } }
export interface RpcNotification { jsonrpc: "2.0"; method: string; params?: any }
export interface Thread { id:string; title:string; workspace:string; model:string; reasoning:string; permission_profile:string; status:string; pinned:boolean; archived:boolean; updated_at:string }

