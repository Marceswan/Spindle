// Compatibility command: register a project with the shared service; never detach a
// per-project process. Watch scheduling now lives inside service/host.ts.
import { callService } from "../service/client.ts";
import { resolve } from "node:path";
export async function runWatchDaemon(projectRoot: string): Promise<void> {
  await callService("index_project", { project_root: resolve(projectRoot) });
}
