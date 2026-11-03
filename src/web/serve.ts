// Workbench is hosted by the same service as MCP and all project watchers.
import { spawn } from "node:child_process";
import { ensureService } from "../service/client.ts";
import { SERVICE_PORT } from "../service/location.ts";
import { logger } from "../util/logger.ts";
export type ServeOpts = { port?: number; open?: boolean; dbPath?: string };
export async function startUiServer(opts: ServeOpts = {}): Promise<void> {
  if (opts.port !== undefined && opts.port !== SERVICE_PORT)
    throw new Error(
      `The shared service uses port ${SERVICE_PORT}; alternate instances are disabled.`,
    );
  const service = await ensureService(
    opts.dbPath ? { dbPath: opts.dbPath } : {},
  );
  const url = `http://127.0.0.1:${service.port}/#token=${encodeURIComponent(service.token)}`;
  process.stderr.write(`Spindle Workbench: ${url}\n`);
  if (opts.open ?? true) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args =
      process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) =>
      logger.warn({ error }, "could not open browser"),
    );
    child.unref();
  }
}
