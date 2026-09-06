import { Database } from "bun:sqlite";
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { writeFileSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { GraphStore } from "../graph/store.ts";
import { getDefaultDbPath } from "../util/db-path.ts";
import { indexProject } from "../pipeline/index-project.ts";
import { logger } from "../util/logger.ts";
import { toolsWithStore } from "./tools.ts";
import { canonicalDbPath, serviceFiles, SERVICE_PROTOCOL, MAX_FRAME_BYTES } from "./paths.ts";

// OS-managed SQLite write lock survives startup races and is released on crash.
// Never unlink this file: contenders must lock the same inode throughout teardown.
export async function runService(rawDbPath = getDefaultDbPath()): Promise<void> {
  const dbPath = canonicalDbPath(rawDbPath);
  const files = serviceFiles(dbPath);
  const lock = new Database(files.lock, { create: true });
  try { lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); } catch (err) {
    lock.close();
    if ((err as { code?: string }).code === "SQLITE_BUSY") return;
    throw err;
  }
  let store: GraphStore;
  try { store = new GraphStore(dbPath); } catch (err) { lock.close(); throw err; }
  const token = randomBytes(32).toString("hex");
  const clients = new Set<Socket>();
  const sockets = new Set<Socket>();
  const watchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>();
  let queue: Promise<unknown> = Promise.resolve();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => {};
  const finished = new Promise<void>(resolve => { finish = resolve; });

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(err => { logger.warn({ err }, "shared service operation failed"); });
    return result;
  };

  const ensureWatch = (rawRoot: string): string => {
    const root = realpathSync(rawRoot);
    if (watchers.has(root)) return root;
    const watcher = watch(root, {
      ignored: [/(^|[/\\])\../, "**/node_modules/**", "**/dist/**", "**/build/**"],
      ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    const state = { watcher, timer: null as ReturnType<typeof setTimeout> | null };
    watchers.set(root, state);
    watcher.on("error", err => { logger.warn({ err, root }, "shared watcher error"); });
    watcher.on("all", () => {
      if (stopping) return;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = null;
        if (!stopping) void enqueue(async () => { await indexProject(root, store, { mode: "incremental" }); }).catch(() => {});
      }, 300);
    });
    return root;
  };

  const server = createServer(socket => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    const handshakeTimer = setTimeout(() => socket.destroy(), 2000);
    socket.on("error", err => { logger.debug({ err }, "shared client socket error"); });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      sockets.delete(socket);
      clients.delete(socket);
      if (!stopping && clients.size === 0) armIdle(1000);
    });
    const reply = (id: number, value: { result?: unknown; error?: string }): void => {
      if (!socket.destroyed) socket.write(JSON.stringify({ id, ...value }) + "\n");
    };
    socket.on("data", (chunk: string) => {
      if (stopping) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let request: { id: number; method: string; params?: unknown };
        try { request = JSON.parse(line) as typeof request; } catch { socket.destroy(); return; }
        if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== "string") { socket.destroy(); return; }
        const { id, method, params } = request;
        if (!clients.has(socket)) {
          const hello = params as { token?: string; protocol?: number } | undefined;
          if (method !== "hello" || hello?.token !== token || hello.protocol !== SERVICE_PROTOCOL) { socket.destroy(); return; }
          clients.add(socket);
          clearTimeout(handshakeTimer);
          clearTimeout(idleTimer);
          reply(id, { result: { pid: process.pid, protocol: SERVICE_PROTOCOL } });
          continue;
        }
        void enqueue(async () => {
          if (method === "status") return { pid: process.pid, clients: clients.size, watchers: watchers.size, dbPath };
          if (method === "list") return toolsWithStore.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
          if (method === "stop-watch") {
            const root = realpathSync((params as { project_root: string }).project_root);
            const state = watchers.get(root);
            if (!state) return { stopped: false };
            watchers.delete(root);
            if (state.timer) clearTimeout(state.timer);
            await state.watcher.close();
            return { stopped: true };
          }
          if (method !== "call") throw new Error(`Unknown service method: ${method}`);
          const call = params as { name: string; arguments?: Record<string, unknown> };
          const tool = toolsWithStore.find(t => t.name === call.name);
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);
          const args = call.arguments ?? {};
          // Subscribe before indexing so file changes during indexing are queued.
          if (call.name === "index_project") ensureWatch(args["project_root"] as string);
          return await tool.handler(args, store);
        }).then(result => reply(id, { result }), err => reply(id, { error: String((err as Error).message) }));
      }
    });
  });

  const shutdown = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(idleTimer);
    stopPromise = (async () => {
      // Stop intake and timers, drain accepted work, then close graph and ownership.
      const serverClosed = new Promise<void>(resolve => { server.close(() => resolve()); });
      for (const state of watchers.values()) if (state.timer) clearTimeout(state.timer);
      await queue;
      await Promise.allSettled([...watchers.values()].map(state => state.watcher.close()));
      watchers.clear();
      for (const socket of sockets) socket.destroy();
      await serverClosed;
      store.close();
      try { unlinkSync(files.discovery); } catch { /* crash or startup failure */ }
      lock.close();
      process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); process.off("SIGHUP", onSignal);
      finish();
    })();
    return stopPromise;
  };
  const armIdle = (delay: number): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (clients.size === 0) void shutdown(); }, delay);
  };
  const onSignal = (): void => { void shutdown().catch(err => { logger.error({ err }, "service shutdown failed"); process.exitCode = 1; }); };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); process.on("SIGHUP", onSignal);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Shared service failed to bind");
    const temporary = `${files.discovery}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, port: address.port, token, protocol: SERVICE_PROTOCOL }), { mode: 0o600 });
    renameSync(temporary, files.discovery);
    armIdle(10000); // Give the spawning client time to connect.
    logger.info({ pid: process.pid, dbPath }, "shared service ready");
    await finished;
  } catch (err) { await shutdown(); throw err; }
}
