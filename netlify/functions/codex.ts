import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/web/server";
import { generateImage, generateText, jsonSchema, streamText, tool, type ModelMessage } from "ai";

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const IMAGE_MODEL = "gpt-image-2";
const ALLOWED_ORIGIN = "https://osaii.wyvernhub.net";
let versionPromise: Promise<string> | undefined;

// ── Preview-aware CORS ──
// OSAII Studio Preview f uses Netlify Deploy Previews (deploy-preview--*.netlify.app).
// CODEX_ADAPTER_URL points at the Netlify adapter; in previews it is the deploy URL
// (see wrangler.jsonc vars.CODEX_ADAPTER_URL + netlify.toml [context.deploy-preview.environment]).
// We must allow the preview origin for in-app studio preview iframes / fetch.
// Detect via Origin *.netlify.app, localhost, x-nf-preview, or Netlify env CONTEXT.
function isPreviewOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === ALLOWED_ORIGIN) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (u.hostname.endsWith(".netlify.app")) return true;
    if (u.hostname.endsWith(".netlify.com")) return true;
    if (u.hostname === "osaii.wyvernhub.net") return true;
    if (u.hostname.endsWith(".osaii.wyvernhub.net")) return true;
  } catch { /* ignore */ }
  return false;
}
function resolveAllowedOrigin(request?: Request | null): string {
  const origin = request?.headers.get("origin") || "";
  if (origin && isPreviewOrigin(origin)) return origin;
  // Fallback: allow referer-based preview detection when Origin missing (e.g., image <img>)
  const referer = request?.headers.get("referer") || "";
  if (referer) try { const u = new URL(referer); if (u.hostname.endsWith(".netlify.app")) return new URL(referer).origin; } catch {}
  return ALLOWED_ORIGIN;
}
const cors = (request?: Request | null, headers = new Headers()) => {
  const allowed = resolveAllowedOrigin(request);
  headers.set("access-control-allow-origin", allowed);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-headers", "authorization, chatgpt-account-id, content-type");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-credentials", "true");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  // Netlify Deploy Preview signal: propagate so client can show preview banner
  // X-Nf-Preview / X-Nf-Deploy-Context are set by Netlify's CDN for preview deploys.
  // Also surface via CODEX_ADAPTER_URL check (Worker env) for observability.
  try {
    const previewHeader = request?.headers.get("x-nf-deploy-context") || request?.headers.get("x-nf-preview") || request?.headers.get("x-netlify-context");
    if (previewHeader) headers.set("x-preview-context", previewHeader);
    const host = request ? new URL(request.url).hostname : "";
    if (host.includes("deploy-preview--") || (host.includes("--") && host.endsWith(".netlify.app"))) headers.set("x-netlify-preview", "true");
    // Netlify Functions env (NETLIFY / CONTEXT) — not available in all runtimes, probe safely
    const netlifyGlobal = (globalThis as any).Netlify;
    const envPreview = (typeof process !== "undefined" && (process as any).env?.NETLIFY_PREVIEW === "true") ||
      (typeof process !== "undefined" && (process as any).env?.CONTEXT === "deploy-preview") ||
      (netlifyGlobal?.env?.get?.("NETLIFY_PREVIEW") === "true");
    if (envPreview) headers.set("x-netlify-env", "preview");
  } catch {}
  return headers;
};

const json = (value: unknown, status = 200, request?: Request | null) => new Response(JSON.stringify(value), {
  status,
  headers: cors(request, new Headers({ "content-type": "application/json; charset=utf-8" })),
});

async function codexVersion() {
  if (!versionPromise) versionPromise = fetch("https://registry.npmjs.org/@openai/codex/latest")
    .then(async response => {
      const value = response.ok ? await response.json() as { version?: unknown } : {};
      return typeof value.version === "string" ? value.version : "0.146.0";
    })
    .catch(() => "0.146.0");
  return versionPromise;
}

async function provider(request: Request) {
  const version = await codexVersion();
  return createOpenAIOAuth(openaiCredentials(request, { headers: {
    originator: "codex_sdk_ts",
    version,
    "user-agent": `codex_sdk_ts/${version}`,
    session_id: crypto.randomUUID(),
  } }));
}

function textOf(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("");
}

function messagesOf(input: unknown): ModelMessage[] {
  if (!Array.isArray(input)) return [];
  const result: ModelMessage[] = [];
  const names = new Map<string, string>();
  for (const message of input) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      result.push({ role: "system", content: textOf(message.content) });
    } else if (message.role === "user") {
      result.push({ role: "user", content: textOf(message.content) });
    } else if (message.role === "assistant") {
      const parts: any[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ type: "text", text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const id = typeof call?.id === "string" ? call.id : crypto.randomUUID();
        const name = typeof call?.function?.name === "string" ? call.function.name : "tool";
        let inputValue: unknown = {};
        try { inputValue = JSON.parse(call?.function?.arguments || "{}"); } catch { inputValue = call?.function?.arguments || {}; }
        names.set(id, name);
        parts.push({ type: "tool-call", toolCallId: id, toolName: name, input: inputValue });
      }
      result.push({ role: "assistant", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts } as ModelMessage);
    } else if (message.role === "tool" && typeof message.tool_call_id === "string") {
      let value: unknown = message.content;
      if (typeof value === "string") try { value = JSON.parse(value); } catch { /* keep text */ }
      result.push({ role: "tool", content: [{
        type: "tool-result",
        toolCallId: message.tool_call_id,
        toolName: names.get(message.tool_call_id) || "tool",
        output: typeof value === "string" ? { type: "text", value } : { type: "json", value },
      }] } as ModelMessage);
    }
  }
  return result;
}

function toolsOf(input: unknown) {
  if (!Array.isArray(input)) return undefined;
  return Object.fromEntries(input.flatMap(definition => {
    const fn = definition?.function;
    if (!fn || typeof fn.name !== "string") return [];
    return [[fn.name, tool({
      description: typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: jsonSchema(fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} }),
    })]];
  }));
}

function toolChoiceOf(value: any): any {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (typeof value?.function?.name === "string") return { type: "tool", toolName: value.function.name };
  return undefined;
}

const chunk = (id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) => ({
  id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const sse = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);

async function chat(request: Request, body: any) {
  const model = typeof body.model === "string" ? body.model : "gpt-5.4-mini";
  const openai = await provider(request);
  const options: any = {
    model: openai(model),
    messages: messagesOf(body.messages),
    tools: toolsOf(body.tools),
    toolChoice: toolChoiceOf(body.tool_choice),
    maxOutputTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    providerOptions: { openai: {
      reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
      parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
    } },
  };
  if (body.stream !== true) {
    const result = await generateText(options);
    const calls = result.toolCalls.map((call: any) => ({ id: call.toolCallId, type: "function", function: { name: call.toolName, arguments: JSON.stringify(call.input) } }));
    return json({
      id: `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text || null, tool_calls: calls.length ? calls : undefined }, finish_reason: result.finishReason === "tool-calls" ? "tool_calls" : "stop" }],
      usage: result.usage,
    }, 200, request);
  }
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const result = streamText(options);
  const stream = new ReadableStream<Uint8Array>({ async start(controller) {
    const indexes = new Map<string, number>();
    controller.enqueue(sse(chunk(id, model, { role: "assistant" })));
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") controller.enqueue(sse(chunk(id, model, { content: part.text })));
        else if (part.type === "tool-input-start") {
          const index = indexes.size; indexes.set(part.id, index);
          controller.enqueue(sse(chunk(id, model, { tool_calls: [{ index, id: part.id, type: "function", function: { name: part.toolName, arguments: "" } }] })));
        } else if (part.type === "tool-input-delta") {
          controller.enqueue(sse(chunk(id, model, { tool_calls: [{ index: indexes.get(part.id) || 0, function: { arguments: part.delta } }] })));
        } else if (part.type === "finish") controller.enqueue(sse(chunk(id, model, {}, part.finishReason === "tool-calls" ? "tool_calls" : "stop")));
        else if (part.type === "error") throw part.error;
      }
    } catch (error) {
      controller.enqueue(sse({ error: { message: error instanceof Error ? error.message : "Codex stream failed.", type: "upstream_error" } }));
    }
    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
  } });
  return new Response(stream, { headers: cors(request, new Headers({ "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" })) });
}

async function models(request: Request) {
  const version = await codexVersion();
  const headers = new Headers({
    authorization: request.headers.get("authorization") || "",
    "chatgpt-account-id": request.headers.get("chatgpt-account-id") || "",
    originator: "codex_sdk_ts", version, "user-agent": `codex_sdk_ts/${version}`,
  });
  const upstream = await fetch(`${CODEX_BASE}/models?client_version=${encodeURIComponent(version)}`, { headers });
  const upstreamText = await upstream.text();
  let raw: any = {};
  try { raw = JSON.parse(upstreamText); } catch { /* retain diagnostic metadata only */ }
  if (!upstream.ok) return json({ error: {
    message: raw?.error?.message || raw?.detail?.code || raw?.detail || upstream.statusText || "Codex model catalog failed.",
    code: raw?.error?.code || raw?.detail?.code || "codex_catalog_error",
    upstream_status: upstream.status,
    edge_challenge: upstream.headers.get("cf-mitigated") === "challenge" || upstreamText.includes("Enable JavaScript and cookies"),
    upstream_content_type: upstream.headers.get("content-type"),
  } }, upstream.status, request);
  const data = (Array.isArray(raw.models) ? raw.models : []).filter((item: any) => item?.slug && item.supported_in_api !== false && (!item.visibility || item.visibility === "list")).map((item: any) => ({ id: item.slug, object: "model", owned_by: "codex-oauth", name: item.display_name, capabilities: item }));
  if (!data.some((item: any) => item.id === IMAGE_MODEL)) data.push({ id: IMAGE_MODEL, object: "model", owned_by: "codex-oauth", name: "GPT Image 2" });
  return json({ object: "list", data }, 200, request);
}

async function images(request: Request, body: any) {
  const openai = await provider(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: { message: "Image prompt is required.", code: "missing_prompt" } }, 400, request);
  const result = await generateImage({ model: openai.image(typeof body.model === "string" ? body.model : IMAGE_MODEL), prompt, n: 1, abortSignal: request.signal });
  return json({ created: Math.floor(Date.now() / 1000), data: result.images.map(image => ({ b64_json: image.base64 })) }, 200, request);
}

export default async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!/^Bearer\s+\S+$/i.test(request.headers.get("authorization") || "") || !request.headers.get("chatgpt-account-id")) return json({ error: { message: "ChatGPT sign-in is required.", code: "chatgpt_sign_in_required" } }, 401, request);
  const path = new URL(request.url).pathname;
  try {
    if (path === "/v1/models" && request.method === "GET") return models(request);
    if (request.method !== "POST") return json({ error: { message: "Method not allowed." } }, 405, request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: { message: "A JSON object is required." } }, 400, request);
    if (path === "/v1/chat/completions") return chat(request, body);
    if (path === "/v1/images/generations") return images(request, body);
    return json({ error: { message: "Not found." } }, 404, request);
  } catch (error) {
    return json({ error: { message: error instanceof Error ? error.message : "Codex request failed.", type: "upstream_error", code: "codex_adapter_error" } }, 502, request);
  }
};

export const config = { path: ["/v1/models", "/v1/chat/completions", "/v1/images/generations"] };
