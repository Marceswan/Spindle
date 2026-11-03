// A single kernel-owned listening socket is the machine-wide service lock. A losing
// launch cannot open the database or overwrite the winning owner's discovery record.
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GraphStore } from "../graph/store.ts";
import { listProjects } from "../graph/queries.ts";
import { getDefaultDbPath } from "../util/db-path.ts";
import { logger } from "../util/logger.ts";
import { handleApi } from "../web/api.ts";
import { serveAsset } from "../web/assets.ts";
import { createToolHost } from "./tools.ts";
import { createScheduler } from "./scheduler.ts";
import { SERVICE_PORT, getRuntimePath } from "./location.ts";

export type ServiceOptions = {
  port?: number;
  runtimePath?: string;
  dbPath?: string;
};
export async function startService(
  options: ServiceOptions = {},
): Promise<{ port: number; token: string; close(): Promise<void> }> {
  const token = crypto.randomUUID();
  const runtimePath = options.runtimePath ?? getRuntimePath();
  const dbPath = resolve(options.dbPath ?? getDefaultDbPath());
  let dispatch: (request: Request) => Promise<Response> = async () =>
    new Response("Starting", { status: 503 });
  const inFlight = new Set<Promise<Response>>();
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? SERVICE_PORT,
    fetch: (request) => {
      const response = dispatch(request);
      inFlight.add(response);
      void response.finally(() => inFlight.delete(response)).catch(() => {});
      return response;
    },
    idleTimeout: 0,
    maxRequestBodySize: 1024 * 1024,
  });
  const port = http.port!;
  let store: GraphStore;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    store = new GraphStore(dbPath);
  } catch (error) {
    await http.stop(true);
    throw error;
  }
  const watchers = new Map<
    string,
    { watcher: FSWatcher; scheduler: ReturnType<typeof createScheduler> }
  >();
  const canonicalDatabase = realpathSync(dbPath);
  let closing = false;
  const registerWatcher = async (root: string): Promise<void> => {
    const path = realpathSync(resolve(root));
    if (closing || watchers.has(path)) return;
    const scheduler = createScheduler(
      async () => {
        await tools.call("index_project", { project_root: path });
      },
      300,
      (error) => logger.warn({ error, path }, "watch index failed"),
    );
    const watcher = watch(path, {
      ignoreInitial: true,
      ignored: (candidate) => {
        const absolute = resolve(candidate);
        if ([dbPath, canonicalDatabase].some(p => absolute === p || absolute === p + "-wal" || absolute === p + "-shm")) return true;
        if (absolute === resolve(runtimePath)) return true;
        // Ignore project contents, never the names of its parent directories.
        const parts = relative(path, absolute).split(/[/\\]/);
        return parts.some(part => part.startsWith(".") || ["node_modules", "dist", "build"].includes(part));
      },
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    watchers.set(path, { watcher, scheduler });
    watcher.on("all", () => scheduler.schedule());
    // Close the initial scan gap: changes between indexing and watch readiness
    // must trigger another inventory check even when ignoreInitial suppresses events.
    watcher.once("ready", () => scheduler.schedule());
    watcher.on("error", (error) =>
      logger.warn({ error, path }, "watch failed"),
    );
  };
  const tools = createToolHost(store, registerWatcher);
  const json = (body: unknown, status = 200): Response =>
    Response.json(body, { status });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      closing = true;
      // Keep the ownership socket while draining; new requests receive 503.
      await Promise.allSettled([...inFlight]);
      await Promise.all(
        [...watchers.values()].map(async ({ watcher, scheduler }) => {
          await watcher.close();
          await scheduler.close();
        }),
      );
      await tools.idle();
      store.close();
      try {
        if (
          (JSON.parse(readFileSync(runtimePath, "utf8")) as { token: string })
            .token === token
        )
          unlinkSync(runtimePath);
      } catch {
        /* owner already gone */
      }
      // Release ownership only after the store closes, including idle sockets.
      await http.stop(true);
    })());
  dispatch = async (req) => {
    const url = new URL(req.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return json({ error: "Invalid host" }, 403);
    const origin = req.headers.get("origin");
    if (
      origin &&
      origin !== `http://127.0.0.1:${port}` &&
      origin !== `http://localhost:${port}`
    )
      return json({ error: "Invalid origin" }, 403);
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/service/") &&
      url.pathname !== "/mcp"
    )
      return serveAsset(url.pathname);
    if (req.headers.get("authorization") !== `Bearer ${token}`)
      return json({ error: "Authentication required" }, 401);
    if (closing) return json({ error: "Service stopping" }, 503);
    try {
      if (url.pathname === "/service/status")
        return json({
          protocol: 1,
          pid: process.pid,
          port,
          dbPath,
          projects: [...watchers.keys()],
        });
      if (url.pathname === "/service/tools") return json(tools.list());
      if (url.pathname === "/service/call" && req.method === "POST") {
        const body = (await req.json()) as {
          name?: unknown;
          arguments?: unknown;
        };
        if (
          typeof body.name !== "string" ||
          (body.arguments !== undefined &&
            (!body.arguments ||
              typeof body.arguments !== "object" ||
              Array.isArray(body.arguments)))
        )
          return json({ error: "Invalid tool call" }, 400);
        return json(
          await tools.call(
            body.name,
            (body.arguments ?? {}) as Record<string, unknown>,
          ),
        );
      }
      if (url.pathname === "/service/unwatch" && req.method === "POST") {
        const body = (await req.json()) as { root?: unknown };
        if (typeof body.root !== "string")
          return json({ error: "root required" }, 400);
        let root = resolve(body.root);
        try {
          root = realpathSync(root);
        } catch {
          /* deleted project */
        }
        const entry = watchers.get(root);
        if (entry) {
          await entry.watcher.close();
          await entry.scheduler.close();
          watchers.delete(root);
        }
        return json({ stopped: !!entry });
      }
      if (url.pathname === "/service/stop" && req.method === "POST") {
        setTimeout(() => {
          void close().then(() => process.exit(0));
        }, 25);
        return json({ stopping: true });
      }
      if (url.pathname === "/mcp") {
        const server = new Server(
          { name: "sfdx-graph-mcp", version: "1.1.2" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: tools.list(),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          try {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    await tools.call(
                      request.params.name,
                      request.params.arguments ?? {},
                    ),
                  ),
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                { type: "text" as const, text: (error as Error).message },
              ],
            };
          }
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await server.connect(transport);
        try {
          return await transport.handleRequest(req);
        } finally {
          await server.close();
        }
      }
      if (url.pathname.startsWith("/api/") && req.method !== "GET")
        return json({ error: "Read-only API" }, 405);
      return (
        (await handleApi(req, store)) ??
        json({ error: "Unknown endpoint" }, 404)
      );
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
  };
  try {
    mkdirSync(dirname(runtimePath), { recursive: true, mode: 0o700 });
    const temp = `${runtimePath}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ protocol: 1, pid: process.pid, port, token, dbPath }),
      { mode: 0o600 },
    );
    renameSync(temp, runtimePath);
  } catch (error) {
    await close();
    throw error;
  }
  for (const project of listProjects(store)) {
    try {
      await registerWatcher(project.rootPath);
    } catch (error) {
      logger.warn({ error, root: project.rootPath }, "Cannot restore watcher");
    }
  }
  return { port, token, close };
}
