import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { connectService, type ServiceClient } from "../service/client.ts";
import { PAGE } from "./page.ts";

const READ_TOOLS = new Set(["list_projects", "get_schema", "search_graph", "trace_references", "get_source_snippet", "get_field_usage", "get_permission_access", "diff_projects"]);
export async function startWebUi(options: { port?: number; dbPath?: string; client?: ServiceClient } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const client = options.client ?? await connectService(options.dbPath);
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    const json = (status: number, value: unknown): void => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method !== "GET") { json(405, { error: "Read-only: GET required" }); return; }
    if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) { json(403, { error: "Origin not allowed" }); return; }
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    if (url.pathname !== "/api") { json(404, { error: "Not found" }); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { json(401, { error: "Open the complete URL printed by sfdx-graph-mcp ui to authenticate." }); return; }
    const tool = url.searchParams.get("tool") ?? "";
    if (!READ_TOOLS.has(tool)) { json(403, { error: "This tool is not available in the read-only explorer" }); return; }
    let input: unknown;
    try { input = JSON.parse(url.searchParams.get("input") ?? "{}"); } catch { json(400, { error: "Invalid input JSON" }); return; }
    void client.request("call", { name: tool, arguments: input }).then(data => json(200, data), (err: Error) => json(400, { error: err.message }));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  } catch (err) { await client.close(); throw err; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("UI failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { url: `${origin}/#${token}`, close() {
    closing ??= (async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); })();
    return closing;
  } };
}
