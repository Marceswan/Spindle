// Typed read helpers for the graph store. All SQL lives here; tool handlers call
// these functions and never embed query strings directly.

import type { GraphStore, StoredNode } from "./store.ts";
import type { NodeLabel } from "../model/node-labels.ts";
import type { EdgeType } from "../model/edge-types.ts";
import { DEFAULT_MIN_CONFIDENCE } from "../model/confidence.ts";

// ---------------------------------------------------------------------------
// Re-export StoredEdge so callers can import from one place.
// ---------------------------------------------------------------------------

export type StoredEdge = {
  id: number;
  projectId: number;
  sourceId: number;
  targetId: number;
  edgeType: EdgeType;
  confidence: number;
  properties: Record<string, unknown>;
  sourceFile: string | null;
  sourceLine: number | null;
};

// ---------------------------------------------------------------------------
// Project listing
// ---------------------------------------------------------------------------

export type ProjectSummary = {
  id: number;
  name: string;
  rootPath: string;
  indexedAt: number | null;
  apiVersion: string | null;
  nodeCount: number;
  edgeCount: number;
};

export function listProjects(store: GraphStore): ProjectSummary[] {
  type Row = {
    id: number;
    name: string;
    root_path: string;
    indexed_at: number | null;
    api_version: string | null;
  };
  const projects = store.db
    .query<Row, []>("SELECT id, name, root_path, indexed_at, api_version FROM projects ORDER BY id")
    .all();

  return projects.map((p) => {
    const nodeCount = store.db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM nodes WHERE project_id = ?",
      )
      .get(p.id)?.n ?? 0;

    const edgeCount = store.db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM edges WHERE project_id = ?",
      )
      .get(p.id)?.n ?? 0;

    return {
      id: p.id,
      name: p.name,
      rootPath: p.root_path,
      indexedAt: p.indexed_at,
      apiVersion: p.api_version,
      nodeCount,
      edgeCount,
    };
  });
}

// ---------------------------------------------------------------------------
// Schema summary (§9.4)
// ---------------------------------------------------------------------------

export type SchemaSummary = {
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  sampleNames: Record<string, string[]>;
  apiVersion: string | null;
  indexedAt: number | null;
};

export function getSchemaSummary(store: GraphStore, projectId: number): SchemaSummary {
  const project = store.db
    .query<{ api_version: string | null; indexed_at: number | null }, [number]>(
      "SELECT api_version, indexed_at FROM projects WHERE id = ?",
    )
    .get(projectId);

  type CountRow = { label: string; n: number };
  const nodeRows = store.db
    .query<CountRow, [number]>(
      "SELECT label, COUNT(*) AS n FROM nodes WHERE project_id = ? GROUP BY label",
    )
    .all(projectId);

  type EdgeCountRow = { edge_type: string; n: number };
  const edgeRows = store.db
    .query<EdgeCountRow, [number]>(
      "SELECT edge_type, COUNT(*) AS n FROM edges WHERE project_id = ? GROUP BY edge_type",
    )
    .all(projectId);

  const nodeCounts: Record<string, number> = {};
  const sampleNames: Record<string, string[]> = {};
  for (const row of nodeRows) {
    nodeCounts[row.label] = row.n;
  }

  // Sample up to 5 names per label.
  const labels = Object.keys(nodeCounts);
  for (const label of labels) {
    type SampleRow = { name: string };
    const samples = store.db
      .query<SampleRow, [number, string]>(
        "SELECT name FROM nodes WHERE project_id = ? AND label = ? LIMIT 5",
      )
      .all(projectId, label);
    sampleNames[label] = samples.map((r) => r.name);
  }

  const edgeCounts: Record<string, number> = {};
  for (const row of edgeRows) {
    edgeCounts[row.edge_type] = row.n;
  }

  return {
    nodeCounts,
    edgeCounts,
    sampleNames,
    apiVersion: project?.api_version ?? null,
    indexedAt: project?.indexed_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Node counts / edge counts (used by tools for output)
// ---------------------------------------------------------------------------

export function getNodeCounts(store: GraphStore, projectId: number): Record<string, number> {
  type Row = { label: string; n: number };
  const rows = store.db
    .query<Row, [number]>(
      "SELECT label, COUNT(*) AS n FROM nodes WHERE project_id = ? GROUP BY label",
    )
    .all(projectId);
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.label] = r.n;
  }
  return out;
}

export function getEdgeCounts(store: GraphStore, projectId: number): Record<string, number> {
  type Row = { edge_type: string; n: number };
  const rows = store.db
    .query<Row, [number]>(
      "SELECT edge_type, COUNT(*) AS n FROM edges WHERE project_id = ? GROUP BY edge_type",
    )
    .all(projectId);
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.edge_type] = r.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Node lookup
// ---------------------------------------------------------------------------

type RawNodeRow = {
  id: number;
  project_id: number;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  properties: string;
  content_hash: string | null;
};

function toStoredNode(row: RawNodeRow): StoredNode {
  let props: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      props = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed JSON — leave empty
  }
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label as NodeLabel,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    properties: props,
    contentHash: row.content_hash,
  };
}

export function getNodeByQName(
  store: GraphStore,
  projectId: number,
  label: NodeLabel,
  qname: string,
): StoredNode | null {
  const row = store.db
    .query<RawNodeRow, [number, string, string]>(
      `SELECT id, project_id, label, name, qualified_name,
              file_path, start_line, end_line, properties, content_hash
       FROM nodes
       WHERE project_id = ? AND label = ? AND qualified_name = ?`,
    )
    .get(projectId, label, qname);
  return row === null ? null : toStoredNode(row);
}

export function getNodeById(store: GraphStore, id: number): StoredNode | null {
  const row = store.db
    .query<RawNodeRow, [number]>(
      `SELECT id, project_id, label, name, qualified_name,
              file_path, start_line, end_line, properties, content_hash
       FROM nodes WHERE id = ?`,
    )
    .get(id);
  return row === null ? null : toStoredNode(row);
}

// ---------------------------------------------------------------------------
// All nodes for a project (used by pass 2 to build the symbol table)
// ---------------------------------------------------------------------------

export function getAllNodesForProject(store: GraphStore, projectId: number): StoredNode[] {
  const rows = store.db
    .query<RawNodeRow, [number]>(
      `SELECT id, project_id, label, name, qualified_name,
              file_path, start_line, end_line, properties, content_hash
       FROM nodes WHERE project_id = ?`,
    )
    .all(projectId);
  return rows.map(toStoredNode);
}

// ---------------------------------------------------------------------------
// Search nodes (§9.5)
// ---------------------------------------------------------------------------

export type SearchParams = {
  projectId: number;
  label?: string | string[] | undefined;
  namePattern?: string | undefined;
  qualifiedNamePattern?: string | undefined;
  filePattern?: string | undefined;
  propertyFilters?: Record<string, unknown> | undefined;
  relationship?: {
    edgeType: string;
    direction: "inbound" | "outbound" | "both";
    minDegree?: number | undefined;
    maxDegree?: number | undefined;
  } | undefined;
  excludeEntryPoints?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export function searchNodes(store: GraphStore, params: SearchParams): StoredNode[] {
  // Build query with label and project constraints; post-filter in JS for regex and property filters.
  const whereClauses: string[] = ["project_id = ?"];
  const bindValues: (string | number)[] = [params.projectId];

  const labels: string[] = [];
  if (params.label !== undefined) {
    if (Array.isArray(params.label)) {
      labels.push(...params.label);
    } else {
      labels.push(params.label);
    }
  }

  if (labels.length === 1) {
    whereClauses.push("label = ?");
    bindValues.push(labels[0] as string);
  } else if (labels.length > 1) {
    whereClauses.push(`label IN (${labels.map(() => "?").join(",")})`);
    bindValues.push(...labels);
  }

  const limitN = params.limit ?? 50;
  // Apply pagination after every filter; a pre-filter cap silently loses late matches.
  const sql = `
    SELECT id, project_id, label, name, qualified_name,
           file_path, start_line, end_line, properties, content_hash
    FROM nodes
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY id
  `;

  const nameRe = params.namePattern === undefined ? null : new RegExp(params.namePattern, "i");
  const qnameRe = params.qualifiedNamePattern === undefined ? null : new RegExp(params.qualifiedNamePattern, "i");
  const fileRe = params.filePattern === undefined ? null : new RegExp(
    params.filePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i",
  );
  const degreeQuery = store.db.query<{ n: number }, [number, string, number, string]>(
    "SELECT (SELECT count(*) FROM edges WHERE source_id = ? AND edge_type = ?) + " +
    "(SELECT count(*) FROM edges WHERE target_id = ? AND edge_type = ?) AS n",
  );
  const nodes: StoredNode[] = [];
  const offset = params.offset ?? 0;
  let matched = 0;
  // Stream candidates until the requested matching page is filled. No pre-filter cap,
  // and no full-project array of parser properties retained in memory.
  const statement = store.db.prepare<RawNodeRow, (string | number)[]>(sql);
  try {
    for (const row of statement.iterate(...bindValues)) {
      if (nameRe && !nameRe.test(row.name)) continue;
      if (qnameRe && !qnameRe.test(row.qualified_name)) continue;
      if (fileRe && (row.file_path === null || !fileRe.test(row.file_path))) continue;
      const node = toStoredNode(row);
      if (params.propertyFilters && Object.entries(params.propertyFilters).some(
        ([key, value]) => JSON.stringify(node.properties[key]) !== JSON.stringify(value),
      )) continue;
      if (params.excludeEntryPoints) {
        const annotations = node.properties["annotations"];
        if (Array.isArray(annotations) && annotations.some(a => typeof a === "string" &&
          ["auraenabled", "invocablemethod", "istest", "httpget", "httppost", "httpput", "httppatch", "httpdelete"].includes(a.toLowerCase()),
        )) continue;
      }
      if (params.relationship) {
        const rel = params.relationship;
        const degree = degreeQuery.get(
          rel.direction === "inbound" ? -1 : node.id, rel.edgeType,
          rel.direction === "outbound" ? -1 : node.id, rel.edgeType,
        )?.n ?? 0;
        if (degree < (rel.minDegree ?? 1) || (rel.maxDegree !== undefined && degree > rel.maxDegree)) continue;
      }
      if (matched++ < offset) continue;
      nodes.push(node);
      if (nodes.length >= limitN) break;
    }
  } finally { statement.finalize(); }
  return nodes;
}

// ---------------------------------------------------------------------------
// Trace references (§9.6)
// ---------------------------------------------------------------------------

export type TraceParams = {
  projectId: number;
  startQName: string;
  startLabel?: NodeLabel | undefined;
  direction: "inbound" | "outbound" | "both";
  edgeTypes?: EdgeType[] | undefined;
  depth?: number | undefined;
  minConfidence?: number | undefined;
};

export type TraceResult = {
  nodes: StoredNode[];
  edges: StoredEdge[];
};

type RawEdgeRow = {
  id: number;
  project_id: number;
  source_id: number;
  target_id: number;
  edge_type: string;
  confidence: number;
  properties: string;
  source_file: string | null;
  source_line: number | null;
};

function toStoredEdge(row: RawEdgeRow): StoredEdge {
  let props: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      props = parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    edgeType: row.edge_type as EdgeType,
    confidence: row.confidence,
    properties: props,
    sourceFile: row.source_file,
    sourceLine: row.source_line,
  };
}

export function traceReferences(store: GraphStore, params: TraceParams): TraceResult {
  const maxDepth = Math.min(params.depth ?? 2, 5);
  const minConf = params.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // Find start node.
  let startNode: StoredNode | null = null;
  if (params.startLabel !== undefined) {
    startNode = getNodeByQName(store, params.projectId, params.startLabel, params.startQName);
  } else {
    const row = store.db
      .query<RawNodeRow, [number, string]>(
        `SELECT id, project_id, label, name, qualified_name,
                file_path, start_line, end_line, properties, content_hash
         FROM nodes WHERE project_id = ? AND qualified_name = ? LIMIT 1`,
      )
      .get(params.projectId, params.startQName);
    if (row !== null) startNode = toStoredNode(row);
  }

  if (startNode === null) {
    return { nodes: [], edges: [] };
  }

  const visitedNodeIds = new Set<number>();
  const visitedEdgeIds = new Set<number>();
  const resultNodes: StoredNode[] = [startNode];
  const resultEdges: StoredEdge[] = [];
  visitedNodeIds.add(startNode.id);

  let frontier: number[] = [startNode.id];

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier: number[] = [];

    for (const nodeId of frontier) {
      // Build edge query based on direction.
      const edgeTypePlaceholders =
        params.edgeTypes && params.edgeTypes.length > 0
          ? `AND edge_type IN (${params.edgeTypes.map(() => "?").join(",")})`
          : "";

      const directions: Array<"inbound" | "outbound"> = [];
      if (params.direction === "outbound" || params.direction === "both") directions.push("outbound");
      if (params.direction === "inbound" || params.direction === "both") directions.push("inbound");

      for (const dir of directions) {
        const idColumn = dir === "outbound" ? "source_id" : "target_id";
        const otherColumn = dir === "outbound" ? "target_id" : "source_id";

        const edgeTypeValues: string[] = params.edgeTypes ?? [];
        const sql = `
          SELECT id, project_id, source_id, target_id, edge_type,
                 confidence, properties, source_file, source_line
          FROM edges
          WHERE ${idColumn} = ? AND project_id = ? AND confidence >= ? ${edgeTypePlaceholders}
        `;
        const bindArgs: (number | string)[] = [nodeId, params.projectId, minConf, ...edgeTypeValues];

        const edgeRows = store.db.query<RawEdgeRow, (number | string)[]>(sql).all(...bindArgs);

        for (const eRow of edgeRows) {
          if (visitedEdgeIds.has(eRow.id)) continue;
          visitedEdgeIds.add(eRow.id);
          resultEdges.push(toStoredEdge(eRow));

          const neighborId: number = eRow[otherColumn as keyof typeof eRow] as number;
          if (!visitedNodeIds.has(neighborId)) {
            visitedNodeIds.add(neighborId);
            const neighborNode = getNodeById(store, neighborId);
            if (neighborNode !== null) {
              resultNodes.push(neighborNode);
              nextFrontier.push(neighborId);
            }
          }
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return { nodes: resultNodes, edges: resultEdges };
}
