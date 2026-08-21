import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { poolsideModelRequest, type PoolsideEnv } from "./poolside";
import { accountIdForRequest } from "./studio";

export interface StudioPlatformEnv extends PoolsideEnv {
  DB: D1Database;
  STUDIO_FILES: R2Bucket;
  BROWSER?: BrowserWorker;
}

type JsonObject = Record<string, unknown>;
const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MARKETPLACE = [
  { id: "research-brief", name: "Research brief", category: "Research", description: "Plan, browse, cite, and export a decision-ready report." },
  { id: "meeting-notes", name: "Meeting notes", category: "Productivity", description: "Record, transcribe, extract decisions, and create follow-ups." },
  { id: "data-story", name: "Data story", category: "Analysis", description: "Turn CSV or spreadsheet data into a table, chart, and narrative." },
  { id: "study-coach", name: "Study coach", category: "Learning", description: "Adaptive Socratic teaching with retained topic progress." },
  { id: "ship-static-site", name: "Ship a static site", category: "Coding", description: "Build in project VFS, review changes, and publish under Studio." },
  { id: "weekly-reflection", name: "Weekly reflection", category: "Personal", description: "Summarize topics, progress, patterns, and next actions." },
] as const;

export async function studioPlatformApi(
  request: Request,
  env: StudioPlatformEnv,
  path: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const accountId = await accountIdForRequest(request, env.DB);
  if (!accountId) return json({ error: "sign_in_required", message: "Sign in to use synced Studio workspaces." }, 401);
  const method = request.method;
  if (path === "/bootstrap" && method === "GET") return bootstrap(env.DB, accountId);
  if (path === "/profile" && method === "PATCH") return updateProfile(request, env.DB, accountId);
  if (path === "/memory/export" && method === "GET") return exportMemory(env.DB, accountId);
  if (path === "/memory/import" && method === "POST") return importMemory(request, env.DB, accountId);
  if (path === "/memory" && method === "GET") return listMemory(request, env.DB, accountId);
  if (path === "/memory" && method === "POST") return createMemory(request, env.DB, accountId);
  if (path.startsWith("/memory/")) return mutateMemory(request, env.DB, accountId, path.slice(8));
  if (path === "/chats" && method === "GET") return listChats(request, env.DB, accountId);
  if (path === "/chats" && method === "POST") return saveChat(request, env.DB, accountId);
  if (path.startsWith("/chats/")) return mutateChat(request, env.DB, accountId, path.slice(7));
  if (path === "/attachments" && method === "POST") return createAttachment(request, env, accountId);
  if (path.startsWith("/attachments/")) return attachmentApi(request, env, accountId, path.slice(13));
  if (path === "/documents" && method === "GET") return listRows(env.DB, "studio_documents", accountId);
  if (path === "/documents" && method === "POST") return saveDocument(request, env.DB, accountId);
  if (path.startsWith("/documents/")) return mutateDocument(request, env.DB, accountId, path.slice(11));
  if (path === "/assistants" && method === "GET") return listAssistants(env.DB, accountId);
  if (path === "/assistants" && method === "POST") return saveAssistant(request, env.DB, accountId);
  if (path.startsWith("/assistants/")) return mutateAssistant(request, env.DB, accountId, path.slice(12));
  if (path === "/marketplace" && method === "GET") return marketplace(env.DB, accountId);
  if (path === "/marketplace/install" && method === "POST") return installWorkflow(request, env.DB, accountId);
  if (path === "/tasks" && method === "GET") return listRows(env.DB, "studio_tasks", accountId);
  if (path === "/tasks" && method === "POST") return saveTask(request, env.DB, accountId);
  if (path.startsWith("/tasks/")) return taskApi(request, env, accountId, path.slice(7), ctx);
  if (path === "/notifications" && method === "GET") return listRows(env.DB, "studio_notifications", accountId);
  if (path === "/notifications/read" && method === "PATCH") {
    await env.DB.prepare("UPDATE studio_notifications SET read=1 WHERE account_id=?").bind(accountId).run();
    return json({ ok: true });
  }
  if (path === "/sessions" && method === "GET") return listRows(env.DB, "studio_agent_sessions", accountId);
  if (path === "/sessions" && method === "POST") return saveSession(request, env.DB, accountId);
  if (path.startsWith("/sessions/")) return sessionApi(request, env, accountId, path.slice(10), ctx);
  if (path === "/research" && method === "POST") return runResearch(request, env, accountId, ctx);
  if (path === "/browser/action" && method === "POST") return browserAction(request, env, accountId);
  if (path.startsWith("/browser/screenshot/") && method === "GET")
    return browserScreenshot(env, accountId, path.slice(20));
  if (path === "/study" && method === "POST") return updateStudy(request, env.DB, accountId);
  if (path === "/reflection" && method === "GET") return reflection(env.DB, accountId);
  return json({ error: "not_found" }, 404);
}

export async function runScheduledStudioTasks(env: StudioPlatformEnv, ctx: ExecutionContext): Promise<void> {
  const due = await env.DB.prepare(
    "SELECT id,account_id FROM studio_tasks WHERE status='scheduled' AND next_run IS NOT NULL AND next_run<=datetime('now') ORDER BY next_run LIMIT 8",
  ).all<{ id: string; account_id: number }>();
  for (const task of due.results) ctx.waitUntil(runTask(env, task.account_id, task.id));
}

export async function sharedStudioItem(env: StudioPlatformEnv, token: string): Promise<Response> {
  const chat = await env.DB.prepare("SELECT title,messages,updated_at FROM studio_chats WHERE share_token=?").bind(token).first<{ title: string; messages: string; updated_at: string }>();
  if (chat) {
    const messages = safeArray(chat.messages).map((m) => `<article class="${escapeHtml(String((m as JsonObject).role || "assistant"))}">${escapeHtml(messageText((m as JsonObject).content))}</article>`).join("");
    return sharedPage(chat.title, messages, chat.updated_at);
  }
  const doc = await env.DB.prepare("SELECT title,kind,content,updated_at FROM studio_documents WHERE share_token=?").bind(token).first<{ title: string; kind: string; content: string; updated_at: string }>();
  return doc ? sharedPage(doc.title, `<article class="document"><pre>${escapeHtml(doc.content)}</pre></article>`, doc.updated_at) : new Response("Not found", { status: 404 });
}

async function bootstrap(db: D1Database, accountId: number): Promise<Response> {
  // batched single round-trip (was 11 sequential Promise.all fetches -> 11 HTTP calls)
  const batch = await db.batch([
    db.prepare("SELECT custom_instructions,preferences,tier,memory_enabled,updated_at FROM studio_profiles WHERE account_id=?").bind(accountId),
    db.prepare("SELECT * FROM studio_memories WHERE account_id=? ORDER BY pinned DESC,updated_at DESC LIMIT 250").bind(accountId),
    db.prepare("SELECT * FROM studio_chats WHERE account_id=? ORDER BY pinned DESC,updated_at DESC LIMIT 250").bind(accountId),
    db.prepare("SELECT id,chat_id,project_id,name,content_type,size,extracted_text,created_at FROM studio_attachments WHERE account_id=? ORDER BY created_at DESC LIMIT 250").bind(accountId),
    db.prepare("SELECT * FROM studio_documents WHERE account_id=? ORDER BY updated_at DESC LIMIT 100").bind(accountId),
    db.prepare("SELECT * FROM studio_assistants WHERE account_id=? OR visibility='public' ORDER BY updated_at DESC LIMIT 100").bind(accountId),
    db.prepare("SELECT * FROM studio_tasks WHERE account_id=? ORDER BY updated_at DESC LIMIT 100").bind(accountId),
    db.prepare("SELECT * FROM studio_notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 100").bind(accountId),
    db.prepare("SELECT * FROM studio_agent_sessions WHERE account_id=? ORDER BY updated_at DESC LIMIT 100").bind(accountId),
    db.prepare("SELECT * FROM studio_study_progress WHERE account_id=? ORDER BY updated_at DESC").bind(accountId),
    db.prepare("SELECT workflow_id,settings,installed_at FROM studio_market_installs WHERE account_id=?").bind(accountId),
  ]);
  const profile = (batch[0].results?.[0] as unknown) || null;
  const memories = batch[1];
  const chats = batch[2];
  const attachments = batch[3];
  const documents = batch[4];
  const assistants = batch[5];
  const tasks = batch[6];
  const notifications = batch[7];
  const sessions = batch[8];
  const studies = batch[9];
  const installs = batch[10];
  return json({ profile: profile || defaultProfile(), memories: memories.results, chats: (chats.results as unknown[]).map(parseChat), attachments: attachments.results, documents: (documents.results as unknown[]).map(parseDocument), assistants: (assistants.results as unknown[]).map(parseAssistant), tasks: tasks.results, notifications: notifications.results, sessions: (sessions.results as unknown[]).map(parseSession), studies: studies.results, installs: installs.results, marketplace: MARKETPLACE });
}

async function updateProfile(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const body = await bodyJson(request);
  const instructions = cleanText(body.custom_instructions, 12_000);
  const preferences = JSON.stringify(object(body.preferences));
  const memoryEnabled = body.memory_enabled === false ? 0 : 1;
  await db.prepare("INSERT INTO studio_profiles(account_id,custom_instructions,preferences,memory_enabled) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET custom_instructions=excluded.custom_instructions,preferences=excluded.preferences,memory_enabled=excluded.memory_enabled,updated_at=datetime('now')").bind(accountId, instructions, preferences, memoryEnabled).run();
  return json({ ok: true });
}

async function listMemory(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const url = new URL(request.url), q = (url.searchParams.get("q") || "").slice(0, 120), project = url.searchParams.get("project_id");
  const rows = q
    ? await db.prepare("SELECT * FROM studio_memories WHERE account_id=? AND content LIKE ? AND (? IS NULL OR project_id=?) ORDER BY pinned DESC,updated_at DESC LIMIT 100").bind(accountId, `%${q}%`, project, project).all()
    : await db.prepare("SELECT * FROM studio_memories WHERE account_id=? AND (? IS NULL OR project_id=?) ORDER BY pinned DESC,updated_at DESC LIMIT 250").bind(accountId, project, project).all();
  return json({ memories: rows.results });
}

async function createMemory(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const body = await bodyJson(request), content = cleanText(body.content, 20_000);
  if (!content) return json({ error: "memory_content_required" }, 400);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO studio_memories(id,account_id,project_id,content,tags,source,pinned) VALUES(?,?,?,?,?,?,?)").bind(id, accountId, nullableId(body.project_id), content, JSON.stringify(stringArray(body.tags)), cleanText(body.source, 40) || "manual", body.pinned ? 1 : 0).run();
  return json({ ok: true, id }, 201);
}

async function mutateMemory(request: Request, db: D1Database, accountId: number, id: string): Promise<Response> {
  if (request.method === "DELETE") {
    await db.prepare("DELETE FROM studio_memories WHERE id=? AND account_id=?").bind(id, accountId).run();
    return json({ ok: true });
  }
  if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
  const b = await bodyJson(request);
  await db.prepare("UPDATE studio_memories SET content=COALESCE(?,content),tags=COALESCE(?,tags),pinned=COALESCE(?,pinned),updated_at=datetime('now') WHERE id=? AND account_id=?").bind(typeof b.content === "string" ? cleanText(b.content, 20_000) : null, Array.isArray(b.tags) ? JSON.stringify(stringArray(b.tags)) : null, typeof b.pinned === "boolean" ? (b.pinned ? 1 : 0) : null, id, accountId).run();
  return json({ ok: true });
}

async function exportMemory(db: D1Database, accountId: number): Promise<Response> {
  const [profile, memories] = await Promise.all([db.prepare("SELECT custom_instructions,preferences,memory_enabled FROM studio_profiles WHERE account_id=?").bind(accountId).first(), db.prepare("SELECT project_id,content,tags,source,pinned,created_at,updated_at FROM studio_memories WHERE account_id=? ORDER BY updated_at").bind(accountId).all()]);
  return new Response(JSON.stringify({ version: 1, exported_at: new Date().toISOString(), profile: profile || defaultProfile(), memories: memories.results }, null, 2), { headers: { "content-type": "application/json", "content-disposition": "attachment; filename=oss-studio-memory.json", "cache-control": "no-store" } });
}

async function importMemory(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), memories = Array.isArray(b.memories) ? b.memories.slice(0, 500) : [];
  const statements = memories.flatMap((item) => {
    const row = object(item), content = cleanText(row.content, 20_000);
    return content ? [db.prepare("INSERT INTO studio_memories(id,account_id,project_id,content,tags,source,pinned) VALUES(?,?,?,?,?,?,?)").bind(crypto.randomUUID(), accountId, nullableId(row.project_id), content, JSON.stringify(stringArray(row.tags)), "import", row.pinned ? 1 : 0)] : [];
  });
  if (statements.length) await db.batch(statements);
  return json({ ok: true, imported: statements.length });
}

async function listChats(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const url = new URL(request.url), q = (url.searchParams.get("q") || "").slice(0, 120), archived = url.searchParams.get("archived") === "1" ? 1 : 0;
  const rows = q
    ? await db.prepare("SELECT * FROM studio_chats WHERE account_id=? AND archived=? AND (title LIKE ? OR messages LIKE ?) ORDER BY pinned DESC,updated_at DESC LIMIT 100").bind(accountId, archived, `%${q}%`, `%${q}%`).all()
    : await db.prepare("SELECT * FROM studio_chats WHERE account_id=? AND archived=? ORDER BY pinned DESC,updated_at DESC LIMIT 250").bind(accountId, archived).all();
  return json({ chats: rows.results.map(parseChat) });
}

async function saveChat(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), id = validId(b.id) || crypto.randomUUID(), messages = Array.isArray(b.messages) ? b.messages.slice(-500) : [];
  await db.prepare("INSERT INTO studio_chats(id,account_id,project_id,assistant_id,title,mode,model,messages,parent_chat_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,assistant_id=excluded.assistant_id,title=excluded.title,mode=excluded.mode,model=excluded.model,messages=excluded.messages,updated_at=datetime('now') WHERE account_id=excluded.account_id").bind(id, accountId, nullableId(b.project_id), nullableId(b.assistant_id), cleanText(b.title, 160) || chatTitle(messages), allowed(b.mode, ["chat", "agent", "swarm", "research", "study"], "chat"), cleanText(b.model, 120) || "auto", JSON.stringify(messages), nullableId(b.parent_chat_id)).run();
  return json({ ok: true, id });
}

async function mutateChat(request: Request, db: D1Database, accountId: number, tail: string): Promise<Response> {
  const [id, action] = tail.split("/");
  if (action === "share" && request.method === "POST") {
    const token = randomToken();
    await db.prepare("UPDATE studio_chats SET share_token=?,updated_at=datetime('now') WHERE id=? AND account_id=?").bind(token, id, accountId).run();
    return json({ ok: true, url: `/studio/share/${token}` });
  }
  if (action === "branch" && request.method === "POST") {
    const row = await db.prepare("SELECT * FROM studio_chats WHERE id=? AND account_id=?").bind(id, accountId).first<JsonObject>();
    if (!row) return json({ error: "not_found" }, 404);
    const next = crypto.randomUUID();
    await db.prepare("INSERT INTO studio_chats(id,account_id,project_id,assistant_id,title,mode,model,messages,parent_chat_id) VALUES(?,?,?,?,?,?,?,?,?)").bind(next, accountId, row.project_id, row.assistant_id, `${String(row.title)} (branch)`, row.mode, row.model, row.messages, id).run();
    return json({ ok: true, id: next });
  }
  if (request.method === "DELETE") {
    await db.prepare("DELETE FROM studio_chats WHERE id=? AND account_id=?").bind(id, accountId).run();
    return json({ ok: true });
  }
  if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
  const b = await bodyJson(request);
  await db.prepare("UPDATE studio_chats SET title=COALESCE(?,title),archived=COALESCE(?,archived),pinned=COALESCE(?,pinned),project_id=COALESCE(?,project_id),updated_at=datetime('now') WHERE id=? AND account_id=?").bind(typeof b.title === "string" ? cleanText(b.title, 160) : null, typeof b.archived === "boolean" ? (b.archived ? 1 : 0) : null, typeof b.pinned === "boolean" ? (b.pinned ? 1 : 0) : null, typeof b.project_id === "string" ? nullableId(b.project_id) : null, id, accountId).run();
  return json({ ok: true });
}

async function createAttachment(request: Request, env: StudioPlatformEnv, accountId: number): Promise<Response> {
  const b = await bodyJson(request), size = Number(b.size || 0), name = cleanText(b.name, 240), type = cleanText(b.content_type, 120) || "application/octet-stream";
  if (!name || !Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT) return json({ error: "invalid_attachment", message: "Files must be 20 MB or smaller." }, 400);
  const id = crypto.randomUUID(), key = `attachments/${accountId}/${id}/${safeFileName(name)}`;
  await env.DB.prepare("INSERT INTO studio_attachments(id,account_id,chat_id,project_id,name,content_type,size,r2_key,extracted_text) VALUES(?,?,?,?,?,?,?,?,?)").bind(id, accountId, nullableId(b.chat_id), nullableId(b.project_id), name, type, size, key, cleanText(b.extracted_text, 250_000)).run();
  return json({ ok: true, id, upload_url: `/studio/api/platform/attachments/${id}/content` }, 201);
}

async function attachmentApi(request: Request, env: StudioPlatformEnv, accountId: number, tail: string): Promise<Response> {
  const [id, action] = tail.split("/"), row = await env.DB.prepare("SELECT * FROM studio_attachments WHERE id=? AND account_id=?").bind(id, accountId).first<JsonObject>();
  if (!row) return json({ error: "not_found" }, 404);
  if (action === "content" && request.method === "PUT") {
    const length = Number(request.headers.get("content-length") || 0);
    if (length && length > MAX_ATTACHMENT) return json({ error: "file_too_large" }, 413);
    if (!request.body) return json({ error: "empty_file" }, 400);
    await env.STUDIO_FILES.put(String(row.r2_key), request.body, { httpMetadata: { contentType: String(row.content_type) } });
    return json({ ok: true });
  }
  if (action === "content" && request.method === "GET") {
    const object = await env.STUDIO_FILES.get(String(row.r2_key));
    return object ? new Response(object.body, { headers: { "content-type": String(row.content_type), "content-disposition": `inline; filename="${safeFileName(String(row.name))}"`, "cache-control": "private, no-store" } }) : json({ error: "not_found" }, 404);
  }
  if (request.method === "DELETE") {
    await Promise.all([env.STUDIO_FILES.delete(String(row.r2_key)), env.DB.prepare("DELETE FROM studio_attachments WHERE id=? AND account_id=?").bind(id, accountId).run()]);
    return json({ ok: true });
  }
  return json({ attachment: row });
}

async function saveDocument(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), id = validId(b.id) || crypto.randomUUID();
  await db.prepare("INSERT INTO studio_documents(id,account_id,project_id,kind,title,content,metadata) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,metadata=excluded.metadata,updated_at=datetime('now') WHERE account_id=excluded.account_id").bind(id, accountId, nullableId(b.project_id), allowed(b.kind, ["document", "code", "data", "app", "report"], "document"), cleanText(b.title, 160) || "Untitled", cleanText(b.content, 1_000_000), JSON.stringify(object(b.metadata))).run();
  return json({ ok: true, id });
}

async function mutateDocument(request: Request, db: D1Database, accountId: number, tail: string): Promise<Response> {
  const [id, action] = tail.split("/");
  if (action === "share" && request.method === "POST") {
    const token = randomToken();
    await db.prepare("UPDATE studio_documents SET share_token=?,updated_at=datetime('now') WHERE id=? AND account_id=?").bind(token, id, accountId).run();
    return json({ ok: true, url: `/studio/share/${token}` });
  }
  if (request.method === "DELETE") { await db.prepare("DELETE FROM studio_documents WHERE id=? AND account_id=?").bind(id, accountId).run(); return json({ ok: true }); }
  if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
  const b = await bodyJson(request);
  await db.prepare("UPDATE studio_documents SET title=COALESCE(?,title),content=COALESCE(?,content),metadata=COALESCE(?,metadata),updated_at=datetime('now') WHERE id=? AND account_id=?").bind(typeof b.title === "string" ? cleanText(b.title, 160) : null, typeof b.content === "string" ? cleanText(b.content, 1_000_000) : null, b.metadata ? JSON.stringify(object(b.metadata)) : null, id, accountId).run();
  return json({ ok: true });
}

async function listAssistants(db: D1Database, accountId: number): Promise<Response> {
  const rows = await db.prepare("SELECT * FROM studio_assistants WHERE account_id=? OR visibility='public' ORDER BY updated_at DESC").bind(accountId).all();
  return json({ assistants: rows.results.map(parseAssistant) });
}

async function saveAssistant(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), instructions = cleanText(b.instructions, 30_000);
  if (!instructions) return json({ error: "instructions_required" }, 400);
  const id = validId(b.id) || crypto.randomUUID();
  await db.prepare("INSERT INTO studio_assistants(id,account_id,name,description,instructions,visibility,icon,knowledge_ids) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,instructions=excluded.instructions,visibility=excluded.visibility,icon=excluded.icon,knowledge_ids=excluded.knowledge_ids,updated_at=datetime('now') WHERE account_id=excluded.account_id").bind(id, accountId, cleanText(b.name, 100) || "Custom assistant", cleanText(b.description, 500), instructions, allowed(b.visibility, ["private", "unlisted", "public"], "private"), cleanText(b.icon, 8) || "✦", JSON.stringify(stringArray(b.knowledge_ids))).run();
  return json({ ok: true, id });
}

async function mutateAssistant(request: Request, db: D1Database, accountId: number, id: string): Promise<Response> {
  if (request.method === "DELETE") { await db.prepare("DELETE FROM studio_assistants WHERE id=? AND account_id=?").bind(id, accountId).run(); return json({ ok: true }); }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const source = await db.prepare("SELECT * FROM studio_assistants WHERE id=? AND (account_id=? OR visibility IN ('public','unlisted'))").bind(id, accountId).first<JsonObject>();
  if (!source) return json({ error: "not_found" }, 404);
  const next = crypto.randomUUID();
  await db.prepare("INSERT INTO studio_assistants(id,account_id,name,description,instructions,visibility,icon,knowledge_ids) VALUES(?,?,?,?,?,'private',?,?)").bind(next, accountId, `${source.name} remix`, source.description, source.instructions, source.icon, source.knowledge_ids).run();
  return json({ ok: true, id: next });
}

async function marketplace(db: D1Database, accountId: number): Promise<Response> {
  const installs = await db.prepare("SELECT workflow_id,settings,installed_at FROM studio_market_installs WHERE account_id=?").bind(accountId).all();
  return json({ workflows: MARKETPLACE, installs: installs.results });
}

async function installWorkflow(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), id = cleanText(b.workflow_id, 80);
  if (!MARKETPLACE.some((x) => x.id === id)) return json({ error: "unknown_workflow" }, 404);
  if (b.installed === false) await db.prepare("DELETE FROM studio_market_installs WHERE account_id=? AND workflow_id=?").bind(accountId, id).run();
  else await db.prepare("INSERT INTO studio_market_installs(account_id,workflow_id,settings) VALUES(?,?,?) ON CONFLICT(account_id,workflow_id) DO UPDATE SET settings=excluded.settings,installed_at=datetime('now')").bind(accountId, id, JSON.stringify(object(b.settings))).run();
  return json({ ok: true });
}

async function saveTask(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), prompt = cleanText(b.prompt, 40_000), title = cleanText(b.title, 160);
  if (!prompt || !title) return json({ error: "title_and_prompt_required" }, 400);
  const id = crypto.randomUUID(), next = isoDate(b.next_run) || new Date(Date.now() + 60_000).toISOString();
  await db.prepare("INSERT INTO studio_tasks(id,account_id,project_id,title,prompt,kind,schedule,next_run,status,notify) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id, accountId, nullableId(b.project_id), title, prompt, allowed(b.kind, ["agent", "research", "coding", "reflection"], "agent"), cleanText(b.schedule, 80) || null, next, b.run_now ? "running" : "scheduled", b.notify === false ? 0 : 1).run();
  return json({ ok: true, id }, 201);
}

async function taskApi(request: Request, env: StudioPlatformEnv, accountId: number, tail: string, ctx: ExecutionContext): Promise<Response> {
  const [id, action] = tail.split("/");
  if (action === "run" && request.method === "POST") {
    await env.DB.prepare("UPDATE studio_tasks SET status='running',progress='Starting…',updated_at=datetime('now') WHERE id=? AND account_id=?").bind(id, accountId).run();
    ctx.waitUntil(runTask(env, accountId, id));
    return json({ ok: true, status: "running" }, 202);
  }
  if (request.method === "DELETE") { await env.DB.prepare("DELETE FROM studio_tasks WHERE id=? AND account_id=?").bind(id, accountId).run(); return json({ ok: true }); }
  if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
  const b = await bodyJson(request);
  await env.DB.prepare("UPDATE studio_tasks SET title=COALESCE(?,title),prompt=COALESCE(?,prompt),schedule=COALESCE(?,schedule),next_run=COALESCE(?,next_run),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=? AND account_id=?").bind(typeof b.title === "string" ? cleanText(b.title, 160) : null, typeof b.prompt === "string" ? cleanText(b.prompt, 40_000) : null, typeof b.schedule === "string" ? cleanText(b.schedule, 80) : null, isoDate(b.next_run), typeof b.status === "string" ? allowed(b.status, ["scheduled", "paused", "cancelled"], "scheduled") : null, id, accountId).run();
  return json({ ok: true });
}

async function runTask(env: StudioPlatformEnv, accountId: number, id: string): Promise<void> {
  const task = await env.DB.prepare("SELECT * FROM studio_tasks WHERE id=? AND account_id=?").bind(id, accountId).first<JsonObject>();
  if (!task) return;
  try {
    await env.DB.prepare("UPDATE studio_tasks SET status='running',progress='Working in the cloud…',updated_at=datetime('now') WHERE id=?").bind(id).run();
    const result = task.kind === "research" ? await researchReport(env, accountId, String(task.prompt), String(task.prompt), []) : await modelText(env, [{ role: "system", content: "Complete this background task directly. Return a durable result with decisions and next actions." }, { role: "user", content: String(task.prompt) }]);
    const next = nextRun(String(task.schedule || ""));
    await env.DB.prepare("UPDATE studio_tasks SET status=?,progress='Complete',result=?,next_run=?,updated_at=datetime('now') WHERE id=?").bind(next ? "scheduled" : "complete", result.slice(0, 200_000), next, id).run();
    if (Number(task.notify)) await notify(env.DB, accountId, String(task.title), "Background task complete.", `/studio/new?task=${id}`);
  } catch (error) {
    await env.DB.prepare("UPDATE studio_tasks SET status='failed',progress=?,updated_at=datetime('now') WHERE id=?").bind(errorText(error), id).run();
    await notify(env.DB, accountId, String(task.title), `Task failed: ${errorText(error)}`, `/studio/new?task=${id}`);
  }
}

async function saveSession(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), id = crypto.randomUUID(), token = randomToken();
  await db.prepare("INSERT INTO studio_agent_sessions(id,account_id,project_id,kind,title,state,status,workspace_key,control_token) VALUES(?,?,?,?,?,?,?,?,?)").bind(id, accountId, nullableId(b.project_id), allowed(b.kind, ["agent", "research", "coding", "browser", "cowork", "multi-agent"], "agent"), cleanText(b.title, 160) || "Background session", JSON.stringify(object(b.state)), "ready", `sessions/${accountId}/${id}`, token).run();
  return json({ ok: true, id, control_url: `/studio/new?session=${id}&control=${token}` }, 201);
}

async function mutateSession(request: Request, db: D1Database, accountId: number, id: string): Promise<Response> {
  if (request.method === "DELETE") { await db.prepare("UPDATE studio_agent_sessions SET status='cancelled',updated_at=datetime('now') WHERE id=? AND account_id=?").bind(id, accountId).run(); return json({ ok: true }); }
  if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
  const b = await bodyJson(request);
  await db.prepare("UPDATE studio_agent_sessions SET title=COALESCE(?,title),state=COALESCE(?,state),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=? AND account_id=?").bind(typeof b.title === "string" ? cleanText(b.title, 160) : null, b.state ? JSON.stringify(object(b.state)) : null, typeof b.status === "string" ? allowed(b.status, ["ready", "running", "paused", "complete", "cancelled", "failed"], "ready") : null, id, accountId).run();
  return json({ ok: true });
}

async function sessionApi(request: Request, env: StudioPlatformEnv, accountId: number, tail: string, ctx: ExecutionContext): Promise<Response> {
  const [id, action] = tail.split("/");
  if (action === "run" && request.method === "POST") {
    const b = await bodyJson(request), prompt = cleanText(b.prompt, 40_000);
    if (!prompt) return json({ error: "prompt_required" }, 400);
    await env.DB.prepare("UPDATE studio_agent_sessions SET state=?,status='running',updated_at=datetime('now') WHERE id=? AND account_id=?").bind(JSON.stringify({ prompt, progress: "Launching isolated roles", agents: [] }), id, accountId).run();
    ctx.waitUntil(runManagedSession(env, accountId, id, prompt));
    return json({ ok: true, status: "running" }, 202);
  }
  return mutateSession(request, env.DB, accountId, id);
}

async function runManagedSession(env: StudioPlatformEnv, accountId: number, id: string, prompt: string): Promise<void> {
  const roles = [
    ["Architect", "Design the implementation and identify interfaces, risks, and files."],
    ["Builder", "Produce the concrete implementation approach and key code changes."],
    ["Tester", "Design verification, edge-case, security, and regression tests."],
    ["Reviewer", "Challenge the plan for correctness, maintainability, and hidden failure modes."],
  ];
  try {
    const agents = await Promise.all(roles.map(async ([name, instruction]) => ({ name, status: "complete", output: await modelText(env, [{ role: "system", content: `You are the ${name} in a separate managed coding workspace. ${instruction}` }, { role: "user", content: prompt }]) })));
    await env.DB.prepare("UPDATE studio_agent_sessions SET state=?,updated_at=datetime('now') WHERE id=? AND account_id=?").bind(JSON.stringify({ prompt, progress: "Delegator synthesis", agents }), id, accountId).run();
    const synthesis = await modelText(env, [{ role: "system", content: "You are the lead coding delegator. Synthesize the independent managed-workspace outputs into one executable plan with file changes, tests, and risk controls. Resolve disagreements explicitly." }, { role: "user", content: agents.map((a) => `${a.name}:\n${a.output}`).join("\n\n") }]);
    await env.DB.prepare("UPDATE studio_agent_sessions SET state=?,status='complete',updated_at=datetime('now') WHERE id=? AND account_id=?").bind(JSON.stringify({ prompt, progress: "Complete", agents, synthesis }), id, accountId).run();
    await notify(env.DB, accountId, "Multi-agent coding session complete", prompt.slice(0, 160), `/studio/new?session=${id}`);
  } catch (error) {
    await env.DB.prepare("UPDATE studio_agent_sessions SET state=?,status='failed',updated_at=datetime('now') WHERE id=? AND account_id=?").bind(JSON.stringify({ prompt, progress: errorText(error) }), id, accountId).run();
    await notify(env.DB, accountId, "Multi-agent coding session failed", errorText(error), `/studio/new?session=${id}`);
  }
}

async function runResearch(request: Request, env: StudioPlatformEnv, accountId: number, ctx: ExecutionContext): Promise<Response> {
  const b = await bodyJson(request), question = cleanText(b.question, 20_000), plan = cleanText(b.plan, 20_000) || question;
  if (!question) return json({ error: "question_required" }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO studio_agent_sessions(id,account_id,project_id,kind,title,state,status,workspace_key,control_token) VALUES(?,?,?,'research',?,?, 'running',?,?)").bind(id, accountId, nullableId(b.project_id), cleanText(b.title, 160) || chatTitle([{ role: "user", content: question }]), JSON.stringify({ question, plan, progress: "Searching sources" }), `research/${accountId}/${id}`, randomToken()).run();
  try {
    const report = await researchReport(env, accountId, question, plan, stringArray(b.domains));
    await env.DB.prepare("UPDATE studio_agent_sessions SET state=?,status='complete',updated_at=datetime('now') WHERE id=? AND account_id=?").bind(JSON.stringify({ question, plan, progress: "Complete", report }), id, accountId).run();
    await notify(env.DB, accountId, "Research complete", cleanText(b.title, 160) || question.slice(0, 100), `/studio/new?session=${id}`);
    ctx.waitUntil(Promise.resolve());
    return json({ ok: true, id, report });
  } catch (error) {
    await env.DB.prepare("UPDATE studio_agent_sessions SET state=?,status='failed',updated_at=datetime('now') WHERE id=?").bind(JSON.stringify({ question, plan, progress: errorText(error) }), id).run();
    return json({ error: "research_failed", message: errorText(error), id }, 502);
  }
}

async function researchReport(env: StudioPlatformEnv, _accountId: number, question: string, plan: string, domains: string[]): Promise<string> {
  const queries = plan.split(/\n+/).map((line) => line.replace(/^[-*\d.()\s]+/, "").trim()).filter(Boolean).slice(0, 4);
  if (!queries.length) queries.push(question);
  const found = (await Promise.all(queries.map((q) => webSearch(q, domains)))).flat();
  const unique = [...new Map(found.map((x) => [x.url, x])).values()].slice(0, 12);
  const sources = await Promise.all(unique.map(async (source, index) => ({ ...source, index: index + 1, excerpt: await pageExcerpt(source.url) })));
  const material = sources.map((s) => `[${s.index}] ${s.title}\n${s.url}\n${s.excerpt}`).join("\n\n").slice(0, 100_000);
  return modelText(env, [{ role: "system", content: "You are OSS Studio Research. Follow the user's editable plan. Write a cited final report using only the supplied sources. Every factual claim must cite source numbers like [1]. Include findings, uncertainty, disagreements, and a source list with full URLs." }, { role: "user", content: `Question: ${question}\n\nPlan:\n${plan}\n\nSources:\n${material}` }]);
}

async function browserAction(request: Request, env: StudioPlatformEnv, accountId: number): Promise<Response> {
  if (!env.BROWSER) return json({ error: "browser_unavailable", message: "Cloud browser is not configured." }, 503);
  const b = await bodyJson(request), action = allowed(b.action, ["navigate", "read", "click", "type"], "navigate"), sessionId = validId(b.session_id) || crypto.randomUUID();
  if (["click", "type"].includes(action) && b.confirmed !== true) return json({ error: "confirmation_required", message: "Confirm this browser action before it runs." }, 409);
  const url = safePublicUrl(String(b.url || ""));
  if (!url) return json({ error: "public_url_required" }, 400);
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60_000 });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 820 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const selector = cleanText(b.selector, 300);
    if (action === "click" && selector) await page.click(selector);
    if (action === "type" && selector) await page.type(selector, cleanText(b.value, 2_000));
    if (action === "click" || action === "type") await new Promise((resolve) => setTimeout(resolve, 700));
    const screenshot = await page.screenshot({ type: "jpeg", quality: 76 });
    const key = `browser/${accountId}/${sessionId}.jpg`;
    await env.STUDIO_FILES.put(key, screenshot, { httpMetadata: { contentType: "image/jpeg" } });
    const text = cleanText(await page.evaluate(() => document.body?.innerText || ""), 40_000);
    const state = { url: page.url(), title: await page.title(), action, text: text.slice(0, 12_000), screenshot: `/studio/api/platform/browser/screenshot/${sessionId}` };
    await env.DB.prepare("INSERT INTO studio_agent_sessions(id,account_id,kind,title,state,status,workspace_key,control_token) VALUES(?,?,'browser',?,?,'ready',?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,title=excluded.title,updated_at=datetime('now') WHERE account_id=excluded.account_id").bind(sessionId, accountId, state.title || "Browser session", JSON.stringify(state), key, randomToken()).run();
    return json({ ok: true, session_id: sessionId, ...state });
  } finally { await browser.close(); }
}

async function browserScreenshot(env: StudioPlatformEnv, accountId: number, sessionId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT workspace_key FROM studio_agent_sessions WHERE id=? AND account_id=? AND kind='browser'").bind(sessionId, accountId).first<{ workspace_key: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  const object = await env.STUDIO_FILES.get(row.workspace_key);
  return object ? new Response(object.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } }) : json({ error: "not_found" }, 404);
}

async function updateStudy(request: Request, db: D1Database, accountId: number): Promise<Response> {
  const b = await bodyJson(request), topic = cleanText(b.topic, 200);
  if (!topic) return json({ error: "topic_required" }, 400);
  await db.prepare("INSERT INTO studio_study_progress(account_id,topic,level,correct,attempted,notes) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,topic) DO UPDATE SET level=excluded.level,correct=studio_study_progress.correct+excluded.correct,attempted=studio_study_progress.attempted+excluded.attempted,notes=excluded.notes,updated_at=datetime('now')").bind(accountId, topic, Math.max(1, Math.min(10, Number(b.level || 1))), b.correct ? 1 : 0, 1, cleanText(b.notes, 2_000)).run();
  return json({ ok: true });
}

async function reflection(db: D1Database, accountId: number): Promise<Response> {
  const [chats, tasks, usage] = await Promise.all([
    db.prepare("SELECT title,mode,updated_at FROM studio_chats WHERE account_id=? AND updated_at>=datetime('now','-30 day') ORDER BY updated_at DESC").bind(accountId).all(),
    db.prepare("SELECT kind,status,COUNT(*) count FROM studio_tasks WHERE account_id=? GROUP BY kind,status").bind(accountId).all(),
    db.prepare("SELECT model,SUM(total_tokens) tokens,COUNT(*) requests FROM token_usage WHERE account_id=? AND created_at>=datetime('now','-30 day') GROUP BY model ORDER BY tokens DESC").bind(accountId).all(),
  ]);
  const topics = new Map<string, number>();
  for (const row of chats.results as Array<{ title?: string }>) for (const word of String(row.title || "").toLowerCase().match(/[a-z]{4,}/g) || []) topics.set(word, (topics.get(word) || 0) + 1);
  return json({ chats: chats.results.length, topics: [...topics].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([topic, count]) => ({ topic, count })), tasks: tasks.results, usage: usage.results });
}

async function modelText(env: StudioPlatformEnv, messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await poolsideModelRequest(new Request("https://internal/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ model: "poolside/laguna-s-2.1", messages, stream: false, temperature: 0.35 }) }), env, "/chat/completions");
  const data: JsonObject = await response
    .json<JsonObject>()
    .catch((): JsonObject => ({}));
  if (!response.ok) throw new Error(errorText(data.error || data));
  const choices = Array.isArray(data.choices) ? data.choices : [], first = object(choices[0]), message = object(first.message), content = message.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned no final response.");
  return content;
}

async function webSearch(query: string, domains: string[]): Promise<Array<{ title: string; url: string }>> {
  const suffix = domains.length ? ` ${domains.slice(0, 8).map((x) => `site:${x.replace(/[^a-zA-Z0-9.-]/g, "")}`).join(" OR ")}` : "";
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + suffix)}`, { headers: { "user-agent": "OSS-Studio-Research/1.0" } });
  if (!response.ok) return [];
  const html = await response.text(), out: Array<{ title: string; url: string }> = [];
  for (const match of html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = decodeHtml(match[1]), title = decodeHtml(match[2].replace(/<[^>]+>/g, "").trim());
    if (safePublicUrl(url) && title) out.push({ title: title.slice(0, 240), url });
    if (out.length === 6) break;
  }
  return out;
}

async function pageExcerpt(url: string): Promise<string> {
  try {
    const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "OSS-Studio-Research/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return `Source returned HTTP ${response.status}.`;
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/") && !type.includes("json")) return `Non-text source (${type || "unknown"}).`;
    return cleanText((await response.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "), 12_000);
  } catch { return "Source could not be fetched."; }
}

async function notify(db: D1Database, accountId: number, title: string, body: string, href: string): Promise<void> {
  await db.prepare("INSERT INTO studio_notifications(id,account_id,title,body,href) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), accountId, cleanText(title, 160), cleanText(body, 500), href).run();
}

async function listRows(db: D1Database, table: "studio_documents" | "studio_tasks" | "studio_notifications" | "studio_agent_sessions", accountId: number): Promise<Response> {
  const rows = await db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY updated_at DESC LIMIT 200`).bind(accountId).all().catch(async () => db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY created_at DESC LIMIT 200`).bind(accountId).all());
  return json({ items: rows.results });
}

function parseChat(row: unknown) { const item = object(row); return { ...item, messages: safeArray(item.messages) }; }
function parseDocument(row: unknown) { const item = object(row); return { ...item, metadata: safeObject(item.metadata) }; }
function parseAssistant(row: unknown) { const item = object(row); return { ...item, knowledge_ids: safeArray(item.knowledge_ids) }; }
function parseSession(row: unknown) { const item = object(row); return { ...item, state: safeObject(item.state) }; }
function defaultProfile() { return { custom_instructions: "", preferences: {}, tier: "standard", memory_enabled: 1 }; }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } }
function safeArray(value: unknown): unknown[] { const parsed = parseJson(value); return Array.isArray(parsed) ? parsed : []; }
function safeObject(value: unknown): JsonObject { const parsed = parseJson(value); return object(parsed); }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
async function bodyJson(request: Request): Promise<JsonObject> { try { return object(await request.json()); } catch { return {}; } }
function cleanText(value: unknown, max: number): string { return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((x) => typeof x === "string" && x.trim() ? [x.trim().slice(0, 160)] : []).slice(0, 100) : []; }
function validId(value: unknown): string { return typeof value === "string" && /^[a-zA-Z0-9_-]{6,80}$/.test(value) ? value : ""; }
function nullableId(value: unknown): string | null { const id = validId(value); return id || null; }
function allowed<T extends string>(value: unknown, values: readonly T[], fallback: T): T { return typeof value === "string" && values.includes(value as T) ? value as T : fallback; }
function isoDate(value: unknown): string | null { if (typeof value !== "string" || !value) return null; const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null; }
function nextRun(schedule: string): string | null { const match = schedule.match(/^every:(\d+):(minutes|hours|days)$/); if (!match) return null; const amount = Math.max(1, Math.min(10_000, Number(match[1]))), unit = match[2] === "minutes" ? 60_000 : match[2] === "hours" ? 3_600_000 : 86_400_000; return new Date(Date.now() + amount * unit).toISOString(); }
function randomToken(): string { const bytes = new Uint8Array(24); crypto.getRandomValues(bytes); return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function safeFileName(name: string): string { return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "file"; }
function chatTitle(messages: unknown[]): string { const first = messages.map(object).find((m) => m.role === "user"); return messageText(first?.content).replace(/\s+/g, " ").slice(0, 90) || "New conversation"; }
function messageText(value: unknown): string { if (typeof value === "string") return value; if (Array.isArray(value)) return value.map((x) => { const p = object(x); return typeof p.text === "string" ? p.text : ""; }).join("\n"); return ""; }
function errorText(error: unknown): string { if (error instanceof Error) return error.message.slice(0, 500); if (typeof error === "string") return error.slice(0, 500); try { return JSON.stringify(error).slice(0, 500); } catch { return "Unknown error"; } }
function safePublicUrl(value: string): string { try { const url = new URL(value); if (!/^https?:$/.test(url.protocol) || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i.test(url.hostname)) return ""; return url.href; } catch { return ""; } }
function decodeHtml(value: string): string { return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char); }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
function sharedPage(title: string, content: string, updated: string): Response { return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · OSS Studio</title><style>body{margin:0;background:#000;color:#f5f5f1;font:16px/1.7 system-ui}.wrap{max-width:820px;margin:auto;padding:56px 24px}header{border-bottom:1px solid #242424;margin-bottom:36px}small{color:#8e8e88}.user{margin:20px 0 20px auto;max-width:75%;background:#0c2d1e;border:1px solid #175b3a;border-radius:18px 18px 4px;padding:14px 18px}.assistant,.document{white-space:pre-wrap;margin:24px 0}pre{white-space:pre-wrap;font:inherit}</style></head><body><main class="wrap"><header><h1>${escapeHtml(title)}</h1><small>Shared from OSS Studio · ${escapeHtml(updated)}</small></header>${content}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; frame-ancestors 'none'" } }); }
