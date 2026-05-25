// Default graph database path. Shared by the MCP server, the CLI index subcommand, and
// the index_project tool so a write from any of them is visible to reads from any of them.
//
// Default: $HOME/.cache/sfdx-graph-mcp/graph.db (or %USERPROFILE%\.cache\... on Windows).
// Override: set $SFDX_GRAPH_HOME to a directory; the db lives at $SFDX_GRAPH_HOME/graph.db.

import { join } from "node:path";

export function getDefaultDbDir(): string {
  if (process.env["SFDX_GRAPH_HOME"]) {
    return process.env["SFDX_GRAPH_HOME"];
  }
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp";
  return join(home, ".cache", "sfdx-graph-mcp");
}

export function getDefaultDbPath(): string {
  return join(getDefaultDbDir(), "graph.db");
}
