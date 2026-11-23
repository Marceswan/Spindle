// MCP tool: trace_references
// Bidirectional reference traversal from a named node.

import { GraphStore } from "../graph/store.ts";
import { traceReferences } from "../graph/queries.ts";
import type { NodeLabel } from "../model/node-labels.ts";
import type { EdgeType } from "../model/edge-types.ts";

export const name = "trace_references";

// Maximum nodes returned (start node included) when the caller sets no limit.
export const DEFAULT_TRACE_LIMIT = 500;
const MAX_TRACE_LIMIT = 5000;
const DIRECTIONS = ["inbound", "outbound", "both"] as const;

export const description =
  "Traverse the reference graph from a named node. Use for 'who calls X', 'what does X call', " +
  "or multi-hop reachability queries. Replaces recursive grep for call-graph questions. " +
  `Returns at most \`limit\` nodes (default ${DEFAULT_TRACE_LIMIT}, max ${MAX_TRACE_LIMIT}, start node included), nearest nodes first. ` +
  "When the limit cuts the traversal, truncated is true: raise limit, lower depth, or filter edge_types. " +
  "Output: nodes, edges (both ends always in nodes), truncated, node_count, edge_count.";

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
    depth: { type: "integer", minimum: 1, maximum: 5, description: "BFS depth. Default 2, max 5." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TRACE_LIMIT,
      description: `Maximum number of nodes to return, start node included. Default ${DEFAULT_TRACE_LIMIT}, max ${MAX_TRACE_LIMIT}.`,
    },
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
  limit?: number | undefined;
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const i = input as Input;

  if (typeof i.start !== "object" || i.start === null || Array.isArray(i.start)) {
    throw new Error("start must be an object with a string qualified_name");
  }
  if (typeof i.start.qualified_name !== "string" || i.start.qualified_name === "") {
    throw new Error("start.qualified_name must be a non-empty string");
  }
  if (!DIRECTIONS.includes(i.direction)) {
    throw new Error("direction must be one of: inbound, outbound, both");
  }
  if (i.depth !== undefined && (!Number.isSafeInteger(i.depth) || i.depth < 1 || i.depth > 5)) {
    throw new Error("depth must be an integer from 1 to 5");
  }
  const limit = i.limit ?? DEFAULT_TRACE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRACE_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_TRACE_LIMIT}`);
  }

  const result = traceReferences(store, {
    projectId: i.project_id,
    startQName: i.start.qualified_name,
    ...(i.start.label !== undefined ? { startLabel: i.start.label as NodeLabel } : {}),
    direction: i.direction,
    ...(i.edge_types !== undefined ? { edgeTypes: i.edge_types as EdgeType[] } : {}),
    ...(i.depth !== undefined ? { depth: i.depth } : {}),
    ...(i.min_confidence !== undefined ? { minConfidence: i.min_confidence } : {}),
    limit,
  });

  return {
    nodes: result.nodes,
    edges: result.edges,
    truncated: result.truncated,
    node_count: result.nodes.length,
    edge_count: result.edges.length,
  };
}
