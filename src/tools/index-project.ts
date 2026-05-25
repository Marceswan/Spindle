// MCP tool: index_project
// Build or refresh the graph for an SFDX project using the shared graph store.

import { GraphStore } from "../graph/store.ts";
import { indexProject } from "../pipeline/index-project.ts";

export const name = "index_project";

export const description =
  "Build or refresh the metadata graph for an SFDX project. Run this before any other tool. " +
  "Use mode 'incremental' (default) to skip unchanged files; use 'full' to force a complete reindex.";

export const inputSchema = {
  type: "object",
  properties: {
    project_root: {
      type: "string",
      description: "Absolute path to the SFDX project root (directory containing sfdx-project.json)",
    },
    mode: {
      type: "string",
      enum: ["full", "incremental"],
      description: "Indexing mode. Default: incremental.",
    },
  },
  required: ["project_root"],
} as const;

type Input = {
  project_root: string;
  mode?: "full" | "incremental" | undefined;
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const { project_root, mode } = input as Input;

  const result = await indexProject(project_root, store, { mode: mode ?? "incremental" });
  return {
    project_root,
    files_parsed: result.filesParsed,
    nodes_written: result.nodesWritten,
    edges_written: result.edgesWritten,
    duration_ms: result.durationMs,
    warnings: result.warnings.length,
  };
}
