// MCP tool: trace_references
// Bidirectional reference traversal from a named node.

import { GraphStore } from "../graph/store.ts";
import { assertProjectIndexed, traceReferences } from "../graph/queries.ts";
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
  "References to a method or field do not target its class or object: set include_members to true for " +
  "'everything that depends on class X or object X'. " +
  "Output: nodes, edges (both ends always in nodes; join them on node id), truncated, node_count, edge_count. " +
  "Compact by default; use detail=full for parser properties.";

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
    min_confidence: { type: "number", description: "Minimum edge confidence, inclusive. Default 0.6. Regex-derived edges are 0.6, heuristic 0.8, resolved 1.0." },
    include_members: {
      type: "boolean",
      description: "Also start from the members of the start node: methods, properties and inner types of an Apex class or interface; fields, validation rules and record types of an SObject. Default false.",
    },
    detail: { type: "string", enum: ["compact", "full"], description: "Default compact: ids, names, labels, source locations, edge properties. Full adds parser properties and storage fields." },
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
  include_members?: boolean | undefined;
  detail?: "compact" | "full" | undefined;
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const i = input as Input;
  assertProjectIndexed(store, i.project_id);

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

  if (i.include_members !== undefined && typeof i.include_members !== "boolean") {
    throw new Error("include_members must be a boolean");
  }
  if (i.detail !== undefined && i.detail !== "compact" && i.detail !== "full") {
    throw new Error("detail must be compact or full");
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
    ...(i.include_members ? { includeMembers: true } : {}),
  });

  // An empty result would read as "nothing refers to it". The usual cause is a qualified
  // name in the wrong form, so say that.
  if (result.nodes.length === 0) {
    const label = i.start.label !== undefined ? ` with label ${i.start.label}` : "";
    throw new Error(
      `No node has the qualified name "${i.start.qualified_name}"${label} in project ${i.project_id}. ` +
      "Names are exact. Find the name with search_graph (name_pattern), then try again. " +
      "Examples: ApexMethod `Class.method(ParamType)`, LwcBundle `c/name`, Field `Object.Field__c`.",
    );
  }

  const full = i.detail === "full";
  return {
    nodes: full ? result.nodes : result.nodes.map(({ id, label, name, qualifiedName, filePath, startLine, endLine }) => ({
      id, label, name, qualifiedName, filePath, startLine, endLine,
    })),
    edges: full ? result.edges : result.edges.map(({ id, sourceId, targetId, edgeType, confidence, sourceLine, properties }) => ({
      id, sourceId, targetId, edgeType, confidence, sourceLine, properties,
    })),
    truncated: result.truncated,
    node_count: result.nodes.length,
    edge_count: result.edges.length,
  };
}
