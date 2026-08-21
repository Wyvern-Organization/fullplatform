// Netlify Edge Function — OSAII Studio Preview f
// Optional edge middleware for Netlify Deploy Previews that injects preview headers
// and can add a <meta name="robots" content="noindex"> if needed.
// This complements the Worker-side isNetlifyPreviewRequest() banner injection.
//
// Enable in netlify.toml:
//   [[edge_functions]]
//     path = "/*"
//     function = "preview-banner"
//
// Deno runtime (Netlify Edge). No npm deps.

export default async (request: Request, context: any) => {
  const url = new URL(request.url);
  const isDeployPreview =
    url.hostname.includes("deploy-preview--") ||
    (url.hostname.includes("--") && url.hostname.endsWith(".netlify.app")) ||
    request.headers.get("x-nf-deploy-context") === "deploy-preview" ||
    context?.deployContext === "deploy-preview" ||
    url.searchParams.get("preview") === "1";

  // Let the origin handle it, but add headers for observability
  const response = await context.next();

  if (isDeployPreview) {
    // Ensure preview HTML is never cached durably
    if (url.pathname.startsWith("/studio/preview") || url.pathname.startsWith("/studio/new")) {
      response.headers.set("cache-control", "no-store, must-revalidate, max-age=0");
      response.headers.set("netlify-cdn-cache-control", "no-store, durable=false");
      response.headers.set("x-robots-tag", "noindex, nofollow");
      response.headers.set("x-preview-f", "1");
    }
    response.headers.set("x-preview-deploy", "true");
    // Vary by preview context so CDN doesn't serve preview cache to prod
    const vary = response.headers.get("vary");
    response.headers.set("vary", vary ? `${vary}, X-Nf-Preview` : "X-Nf-Preview, Origin");
  }

  // Hint for client code that this is a preview (used by netlify/public/index.html)
  if (isDeployPreview && response.headers.get("content-type")?.includes("text/html")) {
    response.headers.set("x-nf-preview", "true");
  }

  return response;
};

export const config = {
  path: ["/*"],
  // Only run on deploy previews / branch deploys — skip prod for performance
  // Netlify will still deploy the function but it short-circuits fast on prod host.
  excludedPath: ["/.netlify/*", "/osaii.png", "/*.js", "/*.css"],
};
