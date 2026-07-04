// Self-hosted workerd gateway.
//
// Cloudflare's managed Workers "assets" binding (used by wrangler.jsonc's
// `assets.run_worker_first: ["/api/*"]` + `not_found_handling: "single-page-application"`)
// does two things for free that plain workerd does not: (1) route /api/* to the
// worker script while serving everything else as static files, and (2) fall back
// to /index.html for extensionless paths so client-side routes (e.g. /login) don't
// 404 on a hard refresh. Neither behavior exists in open-source workerd, so this
// small gateway worker re-implements both in front of two workerd services:
//   - MAIN: the actual @hyeboard/worker Elysia app (service binding)
//   - ASSETS: a workerd `disk` service serving apps/web/dist (service binding)
//
// This is a best-effort re-implementation, not a byte-for-byte match of
// Cloudflare's managed asset-serving semantics (e.g. no immutable-asset caching
// headers, no content-negotiation beyond what the disk service already provides).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return env.MAIN.fetch(request);
    }

    const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
    let response = await env.ASSETS.fetch(new Request(new URL(assetPath, "http://assets"), request));

    // SPA fallback: an extensionless path with no matching file is almost
    // certainly a client-side route (e.g. /login, /settings) - hand it
    // index.html and let the React app's router take over.
    if (response.status === 404 && !assetPath.includes(".")) {
      response = await env.ASSETS.fetch(new Request(new URL("/index.html", "http://assets"), request));
    }

    return response;
  },
};
