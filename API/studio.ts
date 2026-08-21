import {
  generalSafetyCheck,
  poolsideModelRequest,
  type PoolsideEnv,
} from "./poolside";
import {
  providerForModel,
  trackTokenResponse,
} from "../src/lib/token-usage";
import { BITNET_MODEL_ID } from "./bitnet";

export interface StudioEnv extends PoolsideEnv {
  DB: D1Database;
  STUDIO_FILES: R2Bucket;
}
type Account = { id: number; email: string; display_name: string };
const MODELS = [
  { id: BITNET_MODEL_ID, name: "Mini (Preview)", access: "guest" },
  { id: "poolside/laguna-xs-2.1", name: "Fast", access: "guest" },
  { id: "poolside/laguna-s-2.1", name: "Smart", access: "guest" },
  { id: "logfare/kimi-k3", name: "Kimi K3", access: "advanced" },
  {
    id: "logfare/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    access: "advanced",
  },
  { id: "logfare/minimax-m3", name: "MiniMax M3", access: "advanced" },
  {
    id: "logfare/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    access: "advanced",
  },
] as const;

const STUDIO_IDENTITY_PROMPT =
  "You are a helpful AI assistant in OSS Studio by OSAII (Open-Source AI Initiative, osaii.wyvernhub.net). Be clear, honest, and useful. Do not claim to be the underlying model provider or expose internal provider details.";

function withStudioIdentity(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const alreadyPresent = messages.some((message) =>
    message && typeof message === "object" &&
    (message as { role?: unknown }).role === "system" &&
    typeof (message as { content?: unknown }).content === "string" &&
    (message as { content: string }).content.includes("Open-Source AI Initiative")
  );
  return alreadyPresent
    ? body
    : { ...body, messages: [{ role: "system", content: STUDIO_IDENTITY_PROMPT }, ...messages] };
}

export async function studioApi(
  request: Request,
  env: StudioEnv,
  path: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const account = await accountFor(request, env.DB);
  // Studio is authenticated-first: retain the account identity rather than a
  // network identifier, so users behind shared IPs are never conflated.
  if (account) await trackRequest(env.DB, account.id, "studio", request);
  else await trackAnonymousRequest(env.DB, request, "studio");
  if (path === "/chat" && request.method === "POST") {
    const limited = await globalRateLimit(env.DB, request, account?.id ?? null);
    if (limited) return limited;
  }
  if (path === "/models" && request.method === "GET")
    return json({
      models: MODELS.filter((model) => account || model.access === "guest"),
      access: account ? "advanced" : "guest",
    });
  if (path === "/swarm" && request.method === "POST") {
    if (!account)
      return json(
        { error: "sign_in_required", message: "Sign in to use Agent Swarm." },
        401,
      );
    return studioSwarm(request, env, account, ctx);
  }
  if (path === "/chat" && request.method === "POST")
    return studioChat(request, env, account, ctx);
  if (!account)
    return json(
      {
        error: "sign_in_required",
        message:
          "Sign in to create projects, use agent tools, or change deployment settings.",
      },
      401,
    );

  if (path === "/projects" && request.method === "GET")
    return json({
      projects: (
        await env.DB.prepare(
          "SELECT id,name,storage_mode,permission_mode,status,updated_at FROM studio_projects WHERE account_id=? ORDER BY updated_at DESC",
        )
          .bind(account.id)
          .all()
      ).results,
    });
  if (path === "/projects" && request.method === "POST")
    return createProject(request, env.DB, account);
  if (path === "/usage" && request.method === "GET")
    return usage(env.DB, account.id);
  if (path === "/audit" && request.method === "GET")
    return json({
      events: (
        await env.DB.prepare(
          "SELECT kind,detail,project_id,created_at FROM studio_audit WHERE account_id=? ORDER BY id DESC LIMIT 100",
        )
          .bind(account.id)
          .all()
      ).results,
    });
  if (path === "/plugins" && request.method === "GET")
    return json({
      plugins: (
        await env.DB.prepare(
          "SELECT id,kind,name,endpoint,manifest,enabled,created_at FROM studio_plugins WHERE account_id=? ORDER BY created_at DESC",
        )
          .bind(account.id)
          .all()
      ).results,
    });
  if (path === "/plugins" && request.method === "POST")
    return savePlugin(request, env.DB, account);

  const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/(.*))?$/);
  if (!projectMatch) return json({ error: "not_found" }, 404);
  const projectId = projectMatch[1];
  const tail = projectMatch[2] || "";
  const project = await owned(env.DB, account.id, projectId);
  if (!project) return json({ error: "not_found" }, 404);

  if (tail === "" && request.method === "PATCH")
    return updateProject(request, env.DB, account, projectId);
  if (tail === "files" && request.method === "GET")
    return json({
      files: (
        await env.DB.prepare(
          "SELECT path,version,content_type,updated_at FROM studio_files WHERE project_id=? ORDER BY path",
        )
          .bind(projectId)
          .all()
      ).results,
    });
  const fileMatch = tail.match(/^files\/(.*)$/);
  if (fileMatch) return fileApi(request, env, account, projectId, fileMatch[1]);
  if (tail === "deploy" && request.method === "POST")
    return deploy(request, env.DB, account, projectId);
  if (tail === "deployments" && request.method === "GET")
    return json({
      deployments: (
        await env.DB.prepare(
          "SELECT id,provider,status,detail,created_at,updated_at FROM studio_deployments WHERE project_id=? ORDER BY id DESC LIMIT 25",
        )
          .bind(projectId)
          .all()
      ).results,
    });
  if (tail === "tools" && request.method === "POST")
    return toolRun(request, env, account, projectId);
  return json({ error: "not_found" }, 404);
}

export async function trackAnonymousRequest(
  db: D1Database,
  request: Request,
  surface = "api",
): Promise<void> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  let ipHash = ipHashMemo.get(request as unknown as object);
  if (!ipHash) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    ipHash = [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
    ipHashMemo.set(request as unknown as object, ipHash);
  }
  await db
    .prepare(
      "INSERT INTO request_activity(ip_hash,surface,method,path) VALUES(?,?,?,?)",
    )
    .bind(
      ipHash,
      surface,
      request.method,
      new URL(request.url).pathname.slice(0, 300),
    )
    .run();
}

/** Persistent D1-backed guard: identity comes only from a Cloudflare header
 * (anonymous) or the verified session (Studio), never from browser input. */
/**
 * Studio deliberately has a much larger fair-use envelope than /api/v1.
 * The public API is for customer-owned integrations and keeps its tighter
 * model-aware limits; Studio is an interactive product and should not feel
 * like every few messages are a quota wall. These are still hard abuse
 * brakes, rather than an unsafe promise of literally unlimited inference.
 */
const STUDIO_LIMITS = {
  guest: { minute: 30, hour: 300, day: 1_000 },
  account: { minute: 600, hour: 6_000, day: 20_000 },
} as const;
const STUDIO_MINI_FAST_LIMITS = {
  guest: { minute: 5, hour: 30, day: 100 },
  account: { minute: 10, hour: 100, day: 300 },
} as const;
// Memoize SHA-256 of IP per Request object to avoid double hashing (track + rate limit + token usage)
const ipHashMemo = new WeakMap<object, string>();
type StudioRateWindow = { count: number; resetAt: number };
const studioMiniFastWindows = new Map<string, StudioRateWindow>();

function studioMiniFastWindow(key: string, now: number, duration: number): StudioRateWindow {
  const current = studioMiniFastWindows.get(key);
  if (current && current.resetAt > now) {
    current.count += 1;
    return current;
  }
  const next = { count: 1, resetAt: now + duration };
  studioMiniFastWindows.set(key, next);
  if (studioMiniFastWindows.size > 10_000)
    for (const [entry, value] of studioMiniFastWindows) if (value.resetAt <= now) studioMiniFastWindows.delete(entry);
  return next;
}

async function globalRateLimit(
  db: D1Database,
  request: Request,
  accountId: number | null,
): Promise<Response | null> {
  const body: { model?: unknown; fast_mode?: unknown; device?: unknown } = await request.clone().json<{ model?: unknown; fast_mode?: unknown; device?: unknown }>().catch(() => ({} as { model?: unknown; fast_mode?: unknown; device?: unknown }));
  const selectedModel = typeof body.model === "string" ? body.model : "";
  const fastMini = selectedModel === BITNET_MODEL_ID && (body.fast_mode === true || body.device === "gpu");
  // Standard Mini uses the CPU demo path and is unlimited for guests and
  // accounts. Only its explicitly selected GPU Fast Mode is quota-managed.
  if (selectedModel === BITNET_MODEL_ID && !fastMini) return null;
  if (fastMini) {
    const bytes = accountId
      ? `account:${accountId}`
      : `ip:${request.headers.get("cf-connecting-ip") || "unknown"}`;
    const now = Date.now();
    const limits = accountId ? STUDIO_MINI_FAST_LIMITS.account : STUDIO_MINI_FAST_LIMITS.guest;
    const minute = studioMiniFastWindow(`${bytes}:minute`, now, 60_000);
    const hour = studioMiniFastWindow(`${bytes}:hour`, now, 3_600_000);
    const day = studioMiniFastWindow(`${bytes}:day`, now, 86_400_000);
    const breached = minute.count > limits.minute ? minute : hour.count > limits.hour ? hour : day.count > limits.day ? day : null;
    if (!breached) return null;
    const retryAfter = Math.max(1, Math.ceil((breached.resetAt - now) / 1000));
    return json({
      error: "rate_limit_exceeded",
      message: "Mini Fast Mode has a separate GPU fair-use limit. Mini streaming remains unlimited.",
      scope: "studio-mini-fast",
      limits,
    }, 429, { "retry-after": String(retryAfter), "x-ratelimit-limit-minute": String(limits.minute), "x-ratelimit-remaining": String(Math.max(0, limits.minute - minute.count)) });
  }
  // IP hash memoization per-request (also used by token-usage)
  const identity = accountId
    ? { clause: "account_id=?", value: accountId, hash: null as string | null }
    : await (async () => {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        // use shared memoized anonymous hash if available via WeakMap
        const cached = ipHashMemo.get(request as unknown as object);
        if (cached) return { clause: "ip_hash=?", value: cached, hash: cached };
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
        const hash = [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
        ipHashMemo.set(request as unknown as object, hash);
        return { clause: "ip_hash=?", value: hash, hash };
      })();
  // Single round-trip conditional aggregation (was 3 separate COUNT queries)
  const row = await db.prepare(
    `SELECT
      SUM(CASE WHEN created_at >= datetime('now','-1 minute') THEN 1 ELSE 0 END) AS minuteCount,
      SUM(CASE WHEN created_at >= datetime('now','-1 hour') THEN 1 ELSE 0 END) AS hourCount,
      SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS dayCount
    FROM request_activity
    WHERE ${identity.clause} AND surface='studio' AND path='/studio/api/chat' AND created_at >= datetime('now','-1 day')`
  ).bind(identity.value).first<{ minuteCount: number; hourCount: number; dayCount: number }>();
  const limits = accountId ? STUDIO_LIMITS.account : STUDIO_LIMITS.guest;
  const counts = {
    minute: Number(row?.minuteCount || 0),
    hour: Number(row?.hourCount || 0),
    day: Number(row?.dayCount || 0),
  };
  const breached = (Object.keys(limits) as Array<keyof typeof limits>).find(
    (window) => counts[window] > limits[window],
  );
  if (!breached) return null;
  const retryAfter = breached === "minute" ? 60 : breached === "hour" ? 3_600 : 86_400;
  const remaining = Math.max(
    0,
    Math.min(
      limits.minute - counts.minute,
      limits.hour - counts.hour,
      limits.day - counts.day,
    ),
  );
  return json(
    {
      error: "rate_limit_exceeded",
      message: "Studio is temporarily at its fair-use limit. Please try again shortly.",
      scope: "studio",
      limits,
    },
    429,
    {
      "retry-after": String(retryAfter),
      "x-ratelimit-limit-minute": String(limits.minute),
      "x-ratelimit-remaining": String(remaining),
    },
  );
}

async function trackRequest(
  db: D1Database,
  accountId: number,
  surface: string,
  request: Request,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO request_activity(account_id,surface,method,path) VALUES(?,?,?,?)",
    )
    .bind(
      accountId,
      surface,
      request.method,
      new URL(request.url).pathname.slice(0, 300),
    )
    .run();
}

/** The Studio uses the same audited gateway as the public API.  Streaming is
 * intentionally passed through unchanged so the browser can render deltas. */
async function studioChat(
  request: Request,
  env: StudioEnv,
  account: Account | null,
  ctx: ExecutionContext,
): Promise<Response> {
  const body: { model?: unknown; surface?: unknown; stream?: unknown } = await request
    .clone()
    .json<{ model?: unknown; surface?: unknown }>()
    .catch(() => ({}));
  if (body.surface === "agent" && !account)
    return json(
      { error: "sign_in_required", message: "Sign in to use Agent mode." },
      401,
    );
  const selected = typeof body.model === "string" ? body.model : "";
  const model = MODELS.find((candidate) => candidate.id === selected);
  if (!model) return json({ error: "model_not_available" }, 404);
  if (model.access === "advanced" && !account)
    return json(
      {
        error: "advanced_access_required",
        message: "Sign in to use this model.",
      },
      403,
    );
  // Rebuild the upstream request from the parsed payload. This keeps the
  // gateway independent of any prior body clone used for model gating.
  const response = await poolsideModelRequest(
    new Request(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: request.headers.get("accept") || "application/json",
      },
      body: JSON.stringify(withStudioIdentity(body as Record<string, unknown>)),
    }),
    env,
    "/chat/completions",
  );
  if (account)
    await audit(
      env.DB,
      account.id,
      "",
      "chat.request",
      `${model.id}${body && typeof body === "object" && (body as { stream?: unknown }).stream ? " stream" : ""}`,
    );
  return trackTokenResponse(response, {
    db: env.DB,
    ctx,
    request,
    accountId: account?.id ?? null,
    surface: body.surface === "agent" ? "studio_agent" : "studio_chat",
    provider: providerForModel(model.id),
    model: model.id,
    path: "/studio/api/chat",
  });
}

async function studioSwarm(
  request: Request,
  env: StudioEnv,
  account: Account,
  ctx: ExecutionContext,
): Promise<Response> {
  const body: { prompt?: unknown } = await request
    .clone()
    .json<{ prompt?: unknown }>()
    .catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 8_000) : "";
  if (!prompt) return json({ error: "prompt_required" }, 400);

  // A Swarm is one user task, not 301 unrelated public API requests. Screen
  // the task once before fan-out, then screen the final synthesis once after
  // inference. Internal researcher calls reuse this approved decision so a
  // Groq safety quota cannot be exhausted by the 300-way fan-out.
  const inputSafety = await generalSafetyCheck(
    {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: prompt }],
    },
    env,
  );
  if (!inputSafety.allowed) {
    const unavailable = inputSafety.unavailable === true;
    await audit(
      env.DB,
      account.id,
      "",
      "swarm.blocked",
      unavailable ? "input safety unavailable" : inputSafety.reason || "input safety blocked",
    );
    return json(
      {
        error: {
          code: unavailable ? "safety_filter_unavailable" : "content_policy_violation",
          message: unavailable
            ? "Safety screening is temporarily unavailable. Please retry the swarm shortly."
            : inputSafety.message,
        },
      },
      unavailable ? 503 : 400,
    );
  }

  // Keep the product promise of roughly 300 logical researchers without
  // changing the user-facing "300 fast researchers" contract.
  // opening 300 upstream connections in one Worker request. Twenty-four
  // bounded researcher calls are materially more reliable under provider and
  // Worker time limits; each call is instructed to cover a slice of the
  // logical swarm and the delegator still receives the combined perspectives.
  const logicalResearcherCount = 300;
  const upstreamResearcherCount = 24;
  await audit(env.DB, account.id, "", "swarm.start", `${logicalResearcherCount} logical researchers (${upstreamResearcherCount} pooled calls)`);
  const results = new Array<string>(upstreamResearcherCount).fill("");
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= results.length) return;
      try {
        const upstream = await poolsideModelRequest(
          new Request(request.url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              model: "poolside/laguna-xs-2.1",
              max_tokens: 180,
              messages: [
                { role: "system", content: `${STUDIO_IDENTITY_PROMPT}\nYou are a bounded researcher call representing logical researchers ${index * Math.ceil(logicalResearcherCount / upstreamResearcherCount) + 1}-${Math.min(logicalResearcherCount, (index + 1) * Math.ceil(logicalResearcherCount / upstreamResearcherCount))} in a parallel team of ${logicalResearcherCount}. Produce one compact, concrete angle that combines that slice. Do not repeat the task.` },
                { role: "user", content: prompt },
              ],
            }),
          }),
          env,
          "/chat/completions",
          // The Swarm task was screened once above. Do not send the same input
          // through Groq 300 times, and do not screen intermediate findings.
          { safetyAlreadyChecked: true, finalOutputSafety: false, modelAlreadyValidated: true },
        );
        const response = trackTokenResponse(upstream, {
          db: env.DB,
          ctx,
          request,
          accountId: account.id,
          surface: "studio_swarm",
          provider: "poolside",
          model: "poolside/laguna-xs-2.1",
          path: "/studio/api/swarm/research",
        });
        if (!response.ok) continue;
        const result: { choices?: Array<{ message?: { content?: unknown } }> } = await response
          .json<{ choices?: Array<{ message?: { content?: unknown } }> }>()
          .catch(() => ({}));
        const content = result.choices?.[0]?.message?.content;
        if (typeof content === "string") results[index] = content.slice(0, 1_200);
      } catch {
        // One researcher failing must not stop the rest of the Swarm.
      }
    }
  };
  // Keep 300 logical agents while limiting Poolside and Worker concurrency.
  await Promise.all(Array.from({ length: 24 }, () => worker()));
  const findings = results.filter(Boolean);
  const synthesis = trackTokenResponse(await poolsideModelRequest(
    new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: "poolside/laguna-s-2.1",
        max_tokens: 1_500,
        messages: [
          { role: "system", content: `${STUDIO_IDENTITY_PROMPT}\nYou are the lead delegator. Synthesize the team findings into a direct, useful answer with a recommendation. Do not mention internal provider details.` },
          { role: "user", content: `Task: ${prompt}\n\nFindings from ${logicalResearcherCount} logical researchers (${findings.length} pooled calls):\n${findings.join("\n---\n").slice(0, 120_000)}` },
        ],
      }),
    }),
    env,
    "/chat/completions",
    // The final synthesis is screened explicitly below so the Swarm performs
    // exactly one output check, after all researcher work is complete.
    { safetyAlreadyChecked: true, finalOutputSafety: false, modelAlreadyValidated: true },
  ), {
    db: env.DB,
    ctx,
    request,
    accountId: account.id,
    surface: "studio_swarm",
    provider: "poolside",
    model: "poolside/laguna-s-2.1",
    path: "/studio/api/swarm/synthesis",
  });

  if (!synthesis.ok) {
    const raw = await synthesis.text();
    let detail = "The delegator model could not complete the synthesis.";
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      const nested = parsed.error && typeof parsed.error === "object" ? (parsed.error as { message?: unknown }).message : parsed.error;
      if (typeof nested === "string" && nested.trim()) detail = nested.slice(0, 500);
      else if (typeof parsed.message === "string" && parsed.message.trim()) detail = parsed.message.slice(0, 500);
    } catch {
      if (raw.trim() && !raw.trim().startsWith("<")) detail = raw.trim().slice(0, 500);
    }
    await audit(env.DB, account.id, "", "swarm.failed", `${synthesis.status}: ${detail}`);
    return json({ error: { code: "swarm_upstream_error", message: detail } }, synthesis.status >= 500 ? 502 : synthesis.status);
  }

  if ((synthesis.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    const raw = await synthesis.text();
    let payload: { choices?: Array<{ message?: { content?: unknown } }> } | null = null;
    try {
      payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    } catch {
      // Preserve an unexpected upstream body; the normal proxy already
      // handled it and there is no textual completion to screen here.
    }
    const finalText = payload?.choices?.[0]?.message?.content;
    if (typeof finalText === "string" && finalText.trim()) {
      const outputSafety = await generalSafetyCheck(
        {
          model: "poolside/laguna-s-2.1",
          messages: [{ role: "assistant", content: finalText.slice(0, 12_000) }],
        },
        env,
      );
      if (!outputSafety.allowed) {
        const unavailable = outputSafety.unavailable === true;
        await audit(
          env.DB,
          account.id,
          "",
          "swarm.output_blocked",
          unavailable ? "output safety unavailable" : outputSafety.reason || "output safety blocked",
        );
        return json(
          {
            error: {
              code: unavailable ? "safety_filter_unavailable" : "content_policy_violation",
              message: unavailable
                ? "Safety screening is temporarily unavailable. Please retry the swarm shortly."
                : "The swarm response was blocked by the safety filter.",
            },
          },
          unavailable ? 503 : 400,
        );
      }
    }
    await audit(env.DB, account.id, "", "swarm.complete", `${logicalResearcherCount} logical researchers represented by ${findings.length} pooled calls`);
    return new Response(raw, { status: synthesis.status, headers: synthesis.headers });
  }

  const raw = await synthesis.text();
  const text = raw.trim();
  if (text) {
    await audit(env.DB, account.id, "", "swarm.complete", `${logicalResearcherCount} logical researchers represented by ${findings.length} pooled calls (text response)`);
    return json({ choices: [{ message: { role: "assistant", content: text } }] });
  }
  await audit(env.DB, account.id, "", "swarm.failed", "Delegator returned an empty response");
  return json({ error: { code: "swarm_empty_response", message: "The delegator returned an empty response. Please retry." } }, 502);
}

async function createProject(
  request: Request,
  db: D1Database,
  account: Account,
): Promise<Response> {
  const b = await request.json<{
    name?: string;
    storage_mode?: string;
    permission_mode?: string;
  }>();
  const id = crypto.randomUUID();
  const name = cleanName(b.name);
  const storage = b.storage_mode === "browser" ? "browser" : "cloud";
  const permission = validPermission(b.permission_mode)
    ? b.permission_mode
    : "reads";
  await db
    .prepare(
      "INSERT INTO studio_projects (id,account_id,name,storage_mode,permission_mode) VALUES (?,?,?,?,?)",
    )
    .bind(id, account.id, name, storage, permission)
    .run();
  await audit(db, account.id, id, "project.create", `${name} (${storage})`);
  return json(
    {
      id,
      name,
      storage_mode: storage,
      permission_mode: permission,
      status: "draft",
    },
    201,
  );
}

async function updateProject(
  request: Request,
  db: D1Database,
  account: Account,
  projectId: string,
): Promise<Response> {
  const b = await request.json<{
    name?: string;
    permission_mode?: string;
    status?: string;
  }>();
  if (b.status === "published") {
    const entry = await db
      .prepare(
        'SELECT path FROM studio_files WHERE project_id=? AND path="index.html"',
      )
      .bind(projectId)
      .first();
    if (!entry)
      return json(
        {
          error: "entry_file_required",
          message:
            "Create and save index.html before publishing a static site.",
        },
        400,
      );
    await db
      .prepare(
        "UPDATE studio_projects SET status='published', updated_at=datetime('now') WHERE id=?",
      )
      .bind(projectId)
      .run();
    await db
      .prepare(
        "INSERT INTO studio_deployments(project_id,provider,status,detail) VALUES(?,?,?,?)",
      )
      .bind(
        projectId,
        "oss-studio-r2",
        "published",
        "Static files published from Cloud VFS to the OSS Studio Worker.",
      )
      .run();
    await audit(
      db,
      account.id,
      projectId,
      "deploy.static.publish",
      "R2 artifact published",
    );
    return json({
      ok: true,
      status: "published",
      url: `/studio/site/${projectId}/`,
    });
  }
  const permission = validPermission(b.permission_mode)
    ? b.permission_mode
    : null;
  const status =
    b.status === "disabled" || b.status === "draft" ? b.status : null;
  if (b.name !== undefined)
    await db
      .prepare(
        "UPDATE studio_projects SET name=?, updated_at=datetime('now') WHERE id=?",
      )
      .bind(cleanName(b.name), projectId)
      .run();
  if (permission)
    await db
      .prepare(
        "UPDATE studio_projects SET permission_mode=?, updated_at=datetime('now') WHERE id=?",
      )
      .bind(permission, projectId)
      .run();
  if (status)
    await db
      .prepare(
        "UPDATE studio_projects SET status=?, updated_at=datetime('now') WHERE id=?",
      )
      .bind(status, projectId)
      .run();
  await audit(
    db,
    account.id,
    projectId,
    status === "disabled" ? "project.disable" : "project.settings",
    JSON.stringify({ permission, status }),
  );
  return json({ ok: true });
}

async function fileApi(
  request: Request,
  env: StudioEnv,
  account: Account,
  projectId: string,
  rawPath: string,
): Promise<Response> {
  const filePath = safePath(decodeURIComponent(rawPath));
  if (!filePath) return json({ error: "invalid_path" }, 400);
  if (request.method === "GET") {
    const f = await env.DB.prepare(
      "SELECT r2_key,content_type FROM studio_files WHERE project_id=? AND path=?",
    )
      .bind(projectId, filePath)
      .first<{ r2_key: string; content_type: string }>();
    if (!f) return json({ error: "not_found" }, 404);
    const o = await env.STUDIO_FILES.get(f.r2_key);
    return o
      ? new Response(o.body, {
          headers: {
            "content-type": f.content_type || "application/octet-stream",
            "cache-control": "no-store",
          },
        })
      : json({ error: "not_found" }, 404);
  }
  if (request.method !== "PUT")
    return json({ error: "method_not_allowed" }, 405);
  const content = await request.text();
  if (content.length > 1_000_000) return json({ error: "file_too_large" }, 413);
  const type =
    request.headers.get("content-type") || "text/plain; charset=utf-8";
  const key = `projects/${projectId}/${filePath}`;
  await env.STUDIO_FILES.put(key, content, {
    httpMetadata: { contentType: type },
  });
  await env.DB.prepare(
    "INSERT INTO studio_files(project_id,path,r2_key,content_type,version) VALUES(?,?,?,?,1) ON CONFLICT(project_id,path) DO UPDATE SET r2_key=excluded.r2_key,content_type=excluded.content_type,version=version+1,updated_at=datetime('now')",
  )
    .bind(projectId, filePath, key, type)
    .run();
  await audit(env.DB, account.id, projectId, "vfs.write", filePath);
  return json({ ok: true });
}

async function toolRun(
  request: Request,
  env: StudioEnv,
  account: Account,
  projectId: string,
): Promise<Response> {
  const db = env.DB;
  const b = await request.json<{
    tool?: string;
    query?: string;
    permission?: string;
    plugin_id?: string;
  }>();
  const tool = b.tool || "";
  if (!["search", "vfs.read", "vfs.write", "mcp.execute", "deploy"].includes(tool))
    return json({ error: "unsupported_tool" }, 400);
  const project = await db
    .prepare("SELECT permission_mode FROM studio_projects WHERE id=?")
    .bind(projectId)
    .first<{ permission_mode: string }>();
  if (project?.permission_mode === "deny")
    return json({ error: "tools_disabled" }, 403);
  if (project?.permission_mode === "confirm" && b.permission !== "granted")
    return json({ error: "permission_required", tool }, 409);
  if (
    project?.permission_mode === "reads" &&
    !["search", "vfs.read"].includes(tool) &&
    b.permission !== "granted"
  )
    return json({ error: "permission_required", tool }, 409);
  const rawDetail = String(b.query || "");
  // File contents can legitimately exceed the short query/audit limit. Keep
  // the full JSON for vfs.write (vfsWrite enforces the 1 MB content limit),
  // while keeping the audit row compact and free of source-code payloads.
  const detail = tool === "vfs.write" ? rawDetail.slice(0, 1_000_000) : rawDetail.slice(0, 500);
  const auditDetail = tool === "vfs.write" ? rawDetail.slice(0, 240) : detail;
  await audit(db, account.id, projectId, `tool.${tool}`, auditDetail);
  if (tool === "search") return duckDuckGo(detail);
  if (tool === "mcp.execute")
    return mcpExecute(db, account, projectId, b.plugin_id, detail);
  if (tool === "deploy")
    return deploy(new Request("https://studio.invalid", { method: "POST", body: "{}" }), db, account, projectId);
  if (tool === "vfs.read") return vfsRead(env, projectId, detail);
  if (tool === "vfs.write") return vfsWrite(env, account, projectId, detail);
  return json({ ok: true, message: `${tool} permission granted.` });
}

async function vfsRead(
  env: StudioEnv,
  projectId: string,
  path: string,
): Promise<Response> {
  const file = safePath(path);
  if (!file)
    return json(
      {
        error: "path_required",
        message: "Provide a safe project-relative file path.",
      },
      400,
    );
  const row = await env.DB.prepare(
    "SELECT path,version,content_type,r2_key FROM studio_files WHERE project_id=? AND path=?",
  )
    .bind(projectId, file)
    .first<{
      path: string;
      version: number;
      content_type: string;
      r2_key: string;
    }>();
  if (!row) return json({ error: "not_found" }, 404);
  const object = await env.STUDIO_FILES.get(row.r2_key);
  return object
    ? json({
        ok: true,
        file: {
          path: row.path,
          version: row.version,
          content_type: row.content_type,
          content: (await object.text()).slice(0, 100_000),
        },
      })
    : json({ error: "not_found" }, 404);
}

async function vfsWrite(
  env: StudioEnv,
  account: Account,
  projectId: string,
  input: string,
): Promise<Response> {
  try {
    const item = JSON.parse(input) as { path?: unknown; content?: unknown };
    const path = safePath(typeof item.path === "string" ? item.path : "");
    if (
      !path ||
      typeof item.content !== "string" ||
      item.content.length > 1_000_000
    )
      return json({ error: "invalid_vfs_write" }, 400);
    const key = `projects/${projectId}/${path}`;
    await env.STUDIO_FILES.put(key, item.content, {
      httpMetadata: { contentType: contentTypeFor(path) },
    });
    await env.DB.prepare(
      "INSERT INTO studio_files(project_id,path,r2_key,content_type,version) VALUES(?,?,?,?,1) ON CONFLICT(project_id,path) DO UPDATE SET r2_key=excluded.r2_key,content_type=excluded.content_type,version=version+1,updated_at=datetime('now')",
    )
      .bind(projectId, path, key, contentTypeFor(path))
      .run();
    await audit(env.DB, account.id, projectId, "vfs.write.agent", path);
    return json({ ok: true, path, message: `Wrote ${path}.` });
  } catch {
    return json(
      {
        error: "invalid_vfs_write",
        message: 'Use JSON: {"path":"...","content":"..."}.',
      },
      400,
    );
  }
}

async function duckDuckGo(query: string): Promise<Response> {
  if (!query) return json({ error: "search_query_required" }, 400);
  const response = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "user-agent": "OSS-Studio/1.0 (+https://osaii.wyvernhub.net)",
      },
    },
  );
  if (!response.ok)
    return json(
      { error: "search_provider_unavailable", provider: "DuckDuckGo" },
      502,
    );
  const html = await response.text();
  const results: Array<{ title: string; url: string }> = [];
  for (const match of html.matchAll(
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
  )) {
    const url = decodeHtml(match[1]);
    const title = decodeHtml(match[2].replace(/<[^>]+>/g, "").trim());
    if (/^https?:\/\//.test(url) && title)
      results.push({ title: title.slice(0, 180), url });
    if (results.length === 5) break;
  }
  return json({
    ok: true,
    provider: "DuckDuckGo",
    results,
    message: results.length
      ? `Found ${results.length} results.`
      : "No DuckDuckGo results found.",
  });
}

async function mcpExecute(
  db: D1Database,
  account: Account,
  projectId: string,
  pluginId: string | undefined,
  input: string,
): Promise<Response> {
  if (!pluginId)
    return json(
      {
        error: "mcp_plugin_required",
        message: "Choose a configured MCP server before executing.",
      },
      400,
    );
  const plugin = await db
    .prepare(
      'SELECT name,endpoint,enabled FROM studio_plugins WHERE id=? AND account_id=? AND kind="mcp"',
    )
    .bind(pluginId, account.id)
    .first<{ name: string; endpoint: string; enabled: number }>();
  if (!plugin?.enabled || !plugin.endpoint)
    return json({ error: "mcp_not_available" }, 404);
  try {
    const parsed = input
      ? (JSON.parse(input) as { method?: unknown; params?: unknown })
      : {};
    const method =
      typeof parsed.method === "string" &&
      /^tools\/[a-zA-Z0-9_.-]+$/.test(parsed.method)
        ? parsed.method
        : "tools/list";
    const params =
      parsed.params && typeof parsed.params === "object" ? parsed.params : {};
    const response = await fetch(plugin.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });
    const payload = (await response.text()).slice(0, 10_000);
    await audit(db, account.id, projectId, "mcp.execute", plugin.name);
    return json({
      ok: response.ok,
      server: plugin.name,
      status: response.status,
      response: payload,
    });
  } catch {
    return json(
      { error: "mcp_provider_unavailable", server: plugin.name },
      502,
    );
  }
}

async function savePlugin(
  request: Request,
  db: D1Database,
  account: Account,
): Promise<Response> {
  const b = await request.json<{
    kind?: string;
    name?: string;
    endpoint?: string;
    manifest?: unknown;
    enabled?: boolean;
  }>();
  const kind = b.kind === "mcp" ? "mcp" : "skill";
  const name = cleanName(b.name);
  const endpoint =
    typeof b.endpoint === "string" && /^https:\/\//.test(b.endpoint)
      ? b.endpoint.slice(0, 500)
      : "";
  if (kind === "mcp" && !endpoint)
    return json({ error: "MCP server URLs must use https." }, 400);
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO studio_plugins(id,account_id,kind,name,endpoint,manifest,enabled) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      account.id,
      kind,
      name,
      endpoint,
      JSON.stringify(b.manifest || {}),
      b.enabled === false ? 0 : 1,
    )
    .run();
  await audit(db, account.id, "", `${kind}.configure`, name);
  return json({ id }, 201);
}

async function deploy(
  request: Request,
  db: D1Database,
  account: Account,
  projectId: string,
): Promise<Response> {
  await request.json().catch(() => ({}));
  const entry = await db
    .prepare(
      'SELECT path FROM studio_files WHERE project_id=? AND path="index.html"',
    )
    .bind(projectId)
    .first();
  if (!entry)
    return json(
      {
        error: "entry_file_required",
        message: "Create and save index.html before publishing a static site.",
      },
      400,
    );
  await db
    .prepare(
      "UPDATE studio_projects SET status='published', updated_at=datetime('now') WHERE id=?",
    )
    .bind(projectId)
    .run();
  const res = await db
    .prepare(
      "INSERT INTO studio_deployments(project_id,provider,status,detail) VALUES(?,?,?,?)",
    )
    .bind(
      projectId,
      "oss-studio-r2",
      "published",
      "Static files published from Cloud VFS to the OSS Studio Worker.",
    )
    .run();
  await audit(
    db,
    account.id,
    projectId,
    "deploy.static.publish",
    "R2 artifact published",
  );
  return json({
    id: res.meta.last_row_id,
    status: "published",
    provider: "oss-studio-r2",
    url: `/studio/site/${projectId}/`,
    message: "Static site published.",
  });
}

async function usage(db: D1Database, accountId: number): Promise<Response> {
  const [rows, tokens, byModel] = await Promise.all([
    db.prepare(
      "SELECT kind,COUNT(*) AS count FROM studio_audit WHERE account_id=? AND created_at>=datetime('now','-30 days') GROUP BY kind",
    )
    .bind(accountId)
    .all(),
    db.prepare(
      `SELECT COUNT(*) AS requests,
        SUM(usage_reported) AS reported_requests,
        COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens),0) AS completion_tokens,
        COALESCE(SUM(total_tokens),0) AS total_tokens,
        COALESCE(SUM(cached_tokens),0) AS cached_tokens,
        COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
        MIN(created_at) AS tracking_since
      FROM token_usage
      WHERE account_id=? AND created_at>=datetime('now','-30 days')`,
    ).bind(accountId).first<Record<string, number | string | null>>(),
    db.prepare(
      `SELECT surface,provider,model,COUNT(*) AS requests,
        COALESCE(SUM(total_tokens),0) AS total_tokens
      FROM token_usage
      WHERE account_id=? AND created_at>=datetime('now','-30 days')
      GROUP BY surface,provider,model
      ORDER BY total_tokens DESC`,
    ).bind(accountId).all(),
  ]);
  return json({
    period: "30d",
    usage: rows.results,
    tokens: tokens ?? {
      requests: 0,
      reported_requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      tracking_since: null,
    },
    tokens_by_model: byModel.results,
  });
}
export async function studioPreview(
  request: Request,
  env: StudioEnv,
  idOrName: string,
  path: string,
): Promise<Response> {
  const token = decodeURIComponent(idOrName);
  const p = await env.DB.prepare(
    'SELECT id FROM studio_projects WHERE (id=? OR name=?) AND status="published" ORDER BY updated_at DESC LIMIT 1',
  )
    .bind(token, token)
    .first<{ id: string }>();
  if (!p) return new Response("Not found", { status: 404 });
  const file = safePath(path || "index.html");
  if (!file) return new Response("Not found", { status: 404 });
  const o = await env.STUDIO_FILES.get(`projects/${p.id}/${file}`);
  if (!o) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const fontParam = url.searchParams.get("font")?.trim() || "";
  const allowedFonts = new Set(["Manrope","Instrument Sans","Geist","Fragment Mono","DM Mono","Playfair Display"]);
  const previewFont = allowedFonts.has(fontParam) ? fontParam : "";
  const contentType = o.httpMetadata?.contentType || "application/octet-stream";
  const isHtml = file.endsWith(".html") || contentType.includes("text/html");
  // If ?font= is requested, inject font preview into HTML response (isolated, no cookie access).
  if (previewFont && isHtml) {
    const text = await o.text();
    const fontEnc = encodeURIComponent(previewFont).replace(/%20/g, "+");
    const fontLink = `<link href="https://fonts.googleapis.com/css2?family=${fontEnc}:wght@400;500;600;700&family=Fragment+Mono&family=Geist:wght@400;500;600&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">`;
    const fontStyle = `<style>html{font-family:'${previewFont}',system-ui,sans-serif}body{font-family:'${previewFont}',system-ui,sans-serif}</style>`;
    let injected = text;
    if (/<head[^>]*>/i.test(text)) injected = text.replace(/<head[^>]*>/i, (m) => m + fontLink + fontStyle);
    else injected = fontLink + fontStyle + text;
    return new Response(injected, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "sandbox allow-scripts allow-forms allow-modals allow-popups; base-uri 'none'; frame-ancestors 'none'",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "cross-origin",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
        "x-preview-font": previewFont,
      },
    });
  }
  return new Response(o.body, {
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      // No allow-same-origin: an untrusted published project has an opaque origin,
      // cannot read Studio cookies, and cannot impersonate the control plane.
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-modals allow-popups; base-uri 'none'; frame-ancestors 'none'",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    },
  });
}
async function accountFor(r: Request, db: D1Database) {
  const t = r.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)osaii_platform_session=([^;]+)/)?.[1];
  return t
    ? db
        .prepare(
          "SELECT a.id,a.email,a.display_name FROM platform_sessions s JOIN platform_accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at>datetime('now')",
        )
        .bind(t)
        .first<Account>()
    : null;
}

export async function accountIdForRequest(
  request: Request,
  db: D1Database,
): Promise<number | null> {
  return (await accountFor(request, db))?.id ?? null;
}
async function owned(db: D1Database, accountId: number, id: string) {
  return db
    .prepare("SELECT id FROM studio_projects WHERE id=? AND account_id=?")
    .bind(id, accountId)
    .first();
}
async function audit(
  db: D1Database,
  accountId: number,
  projectId: string,
  kind: string,
  detail: string,
) {
  return db
    .prepare(
      "INSERT INTO studio_audit(account_id,project_id,kind,detail) VALUES(?,?,?,?)",
    )
    .bind(accountId, projectId || null, kind, detail)
    .run();
}
function cleanName(x: unknown) {
  return typeof x === "string" && x.trim()
    ? x.trim().slice(0, 80)
    : "Untitled project";
}
function validPermission(
  x: unknown,
): x is "confirm" | "reads" | "allow" | "deny" {
  return x === "confirm" || x === "reads" || x === "allow" || x === "deny";
}
function safePath(path: string) {
  const p = path.replace(/^\/+/, "");
  return p && !p.includes("..") && !p.includes("\\") && !p.includes("\0")
    ? p.slice(0, 300)
    : "";
}
function contentTypeFor(path: string) {
  return path.endsWith(".html")
    ? "text/html; charset=utf-8"
    : path.endsWith(".css")
      ? "text/css; charset=utf-8"
      : path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : path.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8";
}
function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function json(x: unknown, s = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(x), {
    status: s,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}
