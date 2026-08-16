import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const studio = await readFile(new URL("../API/studio.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../API/app.ts", import.meta.url), "utf8");
const studioNext = await readFile(new URL("../API/studio-next.ts", import.meta.url), "utf8");
const studioT3 = await readFile(new URL("../API/studio-t3.ts", import.meta.url), "utf8");
const studioPlatform = await readFile(new URL("../API/studio-platform.ts", import.meta.url), "utf8");
const platformMigration = await readFile(new URL("../migrations/0008_studio_platform.sql", import.meta.url), "utf8");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const poolside = await readFile(new URL("../API/poolside.ts", import.meta.url), "utf8");
const bitnet = await readFile(new URL("../API/bitnet.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const pages = await readFile(new URL("../src/lib/pages.ts", import.meta.url), "utf8");
const chatgpt = await readFile(new URL("../API/chatgpt.ts", import.meta.url), "utf8");
const tokenUsage = await readFile(new URL("../src/lib/token-usage.ts", import.meta.url), "utf8");
const tokenMigration = await readFile(new URL("../migrations/0006_token_usage.sql", import.meta.url), "utf8");
const platform = await readFile(new URL("../API/platform.ts", import.meta.url), "utf8");
const cosaii = await readFile(new URL("../API/cosaii.ts", import.meta.url), "utf8");
const apiKeys = await readFile(new URL("../src/lib/api-keys.ts", import.meta.url), "utf8");
const docs = await readFile(new URL("../API/docs.ts", import.meta.url), "utf8");
const mythos = await readFile(new URL("../API/mythos.ts", import.meta.url), "utf8");
const keyMigration = await readFile(new URL("../migrations/0007_api_keys.sql", import.meta.url), "utf8");
const favicon = await readFile(new URL("../osaii.png", import.meta.url));

test("Studio retains the approved centered Chat, Agent, and Swarm shell", () => {
  for (const expected of [
    "<title>OSS Studio</title>",
    "What would you like to",
    "Agent Swarm",
    "Explain the observer pattern",
    "class=\"composer\"",
    "position:sticky;bottom:0",
    "#histList{overflow-y:auto",
  ]) assert.match(app, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("OSAII pages use the supplied PNG favicon without overriding published sites", () => {
  assert.deepEqual([...favicon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(worker, /import osaiiIcon from "\.\.\/osaii\.png"/);
  assert.match(worker, /url\.pathname === "\/osaii\.png"/);
  assert.match(worker, /url\.pathname === "\/favicon\.ico"/);
  assert.match(worker, /"content-type": "image\/png"/);
  assert.match(app, /<link rel="icon" href="\/osaii\.png" type="image\/png">/);
  assert.match(pages, /<link rel="icon" href="\/osaii\.png" type="image\/png" \/>/);
  assert.doesNotMatch(studio, /studioPreview[\s\S]{0,800}osaii\.png/);
});

test("Platform homepage manages revocable hashed API keys", () => {
  for (const expected of [
    "platformPage()",
    "Create API key",
    "/platform/api/keys",
    "OpenAI-compatible",
    "KEYED_XS_RATE_LIMIT_PER_MINUTE = 600",
    "KEYED_DEFAULT_RATE_LIMIT_PER_MINUTE = 300",
    "KEYED_RATE_LIMIT_PER_HOUR = 6_000",
    "KEYED_RATE_LIMIT_PER_DAY = 20_000",
    "accountForApiKey",
    "Authorization: Bearer",
    "SHA-256",
    "revoked_at",
    "last_used_at",
  ]) assert.match(platform + worker + poolside + apiKeys + keyMigration, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.doesNotMatch(keyMigration, /key_secret|raw_key|api_key_value/i);
});

test("OSAII Platform clearly connects separate API and Studio surfaces", () => {
  for (const expected of [
    "One platform.<br><em>Two ways</em> to build.",
    "API and Studio are distinct products inside one Platform",
    "href=\"/studio/new\">Open Studio",
    "The OSAII Platform",
    "Docs · OSAII Platform",
    "The Platform connects a separate OpenAI-compatible API",
  ]) assert.match(worker, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.match(platform, /OpenAI-compatible/);
});

test("Products catalog keeps optional products off the focused Platform front page", () => {
  assert.match(worker, /url\.pathname === "\/products"/);
  assert.match(platform, /function productsPage\(\)/);
  assert.match(platform, /Install Cosaii/);
  assert.match(platform, /\/install\/cosaii\.sh/);
  assert.match(platform, /Open Masque/);
  assert.match(platform, /Explore MythOS/);
  assert.match(worker, /href="\/products">Products/);
  assert.doesNotMatch(worker, /<section class="section" id="mythos">/);
  assert.doesNotMatch(worker, /<section class="section" id="masque">/);
});

test("Ask about docs uses a bounded route map and removes unverified links", () => {
  assert.match(worker, /Never invent URLs, endpoints, model IDs, or capabilities/);
  assert.match(worker, /unverified link omitted/);
  for (const route of ["/docs", "/api/ask", "/api/v1/models", "/studio/new"]) {
    assert.match(worker, new RegExp(route.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});

test("Platform API-key CTAs use a reliable modal handler", () => {
  assert.match(worker, /function openModal\(\)/);
  assert.match(worker, /b\.onclick=openModal/);
});

test("Cosaii replaces the browser coding mock with app-server interfaces", () => {
  for (const expected of [
    "/platform/api/cli/",
    "/platform/cli/authorize",
    "/cosaii/api/v1/",
    "cosaiiDeviceApi",
    "cosaiiAuthorizePage",
    "COSAII_RELAYS",
  ]) assert.match(cosaii + worker, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.doesNotMatch(worker, /url\.pathname === "\/cli"/);
});

test("Studio chat streams through the Studio gateway with accurate reasoning controls", () => {
  for (const expected of [
    "/studio/api/chat",
    "text/event-stream",
    "stream:true",
    "stream_options:{include_usage:true}",
    "getReader()",
    "reasoning_content",
    "flushComplete",
    "escapeHtml(content).replace",
    "function requestControls(model)",
    "model.startsWith('logfare/')",
    "if(j.error)throw new Error",
    "['none','None']",
    "['low','Light']",
    "['medium','Medium']",
    "['xhigh','Max']",
    "selectedModel()",
    "id=\"speed\" aria-label=\"Model family\"",
    "value=\"chatgpt\" id=\"chatgptFamily\"",
    "value=\"logfare/minimax-m3\">MiniMax M3",
    "value=\"logfare/deepseek-v4-pro\">DeepSeek V4 Pro",
    "id=\"reasoning\" aria-label=\"Reasoning\"",
    "chatgptSignedIn",
    "ChatGPT / Codex",
    "modelPickerRepairScript",
    "chatgptConnect",
    "Sign in with ChatGPT to choose a model",
    "Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype,'disabled')",
    "modelPickerRepairScript",
    "Sign in with ChatGPT to choose a model",
    "chatgptConnect",
    "logfare/minimax-m3",
    "logfare/deepseek-v4-pro",
    "followStream",
    "Follow live response",
    "stateFollowing",
    "feed.scrollTop=feed.scrollHeight",
    "autoChatTitle",
    "chatTitleFromMessages",
    "titleText",
    "normalizeChat",
    "title:title||'New conversation'",
    "!state.messages.some(m=>m&&m.role==='user')",
    "readableError",
    "apiErrorMessage",
    "Deny All",
    "Allow low-risk",
    "Always Ask",
    "Full Access",
    "permissionSelect",
    "createAgentActivity",
    "agent-activity-previous",
    "No active tool call",
    "Blocked by permissions: ",
    "Completed: ",
    "activity-failed",
    "activity-blocked",
    "streamedAgentChat",
    "window.__osaiiState=state",
    "hasToolContext",
    "data.surface==='agent'",
    "resilientAgentChat",
    "accept:'text/event-stream'",
    "tool_calls",
    "activity?.args",
    "web_search",
    "vfs_read",
    "vfs_write",
    "deploy_site",
    "toolAliases",
    "unknown_tool",
    "part?.id&&!current.id",
    "Last error:",
    "safety_filter_unavailable",
    "Safety screening unavailable; retrying",
    "No model request was sent; please retry.",
    "failed or denied tool must be included in the next model turn",
    "for(let turn=0;turn<8;turn++)",
    "call.id||'agent-tool-'",
    "cleanAgentText",
    "normalizeAgentToolResult",
    "no output was returned",
    "successful tool call is progress",
    "Never perform a read solely to verify",
    "state.messages.push({role:'user',content:input})",
    "backupStoreKey",
    "chatStorages",
    "window.__osaiiUnsavedChats",
  ]) assert.match(app, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(app, /document\.querySelector\('#speed'\)\.textContent=/);
});

test("Mini Preview recreates the BitNet demo CPU and GPU transports", () => {
  for (const expected of [
    'microsoft/bitnet-b1.58-2B-4T',
    'https://demo-bitnet-h0h8hcfqeqhrf5gf.canadacentral-01.azurewebsites.net',
    '"user-agent": "BitNetClient/1.0"',
    'device: "cpu"',
    'device: "gpu"',
    '/gpuresult/',
    'setTimeout(resolve, 2_000)',
    'text/event-stream; charset=utf-8',
    'bitnet_gpu_streaming_unsupported',
    'upstream BitNet demo',
  ]) assert.ok(bitnet.includes(expected), `missing BitNet transport contract: ${expected}`);
  for (const expected of [
    'name: "Mini (Preview)"',
    'STUDIO_IDENTITY_PROMPT',
    'Open-Source AI Initiative',
    'value="mini">Mini (Preview)',
    'id="miniFastMode"',
    'id="miniFastControl" hidden',
    'toggleAttribute(\'hidden\',!active)',
    "family.value==='mini'||(state.tier==='advanced'&&state.advanced===miniModelId)",
    'Fast Mode uses the demo GPU path and disables streaming',
    'fast_mode:state.miniFastMode',
    'MINI · BitNet Preview',
  ]) assert.ok((studio + app).includes(expected), `missing Mini Studio contract: ${expected}`);
  assert.doesNotMatch(app, /id="fastMode"/i);
  assert.match(app, /const miniModelId=/);
  assert.match(poolside, /model === BITNET_MODEL_ID/);
  assert.match(poolside, /BITNET_FAST_RATE_LIMIT_PER_MINUTE = 5/);
  assert.match(poolside, /model === BITNET_MODEL_ID && !fastMode/);
  assert.match(poolside, /rateLimitFastMode/);
  assert.match(studio, /STUDIO_MINI_FAST_LIMITS/);
  assert.match(studio, /Mini Fast Mode has a separate GPU fair-use limit/);
  assert.match(worker, /mini: "microsoft\/bitnet-b1\.58-2B-4T"/);
  assert.match(docs, /fast_mode:true/);
});

test("Chat and sidebar own independent scroll regions without anchor jumps", () => {
  assert.match(app, /html,body\{height:100%;overflow:hidden\}/);
  assert.match(app, /\.side\{height:100dvh;overflow:hidden\}/);
  assert.match(app, /\.feed\{flex:1;min-height:0;overflow-y:auto/);
  assert.match(app, /align-content:start;align-items:start;grid-auto-rows:max-content/);
  assert.doesNotMatch(app, /innerHeight\+scrollY>=document\.body\.scrollHeight/);
  assert.doesNotMatch(app, /el\.scrollIntoView\(\{block:'end'\}\)/);
});

test("The public ask shortcut supports documented output formats", () => {
  for (const expected of [
    'url.pathname === "/api/ask"',
    "url.searchParams.get(\"q\")",
    'format === "ccjson"',
    'format === "rjson"',
    'headers.set("content-type", "text/plain; charset=utf-8")',
    'output_text: answer',
    'fast: "poolside/laguna-xs-2.1"',
    'smart: "poolside/laguna-s-2.1"',
    'surface: "api_ask"',
  ]) assert.ok(worker.includes(expected), `missing ask endpoint contract: ${expected}`);
});

test("Developer docs use the OSS Studio visual system and document the public API", () => {
  for (const expected of [
    'url.pathname === "/docs"',
    "docsPage()",
    "OpenAI-compatible",
    "/api/ask?q=...",
    "/api/v1/chat/completions",
    "ccjson",
    "rjson",
    "Kimi K3",
    "Open OSS Studio",
    "Ask about docs",
    "hashchange",
    "classList.toggle('active'",
    "anonymous requests work immediately",
    "higher limits",
    "id=\"docsAsk\"",
  ]) assert.ok(docs.includes(expected) || worker.includes(expected), `missing docs contract: ${expected}`);
});

test("MythOS is a separate product with opt-in OSAII integration", () => {
  for (const expected of [
    'url.pathname === "/mythos"',
    'url.pathname === "/mythos/release.json"',
    "mythosPage()",
    "MYTHOS_RELEASE",
    "A computer,",
    "optional add-on",
    "absent by default",
    "local login",
    "osaii-web-apps",
  ]) assert.ok(worker.includes(expected) || mythos.includes(expected), `missing MythOS contract: ${expected}`);
  assert.doesNotMatch(mythos, /class="button primary" href="\/studio\/new"/);
});

test("advanced models are server-enforced and only revealed after access check", () => {
  for (const model of ["Kimi K3", "MiniMax M3", "DeepSeek V4 Flash", "DeepSeek V4 Pro"]) {
    assert.match(app, new RegExp(model.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
    assert.match(studio, new RegExp(model.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.match(app, /advancedAllowed/);
  assert.match(app, /\/studio\/api\/models/);
  assert.match(studio, /advanced_access_required/);
  assert.match(app, /advancedModelSelect/);
  assert.match(app, /chatGPTFamilyOption\.hidden=false/);
});

test("ChatGPT OAuth keeps browser credentials request-bound and exposes Codex capabilities", () => {
  for (const expected of [
    "@openai-oauth/web@2.0.0",
    "sign-in-with-chatgpt-button.png",
    "chatgpt-signin-pill",
    "openaiAuthHeaders",
    "startLogin",
    "/studio/oauth/callback",
    "chatgpt-account-id",
    "chatgpt.com/backend-api/codex",
    "/chat/completions",
    "/responses",
    "/images/generations",
    "/images/edits",
    "gpt-image-2",
    "supported_in_api",
    "createOpenAIOAuth",
    "openaiCredentials",
    "codex_sdk_ts",
    "CODEX_ADAPTER_URL",
    "sdkChatCompletions",
    "streamText",
    "generateText",
    "generateImage",
    "persistGeneratedImages",
    "generatedImageAsset",
    "studio-generated-images/",
    "/generated-images/",
    "tool-input-delta",
    "x-accel-buffering",
  ]) {
    assert.match(app + chatgpt + worker, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
  assert.match(chatgpt, /authorization/);
  assert.match(worker, /chatgptApi/);
  assert.match(app, /chatGPTUiScript/);
  assert.match(app, /getSession\(\{refresh:false\}\)/);
  assert.match(app, /setTimeout\(\(\)=>loadChatGPTAccess\(\),150\)/);
  assert.match(app, /GPT-5\.4 mini/);
  assert.match(app, /sdk\.completeLogin\(\)/);
  assert.match(app, /callbackPath:'\/studio'/);
  assert.match(app, /Connected to ChatGPT · Disconnect/);
  assert.match(app, /sessionCatalogLoadChatGPTAccess/);
});

test("generated images use browser object storage instead of overflowing chat localStorage", () => {
  for (const expected of [
    "osaii-generated-images-v1",
    "indexedDB.open",
    "osaii-image://",
    "putImage",
    "window.__osaiiPersistGeneratedImage=persistImage",
    "Generated image unavailable in this browser.",
    "A generated image could not be saved for refresh.",
  ]) assert.match(app, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.match(app, /durableSource=await window\.__osaiiPersistGeneratedImage\(source\)/);
});

test("the gateway preserves low-latency streaming headers", () => {
  assert.match(poolside, /x-accel-buffering/);
  assert.match(poolside, /new Response\(upstream\.body/);
  assert.match(app, /contentType\.toLowerCase\(\)\.includes\('text\/event-stream'\)/);
  assert.match(poolside, /unavailable \? 'safety_filter_unavailable'/);
  assert.match(poolside, /unavailable \? 503 : 400/);
});

test("completion usage is observable and short reasoning budgets are not blank 200s", () => {
  for (const expected of [
    "proxyCompletionResponse",
    "x-osaii-usage-cached-tokens",
    "x-osaii-usage-reasoning-tokens",
    "reasoning_budget_exhausted",
    "full reasoning budget before producing a final answer",
  ]) assert.match(poolside, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.match(app, /reasoningBudgetNotice/);
});

test("provider-reported tokens are durably tracked without retaining content or raw addresses", () => {
  for (const expected of [
    "trackTokenResponse",
    "extractTokenUsage",
    "prompt_tokens",
    "input_tokens",
    "completion_tokens",
    "output_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "text/event-stream",
    ".tee()",
    "ctx.waitUntil",
    "SHA-256",
    "token_usage",
    "usage_reported",
    "studio_chat",
    "studio_agent",
    "studio_swarm",
    "studio_chatgpt",
  ]) assert.match(worker + studio + chatgpt + tokenUsage + tokenMigration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(chatgpt, /part\.totalUsage\.inputTokens/);
  assert.match(chatgpt, /part\.totalUsage\.outputTokens/);
  assert.match(app, /TOKENS SERVED · 30 DAYS/);
  assert.doesNotMatch(tokenMigration, /prompt(?:_text|_body)|response(?:_text|_body)|raw_ip/i);
});

test("Swarm screens the task once and the final synthesis once", () => {
  for (const expected of [
    "generalSafetyCheck",
    "inputSafety = await generalSafetyCheck",
    "final-output",
    "finalOutputSafety",
    "safetyAlreadyChecked: true",
    "Array.from({ length: 24 }",
    "300 logical agents",
  ]) assert.ok((studio + poolside).includes(expected), `missing contract: ${expected}`);
  assert.match(poolside, /finalizeModelResponse/);
  assert.match(poolside, /streamWithFinalSafety/);
  assert.ok(poolside.includes("finalOutputSafety(content, hasToolCalls, env)"));
});

test("safety screening uses Poolside remotely with the ordered Groq fallback chain", () => {
  assert.match(poolside, /const POOLSIDE_SAFETY_MODEL = 'poolside\/laguna-xs-2\.1'/);
  assert.match(poolside, /async function poolsideSafetyCheck/);
  assert.match(poolside, /reasoning_effort: 'minimal'/);
  assert.match(poolside, /provider: 'poolside'/);
  assert.match(poolside, /const poolside = await poolsideSafetyCheck\(body, env, false\)/);
  assert.match(poolside, /if \(!poolside\.unavailable\) return poolside/);
  assert.match(poolside, /GROQ_SAFETY_MODELS = \[/);
  for (const model of ["openai/gpt-oss-20b", "openai/gpt-oss-safeguard-20b", "llama-guard-3-8b", "meta-llama/llama-prompt-guard-2-86m"]) {
    assert.match(poolside, new RegExp(model.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
  assert.match(poolside, /for \(const model of GROQ_SAFETY_MODELS\)/);
  assert.match(poolside, /const llamaGuard = model === LLAMA_GUARD_MODEL/);
  assert.match(poolside, /const promptGuard = model === PROMPT_GUARD_MODEL/);
  assert.match(poolside, /const POLLINATIONS_SAFETY_MODEL = 'qwen-safety'/);
  assert.match(poolside, /pollinationsSafetyCheck/);
  assert.match(poolside, /https:\/\/gen\.pollinations\.ai\/v1\/chat\/completions/);
  assert.match(poolside, /POLLINATIONS_API_KEY/);
  assert.match(poolside, /Safety: Unsafe/);
  assert.match(poolside, /if \(promptGuard\)/);
  assert.match(poolside, /numeric risk score/);
  assert.match(poolside, /if \(!llamaGuard && !promptGuard\) requestBody\.response_format/);
  assert.match(poolside, /if \(verdict\.allow === true\)/);
  assert.match(poolside, /if \(verdict\.allow === false\)/);
  assert.match(poolside, /setTimeout\(\(\) => controller\.abort\(\), 8_000\)/);
  assert.match(poolside, /safety_filter_unavailable/);
});

test("Swarm screens only the task input and final synthesis", () => {
  assert.match(studio, /generalSafetyCheck/);
  assert.match(studio, /inputSafety = await generalSafetyCheck/);
  assert.match(studio, /outputSafety = await generalSafetyCheck/);
  assert.match(studio, /safetyAlreadyChecked: true/);
  assert.match(studio, /300 fast researchers/);
  assert.match(poolside, /options: \{ safetyAlreadyChecked\?: boolean; finalOutputSafety\?: boolean; modelAlreadyValidated\?: boolean \} = \{\}/);
  assert.match(studio, /finalOutputSafety: false/);
  assert.match(studio, /modelAlreadyValidated: true/);
  assert.match(studio, /swarm_upstream_error/);
  assert.match(poolside, /modelAlreadyValidated\?: boolean/);
  assert.match(poolside, /if \(!options\.safetyAlreadyChecked\)/);
});

test("Studio supports project VFS, MCP execution, static preview by ID or name, and audit usage", () => {
  for (const expected of [
    "vfs.read", "vfs.write", "mcp.execute", "tools/list", "studio_files",
    "id=? OR name=?", "sandbox allow-scripts", "studio_audit", "request_activity",
    "globalRateLimit", "rawDetail", "tool === \"vfs.write\" ? rawDetail.slice(0, 1_000_000)",
  ]) assert.match(studio, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(worker, /url\.pathname === "\/studio"/);
  assert.match(worker, /redirect\("\/studio"\)/);
});

test("Projects and Agent use low-friction, permission-safe workflows", () => {
  for (const expected of [
    'id="createProject"',
    "createProjectFromForm",
    "ensureActiveProject",
    "Agent workspace",
    "Auto-run reads",
    "toolPermission(tool)",
    "mode==='deny'",
    "The user declined this action.",
  ]) assert.match(app, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(studio, /permission_mode === "reads"/);
  assert.match(studio, /\["search", "vfs\.read"\]\.includes\(tool\)/);
  assert.match(studio, /project\?\.permission_mode === "deny"/);
});

test("empty cloud and browser workspaces can create their first file", () => {
  for (const expected of [
    "Empty projects are ready to use",
    "Saving creates index.html",
    "This folder is empty. Start with index.html below.",
    "getFileHandle(name,{create:true})",
    "placeholder=\"Empty file — start typing\"",
  ]) assert.match(app, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(studio, /const content = await request\.text\(\)/);
  assert.match(studio, /STUDIO_FILES\.put\(key, content/);
});

test("the rebuilt standard Studio surface is isolated at /studio/new", () => {
  for (const expected of [
    'url.pathname === "/studio/new"',
    "studioNewPage()",
    "/studio/new/manifest.webmanifest",
    "/studio/new/sw.js",
    "Workspaces & tools",
    "Search chats",
    "Chat",
    "Agent",
    "Agent Swarm",
    "Auto",
  ]) assert.match(worker + studioNext + app, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(worker, /url\.pathname === "\/studio"/);
});

test("Studio new uses a compact, account-aware time greeting", () => {
  for (const expected of ["studio-new-greeting", "studioGreeting", "Good morning.", "greetingPeriod", "data.account?.display_name"])
    assert.ok(studioNext.includes(expected), `missing ${expected}`);
  assert.match(studioNext, /\.replace\([\s\S]*What would you like to <em>figure out\?<\/em>[\s\S]*studio-new-greeting/);
  assert.match(app, /What would you like to <em>figure out\?<\/em>/);
});

test("Studio new keeps Fast Mode Mini-only", () => {
  assert.match(studioNext, /miniFastControl/);
  assert.match(studioNext, /microsoft\/bitnet-b1\.58-2B-4T/);
  assert.match(studioNext, /cached script can never expose Fast Mode/);
});

test("Studio platform state is durable, searchable, controllable, and project-grounded", () => {
  for (const expected of [
    "studio_profiles",
    "studio_memories",
    "studio_chats",
    "studio_attachments",
    "studio_documents",
    "studio_assistants",
    "studio_tasks",
    "studio_notifications",
    "studio_agent_sessions",
    "studio_study_progress",
    "memory/export",
    "memory/import",
    "messages LIKE",
    "project_id",
    "extracted_text",
    "autoRemember",
    "grounding",
    "mergeSyncedChats",
  ]) assert.match(studioPlatform + studioNext + platformMigration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Studio workspaces provide real research, creation, voice, data, and sharing flows", () => {
  for (const expected of [
    "researchReport",
    "webSearch",
    "pageExcerpt",
    "full URLs",
    "pdf.js",
    "mammoth",
    "XLSX",
    "JSZip",
    "buildDocx",
    "buildPptx",
    "jspdf",
    "SpeechRecognition",
    "SpeechSynthesisUtterance",
    "getUserMedia",
    "getDisplayMedia",
    "Attach live frame",
    "studio_documents",
    "/studio/share/",
  ]) assert.match(studioPlatform + studioNext, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("cloud work persists with scheduling, managed agents, notifications, and supervised browser use", () => {
  for (const expected of [
    "runScheduledStudioTasks",
    "ScheduledController",
    "*/5 * * * *",
    "runManagedSession",
    "Architect",
    "Builder",
    "Tester",
    "Reviewer",
    "confirmation_required",
    "puppeteer.launch",
    "env.BROWSER",
    "Notification.requestPermission",
    "serviceWorker.register",
    "control_url",
  ]) assert.match(studioPlatform + studioNext + worker + wrangler, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("T3-forked OSS Studio preview is a routed three-panel agent surface", () => {
  for (const expected of [
    'url.pathname === "/studio/preview/a"',
    "studioT3Page()",
    "grid-template-columns:232px 248px 1fr",
    "rail-list",
    "thread-list",
    "id=\"planToggle\"",
    "Approve &amp; execute",
    "dock-terminal",
    "dock-diff",
    "diffLines",
    "id=\"permissions\"",
    "Reasoning: Light",
    "selectedModel()",
    "surface:'agent'",
    "toolAliases",
    "unknown_tool",
    "Launching 300 fast researchers",
    "Publish",
    "Allow low-risk",
  ]) assert.ok((worker + studioT3).includes(expected), `missing T3 preview contract: ${expected}`);
  assert.match(worker, /url\.pathname === "\/studio\/new"/);
  assert.match(studioT3, /Enter to send · Shift \+ Enter/);
});
