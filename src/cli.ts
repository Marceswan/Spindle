// CLI entry point. With no arguments, runs the MCP stdio server. Subcommands cover
// human-driven operations: index, session-start-hook, register-hook, unregister-hook,
// reset, doctor. See section 15.11 of the design doc.

import { Command } from "commander";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { watch } from "chokidar";

import { startServer } from "./server.ts";
import { logger } from "./util/logger.ts";
import { GraphStore } from "./graph/store.ts";
import { indexProject } from "./pipeline/index-project.ts";
import { getDefaultDbPath } from "./util/db-path.ts";
import { runSessionStartHook } from "./hook/session-start.ts";
import { runWatchDaemon } from "./hook/watch-daemon.ts";
import { stopWatcher } from "./hook/watch-control.ts";
import { registerHook, unregisterHook } from "./hook/register.ts";

const VERSION = "1.1.2";

const program = new Command();

program
  .name("sfdx-graph-mcp")
  .description("Local-first MCP server that indexes SFDX projects into a queryable metadata graph")
  .version(VERSION);

program
  .command("index <project-path>")
  .description("Build or refresh the graph for an SFDX project")
  .option("--full", "Force a full reindex, ignoring stored file hashes", false)
  .option("--watch", "After the initial index, watch the project for changes and reindex incrementally", false)
  .option("--db-path <path>", "Override the graph database path (defaults to $SFDX_GRAPH_HOME or ~/.cache/sfdx-graph-mcp/graph.db)")
  .action(async (projectPath: string, opts: { full: boolean; watch: boolean; dbPath?: string }) => {
    const projectRoot = resolve(projectPath);
    const dbPath = opts.dbPath ?? getDefaultDbPath();
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new GraphStore(dbPath);

    const runIndex = async (mode: "full" | "incremental"): Promise<void> => {
      const result = await indexProject(projectRoot, store, { mode });
      logger.info(
        {
          mode,
          filesParsed: result.filesParsed,
          nodesWritten: result.nodesWritten,
          edgesWritten: result.edgesWritten,
          durationMs: result.durationMs,
          warnings: result.warnings.length,
        },
        "index complete",
      );
    };

    try {
      await runIndex(opts.full ? "full" : "incremental");
    } catch (err) {
      logger.error({ err }, "index failed");
      store.close();
      process.exit(1);
    }

    if (!opts.watch) {
      store.close();
      return;
    }

    // Watch mode: chokidar fires on file changes; debounce reindexes by 300ms so a burst of
    // saves (e.g. an IDE batch write) becomes a single incremental run.
    logger.info({ projectRoot }, "watch mode: watching for changes");
    const watcher = watch(projectRoot, {
      ignored: [
        /(^|[/\\])\../,                              // dotfiles + dot-dirs (.git, .sfdx-graph, .sfdx, .sf)
        "**/node_modules/**",
        "**/dist/**",
      ],
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    let pending: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    const scheduleReindex = (): void => {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        if (running) {
          // Reschedule if a run is already in flight.
          scheduleReindex();
          return;
        }
        running = true;
        runIndex("incremental")
          .catch((err: unknown) => logger.error({ err }, "watch: reindex failed"))
          .finally(() => {
            running = false;
          });
      }, 300);
    };

    watcher.on("all", (event, path) => {
      logger.debug({ event, path }, "watch: change");
      scheduleReindex();
    });

    const shutdown = async (): Promise<void> => {
      logger.info("watch mode: shutting down");
      await watcher.close();
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });
  });

program
  .command("session-start-hook")
  .description("Claude Code SessionStart hook: detect SFDX in CWD and run an incremental index")
  .option("--cwd <path>", "Override the cwd (defaults to stdin JSON, $CLAUDE_PROJECT_DIR, or process.cwd())")
  .option("--source <subtype>", "Override the SessionStart subtype (startup|resume|clear|compact)")
  .action(async (opts: { cwd?: string; source?: string }) => {
    // Hook must always exit 0 so a bad project never blocks session start.
    try {
      await runSessionStartHook({
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      });
    } catch (err) {
      logger.warn({ err }, "session-start-hook: unexpected error (ignored)");
    }
    process.exit(0);
  });

program
  .command("watch-daemon <project-root>")
  .description("Internal: long-lived per-project watcher started by session-start-hook")
  .action(async (projectRoot: string) => {
    await runWatchDaemon(projectRoot);
  });

program
  .command("stop-watch")
  .description("Stop the watcher daemon associated with the current (or given) project")
  .option("--cwd <path>", "Project root to stop watching (defaults to $CLAUDE_PROJECT_DIR or process.cwd())")
  .action((opts: { cwd?: string }) => {
    const root = resolve(opts.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
    const result = stopWatcher(root);
    process.stdout.write(
      result.stopped
        ? `Spindle: stopped watcher for ${root}\n`
        : `Spindle: no live watcher for ${root}\n`,
    );
    process.exit(0);
  });

program
  .command("register-hook")
  .description("Register Spindle's SessionStart + SessionEnd hooks in ~/.claude/settings.json")
  .option("--settings <path>", "Override the settings.json path (defaults to $CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json)")
  .option("--binary <path>", "Override the binary path written to settings.json (defaults to this process's argv[0])")
  .action((opts: { settings?: string; binary?: string }) => {
    try {
      const result = registerHook({
        ...(opts.settings ? { settingsPath: opts.settings } : {}),
        ...(opts.binary ? { binary: opts.binary } : {}),
      });
      process.stdout.write(
        result.changed
          ? `Spindle: registered Claude Code hooks in ${result.path}\n`
          : `Spindle: hooks already registered in ${result.path}\n`,
      );
    } catch (err) {
      process.stderr.write(`Spindle: register-hook failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("unregister-hook")
  .description("Remove the SessionStart hook from ~/.claude/settings.json")
  .option("--settings <path>", "Override the settings.json path")
  .action((opts: { settings?: string }) => {
    try {
      const result = unregisterHook(opts.settings ? { settingsPath: opts.settings } : {});
      process.stdout.write(
        result.changed
          ? `Spindle: removed SessionStart hook from ${result.path}\n`
          : `Spindle: no SessionStart hook found in ${result.path}\n`,
      );
    } catch (err) {
      process.stderr.write(`Spindle: unregister-hook failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("reset <project-path>")
  .description("Delete all graph data for a project")
  .action((_projectPath: string) => {
    logger.error("reset subcommand not yet implemented");
    process.exit(2);
  });

program
  .command("doctor")
  .description("Sanity check the install: binary path, write permissions, prerequisites")
  .action(() => {
    logger.error("doctor subcommand not yet implemented");
    process.exit(2);
  });

// Default action (no subcommand): run as MCP stdio server.
program.action(async () => {
  await startServer();
});

// Async errors bubble out of commander; let the process surface them.
program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
