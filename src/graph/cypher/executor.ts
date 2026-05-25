// Runs a SQL plan against the GraphStore and returns typed result rows.

import type { GraphStore, StoredNode } from "../store.ts";
import type { SqlPlan } from "./planner.ts";
import type { CypherQuery, ReturnItem } from "./types.ts";

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  warnings: string[];
};

// Parse a JSON node blob returned by json_object(...) back into a StoredNode shape.
// The SQL produces JSON strings (SQLite json_object returns TEXT); parse them.
function parseNodeBlob(blob: unknown): StoredNode {
  let parsed: Record<string, unknown> = {};
  if (typeof blob === "string") {
    try {
      const v = JSON.parse(blob) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>;
      }
    } catch {
      // leave empty
    }
  } else if (typeof blob === "object" && blob !== null && !Array.isArray(blob)) {
    parsed = blob as Record<string, unknown>;
  }

  // The "properties" field inside the node blob is itself a JSON string stored in SQLite.
  let props: Record<string, unknown> = {};
  const rawProps = parsed["properties"];
  if (typeof rawProps === "string") {
    try {
      const v = JSON.parse(rawProps) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        props = v as Record<string, unknown>;
      }
    } catch {
      // leave empty
    }
  } else if (typeof rawProps === "object" && rawProps !== null && !Array.isArray(rawProps)) {
    props = rawProps as Record<string, unknown>;
  }

  return {
    id: typeof parsed["id"] === "number" ? parsed["id"] : 0,
    projectId: typeof parsed["project_id"] === "number" ? parsed["project_id"] : 0,
    label: typeof parsed["label"] === "string" ? (parsed["label"] as StoredNode["label"]) : "ApexClass",
    name: typeof parsed["name"] === "string" ? parsed["name"] : "",
    qualifiedName: typeof parsed["qualified_name"] === "string" ? parsed["qualified_name"] : "",
    filePath: typeof parsed["file_path"] === "string" ? parsed["file_path"] : null,
    startLine: typeof parsed["start_line"] === "number" ? parsed["start_line"] : null,
    endLine: typeof parsed["end_line"] === "number" ? parsed["end_line"] : null,
    properties: props,
    contentHash: typeof parsed["content_hash"] === "string" ? parsed["content_hash"] : null,
  };
}

// Parse an edge blob back into a plain object.
function parseEdgeBlob(blob: unknown): Record<string, unknown> {
  if (typeof blob === "string") {
    try {
      const v = JSON.parse(blob) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      // leave empty
    }
  } else if (typeof blob === "object" && blob !== null && !Array.isArray(blob)) {
    return blob as Record<string, unknown>;
  }
  return {};
}

// Determine whether a RETURN item refers to a node variable, edge variable, or a scalar.
// We need this to decide how to post-process each column.
type ColumnKind = "node" | "edge" | "scalar";

function classifyReturnItem(
  item: ReturnItem,
  variableAliases: Map<string, string>,
  edgeVariables: Set<string>,
): ColumnKind {
  switch (item.kind) {
    case "variable": {
      if (edgeVariables.has(item.name)) return "edge";
      if (variableAliases.has(item.name)) return "node";
      return "scalar";
    }
    case "prop":
      return "scalar";
    case "count":
      return "scalar";
  }
}

export function executeQuery(
  store: GraphStore,
  plan: SqlPlan,
  query: CypherQuery,
  projectId: number,
): QueryResult {
  const warnings: string[] = [];

  // Replace the projectId placeholder (first param is always projectId = 0).
  const params = [...plan.params];
  if (params[0] === 0) {
    params[0] = projectId;
  }

  // Warn on unlabelled node matches.
  if (
    query.match.kind === "nodeOnly" &&
    query.match.node.label === undefined
  ) {
    warnings.push(
      "Unlabelled node match (MATCH (n)) will scan all nodes. Consider adding a label for performance.",
    );
  }

  // Collect which variables are edge variables.
  const edgeVariables = new Set<string>();
  if (query.match.kind === "relationship" && query.match.rel.variable) {
    edgeVariables.add(query.match.rel.variable);
  }

  // Classify each RETURN column.
  const columnKinds: ColumnKind[] = query.returnItems.map((item) =>
    classifyReturnItem(item, plan.variableAliases, edgeVariables),
  );

  type RawRow = Record<string, unknown>;
  const rawRows = store.db.query<RawRow, (string | number | null)[]>(plan.sql).all(...params);

  const resultRows: unknown[][] = [];
  for (const raw of rawRows) {
    const colValues = Object.values(raw);
    const row: unknown[] = colValues.map((val, idx) => {
      const kind = columnKinds[idx] ?? "scalar";
      if (kind === "node") return parseNodeBlob(val);
      if (kind === "edge") return parseEdgeBlob(val);
      // Scalar: return as-is (string, number, null)
      return val;
    });
    resultRows.push(row);
  }

  return {
    columns: plan.columns,
    rows: resultRows,
    rowCount: resultRows.length,
    warnings,
  };
}
