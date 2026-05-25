// MCP tool: list_projects
// List all indexed projects in the current database instance.

import { GraphStore } from "../graph/store.ts";
import { listProjects } from "../graph/queries.ts";

export const name = "list_projects";

export const description =
  "List all SFDX projects indexed in this graph database. Returns project IDs, names, " +
  "root paths, node/edge counts, and when the project was last indexed.";

export const inputSchema = {
  type: "object",
  properties: {},
  required: [],
} as const;

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  void input;
  const projects = listProjects(store);
  return { projects };
}
