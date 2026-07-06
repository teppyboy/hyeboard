import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

// Minimal static-file + SPA-fallback handler for self-hosted (Node/Bun)
// deployments. Cloudflare's managed `assets` binding (wrangler.jsonc's
// `not_found_handling: "single-page-application"`) does this outside the
// worker script with no open-source equivalent — this re-implements just
// enough of it (serve a file if it exists under dist, else fall back to
// index.html for client-side routes) using only Node's built-in fs, which
// Bun also implements. Registered *after* all /api/* routes so it only
// catches unmatched (i.e. non-API) paths.

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerStaticAssets(app: any, distDir: string): void {
  const root = resolve(distDir);

  app.get("*", async ({ path: reqPath, set }: { path: string; set: { status: number; headers: Record<string, string> } }) => {
    const safeRelative = reqPath.replace(/^\/+/, "").replace(/\.\.(\/|\\|$)/g, "");
    const candidate = safeRelative ? join(root, safeRelative) : join(root, "index.html");

    try {
      const data = await readFile(candidate);
      set.headers["Content-Type"] = MIME_TYPES[extname(candidate)] ?? "application/octet-stream";
      return data;
    } catch {
      // Not a real file on disk — treat as a client-side SPA route and
      // serve index.html, same as Cloudflare's single-page-application
      // not_found_handling.
      try {
        const indexHtml = await readFile(join(root, "index.html"));
        set.headers["Content-Type"] = "text/html; charset=utf-8";
        return indexHtml;
      } catch {
        set.status = 404;
        return "Not found";
      }
    }
  });
}
