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

import { VERSION } from "./version.ts";

const program = new Command();

program
  .name("sfdx-graph-mcp")
  .description("Local-first MCP server that indexes SFDX projects into a queryable metadata graph")
  .version(VERSION);

program
  .command("update")
  .description("Check for or install a GPG-verified public release")
  .option("--check", "Check release metadata without changing the binary", false)
  .option("--yes", "Install the verified release", false)
  .option("--to <version>", "Select a stable release tag, including an explicit downgrade")
  .action(async (opts: { check: boolean; yes: boolean; to?: string }) => {
    const { checkUpdate, performUpdate } = await import("./update/update.ts");
    if (opts.check || !opts.yes) {
      const info = await checkUpdate(VERSION, opts.to);
      process.stdout.write(JSON.stringify(info, null, 2) + "\n");
      if (!opts.check) process.stdout.write("Run update --yes to verify and install.\n");
      return;
    }
    if (import.meta.url.startsWith("file:") && !import.meta.url.includes("/$bunfs/")) throw new Error("Self-update requires the installed compiled binary; refusing to replace the Bun runtime");
    process.stdout.write(JSON.stringify(await performUpdate({ currentVersion: VERSION, executablePath: process.execPath, ...(opts.to ? { version: opts.to } : {}) }), null, 2) + "\n");
    process.stdout.write("Reconnect MCP clients to load the new executable.\n");
  });

program
  .command("rollback")
  .description("Restore the executable saved by the previous verified update")
  .requiredOption("--yes", "Restore the backup executable")
  .action(async () => {
    if (import.meta.url.startsWith("file:") && !import.meta.url.includes("/$bunfs/")) throw new Error("Rollback requires the installed compiled binary");
    const { rollbackUpdate } = await import("./update/update.ts");
    process.stdout.write(JSON.stringify(await rollbackUpdate(process.execPath)) + "\n");
  });

program
  .command("ui")
  .description("Open a read-only local metadata explorer (prints a private local URL)")
  .option("--port <port>", "Loopback port, default automatic", "0")
  .option("--db-path <path>", "Graph database to explore")
  .action(async (opts: { port: string; dbPath?: string }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0–65535");
    const { startWebUi } = await import("./web/server.ts");
    const ui = await startWebUi({ port, ...(opts.dbPath ? { dbPath: opts.dbPath } : {}) });
    process.stdout.write(`Spindle explorer: ${ui.url}\n`);
    const stop = (): void => { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop); void ui.close(); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
  });

program
  .command("diff <base-project-id> <target-project-id>")
  .description("Compare two indexed org/source snapshots by project ID")
  .option("--db-path <path>", "Graph database")
  .option("--metadata-only", "Ignore source content hashes", false)
  .option("--offset <offset>", "Page offset", "0")
  .option("--limit <limit>", "Page size", "50")
  .action(async (base: string, target: string, opts: { dbPath?: string; metadataOnly: boolean; offset: string; limit: string }) => {
    const client = await connectService(opts.dbPath);
    try { process.stdout.write(JSON.stringify(await client.request("call", { name: "diff_projects", arguments: {
      base_project_id: Number(base), target_project_id: Number(target), include_source: !opts.metadataOnly,
      offset: Number(opts.offset), limit: Number(opts.limit),
    } }), null, 2) + "\n"); } finally { await client.close(); }
  });

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
