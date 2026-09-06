// CLI entry point. With no arguments, runs the MCP stdio server. Subcommands cover
// human-driven operations: index, session-start-hook, register-hook, unregister-hook,
// reset, doctor. See section 15.11 of the design doc.

import { Command } from "commander";
import { resolve } from "node:path";

import { startServer } from "./server.ts";
import { logger } from "./util/logger.ts";
import { getDefaultDbPath } from "./util/db-path.ts";
import { runSessionStartHook } from "./hook/session-start.ts";
import { connectService } from "./service/client.ts";
import { registerHook, unregisterHook } from "./hook/register.ts";

const VERSION = "1.1.2";

const program = new Command();

program
  .name("sfdx-graph-mcp")
  .description("Local-first MCP server that indexes SFDX projects into a queryable metadata graph")
  .version(VERSION);

program
  .command("service")
  .description("Internal: shared local graph service; exits after its last client disconnects")
  .option("--db-path <path>", "Graph database to serve")
  .action(async (opts: { dbPath?: string }) => {
    const { runService } = await import("./service/host.ts");
    await runService(opts.dbPath);
  });

program
  .command("index <project-path>")
  .description("Build or refresh the graph for an SFDX project")
  .option("--full", "Force a full reindex, ignoring stored file hashes", false)
  .option("--watch", "After the initial index, watch the project for changes and reindex incrementally", false)
  .option("--db-path <path>", "Override the graph database path (defaults to $SFDX_GRAPH_HOME or ~/.cache/sfdx-graph-mcp/graph.db)")
  .action(async (projectPath: string, opts: { full: boolean; watch: boolean; dbPath?: string }) => {
    const projectRoot = resolve(projectPath);
    const dbPath = opts.dbPath ?? getDefaultDbPath();
    const client = await connectService(dbPath);
    let keepOpen = false;
    try {
      const result = await client.request("call", { name: "index_project", arguments: {
        project_root: projectRoot, mode: opts.full ? "full" : "incremental",
      } });
      logger.info({ result }, "index complete");
      if (opts.watch) {
        keepOpen = true;
        const shutdown = (): void => {
          process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); process.off("SIGHUP", shutdown);
          void client.close();
        };
        process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown); process.on("SIGHUP", shutdown);
        logger.info({ projectRoot }, "shared watch active; Ctrl+C disconnects this client");
      }
    } finally { if (!keepOpen) await client.close(); }
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
  .description("Legacy alias: index through the shared service")
  .action(async (projectRoot: string) => {
    const client = await connectService();
    try { await client.request("call", { name: "index_project", arguments: { project_root: resolve(projectRoot) } }); }
    finally { await client.close(); }
  });

program
  .command("stop-watch")
  .description("Legacy hook compatibility; shared watchers follow client lifetime")
  .option("--cwd <path>", "Project root to stop watching (defaults to $CLAUDE_PROJECT_DIR or process.cwd())")
  .action((_opts: { cwd?: string }) => {
    // Legacy SessionEnd hooks must not terminate a watcher still used by other clients.
    process.stdout.write("Spindle: watchers are shared; they close after the last client disconnects.\n");
  });

program
  .command("register-hook")
  .description("Register SessionStart and remove obsolete SessionEnd hooks")
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
