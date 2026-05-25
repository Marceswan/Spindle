// MCP tool: get_source_snippet
// Read source code for a graph node directly from disk.

import { readFileSync } from "node:fs";

import { GraphStore } from "../graph/store.ts";
import { searchNodes } from "../graph/queries.ts";

export const name = "get_source_snippet";

export const description =
  "Return the source code for a named graph node (Apex class, method, trigger, etc.). " +
  "Use after search_graph or trace_references to read the implementation without a separate file read.";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: { type: "number" },
    qualified_name: {
      type: "string",
      description: "Fully qualified name of the node, e.g. 'AccountService.cleanup()'.",
    },
    context_lines: {
      type: "number",
      description: "Additional lines before start_line and after end_line to include. Default 0.",
    },
  },
  required: ["project_id", "qualified_name"],
} as const;

type Input = {
  project_id: number;
  qualified_name: string;
  context_lines?: number | undefined;
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const { project_id, qualified_name, context_lines } = input as Input;
  const ctx = context_lines ?? 0;

  // Search for the node by qualified name (no label hint).
  const nodes = searchNodes(store, {
    projectId: project_id,
    qualifiedNamePattern: `^${escapeRegex(qualified_name)}$`,
    limit: 1,
  });

  if (nodes.length === 0) {
    return { error: `Node not found: ${qualified_name}` };
  }

  const node = nodes[0]!;
  if (node.filePath === null) {
    return { error: `Node has no associated file: ${qualified_name}` };
  }

  let fileContents: string;
  try {
    fileContents = readFileSync(node.filePath, "utf8");
  } catch (err) {
    return { error: `Cannot read file ${node.filePath}: ${(err as Error).message}` };
  }

  const lines = fileContents.split("\n");
  const totalLines = lines.length;

  const startLine = node.startLine ?? 1;
  const endLine = node.endLine ?? startLine;

  // Convert to 0-indexed, then apply context.
  const from = Math.max(0, startLine - 1 - ctx);
  const to = Math.min(totalLines - 1, endLine - 1 + ctx);

  const source = lines.slice(from, to + 1).join("\n");

  return {
    file_path: node.filePath,
    start_line: from + 1,
    end_line: to + 1,
    source,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
