import { poolsideModelRequest, type PoolsideEnv } from "./poolside";
import { providerForModel, trackTokenResponse } from "../src/lib/token-usage";
import type { CosaiiRelay } from "../src/cosaii-relay";

export interface CosaiiEnv extends PoolsideEnv {
  DB: D1Database;
  STUDIO_FILES: R2Bucket;
  COSAII_RELAYS: DurableObjectNamespace<CosaiiRelay>;
}

type Account = { id: number; email: string; display_name: string };
type CliIdentity = Account & { device_id: string; scopes: string[] };

const CLI_SCOPES = [
  "inference", "models:read", "usage:read", "keys:read", "keys:write",
  "projects:read", "projects:write", "memory:read", "memory:write",
  "tasks:read", "tasks:write", "plugins:read", "plugins:write",
  "agents:read", "agents:write", "notifications:read", "remote:control",
] as const;

const MODELS = [
  { id: "auto", name: "Auto", family: "auto", reasoning: ["none", "light", "medium", "max"] },
  { id: "poolside/laguna-xs-2.1", name: "Fast", family: "standard", reasoning: ["none", "light", "medium", "max"] },
  { id: "poolside/laguna-s-2.1", name: "Smart", family: "standard", reasoning: ["none", "light", "medium", "max"] },
  { id: "logfare/kimi-k3", name: "Kimi K3", family: "advanced", reasoning: ["none", "light", "medium", "max"] },
  { id: "logfare/minimax-m3", name: "MiniMax M3", family: "advanced", reasoning: ["none", "light", "medium", "max"] },
  { id: "logfare/deepseek-v4-flash", name: "DeepSeek V4 Flash", family: "advanced", reasoning: ["none", "light", "medium", "max"] },
  { id: "logfare/deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "advanced", reasoning: ["none", "light", "medium", "max"] },
] as const;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export async function cosaiiDeviceApi(request: Request, env: CosaiiEnv, path: string): Promise<Response> {
  try {
    if (request.method === "POST" && path === "/device/start") return startDeviceLogin(request, env.DB);
    if (request.method === "POST" && path === "/device/approve") return approveDeviceLogin(request, env.DB);
    if (request.method === "POST" && path === "/device/token") return exchangeDeviceToken(request, env.DB);
    if (request.method === "POST" && path === "/token/refresh") return refreshDeviceToken(request, env.DB);
    if (request.method === "GET" && path === "/devices") return listDevices(request, env.DB);
    const revoke = path.match(/^\/devices\/([0-9a-f-]{36})$/i);
    if (request.method === "DELETE" && revoke) return revokeDevice(request, env.DB, revoke[1]);
    return apiJson({ error: "not_found" }, 404);
  } catch (error) {
    return cosaiiError(error);
  }
}

export async function cosaiiApi(request: Request, env: CosaiiEnv, path: string, ctx: ExecutionContext): Promise<Response> {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    const identity = await cliIdentity(request, env.DB);
    if (!identity) return apiJson({ error: "invalid_cli_token", message: "Log in with cosaii login." }, 401, corsHeaders());

  if (request.method === "GET" && path === "/bootstrap") {
    requireScope(identity, "models:read");
    return apiJson({
      account: { id: identity.id, email: identity.email, display_name: identity.display_name },
      device_id: identity.device_id,
      scopes: identity.scopes,
      models: MODELS,
      limits: { minute: 600, hour: 6_000, day: 20_000, policy: "fair-use" },
      protocol: { min: 1, max: 1 },
    }, 200, corsHeaders());
  }
  if (request.method === "GET" && path === "/models") {
    requireScope(identity, "models:read");
    return apiJson({ object: "list", data: MODELS }, 200, corsHeaders());
  }
  if (request.method === "POST" && path === "/chat") {
    requireScope(identity, "inference");
    return cliChat(request, env, identity, ctx);
  }
  if (path.startsWith("/platform/")) return platformFacade(request, env, identity, path.slice(10));
  if (path.startsWith("/remote/")) return remoteControl(request, env, identity, path.slice(7));
  if (path === "/relay") return relay(request, env, identity);
    return apiJson({ error: "not_found" }, 404, corsHeaders());
  } catch (error) {
    return cosaiiError(error);
  }
}

export async function cosaiiAuthorizePage(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const code = cleanCode(url.searchParams.get("user_code") || "");
  const account = await browserAccount(request, db);
  const grant = code ? await db.prepare(
    "SELECT client_name,requested_scopes,status,expires_at FROM cosaii_device_grants WHERE user_code=? AND expires_at>datetime('now')",
  ).bind(code).first<{ client_name: string; requested_scopes: string; status: string; expires_at: string }>() : null;
  const scopes = grant ? parseScopes(grant.requested_scopes) : [];
  const encodedCode = JSON.stringify(code);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Cosaii · OSAII Platform</title><style>:root{color-scheme:dark;font-family:Inter,system-ui;background:#050706;color:#f4f7f4}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(560px,100%);border:1px solid #243128;background:#090d0a;border-radius:20px;padding:28px}h1{font-size:28px;margin:0 0 8px}.muted{color:#9caaa0;line-height:1.55}.code{font:700 28px ui-monospace;letter-spacing:.16em;color:#5ee39b;margin:20px 0}.scopes{display:grid;gap:8px;margin:20px 0}.scope{padding:9px 12px;border:1px solid #1d2921;border-radius:9px}button,input{width:100%;padding:12px;border-radius:10px;border:1px solid #314138;background:#101712;color:inherit;margin-top:10px}button{background:#37d982;color:#041108;font-weight:800;cursor:pointer}.deny{background:#171312;color:#ffb9ac}a{color:#65e8a1}</style></head><body><main class="card"><small>OSAII PLATFORM</small><h1>Authorize Cosaii</h1>${!grant ? `<p class="muted">This code is invalid or expired. Return to the terminal and start login again.</p>` : !account ? `<p class="muted">Sign in to your Platform account, then this page will return to the authorization request.</p><input id="email" type="email" placeholder="Email"><input id="password" type="password" placeholder="Password"><button id="login">Sign in</button><p id="status" class="muted"></p>` : `<p class="muted"><b>${escapeHtml(grant.client_name)}</b> wants to connect as ${escapeHtml(account.email)}.</p><div class="code">${escapeHtml(code)}</div><div class="scopes">${scopes.map((scope) => `<div class="scope">${escapeHtml(scope)}</div>`).join("")}</div><button id="approve">Authorize this device</button><button class="deny" id="deny">Deny</button><p id="status" class="muted"></p>`}</main><script>const code=${encodedCode};const status=document.querySelector('#status');const login=document.querySelector('#login');if(login)login.onclick=async()=>{login.disabled=true;const r=await fetch('/studio/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.querySelector('#email').value,password:document.querySelector('#password').value})});if(r.ok)location.reload();else{const e=await r.json().catch(()=>({}));status.textContent=e.error||'Sign in failed';login.disabled=false}};async function decide(approved){const r=await fetch('/platform/api/cli/device/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_code:code,approved})});const d=await r.json().catch(()=>({}));status.textContent=r.ok?(approved?'Authorized. You may return to Cosaii.':'Request denied.'):d.message||d.error||'Could not update request';document.querySelectorAll('button').forEach(x=>x.disabled=true)};document.querySelector('#approve')?.addEventListener('click',()=>decide(true));document.querySelector('#deny')?.addEventListener('click',()=>decide(false));</script></body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" } });
}

async function startDeviceLogin(request: Request, db: D1Database): Promise<Response> {
  const body = await readBody(request);
  const requested = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === "string" && (CLI_SCOPES as readonly string[]).includes(scope)) : [...CLI_SCOPES];
  const deviceCode = `cosaii_dc_${randomToken(32)}`;
  const userCode = await uniqueUserCode(db);
  const id = crypto.randomUUID();
  const clientName = cleanText(body.client_name, 80) || "Cosaii CLI";
  await db.prepare("INSERT INTO cosaii_device_grants(id,device_code_hash,user_code,requested_scopes,client_name,expires_at) VALUES(?,?,?,?,?,datetime('now','+10 minutes'))")
    .bind(id, await sha256(deviceCode), userCode, JSON.stringify(requested), clientName).run();
  const verificationUri = new URL(`/platform/cli/authorize?user_code=${encodeURIComponent(userCode)}`, request.url).toString();
  return apiJson({ device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, verification_uri_complete: verificationUri, expires_in: 600, interval: 2 }, 201, corsHeaders());
}

async function approveDeviceLogin(request: Request, db: D1Database): Promise<Response> {
  const account = await browserAccount(request, db);
  if (!account) return apiJson({ error: "sign_in_required" }, 401);
  const body = await readBody(request);
  const userCode = cleanCode(body.user_code);
  const approved = body.approved === true;
  const result = await db.prepare("UPDATE cosaii_device_grants SET account_id=?,status=?,decided_at=datetime('now') WHERE user_code=? AND status='pending' AND expires_at>datetime('now')")
    .bind(account.id, approved ? "approved" : "denied", userCode).run();
  if (!result.meta.changes) return apiJson({ error: "invalid_or_expired_code" }, 404);
  await writeAudit(db, account.id, null, approved ? "device.authorized" : "device.denied", "device_grant", userCode, "");
  return apiJson({ ok: true, approved });
}

async function exchangeDeviceToken(request: Request, db: D1Database): Promise<Response> {
  const body = await readBody(request);
  const deviceCode = cleanText(body.device_code, 200);
  if (!deviceCode.startsWith("cosaii_dc_")) return apiJson({ error: "invalid_grant" }, 400);
  const grant = await db.prepare("SELECT id,account_id,status,requested_scopes FROM cosaii_device_grants WHERE device_code_hash=? AND expires_at>datetime('now')")
    .bind(await sha256(deviceCode)).first<{ id: string; account_id: number | null; status: string; requested_scopes: string }>();
  if (!grant) return apiJson({ error: "expired_token" }, 400);
  if (grant.status === "pending") return apiJson({ error: "authorization_pending" }, 428, { ...corsHeaders(), "retry-after": "2" });
  if (grant.status !== "approved" || !grant.account_id) return apiJson({ error: "access_denied" }, 403);
  const deviceId = crypto.randomUUID();
  await db.prepare("INSERT INTO cosaii_devices(id,account_id,name,platform) VALUES(?,?,?,?)")
    .bind(deviceId, grant.account_id, cleanText(body.device_name, 80) || "Cosaii device", cleanText(body.platform, 80)).run();
  const tokens = await issueTokens(db, grant.account_id, deviceId, parseScopes(grant.requested_scopes));
  await db.prepare("UPDATE cosaii_device_grants SET status='consumed',consumed_at=datetime('now') WHERE id=?").bind(grant.id).run();
  await writeAudit(db, grant.account_id, deviceId, "device.token_issued", "device", deviceId, "");
  return apiJson(tokens, 200, corsHeaders());
}

async function refreshDeviceToken(request: Request, db: D1Database): Promise<Response> {
  const body = await readBody(request);
  const token = cleanText(body.refresh_token, 300);
  if (!token.startsWith("cosaii_rt_")) return apiJson({ error: "invalid_grant" }, 400);
  const row = await db.prepare(`SELECT r.id,r.device_id,r.account_id,r.scopes FROM cosaii_refresh_tokens r JOIN cosaii_devices d ON d.id=r.device_id
    WHERE r.token_hash=? AND r.revoked_at IS NULL AND r.expires_at>datetime('now') AND d.revoked_at IS NULL`)
    .bind(await sha256(token)).first<{ id: string; device_id: string; account_id: number; scopes: string }>();
  if (!row) return apiJson({ error: "invalid_grant" }, 401);
  await db.prepare("UPDATE cosaii_refresh_tokens SET revoked_at=datetime('now'),rotated_at=datetime('now') WHERE id=?").bind(row.id).run();
  return apiJson(await issueTokens(db, row.account_id, row.device_id, parseScopes(row.scopes)), 200, corsHeaders());
}

async function issueTokens(db: D1Database, accountId: number, deviceId: string, scopes: string[]) {
  const accessToken = `cosaii_at_${randomToken(32)}`;
  const refreshToken = `cosaii_rt_${randomToken(48)}`;
  await db.batch([
    db.prepare("INSERT INTO cosaii_access_tokens(id,device_id,account_id,token_hash,scopes,expires_at) VALUES(?,?,?,?,?,datetime('now','+1 hour'))")
      .bind(crypto.randomUUID(), deviceId, accountId, await sha256(accessToken), JSON.stringify(scopes)),
    db.prepare("INSERT INTO cosaii_refresh_tokens(id,device_id,account_id,token_hash,scopes,expires_at) VALUES(?,?,?,?,?,datetime('now','+90 days'))")
      .bind(crypto.randomUUID(), deviceId, accountId, await sha256(refreshToken), JSON.stringify(scopes)),
  ]);
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, refresh_expires_in: 7_776_000, scopes };
}

async function cliChat(request: Request, env: CosaiiEnv, identity: CliIdentity, ctx: ExecutionContext): Promise<Response> {
  const body = await readBody(request);
  const agentTurnId = cleanText(body.agent_turn_id, 36);
  const continuationIndex = Number(body.continuation_index ?? 0);
  if (agentTurnId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentTurnId)) {
    return apiJson({ error: "invalid_agent_turn_id" }, 400, corsHeaders());
  }
  if (!Number.isSafeInteger(continuationIndex) || continuationIndex < 0 || continuationIndex > 64) {
    return apiJson({ error: "invalid_continuation_index" }, 400, corsHeaders());
  }
  let safetyAlreadyChecked = false;
  if (continuationIndex > 0) {
    if (!agentTurnId) return apiJson({ error: "agent_turn_id_required" }, 400, corsHeaders());
    const safeTurn = await env.DB.prepare(`SELECT id FROM cosaii_safe_turns
      WHERE id=? AND account_id=? AND device_id=? AND expires_at>datetime('now')`)
      .bind(agentTurnId, identity.id, identity.device_id).first();
    if (!safeTurn) return apiJson({ error: "safe_turn_not_found", message: "Restart this turn so its input can be screened." }, 409, corsHeaders());
    safetyAlreadyChecked = true;
  }
  delete body.agent_turn_id;
  delete body.continuation_index;
  let model = cleanText(body.model, 120) || "auto";
  if (model === "fast") model = "poolside/laguna-xs-2.1";
  if (model === "smart") model = "poolside/laguna-s-2.1";
  if (model === "auto") model = chooseAutoModel(body.messages);
  if (!MODELS.some((entry) => entry.id === model)) return apiJson({ error: "model_not_available" }, 404);
  body.model = model;
  body.surface = "agent";
  await env.DB.prepare("INSERT INTO request_activity(account_id,surface,method,path) VALUES(?,?,?,?)")
    .bind(identity.id, "cosaii", "POST", "/cosaii/api/v1/chat").run();
  const limited = await cliRateLimit(env.DB, identity.id);
  if (limited) return limited;
  const upstream = await poolsideModelRequest(new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: body.stream === false ? "application/json" : "text/event-stream" },
    body: JSON.stringify(body),
  }), env, "/chat/completions", { safetyAlreadyChecked, finalOutputSafety: true });
  if (upstream.ok && agentTurnId) {
    if (continuationIndex === 0) {
      await env.DB.prepare(`INSERT INTO cosaii_safe_turns(id,account_id,device_id,expires_at)
        VALUES(?,?,?,datetime('now','+2 hours'))
        ON CONFLICT(id) DO UPDATE SET last_used_at=datetime('now'),expires_at=datetime('now','+2 hours')
        WHERE account_id=excluded.account_id AND device_id=excluded.device_id`)
        .bind(agentTurnId, identity.id, identity.device_id).run();
    } else {
      await env.DB.prepare("UPDATE cosaii_safe_turns SET last_used_at=datetime('now'),expires_at=datetime('now','+2 hours') WHERE id=? AND account_id=? AND device_id=?")
        .bind(agentTurnId, identity.id, identity.device_id).run();
    }
  }
  await writeAudit(env.DB, identity.id, identity.device_id, "inference.request", "model", model, body.stream === false ? "json" : "stream");
  return trackTokenResponse(upstream, { db: env.DB, ctx, request, accountId: identity.id, surface: "cosaii", provider: providerForModel(model), model, path: "/cosaii/api/v1/chat" });
}

async function cliRateLimit(db: D1Database, accountId: number): Promise<Response | null> {
  const base = "SELECT COUNT(*) AS count FROM request_activity WHERE account_id=? AND surface='cosaii' AND path='/cosaii/api/v1/chat' AND created_at>=";
  const [minute, hour, day] = await Promise.all([
    db.prepare(`${base}datetime('now','-1 minute')`).bind(accountId).first<{ count: number }>(),
    db.prepare(`${base}datetime('now','-1 hour')`).bind(accountId).first<{ count: number }>(),
    db.prepare(`${base}datetime('now','-1 day')`).bind(accountId).first<{ count: number }>(),
  ]);
  const counts = { minute: Number(minute?.count || 0), hour: Number(hour?.count || 0), day: Number(day?.count || 0) };
  if (counts.minute <= 600 && counts.hour <= 6_000 && counts.day <= 20_000) return null;
  return apiJson({ error: "rate_limit_exceeded", message: "Cosaii reached the account fair-use brake.", limits: { minute: 600, hour: 6_000, day: 20_000 } }, 429, { ...corsHeaders(), "retry-after": counts.minute > 600 ? "60" : counts.hour > 6000 ? "3600" : "86400" });
}

async function platformFacade(request: Request, env: CosaiiEnv, identity: CliIdentity, path: string): Promise<Response> {
  const db = env.DB;
  if (request.method === "GET" && path === "usage") {
    requireScope(identity, "usage:read");
    const rows = await db.prepare(`SELECT model,COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens),0) AS completion_tokens,
      COALESCE(SUM(total_tokens),0) AS total_tokens,
      COALESCE(SUM(cached_tokens),0) AS cached_tokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens
      FROM token_usage WHERE account_id=? AND surface='cosaii'
      GROUP BY model ORDER BY total_tokens DESC`)
      .bind(identity.id).all();
    return apiJson({ usage: rows.results }, 200, corsHeaders());
  }
  if (request.method === "GET" && path === "keys") {
    requireScope(identity, "keys:read");
    const rows = await db.prepare("SELECT id,name,prefix,scopes,created_at,last_used_at FROM api_keys WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at DESC").bind(identity.id).all();
    return apiJson({ keys: rows.results }, 200, corsHeaders());
  }
  if (request.method === "GET" && path === "projects") {
    requireScope(identity, "projects:read");
    const rows = await db.prepare("SELECT id,name,storage_mode,permission_mode,status,updated_at FROM studio_projects WHERE account_id=? ORDER BY updated_at DESC").bind(identity.id).all();
    return apiJson({ projects: rows.results }, 200, corsHeaders());
  }
  if (request.method === "GET" && path === "memory") {
    requireScope(identity, "memory:read");
    const rows = await db.prepare("SELECT id,project_id,content,tags,source,pinned,created_at,updated_at FROM studio_memories WHERE account_id=? ORDER BY pinned DESC,updated_at DESC LIMIT 500").bind(identity.id).all();
    return apiJson({ memory: rows.results }, 200, corsHeaders());
  }
  if (request.method === "POST" && path === "memory") {
    requireScope(identity, "memory:write"); const body = await readBody(request); const id = crypto.randomUUID(); const content = cleanText(body.content, 20_000); if (!content) return apiJson({ error: "content_required" }, 400, corsHeaders());
    await db.prepare("INSERT INTO studio_memories(id,account_id,project_id,content,tags,source,pinned) VALUES(?,?,?,?,?,'cosaii',?)").bind(id, identity.id, cleanText(body.project_id, 80) || null, content, JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20) : []), body.pinned === true ? 1 : 0).run();
    await writeAudit(db, identity.id, identity.device_id, "platform.memory.created", "memory", id, ""); return apiJson({ id, created: true }, 201, corsHeaders());
  }
  const resources: Record<string, { scope: string; sql: string; key: string }> = {
    tasks: { scope: "tasks:read", key: "tasks", sql: "SELECT id,project_id,title,kind,schedule,next_run,status,progress,notify,created_at,updated_at FROM studio_tasks WHERE account_id=? ORDER BY updated_at DESC LIMIT 500" },
    plugins: { scope: "plugins:read", key: "plugins", sql: "SELECT id,kind,name,endpoint,manifest,enabled,created_at FROM studio_plugins WHERE account_id=? ORDER BY created_at DESC LIMIT 500" },
    agents: { scope: "agents:read", key: "agents", sql: "SELECT id,project_id,kind,title,status,created_at,updated_at FROM studio_agent_sessions WHERE account_id=? ORDER BY updated_at DESC LIMIT 500" },
    notifications: { scope: "notifications:read", key: "notifications", sql: "SELECT id,title,body,href,read,created_at FROM studio_notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 500" },
  };
  if (request.method === "GET" && resources[path]) { const resource = resources[path]; requireScope(identity, resource.scope); const rows = await db.prepare(resource.sql).bind(identity.id).all(); return apiJson({ [resource.key]: rows.results }, 200, corsHeaders()); }
  if (request.method === "GET" && path === "files") {
    requireScope(identity, "projects:read"); const projectId = cleanText(new URL(request.url).searchParams.get("project_id"), 80); const owner = await db.prepare("SELECT id FROM studio_projects WHERE id=? AND account_id=?").bind(projectId, identity.id).first(); if (!owner) return apiJson({ error: "project_not_found" }, 404, corsHeaders());
    const rows = await db.prepare("SELECT path,version,content_type,updated_at FROM studio_files WHERE project_id=? ORDER BY path").bind(projectId).all(); return apiJson({ files: rows.results }, 200, corsHeaders());
  }
  if (request.method === "POST" && path === "tasks") {
    requireScope(identity, "tasks:write"); const body = await readBody(request); const id = crypto.randomUUID(); const title = cleanText(body.title, 200); const prompt = cleanText(body.prompt, 20_000); if (!title || !prompt) return apiJson({ error: "title_and_prompt_required" }, 400, corsHeaders());
    await db.prepare("INSERT INTO studio_tasks(id,account_id,project_id,title,prompt,kind,schedule,next_run,status,notify) VALUES(?,?,?,?,?,?,?,?,'scheduled',?)").bind(id, identity.id, cleanText(body.project_id, 80) || null, title, prompt, cleanText(body.kind, 30) || "agent", cleanText(body.schedule, 120) || null, cleanText(body.next_run, 40) || null, body.notify === false ? 0 : 1).run(); await writeAudit(db, identity.id, identity.device_id, "platform.task.created", "task", id, ""); return apiJson({ id, created: true }, 201, corsHeaders());
  }
  return apiJson({ error: "not_implemented", message: "This Platform method is not available in the current server build." }, 501, corsHeaders());
}

async function remoteControl(request: Request, env: CosaiiEnv, identity: CliIdentity, path: string): Promise<Response> {
  requireScope(identity, "remote:control");
  const body = request.method === "POST" ? await readBody(request) : {};
  if (request.method === "POST" && path === "enroll") {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO cosaii_environments(id,account_id,device_id,name,public_key) VALUES(?,?,?,?,?)")
      .bind(id, identity.id, identity.device_id, cleanText(body.name, 100) || "Cosaii environment", cleanPublicKey(body.public_key)).run();
    await writeAudit(env.DB, identity.id, identity.device_id, "remote.enrolled", "environment", id, "");
    return apiJson({ environment_id: id }, 201, corsHeaders());
  }
  if (request.method === "GET" && path === "environments") {
    const rows = await env.DB.prepare("SELECT id,name,public_key,created_at,last_seen_at FROM cosaii_environments WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at DESC").bind(identity.id).all();
    return apiJson({ environments: rows.results }, 200, corsHeaders());
  }
  const revokeEnvironment = path.match(/^environments\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && revokeEnvironment) {
    await env.DB.batch([
      env.DB.prepare("UPDATE cosaii_environments SET revoked_at=datetime('now') WHERE id=? AND account_id=?").bind(revokeEnvironment[1], identity.id),
      env.DB.prepare("UPDATE cosaii_remote_clients SET revoked_at=datetime('now') WHERE environment_id=? AND account_id=?").bind(revokeEnvironment[1], identity.id),
    ]);
    await writeAudit(env.DB, identity.id, identity.device_id, "remote.disabled", "environment", revokeEnvironment[1], "");
    return apiJson({ ok: true }, 200, corsHeaders());
  }
  if (request.method === "POST" && path === "pairing/start") {
    const environmentId = cleanUuid(body.environment_id);
    const owned = await ownedEnvironment(env.DB, identity.id, environmentId, identity.device_id);
    if (!owned) return apiJson({ error: "not_found" }, 404);
    const pairingCode = `cosaii_pair_${randomToken(32)}`;
    const manualCode = await uniqueManualCode(env.DB);
    await env.DB.prepare("INSERT INTO cosaii_pairings(id,environment_id,code_hash,manual_code,expires_at) VALUES(?,?,?,?,datetime('now','+10 minutes'))")
      .bind(crypto.randomUUID(), environmentId, await sha256(pairingCode), manualCode).run();
    return apiJson({ pairing_code: pairingCode, manual_pairing_code: manualCode, environment_id: environmentId, expires_in: 600 }, 201, corsHeaders());
  }
  if (request.method === "POST" && path === "pairing/claim") {
    const code = cleanText(body.pairing_code || body.manual_pairing_code, 200);
    const pairing = code.startsWith("cosaii_pair_")
      ? await env.DB.prepare("SELECT id,environment_id FROM cosaii_pairings WHERE code_hash=? AND claimed_at IS NULL AND expires_at>datetime('now')").bind(await sha256(code)).first<{ id: string; environment_id: string }>()
      : await env.DB.prepare("SELECT id,environment_id FROM cosaii_pairings WHERE manual_code=? AND claimed_at IS NULL AND expires_at>datetime('now')").bind(cleanCode(code)).first<{ id: string; environment_id: string }>();
    if (!pairing) return apiJson({ error: "invalid_or_expired_pairing" }, 404);
    const envRow = await env.DB.prepare("SELECT account_id FROM cosaii_environments WHERE id=? AND revoked_at IS NULL").bind(pairing.environment_id).first<{ account_id: number }>();
    if (!envRow || envRow.account_id !== identity.id) return apiJson({ error: "account_mismatch" }, 403);
    const clientId = crypto.randomUUID();
    const publicKey = cleanPublicKey(body.public_key);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cosaii_remote_clients(id,environment_id,account_id,name,public_key) VALUES(?,?,?,?,?)").bind(clientId, pairing.environment_id, identity.id, cleanText(body.name, 100) || "Remote client", publicKey),
      env.DB.prepare("UPDATE cosaii_pairings SET client_id=?,client_public_key=?,claimed_at=datetime('now') WHERE id=?").bind(clientId, publicKey, pairing.id),
    ]);
    return apiJson({ claimed: true, environment_id: pairing.environment_id, client_id: clientId }, 200, corsHeaders());
  }
  if (request.method === "GET" && path === "clients") {
    const environmentId = cleanUuid(new URL(request.url).searchParams.get("environment_id"));
    if (!await ownedEnvironment(env.DB, identity.id, environmentId)) return apiJson({ error: "not_found" }, 404);
    const rows = await env.DB.prepare("SELECT id,name,public_key,created_at,last_seen_at FROM cosaii_remote_clients WHERE environment_id=? AND revoked_at IS NULL ORDER BY created_at DESC").bind(environmentId).all();
    return apiJson({ clients: rows.results }, 200, corsHeaders());
  }
  const revoke = path.match(/^clients\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && revoke) {
    await env.DB.prepare("UPDATE cosaii_remote_clients SET revoked_at=datetime('now') WHERE id=? AND account_id=?").bind(revoke[1], identity.id).run();
    return apiJson({ ok: true }, 200, corsHeaders());
  }
  return apiJson({ error: "not_found" }, 404, corsHeaders());
}

async function relay(request: Request, env: CosaiiEnv, identity: CliIdentity): Promise<Response> {
  requireScope(identity, "remote:control");
  const url = new URL(request.url);
  const environmentId = cleanUuid(url.searchParams.get("environment_id"));
  const role = url.searchParams.get("role");
  const connectionId = cleanUuid(url.searchParams.get("connection_id")) || crypto.randomUUID();
  if (role === "host") {
    if (!await ownedEnvironment(env.DB, identity.id, environmentId, identity.device_id)) return apiJson({ error: "forbidden" }, 403);
  } else if (role === "client") {
    const clientId = cleanUuid(url.searchParams.get("client_id"));
    const client = await env.DB.prepare("SELECT id FROM cosaii_remote_clients WHERE id=? AND environment_id=? AND account_id=? AND revoked_at IS NULL")
      .bind(clientId, environmentId, identity.id).first();
    if (!client) return apiJson({ error: "forbidden" }, 403);
  } else return apiJson({ error: "invalid_role" }, 400);
  const headers = new Headers(request.headers);
  headers.set("x-cosaii-relay-authorized", "1");
  headers.set("x-cosaii-relay-role", role);
  headers.set("x-cosaii-connection-id", connectionId);
  headers.set("x-cosaii-account-id", String(identity.id));
  await env.DB.prepare("UPDATE cosaii_environments SET last_seen_at=datetime('now') WHERE id=?").bind(environmentId).run();
  return env.COSAII_RELAYS.getByName(environmentId).fetch(new Request(request, { headers }));
}

async function listDevices(request: Request, db: D1Database): Promise<Response> {
  const identity = await browserOrCliIdentity(request, db);
  if (!identity) return apiJson({ error: "sign_in_required" }, 401);
  const rows = await db.prepare("SELECT id,name,platform,created_at,last_seen_at FROM cosaii_devices WHERE account_id=? AND revoked_at IS NULL ORDER BY last_seen_at DESC").bind(identity.id).all();
  return apiJson({ devices: rows.results });
}

async function revokeDevice(request: Request, db: D1Database, deviceId: string): Promise<Response> {
  const identity = await browserOrCliIdentity(request, db);
  if (!identity) return apiJson({ error: "sign_in_required" }, 401);
  await db.batch([
    db.prepare("UPDATE cosaii_devices SET revoked_at=datetime('now') WHERE id=? AND account_id=?").bind(deviceId, identity.id),
    db.prepare("UPDATE cosaii_access_tokens SET revoked_at=datetime('now') WHERE device_id=? AND account_id=?").bind(deviceId, identity.id),
    db.prepare("UPDATE cosaii_refresh_tokens SET revoked_at=datetime('now') WHERE device_id=? AND account_id=?").bind(deviceId, identity.id),
  ]);
  return apiJson({ ok: true });
}

async function cliIdentity(request: Request, db: D1Database): Promise<CliIdentity | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!token.startsWith("cosaii_at_")) return null;
  const row = await db.prepare(`SELECT a.id,a.email,a.display_name,t.device_id,t.scopes FROM cosaii_access_tokens t
    JOIN cosaii_devices d ON d.id=t.device_id JOIN platform_accounts a ON a.id=t.account_id
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>datetime('now') AND d.revoked_at IS NULL`)
    .bind(await sha256(token)).first<{ id: number; email: string; display_name: string; device_id: string; scopes: string }>();
  if (!row) return null;
  await db.batch([
    db.prepare("UPDATE cosaii_access_tokens SET last_used_at=datetime('now') WHERE token_hash=?").bind(await sha256(token)),
    db.prepare("UPDATE cosaii_devices SET last_seen_at=datetime('now') WHERE id=?").bind(row.device_id),
  ]);
  return { id: row.id, email: row.email, display_name: row.display_name, device_id: row.device_id, scopes: parseScopes(row.scopes) };
}

async function browserOrCliIdentity(request: Request, db: D1Database): Promise<Account | CliIdentity | null> {
  return await cliIdentity(request, db) || await browserAccount(request, db);
}

async function browserAccount(request: Request, db: D1Database): Promise<Account | null> {
  const token = request.headers.get("cookie")?.match(/(?:^|;\s*)osaii_platform_session=([^;]+)/)?.[1];
  if (!token) return null;
  return db.prepare("SELECT a.id,a.email,a.display_name FROM platform_sessions s JOIN platform_accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at>datetime('now')")
    .bind(token).first<Account>();
}

function requireScope(identity: CliIdentity, scope: string): void {
  if (!identity.scopes.includes(scope)) throw Object.assign(new Error(`Missing CLI scope: ${scope}`), { status: 403, code: "insufficient_scope" });
}

async function ownedEnvironment(db: D1Database, accountId: number, environmentId: string, deviceId?: string) {
  if (!environmentId) return null;
  const sql = deviceId
    ? "SELECT id FROM cosaii_environments WHERE id=? AND account_id=? AND device_id=? AND revoked_at IS NULL"
    : "SELECT id FROM cosaii_environments WHERE id=? AND account_id=? AND revoked_at IS NULL";
  return deviceId ? db.prepare(sql).bind(environmentId, accountId, deviceId).first() : db.prepare(sql).bind(environmentId, accountId).first();
}

async function writeAudit(db: D1Database, accountId: number, deviceId: string | null, action: string, targetType: string, targetId: string, detail: string) {
  await db.prepare("INSERT INTO cosaii_audit(account_id,device_id,action,target_type,target_id,detail) VALUES(?,?,?,?,?,?)")
    .bind(accountId, deviceId, action.slice(0, 100), targetType.slice(0, 60), targetId.slice(0, 120), detail.slice(0, 500)).run();
}

function chooseAutoModel(messages: unknown): string {
  const text = JSON.stringify(messages || "").toLowerCase();
  return text.length > 4_000 || /\b(analy[sz]e|debug|architecture|prove|research|refactor|implement)\b/.test(text)
    ? "poolside/laguna-s-2.1" : "poolside/laguna-xs-2.1";
}

function parseScopes(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  return request.json<Record<string, unknown>>().catch(() => ({}));
}

function cleanText(value: unknown, max = 200): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function cleanCode(value: unknown): string { return cleanText(value, 24).toUpperCase().replace(/[^A-Z0-9-]/g, ""); }
function cleanUuid(value: unknown): string { const text = cleanText(value, 36); return /^[0-9a-f-]{36}$/i.test(text) ? text : ""; }
function cleanPublicKey(value: unknown): string { const text = cleanText(value, 200); if (!/^[A-Za-z0-9_+=\/-]{32,200}$/.test(text)) throw Object.assign(new Error("A valid public key is required."), { status: 400, code: "invalid_public_key" }); return text; }
function randomToken(bytes: number): string { const data = new Uint8Array(bytes); crypto.getRandomValues(data); return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
async function uniqueUserCode(db: D1Database): Promise<string> { for (let i = 0; i < 12; i++) { const code = `${randomChars(4)}-${randomChars(4)}`; if (!await db.prepare("SELECT 1 FROM cosaii_device_grants WHERE user_code=?").bind(code).first()) return code; } throw new Error("Could not allocate device code"); }
async function uniqueManualCode(db: D1Database): Promise<string> { for (let i = 0; i < 12; i++) { const code = `${randomChars(4)}-${randomChars(4)}`; if (!await db.prepare("SELECT 1 FROM cosaii_pairings WHERE manual_code=?").bind(code).first()) return code; } throw new Error("Could not allocate pairing code"); }
function randomChars(length: number): string { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return [...bytes].map((byte) => chars[byte % chars.length]).join(""); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char); }
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type", "access-control-expose-headers": "retry-after,x-ratelimit-remaining", "access-control-max-age": "86400" }; }
function apiJson(value: unknown, status = 200, extra: Record<string, string> = {}): Response { return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...extra } }); }

function cosaiiError(error: unknown): Response {
  const value = error as { status?: number; code?: string; message?: string };
  const status = Number.isInteger(value?.status) && value.status! >= 400 && value.status! < 500 ? value.status! : 500;
  return apiJson({
    error: value?.code || (status === 500 ? "internal_error" : "invalid_request"),
    message: status === 500 ? "The Cosaii service could not complete the request." : value?.message,
  }, status, corsHeaders());
}
