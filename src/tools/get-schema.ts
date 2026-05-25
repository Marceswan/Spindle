// MCP tool: get_schema
// Summarize what is in the graph for a project.

import { GraphStore } from "../graph/store.ts";
import { getSchemaSummary } from "../graph/queries.ts";

export const name = "get_schema";

export const description =
  "Return a summary of the metadata graph for a project: node label counts, edge type counts, " +
  "and up to 5 sample names per label. Use this for orientation before running search_graph.";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: {
      type: "number",
      description: "The numeric project ID from list_projects.",
    },
  },
  required: ["project_id"],
} as const;

type Input = { project_id: number };

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const { project_id } = input as Input;
  const summary = getSchemaSummary(store, project_id);
  return summary;
}
