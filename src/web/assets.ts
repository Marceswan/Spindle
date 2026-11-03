// Serves the SPA. Prefers compiled-in EMBEDDED_ASSETS; in dev (empty map) falls back to
// reading web/dist from disk. Unknown non-API paths fall back to index.html (SPA routing).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_ASSETS } from "./embedded-assets.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot)] ?? "application/octet-stream";
}

const DEV_DIST = join(process.cwd(), "web", "dist");

export function serveAsset(pathname: string): Response {
  const key = pathname === "/" ? "/index.html" : pathname;
  const hasEmbedded = Object.keys(EMBEDDED_ASSETS).length > 0;

  if (hasEmbedded) {
    const embedded = EMBEDDED_ASSETS[key] ?? EMBEDDED_ASSETS["/index.html"];
    if (embedded !== undefined) {
      const bytes = Buffer.from(embedded.base64, "base64");
      return new Response(bytes, { headers: { "content-type": embedded.contentType } });
    }
  }

  // Dev fallback: read from web/dist on disk.
  const onDisk = join(DEV_DIST, key.replace(/^\//, ""));
  if (existsSync(onDisk)) {
    return new Response(readFileSync(onDisk), {
      headers: { "content-type": contentTypeFor(key) },
    });
  }
  const indexOnDisk = join(DEV_DIST, "index.html");
  if (existsSync(indexOnDisk)) {
    return new Response(readFileSync(indexOnDisk), {
      headers: { "content-type": "text/html" },
    });
  }
  return new Response(
    "Spindle Workbench assets not built. Run `bun run build:web` (or `cd web && bun install && vite build`).",
    { status: 503, headers: { "content-type": "text/plain" } },
  );
}
