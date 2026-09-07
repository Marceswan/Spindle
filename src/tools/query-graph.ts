// MCP tool: query_graph — design §9.13 (v0.5).
// Executes a Cypher-subset query against the indexed metadata graph.
//
// Supported:
//   MATCH (n:Label) RETURN n
//   MATCH (n:LabelA)-[r:EDGE_TYPE]->(m:LabelB) RETURN n, r, m
//   MATCH (n:LabelA)<-[r:EDGE_TYPE]-(m:LabelB) RETURN n, m
//   WHERE n.prop = / CONTAINS / STARTS WITH / ENDS WITH / IN / IS NULL / IS NOT NULL
//   WHERE ... AND/OR ...
//   OPTIONAL MATCH with WHERE; WITH aliases, *, DISTINCT, grouped count
//   RETURN n, n.name, count(*)
//   ORDER BY n.name [ASC|DESC]
//   SKIP N  LIMIT N
//
// Not supported (returns friendly error):
//   UNWIND, variable-length paths, CREATE/MERGE/DELETE/SET,
//   aggregates beyond count (collect, sum, min, max, avg), CALL subqueries,
//   path variables, pattern comprehensions.

import type { GraphStore } from "../graph/store.ts";
import { parseCypher } from "../graph/cypher/parser.ts";
import { planQuery } from "../graph/cypher/planner.ts";
import { executeQuery } from "../graph/cypher/executor.ts";

export const name = "query_graph";

export const description =
  "Execute a Cypher-subset query against the indexed metadata graph. " +
  "Supports: MATCH and OPTIONAL MATCH with node patterns and directed relationship patterns, WITH chaining and AS aliases, " +
  "WHERE filters (=, CONTAINS, STARTS WITH, ENDS WITH, IN, IS NULL, IS NOT NULL, AND/OR), " +
  "RETURN (whole variables, property projections, grouped count(*)/count(n)), DISTINCT, ORDER BY, LIMIT, SKIP. " +
  "Not supported: UNWIND, variable-length paths (-[*..]-), " +
  "CREATE/MERGE/DELETE/SET (read-only graph), aggregates other than count, CALL subqueries. " +
  "For unsupported syntax, use the typed tools: search_graph, trace_references, get_field_usage, get_permission_access.";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: {
      type: "number",
      description: "Project ID from list_projects.",
    },
    query: {
      type: "string",
      description: "Cypher-subset query string.",
    },
    params: {
      type: "object",
      description: "Optional named parameters (not yet used in v0.5; reserved for future).",
      additionalProperties: true,
    },
  },
  required: ["project_id", "query"],
} as const;

type Input = {
  project_id: number;
  query: string;
  params?: Record<string, unknown>;
};

type SuccessOutput = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  query: string;
  warnings: string[];
};

type ErrorOutput = {
  error: string;
  suggestion: string;
};

// Detect obviously unsupported constructs before parsing so we can return
// targeted error messages.
const UNSUPPORTED_PATTERNS: Array<{ pattern: RegExp; message: string; suggestion: string }> = [
  {
    pattern: /\bUNWIND\b/i,
    message: "Unsupported: UNWIND is not implemented in v0.5.",
    suggestion: "Use the typed search_graph tool for list-based lookups.",
  },
  {
    pattern: /\[[\s\w*]*\.\.[0-9*]/,
    message: "Unsupported: Variable-length paths (-[*N..M]->) are not implemented in v0.5.",
    suggestion: "Use trace_references for multi-hop traversal.",
  },
  {
    pattern: /\b(CREATE|MERGE|DELETE|SET|REMOVE)\b/i,
    message: "Unsupported: Write operations (CREATE, MERGE, DELETE, SET) are not allowed. Spindle is a read-only graph.",
    suggestion: "Use the SFDX CLI or VSCode to modify your project metadata.",
  },
  {
    pattern: /\b(COLLECT|SUM|MIN|MAX|AVG)\s*\(/i,
    message: "Unsupported: Aggregates other than count() are not implemented in v0.5.",
    suggestion: "Use count(*) or count(n). For other aggregations, retrieve the rows and aggregate client-side.",
  },
  {
    pattern: /\bCALL\b/i,
    message: "Unsupported: CALL subqueries are not implemented in v0.5.",
    suggestion: "Break into separate query_graph calls.",
  },
];

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const { project_id, query } = input as Input;

  if (typeof query !== "string" || query.trim() === "") {
    const out: ErrorOutput = {
      error: "Parse error: empty or missing query string",
      suggestion: "Provide a Cypher query string, e.g.: MATCH (n:ApexClass) RETURN n",
    };
    return out;
  }

  // Ignore quoted literal contents when looking for clause keywords.
  const syntaxOnly = query.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  // Pre-flight: check for unsupported constructs.
  for (const { pattern, message, suggestion } of UNSUPPORTED_PATTERNS) {
    if (pattern.test(syntaxOnly)) {
      const out: ErrorOutput = { error: message, suggestion };
      return out;
    }
  }

  // Parse
  const parseResult = parseCypher(query);
  if (!parseResult.ok) {
    const out: ErrorOutput = {
      error: `Parse error: ${parseResult.message} at column ${parseResult.column}`,
      suggestion:
        "Check your Cypher syntax. Supported: MATCH (n:Label) WHERE n.prop = 'value' RETURN n LIMIT 50",
    };
    return out;
  }

  // Plan
  let plan;
  try {
    plan = planQuery(parseResult.query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out: ErrorOutput = {
      error: `Planner error: ${msg}`,
      suggestion: "Ensure your query uses supported patterns. See the tool description for the supported subset.",
    };
    return out;
  }

  // Execute
  try {
    const result = executeQuery(store, plan, parseResult.query, project_id);
    const out: SuccessOutput = {
      columns: result.columns,
      rows: result.rows,
      row_count: result.rowCount,
      query,
      warnings: result.warnings,
    };
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out: ErrorOutput = {
      error: `Execution error: ${msg}`,
      suggestion:
        "The query could not be executed against the graph. Check that project_id is valid and the project is indexed.",
    };
    return out;
  }
}
