import { homedir } from "node:os";
import { join } from "node:path";
// Deliberately independent of project, cwd and SFDX_GRAPH_HOME. All launchers contend
// for the same loopback port; there is no automatic alternate-port fallback.
export const SERVICE_PORT = 47839;
export function getRuntimePath(): string {
  return join(homedir(), ".cache", "sfdx-graph-mcp", "service.json");
}
