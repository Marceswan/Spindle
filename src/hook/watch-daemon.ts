// Watch daemon: runs an incremental-reindex loop for one project. Started detached by
// the SessionStart hook; stopped via SIGTERM from the SessionEnd hook or `stop-watch`.
//
// The daemon writes a PID file at <db-dir>/watchers/<slug>.pid so the SessionEnd hook
// can find and signal it. If a live watcher is already running for the same project,
// this process exits immediately — only one watcher per project.

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { watch } from "chokidar";

import { GraphStore } from "../graph/store.ts";
import { indexProject } from "../pipeline/index-project.ts";
import { getDefaultDbPath } from "../util/db-path.ts";
import { logger } from "../util/logger.ts";
import {
  getPidFilePath,
  isPidAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from "./watch-control.ts";

export async function runWatchDaemon(rawProjectRoot: string): Promise<never> {
  const projectRoot = resolve(rawProjectRoot);
  const pidFile = getPidFilePath(projectRoot);

  // If a live watcher already owns this project, defer to it.
  const existing = readPidFile(pidFile);
  if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
    logger.info({ projectRoot, pid: existing.pid }, "watch-daemon: another watcher is already running, exiting");
    process.exit(0);
  }

  writePidFile(pidFile, {
    pid: process.pid,
    projectRoot,
    startedAt: Date.now(),
  });

  const dbPath = getDefaultDbPath();
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new GraphStore(dbPath);

  let running = false;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const reindex = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await indexProject(projectRoot, store, { mode: "incremental" });
      logger.debug(
        {
          projectRoot,
          filesParsed: result.filesParsed,
          durationMs: result.durationMs,
        },
        "watch-daemon: reindex",
      );
    } catch (err) {
      logger.warn({ err, projectRoot }, "watch-daemon: reindex failed");
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void reindex();
    }, 300);
  };

  const watcher = watch(projectRoot, {
    ignored: [
      /(^|[/\\])\../,           // dotfiles + dot-dirs
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
    ],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("all", () => {
    schedule();
  });

  logger.info({ projectRoot, pid: process.pid }, "watch-daemon: watching for changes");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ projectRoot, signal }, "watch-daemon: shutting down");
    try { await watcher.close(); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
    removePidFile(pidFile);
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGHUP", () => { void shutdown("SIGHUP"); });

  // Keep the event loop alive forever (chokidar handles this implicitly, but be explicit
  // in case all listeners detach). The real exit path is via SIGTERM.
  return await new Promise<never>(() => { /* never resolves */ });
}
