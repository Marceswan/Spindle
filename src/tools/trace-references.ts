// MCP tool: trace_references
// Bidirectional reference traversal from a named node.

import { GraphStore } from "../graph/store.ts";
import { traceReferences } from "../graph/queries.ts";
import type { NodeLabel } from "../model/node-labels.ts";
import type { EdgeType } from "../model/edge-types.ts";

export const name = "trace_references";

export const description =
  "Traverse the reference graph from a named node. Use for 'who calls X', 'what does X call', " +
  "or multi-hop reachability queries. Replaces recursive grep for call-graph questions.";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: { type: "number" },
    start: {
      type: "object",
      properties: {
        qualified_name: { type: "string", description: "Fully qualified name of the starting node." },
        label: { type: "string", description: "Optional label hint: ApexMethod, ApexClass, etc." },
      },
      required: ["qualified_name"],
    },
    direction: {
      type: "string",
      enum: ["inbound", "outbound", "both"],
      description: "inbound = who references this node; outbound = what this node references.",
    },
    edge_types: {
      type: "array",
      items: { type: "string" },
      description: "Filter to specific edge types. Default: all.",
    },
    depth: { type: "number", description: "BFS depth. Default 2, max 5." },
    min_confidence: { type: "number", description: "Minimum edge confidence. Default 0.6." },
  },
  required: ["project_id", "start", "direction"],
} as const;

type Input = {
  project_id: number;
  start: { qualified_name: string; label?: string | undefined };
  direction: "inbound" | "outbound" | "both";
  edge_types?: string[] | undefined;
  depth?: number | undefined;
  min_confidence?: number | undefined;
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const i = input as Input;

  const result = traceReferences(store, {
    projectId: i.project_id,
    startQName: i.start.qualified_name,
    ...(i.start.label !== undefined ? { startLabel: i.start.label as NodeLabel } : {}),
    direction: i.direction,
    ...(i.edge_types !== undefined ? { edgeTypes: i.edge_types as EdgeType[] } : {}),
    ...(i.depth !== undefined ? { depth: i.depth } : {}),
    ...(i.min_confidence !== undefined ? { minConfidence: i.min_confidence } : {}),
  });

  return result;
}
