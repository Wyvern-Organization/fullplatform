import {
  hashPassword,
  newSalt,
  verifyPassword,
  newSessionToken,
  sessionCookie,
  clearSessionCookie,
  readSessionToken,
  sessionExpiry,
  type Auditor,
} from "./lib/auth";
import {
  createSubmission,
  listSubmissions,
  labelSubmission,
  listCatalog,
  parseLabels,
  labelSummary,
  isApproved,
  isClosed,
  CLOSED_LABEL,
  ALL_LABELS,
  type TierLabel,
} from "./lib/db";
import {
  layout,
  homepage,
  submitPage,
  catalogPage,
  signinPage,
  signupPage,
  auditPage,
  catalogClient,
  submitClient,
  authClient,
  auditClient,
} from "./lib/pages";
import {
  apiCorsHeaders,
  poolsideModelRequest,
  rateLimitModel,
  rateLimitFastMode,
  poolsideModels,
  rateLimit,
  withRateLimitHeaders,
} from "../API/poolside";
import { appPage } from "../API/app";
import { oauthCallbackPage } from "../API/app";
import {
  studioManifest,
  studioNewPage,
  studioServiceWorker,
} from "../API/studio-next";
import { studioT3Page } from "../API/studio-t3";
import {
  runScheduledStudioTasks,
  sharedStudioItem,
  studioPlatformApi,
} from "../API/studio-platform";
import { chatgptApi } from "../API/chatgpt";
import {
  accountIdForRequest,
  studioApi,
  studioPreview,
  trackAnonymousRequest,
} from "../API/studio";
import {
  providerForModel,
  trackTokenResponse,
} from "./lib/token-usage";
import {
  accountForApiKey,
  createApiKeyId,
  createApiKeySecret,
  hashApiKey,
} from "./lib/api-keys";
import { platformPage, productsPage } from "../API/platform";
import {
  cosaiiApi,
  cosaiiAuthorizePage,
  cosaiiDeviceApi,
} from "../API/cosaii";
import {
  cosaiiPowerShellInstaller,
  cosaiiShellInstaller,
} from "../API/cosaii-install";
import { docsPage } from "../API/docs";
import { MYTHOS_RELEASE, mythosPage } from "../API/mythos";
import { getSemanticCache, putSemanticCache } from "./lib/semantic-cache";
import {
  masqueAdminPage,
  masqueManifest,
  masquePage,
  masqueSharePage,
  masqueEmbedPage,
  masqueServiceWorker,
} from "../API/masque";
import {
  masqueApi,
  masqueApiError,
  runScheduledMasqueTasks,
} from "../API/masque-api";
export { MasqueSession } from "./masque-session";
import type { MasqueSession } from "./masque-session";
export { CosaiiRelay } from "./cosaii-relay";
import type { CosaiiRelay } from "./cosaii-relay";
import osaiiIcon from "../osaii.png";

interface Env {
  DB: D1Database;
  INVITE_SECRET?: string;
  POOOLSIDE_API_KEY?: string;
  LOGFARE_API_KEY?: string;
  GROQ_API_KEY?: string;
  POLLINATIONS_API_KEY?: string;
  STUDIO_FILES: R2Bucket;
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
  AI?: Ai;
  MASQUE_SEARCH?: VectorizeIndex;
  MASQUE_SESSIONS: DurableObjectNamespace<MasqueSession>;
  COSAII_RELAYS: DurableObjectNamespace<CosaiiRelay>;
  MASQUE_ADMIN_EMAILS?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "public, max-age=60, stale-while-revalidate=600",
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    try {
      if (
        method === "GET" &&
        (url.pathname === "/osaii.png" || url.pathname === "/favicon.ico")
      )
        return new Response(osaiiIcon, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
          },
        });

      if (url.pathname === "/health")
        return json({
          status: "ok",
          service: "osaii",
          worker: true,
          region: request.cf?.colo ?? "unknown",
        });

      if (method === "GET" && url.pathname === "/install/cosaii.sh")
        return new Response(cosaiiShellInstaller(), {
          headers: {
            "content-type": "text/x-shellscript; charset=utf-8",
            "content-disposition": "inline; filename=cosaii.sh",
            "cache-control": "no-store",
          },
        });
      if (method === "GET" && url.pathname === "/install/cosaii.ps1")
        return new Response(cosaiiPowerShellInstaller(), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": "inline; filename=cosaii.ps1",
            "cache-control": "no-store",
          },
        });
      const cosaiiAsset = url.pathname.match(
        /^\/install\/(cosaii-(?:linux|macos)-(?:x64|arm64)\.tar\.gz|cosaii-windows-(?:x64|arm64)\.zip)(\.sha256)?$/,
      );
      if (method === "GET" && cosaiiAsset) {
        const asset = `${cosaiiAsset[1]}${cosaiiAsset[2] ?? ""}`;
        const object = await env.STUDIO_FILES.get(`cosaii/releases/latest/${asset}`);
        if (!object)
          return json(
            { error: "cosaii_release_unavailable", message: "This Cosaii package has not been published yet." },
            503,
          );
        return new Response(object.body, {
          headers: {
            "content-type": cosaiiAsset[2]
              ? "text/plain; charset=utf-8"
              : cosaiiAsset[1].endsWith(".zip")
                ? "application/zip"
                : "application/gzip",
            "content-disposition": `attachment; filename=${asset}`,
            // The route is deliberately named `latest`; caching it can leave
            // `cosaii update` installing the previous paired binaries.
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (url.pathname === "/api/ask" && method === "GET")
        return askEndpoint(request, env, ctx, url);

      if (url.pathname.startsWith("/masque/api/v1/")) {
        try {
          return await masqueApi(
            request,
            env,
            url.pathname.slice("/masque/api/v1/".length),
            ctx,
          );
        } catch (error) {
          return masqueApiError(error);
        }
      }

      if (url.pathname.startsWith("/platform/api/cli/"))
        return cosaiiDeviceApi(
          request,
          env,
          url.pathname.slice("/platform/api/cli".length),
        );

      if (url.pathname.startsWith("/cosaii/api/v1/"))
        return cosaiiApi(
          request,
          env,
          url.pathname.slice("/cosaii/api/v1".length),
          ctx,
        );

      if (url.pathname.startsWith("/platform/api/"))
        return platformKeys(
          request,
          env.DB,
          url.pathname.slice("/platform/api".length),
        );

      if (url.pathname.startsWith("/api/v1/")) {
        if (method === "OPTIONS")
          return new Response(null, { status: 204, headers: apiCorsHeaders() });
        const apiAccountId = await accountForApiKey(request, env.DB);
        if (apiAccountId) await trackApiRequest(env.DB, apiAccountId, request);
        else await trackAnonymousRequest(env.DB, request);
        const model = await rateLimitModel(request);
        const fastMode = await rateLimitFastMode(request);
        const limited = rateLimit(request, model, apiAccountId, fastMode);
        if (limited) return limited;
        if (method === "GET" && url.pathname === "/api/v1/models")
          return withRateLimitHeaders(
            await poolsideModels(env),
            request,
            model,
            apiAccountId,
            fastMode,
          );
        if (method === "POST") {
          const response = await poolsideModelRequest(
            request,
            env,
            url.pathname.slice("/api/v1".length),
          );
          return withRateLimitHeaders(
            trackTokenResponse(response, {
              db: env.DB,
              ctx,
              request,
              accountId: apiAccountId,
              surface: "api",
              provider: providerForModel(model || ""),
              model: model || "unknown",
              path: url.pathname,
            }),
            request,
            model,
            apiAccountId,
            fastMode,
          );
        }
        return withRateLimitHeaders(
          json(
            { error: { message: "Not found.", type: "invalid_request_error" } },
            404,
            apiCorsHeaders(),
          ),
          request,
          model,
          apiAccountId,
        );
      }

      if (url.pathname === "/studio/api/auth/session" && method === "GET")
        return platformSession(request, env.DB);
      if (url.pathname === "/studio/api/auth/signup" && method === "POST")
        return platformSignup(request, env.DB);
      if (url.pathname === "/studio/api/auth/login" && method === "POST")
        return platformLogin(request, env.DB);
      if (url.pathname === "/studio/api/auth/logout" && method === "POST")
        return platformLogout(request, env.DB);
      if (url.pathname.startsWith("/studio/api/chatgpt")) {
        const path = url.pathname.slice("/studio/api/chatgpt".length) || "/models";
        const model = await rateLimitModel(request);
        const response = await chatgptApi(
          request,
          env,
          path,
        );
        if (method !== "POST" || (path !== "/chat/completions" && path !== "/responses")) {
          return response;
        }
        return trackTokenResponse(response, {
          db: env.DB,
          ctx,
          request,
          accountId: await accountIdForRequest(request, env.DB),
          surface: "studio_chatgpt",
          provider: "chatgpt",
          model: model || "unknown",
          path: url.pathname,
        });
      }
      if (url.pathname.startsWith("/studio/api/platform"))
        return studioPlatformApi(
          request,
          env,
          url.pathname.slice("/studio/api/platform".length) || "/bootstrap",
          ctx,
        );
      if (url.pathname.startsWith("/studio/api/"))
        return studioApi(
          request,
          env,
          url.pathname.slice("/studio/api".length),
          ctx,
        );
      const preview = url.pathname.match(/^\/studio\/site\/([^/]+)\/?(.*)$/);
      if (preview) return studioPreview(request, env, preview[1], preview[2]);
      const shared = url.pathname.match(/^\/studio\/share\/([a-f0-9]{48})$/);
      if (shared && method === "GET") return sharedStudioItem(env, shared[1]);

      if (method === "GET") {
        const masqueShare = url.pathname.match(/^\/masque\/share\/([A-Za-z0-9_-]{20,64})$/);
        if (masqueShare)
          return html(masqueSharePage(masqueShare[1]), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
          });
        const masqueEmbed = url.pathname.match(/^\/masque\/embed\/([A-Za-z0-9_-]{20,64})$/);
        if (masqueEmbed)
          return html(masqueEmbedPage(masqueEmbed[1]), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors *",
          });
        if (url.pathname === "/masque/manifest.webmanifest")
          return new Response(masqueManifest(), {
            headers: {
              "content-type": "application/manifest+json; charset=utf-8",
              "cache-control": "public, max-age=3600",
            },
          });
        if (url.pathname === "/masque/sw.js")
          return new Response(masqueServiceWorker(), {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              "service-worker-allowed": "/masque",
            },
          });
        if (url.pathname === "/masque/admin")
          return html(masqueAdminPage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
          });
        if (url.pathname === "/masque")
          return html(masquePage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "permissions-policy": "camera=(), microphone=(self), geolocation=()",
          });
        if (url.pathname === "/studio/oauth/callback")
          return html(oauthCallbackPage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
        if (url.pathname === "/studio/new/manifest.webmanifest")
          return new Response(studioManifest(), {
            headers: {
              "content-type": "application/manifest+json; charset=utf-8",
              "cache-control": "public, max-age=3600",
            },
          });
        if (url.pathname === "/studio/new/sw.js")
          return new Response(studioServiceWorker(), {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              "service-worker-allowed": "/studio/new",
            },
          });
        if (url.pathname === "/studio/new")
          return html(studioNewPage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "permissions-policy":
              "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
          });
        if (url.pathname === "/studio/preview/a")
          return html(studioT3Page(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "permissions-policy":
              "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
          });
        if (url.pathname === "/platform/cli/authorize")
          return cosaiiAuthorizePage(request, env.DB);
        if (url.pathname === "/mythos/release.json")
          return new Response(JSON.stringify(MYTHOS_RELEASE), {
            headers: {
              ...JSON_HEADERS,
              "cache-control": "public, max-age=300, stale-while-revalidate=3600",
            },
          });
        if (url.pathname === "/mythos")
          return html(mythosPage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=300, stale-while-revalidate=1800",
          });
        if (url.pathname === "/docs") {
          const docs = docsPage()
            .replaceAll("Docs · OSS Studio", "Docs · OSAII Platform")
            .replaceAll("<a class=\"brand\" href=\"/\">OSS <i>Studio</i></a>", "<a class=\"brand\" href=\"/\">OSAII <i>Platform</i></a>")
            .replaceAll("OSS Studio developer docs", "The OSAII Platform · developer docs")
            .replaceAll("One OpenAI-compatible gateway for Poolside models, Logfare Advanced models, and the focused OSS Studio workspace.", "The Platform connects a separate OpenAI-compatible API with the focused OSS Studio workspace. They share model access, accounts, safety, and usage.")
            .replaceAll("<h2>OSS Studio</h2><p class=\"section-intro\">", "<h2>Studio: the hands-on side of the Platform</h2><p class=\"section-intro\">")
            .replaceAll('<a href="#studio">Studio workspaces</a>', '<a href="#studio">Studio workspaces</a><a href="#mythos">MythOS</a>')
            .replaceAll("OSS Studio · <a href=\"/\">Platform</a> · <a href=\"/studio/new\">Studio</a> · <a href=\"/api/v1/models\">Models</a>", "OSAII Platform · <a href=\"/api/v1/models\">API</a> · <a href=\"/studio/new\">Studio</a> · <a href=\"/api/v1/models\">Models</a>")
            .replaceAll("q:'Answer using only the OSS Studio docs. Question: '+q", "q:'Answer only from the OSAII Platform docs below. Never invent URLs, endpoints, model IDs, or capabilities. If the docs do not contain the answer, say so. Known routes: /, /docs, /api/ask, /api/v1/chat/completions, /api/v1/responses, /api/v1/models, /studio/new, /masque, /masque/api/v1, /mythos, /mythos/release.json. Question: '+q")
            .replaceAll("answer.textContent=text", "answer.textContent=text.replace(/https?:\\/\\/[^\\s)]+/g,url=>{try{const u=new URL(url);const allowed=u.hostname==='osaii.wyvernhub.net'&&['/','/docs','/api/ask','/api/v1/chat/completions','/api/v1/responses','/api/v1/models','/studio/new','/masque','/masque/api/v1','/mythos','/mythos/release.json'].includes(u.pathname);return allowed?url:'[unverified link omitted]'}catch{return '[unverified link omitted]'}})");
          const mythosDocs = docs.replace(
            "</main>",
            `<section id="mythos"><h2>MythOS desktop integration</h2><p class="section-intro">MythOS is a separate desktop operating-system product. It works without an OSAII account or OSAII applications.</p><div class="cards"><div class="card"><strong>Opt-in shortcuts</strong><p>The optional <code>osaii-web-apps</code> System Hub feature adds browser shortcuts for Platform, Studio, and Masque. They are absent by default and removable.</p></div><div class="card"><strong>Separate identity</strong><p>Local users, files, administrator credentials, and diagnostics never become Platform account data. Browser sign-in is explicit.</p></div><div class="card"><strong>Service discovery</strong><p><code>GET /mythos/release.json</code> publishes version, channel, architecture, base, and canonical service routes.</p></div><div class="card"><strong>Release boundary</strong><p>Build validation does not imply broad hardware acceptance. The preview currently targets amd64 PC and Intel Mac boot paths.</p></div></div><p><a href="/mythos">Explore MythOS</a> · <a href="/mythos/release.json">Release metadata</a></p></section></main>`,
          );
          const masqueDocs = mythosDocs.replace(
            "</main>",
            `<section id="masque"><h2>Masque character platform</h2><p class="section-intro">Masque is a separate 18+ character product that shares OSAII Platform accounts, model infrastructure, safety, usage, and API keys with Studio and the API.</p><div class="code"><code>GET /masque/api/v1/characters?q=detective<br>POST /masque/api/v1/sessions<br>POST /masque/api/v1/sessions/{session_id}/messages</code></div><p>Masque exposes Auto, Fast, and Smart—not the general OpenAI-compatible model catalog. Public API keys use explicit <code>masque:read</code>, <code>masque:chat</code>, <code>masque:write</code>, <code>masque:embed</code>, and <code>masque:webhook</code> scopes. Existing keys begin with no Masque privileges.</p><p>Character resources include revisions, collaborators, remixes, imports, exports, personas, memory, rooms, social actions, reports, embeds, notifications, and aggregate webhooks. Message responses use SSE events named <code>start</code>, <code>delta</code>, <code>finish</code>, and <code>error</code>, with session, message, branch, revision, selected family, finish reason, and usage fields.</p><p><a href="/masque">Open Masque</a> · <a href="/masque/admin">Operator console</a></p></section></main>`,
          );
          const cosaiiDocs = masqueDocs.replace(
            "</main>",
            `<section id="cosaii"><h2>Cosaii local agent</h2><p class="section-intro">Cosaii (pronounced cozy) is the Platform's local agentic CLI. A persistent Rust <code>cosaii-app-server</code> owns sessions, tools, permissions, encrypted local persistence, and remote attachment; the OpenTUI client only renders state and sends actions.</p><div class="cards"><div class="card"><strong>Install</strong><p><code>curl -fsSL https://osaii.wyvernhub.net/install/cosaii.sh | sh</code><br>PowerShell: <code>irm https://osaii.wyvernhub.net/install/cosaii.ps1 | iex</code></p></div><div class="card"><strong>Browser login</strong><p>Run <code>cosaii login</code>. The CLI opens the normal Platform authorization page and polls a ten-minute device grant; no localhost callback is opened.</p></div><div class="card"><strong>Local sessions</strong><p>Threads, turns, items, search indexes, snapshots, and audit records stay in the app-server's encrypted SQLite store and are not synchronized into Studio transcripts.</p></div><div class="card"><strong>Permissions</strong><p>Deny All, Allow Low-Risk, Always Ask, and Full Access can be set globally or per canonical workspace. Full Access retains ask rules for destructive and sensitive actions.</p></div></div><pre>cosaii                         # open the TUI\ncosaii run "fix the failing tests" --format jsonl\ncosaii session list\ncosaii daemon status\ncosaii remote enable</pre><p>The versioned JSON-RPC protocol begins with <code>initialize</code> and supports thread, turn, item, account, permission, filesystem, command, MCP, skills, Platform, and remote-control methods. Local transport is WebSocket-framed RPC over a user-only Unix socket or Windows named pipe; embedding uses JSON-RPC over stdio.</p><p>Cloud endpoints are scoped under <code>/platform/api/cli/*</code> and <code>/cosaii/api/v1/*</code>. These require CLI bearer tokens and are not additions to the public OpenAI model list. The encrypted relay transports opaque ciphertext only.</p></section></main>`,
          );
          return html(cosaiiDocs, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=300, stale-while-revalidate=1800",
          });
        }
        if (url.pathname === "/products")
          return html(productsPage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=300, stale-while-revalidate=1800",
          });
        if (
          url.pathname === "/studio" ||
          url.pathname.startsWith("/studio/site/")
        )
          return html(appPage(), {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
        if (url.pathname === "/chat") return redirect("/studio");
        if (url.pathname === "/") {
          const umbrella = platformPage()
            .replaceAll("Open-source AI, ready to build", "The OSAII Platform")
            .replaceAll("Serious models.<br><em>Open</em> platform.", "One platform.<br><em>Two ways</em> to build.")
            .replaceAll("OSAII gives builders one OpenAI-compatible endpoint, clear model access, and a workspace for work that needs more than a chat box.", "OSAII Platform brings together the API and OSS Studio. They share models, accounts, safety, and usage while staying separate so you can call AI from code or work directly in a focused workspace.")
            .replaceAll('href="/studio">Open Studio', 'href="/studio/new">Open Studio')
            .replaceAll('href="/studio">Studio', 'href="/studio/new">Studio')
            .replaceAll('<a href="/catalog">Certified models</a>', '<a href="/products">Products</a><a href="/docs">Docs</a>')
            .replaceAll("<b>One endpoint</b><span>OpenAI-compatible chat and responses</span>", "<b>One platform</b><span>Shared models, accounts, safety, and usage</span>")
            .replaceAll("<b>Your key</b><span>Named, revocable credentials per account</span>", "<b>Two surfaces</b><span>API for code · Studio for focused work</span>")
            .replaceAll("<b>Open standard</b><span>Certification and platform, side by side</span>", "<b>Open standard</b><span>Build once, move between both</span>")
            .replaceAll("Build without translation.", "Choose your way in.")
            .replaceAll("Start with familiar client code. Choose models, keep credentials under your control.", "API and Studio are distinct products inside one Platform. Start wherever the work starts, then move between them without changing your model access.")
            .replaceAll("<b>03 / Workspace</b><h3>Move to Studio</h3><p>Use Chat, Agent, Agent Swarm when prompt work becomes project work.</p>", "<b>03 / Symbiotic</b><h3>One Platform, no lock-in</h3><p>The same catalog, safety boundary, account, and usage view connect your first prompt to a production integration.</p>")
            .replaceAll("Create key, test endpoint, start shipping.", "Create a key for code, or open Studio for hands-on work.")
            .replaceAll("function open(){modal.classList.add('open')", "function openModal(){modal.classList.add('open')")
            .replaceAll("b.onclick=open);", "b.onclick=openModal);")
            .replace("</body>", "<script>for(const id of ['accountButton','heroKey','stripKey']){const button=document.getElementById(id);if(button)button.addEventListener('click',()=>document.getElementById('modal')?.classList.add('open'))}</script></body>");
          return html(umbrella, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
        }
        if (url.pathname === "/initiative")
          return html(
            layout(homepage(), {
              title: "Open-Source AI Initiative",
              script:
                catalogClient +
                'renderCatalog(document.getElementById("catalog-preview"), 3);',
            }),
            HTML_HEADERS,
          );
        if (url.pathname === "/submit")
          return html(
            layout(submitPage(), {
              title: "Submit a model",
              script: submitClient,
            }),
            HTML_HEADERS,
          );
        if (url.pathname === "/catalog")
          return html(
            layout(catalogPage(), {
              title: "Certified catalog",
              script:
                catalogClient +
                'renderCatalog(document.getElementById("catalog-list"));',
            }),
            HTML_HEADERS,
          );
        if (url.pathname === "/signin")
          return html(
            layout(signinPage(), {
              title: "Auditor sign in",
              script: authClient,
            }),
            HTML_HEADERS,
          );
        if (url.pathname === "/signup" || url.pathname.startsWith("/signup/")) {
          const code =
            url.searchParams.get("code") ??
            url.pathname.slice("/signup/".length);
          const valid = !!env.INVITE_SECRET && code === env.INVITE_SECRET;
          return html(
            layout(signupPage(valid), {
              title: "Auditor sign up",
              script: valid ? authClient : "",
            }),
            HTML_HEADERS,
          );
        }
        if (url.pathname === "/audit") {
          const auditor = await currentAuditor(request, env.DB);
          if (!auditor) return redirect("/signin");
          return html(
            layout(auditPage(), { title: "Audit queue", script: auditClient }),
            HTML_HEADERS,
          );
        }
        if (url.pathname === "/api/catalog") return catalogHandler(env.DB);
        if (url.pathname === "/api/auth/session") {
          const auditor = await currentAuditor(request, env.DB);
          return json(
            auditor ? { auditor } : { auditor: null },
            auditor ? 200 : 401,
          );
        }
        if (url.pathname === "/api/submissions") {
          const auditor = await currentAuditor(request, env.DB);
          if (!auditor) return json({ error: "unauthorized" }, 401);
          const status = url.searchParams.get("status") ?? "";
          const submissions = (
            await listSubmissions(env.DB, status || undefined)
          ).map(toApiSubmission);
          return json({ submissions });
        }
      }

      if (method === "POST") {
        if (url.pathname === "/api/auth/signup")
          return signupHandler(request, env);
        if (url.pathname === "/api/auth/signin")
          return signinHandler(request, env.DB);
        if (url.pathname === "/api/auth/signout")
          return signoutHandler(request, env.DB);
        if (url.pathname === "/api/submissions")
          return createSubmissionHandler(request, env.DB);
        const labelMatch = url.pathname.match(
          /^\/api\/submissions\/(\d+)\/label$/,
        );
        if (labelMatch)
          return labelHandler(request, env.DB, Number(labelMatch[1]));
      }

      return notFound();
    } catch (error) {
      console.error(error);
      return json(
        {
          error: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await Promise.all([
      runScheduledStudioTasks(env, ctx),
      runScheduledMasqueTasks(env, ctx),
    ]);
  },
};

function html(body: string, headers: Record<string, string>): Response {
  return new Response(body, { headers });
}

function json(
  value: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

async function askEndpoint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (!query)
    return json(
      { error: { message: "The q parameter is required.", type: "invalid_request_error", param: "q" } },
      400,
      apiCorsHeaders(),
    );
  if (query.length > 100_000)
    return json(
      { error: { message: "The q parameter is too long (maximum 100,000 characters).", type: "invalid_request_error", param: "q" } },
      400,
      apiCorsHeaders(),
    );

  const aliases: Record<string, string> = {
    fast: "poolside/laguna-xs-2.1",
    smart: "poolside/laguna-s-2.1",
    mini: "microsoft/bitnet-b1.58-2B-4T",
  };
  const requestedModel = url.searchParams.get("model")?.trim() || "fast";
  const model = aliases[requestedModel.toLowerCase()] || requestedModel;
  const format = (url.searchParams.get("format")?.trim().toLowerCase() || "text");
  if (!["json", "ccjson", "rjson", "text"].includes(format))
    return json(
      { error: { message: "format must be one of json, ccjson, rjson, or text.", type: "invalid_request_error", param: "format" } },
      400,
      apiCorsHeaders(),
    );

  const accountId = await accountForApiKey(request, env.DB);
  if (accountId) await trackApiRequest(env.DB, accountId, request);
  else await trackAnonymousRequest(env.DB, request);
  const limited = rateLimit(request, model, accountId);
  if (limited) return limited;

  // Fast mode uses a short-lived semantic cache for recurring, non-personal
  // questions. Rate limits still apply; cached answers are never used for
  // Smart, Advanced, or provider-specific requests.
  if (model === "poolside/laguna-xs-2.1") {
    const cached = getSemanticCache(model, query);
    if (cached) {
      const cachedResponse = cachedAskResponse(cached, model, format);
      cachedResponse.headers.set("x-osaii-cache", "semantic-hit");
      return withRateLimitHeaders(cachedResponse, request, model, accountId);
    }
  }

  const upstreamRequest = new Request(new URL("/api/v1/chat/completions", request.url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: query }],
      stream: false,
    }),
  });
  let response = await poolsideModelRequest(upstreamRequest, env, "/chat/completions");
  response = trackTokenResponse(response, {
    db: env.DB,
    ctx,
    request,
    accountId,
    surface: "api_ask",
    provider: providerForModel(model),
    model,
    path: "/api/ask",
  });
  response = withRateLimitHeaders(response, request, model, accountId);
  if (!response.ok || format === "ccjson") return response;

  const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  const answer = askText(payload);
  if (model === "poolside/laguna-xs-2.1" && response.ok) putSemanticCache(model, query, answer);
  if (format === "text") {
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(answer, { status: response.status, headers });
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (format === "rjson") {
    const responseId = typeof payload?.id === "string" ? payload.id : `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    return new Response(JSON.stringify({
      id: responseId,
      object: "response",
      created_at: typeof payload?.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
      model,
      output: [{
        id: `${responseId}_msg`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: answer, annotations: [] }],
      }],
      output_text: answer,
      status: "completed",
      usage: payload?.usage ?? null,
    }), { status: response.status, headers });
  }
  return new Response(JSON.stringify({ answer, text: answer, model, usage: payload?.usage ?? null }), {
    status: response.status,
    headers,
  });
}

function cachedAskResponse(answer: string, model: string, format: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (format === "text") {
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(answer, { headers });
  }
  headers.set("content-type", "application/json; charset=utf-8");
  if (format === "ccjson") return new Response(JSON.stringify({
    id: `chatcmpl_cache_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
  }), { headers });
  if (format === "rjson") return new Response(JSON.stringify({
    id: `resp_cache_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response", created_at: Math.floor(Date.now() / 1000), model,
    output_text: answer, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }], status: "completed",
  }), { headers });
  return new Response(JSON.stringify({ answer, text: answer, model, cached: true }), { headers });
}

function askText(payload: Record<string, unknown> | null): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
  const message = first?.message && typeof first.message === "object" ? first.message as Record<string, unknown> : null;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") return String((part as Record<string, unknown>).text ?? (part as Record<string, unknown>).content ?? "");
    return "";
  }).join("");
  return typeof payload?.output_text === "string" ? payload.output_text : "";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

async function currentAuditor(
  request: Request,
  db: D1Database,
): Promise<Auditor | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT a.id, a.email, a.name FROM sessions s JOIN auditors a ON a.id = s.auditor_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .bind(token)
    .first<{ id: number; email: string; name: string }>();
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

function deleteExpiredSessions(db: D1Database): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    .run()
    .catch(() => {});
}

async function signupHandler(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    email?: unknown;
    password?: unknown;
    name?: unknown;
    code?: unknown;
  }>(request);
  if (typeof body.email !== "string" || typeof body.password !== "string")
    return json({ error: "email and password are required." }, 400);
  const email = body.email.trim().toLowerCase();
  if (!isEmail(email)) return json({ error: "Invalid email address." }, 400);
  if (body.password.length < 8)
    return json({ error: "Password must be at least 8 characters." }, 400);
  if (!env.INVITE_SECRET || body.code !== env.INVITE_SECRET)
    return json({ error: "This signup link is not valid." }, 403);

  const existing = await env.DB.prepare(
    "SELECT id FROM auditors WHERE email = ?",
  )
    .bind(email)
    .first();
  if (existing)
    return json(
      { error: "An auditor with that email already exists. Sign in instead." },
      409,
    );

  const salt = newSalt();
  const passwordHash = await hashPassword(body.password, salt);
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  await env.DB.prepare(
    "INSERT INTO auditors (email, name, password_hash, salt) VALUES (?, ?, ?, ?)",
  )
    .bind(email, name, passwordHash, salt)
    .run();

  return createSession(env.DB, email);
}

async function signinHandler(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  if (typeof body.email !== "string" || typeof body.password !== "string")
    return json({ error: "email and password are required." }, 400);
  const email = body.email.trim().toLowerCase();
  const row = await db
    .prepare(
      "SELECT id, email, name, password_hash, salt FROM auditors WHERE email = ?",
    )
    .bind(email)
    .first<{
      id: number;
      email: string;
      name: string;
      password_hash: string;
      salt: string;
    }>();
  if (!row) return json({ error: "Invalid credentials." }, 401);
  if (!(await verifyPassword(body.password, row.salt, row.password_hash)))
    return json({ error: "Invalid credentials." }, 401);
  return createSession(db, row.email);
}

async function createSession(db: D1Database, email: string): Promise<Response> {
  const auditor = await db
    .prepare("SELECT id, email, name FROM auditors WHERE email = ?")
    .bind(email)
    .first<{ id: number; email: string; name: string }>();
  if (!auditor) return json({ error: "Account not found." }, 500);
  const token = newSessionToken();
  const expiresAt = sessionExpiry();
  await db
    .prepare(
      "INSERT INTO sessions (token, auditor_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(token, auditor.id, expiresAt)
    .run();
  deleteExpiredSessions(db);
  return json(
    { auditor: { id: auditor.id, email: auditor.email, name: auditor.name } },
    200,
    { "set-cookie": sessionCookie(token, 30 * 24 * 60 * 60) },
  );
}

async function signoutHandler(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const token = readSessionToken(request);
  if (token)
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

async function createSubmissionHandler(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const body = await readJson<{
    name?: unknown;
    description?: unknown;
    submitter_email?: unknown;
    website_url?: unknown;
    weights_url?: unknown;
    code_url?: unknown;
    data_url?: unknown;
    license?: unknown;
  }>(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120)
    return json({ error: "A model name is required (max 120 chars)." }, 400);

  const urls = {
    website_url: cleanUrl(body.website_url),
    weights_url: cleanUrl(body.weights_url),
    code_url: cleanUrl(body.code_url),
    data_url: cleanUrl(body.data_url),
  };
  for (const [key, value] of Object.entries(urls)) {
    if (value === "__invalid__")
      return json({ error: `Invalid URL in ${key}.` }, 400);
  }

  const submitter_email =
    typeof body.submitter_email === "string"
      ? body.submitter_email.trim().toLowerCase().slice(0, 120)
      : "";
  if (submitter_email && !isEmail(submitter_email))
    return json({ error: "Invalid submitter email." }, 400);

  const submission = await createSubmission(db, {
    name,
    description:
      typeof body.description === "string"
        ? body.description.trim().slice(0, 600)
        : "",
    submitter_email,
    website_url: urls.website_url,
    weights_url: urls.weights_url,
    code_url: urls.code_url,
    data_url: urls.data_url,
    license:
      typeof body.license === "string" ? body.license.trim().slice(0, 60) : "",
  });
  return json({ ok: true, id: submission.id }, 201);
}

function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim().slice(0, 500);
  if (!isHttpUrl(trimmed)) return "__invalid__";
  return trimmed;
}

async function labelHandler(
  request: Request,
  db: D1Database,
  id: number,
): Promise<Response> {
  const auditor = await currentAuditor(request, db);
  if (!auditor) return json({ error: "unauthorized" }, 401);

  const body = await readJson<{
    labels?: unknown;
    publish?: unknown;
    notes?: unknown;
  }>(request);
  const labels: TierLabel[] = Array.isArray(body.labels)
    ? (body.labels as unknown[]).filter(
        (l): l is TierLabel =>
          typeof l === "string" && ALL_LABELS.includes(l as TierLabel),
      )
    : [];
  const publish = body.publish !== false;
  if (publish && !labels.length)
    return json({ error: "Select at least one label before publishing." }, 400);
  const closed = labels.includes(CLOSED_LABEL);
  if (closed && labels.some((l) => l !== CLOSED_LABEL))
    return json(
      { error: "A model cannot be both fully closed and open." },
      400,
    );
  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

  const submission = await labelSubmission(db, id, labels, publish, notes);
  if (!submission) return json({ error: "Submission not found." }, 404);
  return json({ ok: true, submission: toApiSubmission(submission) });
}

async function catalogHandler(db: D1Database): Promise<Response> {
  const submissions = await listCatalog(db);
  return json({ models: submissions.map(toApiSubmission) }, 200, {
    "cache-control": "public, max-age=300",
    "content-type": "application/json; charset=utf-8",
  });
}

function toApiSubmission(s: {
  id: number;
  name: string;
  description: string;
  submitter_email: string;
  website_url: string;
  weights_url: string;
  code_url: string;
  data_url: string;
  license: string;
  status: string;
  approved: number;
  audit_notes: string;
  created_at: string;
  audited_at: string | null;
  labels: string;
}) {
  const labels = parseLabels(s.labels);
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    website_url: s.website_url,
    weights_url: s.weights_url,
    code_url: s.code_url,
    data_url: s.data_url,
    license: s.license,
    status: s.status,
    approved: !!s.approved,
    labels,
    closed: isClosed(labels),
    summary: labelSummary(labels),
    osaii_approved: isApproved(labels),
    audit_notes: s.audit_notes,
    created_at: s.created_at,
    audited_at: s.audited_at,
  };
}

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

type PlatformAccount = { id: number; email: string; display_name: string };

async function platformAccount(
  request: Request,
  db: D1Database,
): Promise<PlatformAccount | null> {
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)osaii_platform_session=([^;]+)/)?.[1];
  if (!token) return null;
  return db
    .prepare(
      "SELECT a.id,a.email,a.display_name FROM platform_sessions s JOIN platform_accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at>datetime('now')",
    )
    .bind(token)
    .first<PlatformAccount>();
}

async function platformKeys(
  request: Request,
  db: D1Database,
  path: string,
): Promise<Response> {
  const account = await platformAccount(request, db);
  if (!account) return json({ error: "sign_in_required" }, 401);
  if (path === "/keys" && request.method === "GET") {
    const keys = await db
      .prepare(
        "SELECT id,name,prefix,scopes,created_at,last_used_at FROM api_keys WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .bind(account.id)
      .all();
    return json({ keys: keys.results });
  }
  if (path === "/keys" && request.method === "POST") {
    const body = await readJson<{ name?: unknown }>(request);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return json({ error: "A key name is required." }, 400);
    const key = createApiKeySecret();
    await db
      .prepare(
        "INSERT INTO api_keys(id,account_id,name,key_hash,prefix) VALUES(?,?,?,?,?)",
      )
      .bind(
        createApiKeyId(),
        account.id,
        name,
        await hashApiKey(key),
        key.slice(0, 14),
      )
      .run();
    return json({ key, prefix: key.slice(0, 14) }, 201);
  }
  const revoked = path.match(/^\/keys\/([0-9a-f-]{36})$/i);
  if (revoked && request.method === "DELETE") {
    await db
      .prepare(
        "UPDATE api_keys SET revoked_at=datetime('now') WHERE id=? AND account_id=? AND revoked_at IS NULL",
      )
      .bind(revoked[1], account.id)
      .run();
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

async function trackApiRequest(
  db: D1Database,
  accountId: number,
  request: Request,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO request_activity(account_id,surface,method,path) VALUES(?,?,?,?)",
    )
    .bind(
      accountId,
      "api",
      request.method,
      new URL(request.url).pathname.slice(0, 300),
    )
    .run();
}

async function platformSignup(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const body = await readJson<{
    email?: unknown;
    password?: unknown;
    display_name?: unknown;
  }>(request);
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName =
    typeof body.display_name === "string"
      ? body.display_name.trim().slice(0, 60)
      : "";
  if (!isEmail(email) || password.length < 8 || !displayName)
    return json(
      { error: "Name, valid email, and an 8-character password are required." },
      400,
    );
  if (
    await db
      .prepare("SELECT id FROM platform_accounts WHERE email = ?")
      .bind(email)
      .first()
  )
    return json(
      { error: "An OSAII Platform account already exists for this email." },
      409,
    );
  const salt = newSalt();
  await db
    .prepare(
      "INSERT INTO platform_accounts (email, display_name, password_hash, salt) VALUES (?, ?, ?, ?)",
    )
    .bind(email, displayName, await hashPassword(password, salt), salt)
    .run();
  return createPlatformSession(db, email);
}

async function platformLogin(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const account = await db
    .prepare(
      "SELECT id, email, display_name, password_hash, salt FROM platform_accounts WHERE email = ?",
    )
    .bind(email)
    .first<{
      id: number;
      email: string;
      display_name: string;
      password_hash: string;
      salt: string;
    }>();
  if (
    !account ||
    !(await verifyPassword(password, account.salt, account.password_hash))
  )
    return json({ error: "Invalid email or password." }, 401);
  return createPlatformSession(db, email);
}

async function createPlatformSession(
  db: D1Database,
  email: string,
): Promise<Response> {
  const account = await db
    .prepare(
      "SELECT id, email, display_name FROM platform_accounts WHERE email = ?",
    )
    .bind(email)
    .first<{ id: number; email: string; display_name: string }>();
  if (!account) return json({ error: "Account not found." }, 500);
  const token = newSessionToken();
  const expiresAt = sessionExpiry();
  await db
    .prepare(
      "INSERT INTO platform_sessions (token, account_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(token, account.id, expiresAt)
    .run();
  return json({ account }, 200, {
    "set-cookie": `osaii_platform_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
  });
}

async function platformSession(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)osaii_platform_session=([^;]+)/)?.[1];
  if (!token) return json({ account: null }, 401);
  const account = await db
    .prepare(
      `SELECT a.id, a.email, a.display_name FROM platform_sessions s JOIN platform_accounts a ON a.id = s.account_id WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .bind(token)
    .first();
  return json({ account: account ?? null }, account ? 200 : 401);
}

async function platformLogout(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)osaii_platform_session=([^;]+)/)?.[1];
  if (token)
    await db
      .prepare("DELETE FROM platform_sessions WHERE token = ?")
      .bind(token)
      .run();
  return json({ ok: true }, 200, {
    "set-cookie":
      "osaii_platform_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  });
}
