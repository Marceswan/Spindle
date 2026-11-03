// CLI launchers are clients of the one shared background service.
import { Command } from "commander";
import { resolve } from "node:path";
import {
  callService,
  ensureService,
  existingService,
  serviceRequest,
} from "./service/client.ts";
import { registerHook, unregisterHook } from "./hook/register.ts";

const program = new Command()
  .name("sfdx-graph-mcp")
  .description("Local-first Salesforce graph service")
  .version("1.1.2");
program
  .command("service")
  .description("Run the single shared service in the foreground")
  .option("--db-path <path>", "Graph database path")
  .action(async (opts: { dbPath?: string }) => {
    const { startService } = await import("./service/host.ts");
    try {
      const service = await startService(opts);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        process.once(signal, () => {
          void service.close().then(() => process.exit(0));
        });
      process.stderr.write(
        `Spindle service listening on 127.0.0.1:${service.port}\n`,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "EADDRINUSE") {
        process.stderr.write(
          "Spindle service port is already owned; no second instance started.\n",
        );
        return;
      }
      throw error;
    }
  });
program.command("service-status").action(async () => {
  const service = await existingService();
  process.stdout.write(
    JSON.stringify(
      service
        ? await serviceRequest(service, "/service/status")
        : { running: false },
    ) + "\n",
  );
});
program
  .command("service-stop")
  .description("Stop the shared service and all watchers")
  .action(async () => {
    const service = await existingService();
    if (service) await serviceRequest(service, "/service/stop", {});
  });
program
  .command("index <project-path>")
  .option("--full")
  .option("--watch", "Register a watcher (automatic in the shared service)")
  .option("--db-path <path>", "Database path; must match a running service")
  .action(async (root: string, opts: { full?: boolean; dbPath?: string }) => {
    const result = await callService(
      "index_project",
      { project_root: resolve(root), mode: opts.full ? "full" : "incremental" },
      opts.dbPath ? { dbPath: opts.dbPath } : {},
    );
    process.stderr.write(JSON.stringify(result) + "\n");
  });
program
  .command("watch-daemon <project-root>")
  .description("Register with the shared watcher service (compatibility alias)")
  .action(async (root: string) => {
    await callService("index_project", { project_root: resolve(root) });
  });
program
  .command("stop-watch")
  .description("Explicitly stop watching one project in the shared service")
  .option("--cwd <path>")
  .action(async (opts: { cwd?: string }) => {
    const service = await existingService();
    const result = service
      ? await serviceRequest(service, "/service/unwatch", {
          root: resolve(
            opts.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd(),
          ),
        })
      : { stopped: false };
    process.stdout.write(JSON.stringify(result) + "\n");
  });
program
  .command("session-start-hook")
  .option("--cwd <path>")
  .option("--source <subtype>")
  .action(async (opts: { cwd?: string; source?: string }) => {
    try {
      const { runSessionStartHook } = await import("./hook/session-start.ts");
      await runSessionStartHook(opts);
    } catch (error) {
      process.stderr.write(`Spindle hook: ${(error as Error).message}\n`);
    }
    process.exit(0);
  });
program
  .command("session-end-hook")
  .description("Leave shared watchers available to other clients")
  .action(() => {});
program
  .command("register-hook")
  .option("--settings <path>")
  .option("--binary <path>")
  .action((opts: { settings?: string; binary?: string }) => {
    const result = registerHook({
      ...(opts.settings ? { settingsPath: opts.settings } : {}),
      ...(opts.binary ? { binary: opts.binary } : {}),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  });
program
  .command("unregister-hook")
  .option("--settings <path>")
  .action((opts: { settings?: string }) => {
    process.stdout.write(
      JSON.stringify(
        unregisterHook(opts.settings ? { settingsPath: opts.settings } : {}),
      ) + "\n",
    );
  });
program
  .command("ui [project-path]")
  .option("--port <n>", "Shared service port", Number)
  .option("--no-open")
  .option("--db-path <path>")
  .action(
    async (
      root: string | undefined,
      opts: { port?: number; open?: boolean; dbPath?: string },
    ) => {
      if (root)
        await callService(
          "index_project",
          { project_root: resolve(root) },
          opts.dbPath ? { dbPath: opts.dbPath } : {},
        );
      const { startUiServer } = await import("./web/serve.ts");
      await startUiServer(opts);
    },
  );
program.command("doctor").action(async () => {
  const service = await ensureService();
  process.stdout.write(
    JSON.stringify(await serviceRequest(service, "/service/status")) + "\n",
  );
});
program.action(async () => {
  const { startServer } = await import("./server.ts");
  await startServer();
});
program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`Spindle: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
