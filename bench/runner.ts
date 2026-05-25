// Benchmark runner. Indexes the fixture project, executes each canonical query,
// and returns a structured BenchReport with latency, memory, token approximation,
// and correctness scores.
//
// Usage: import { runBench } from "./runner.ts"

// To suppress pino index-project logs, set SFDX_GRAPH_LOG_LEVEL=silent before invoking
// (the `bench` npm script does this). Setting it at module top is too late under ES module
// hoisting — imports evaluate before runtime statements.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../src/graph/store.ts";
import { indexProject } from "../src/pipeline/index-project.ts";
import * as searchGraphTool from "../src/tools/search-graph.ts";
import * as traceReferencesTool from "../src/tools/trace-references.ts";
import * as getSchemaTool from "../src/tools/get-schema.ts";
import * as getSourceSnippetTool from "../src/tools/get-source-snippet.ts";
import * as listProjectsTool from "../src/tools/list-projects.ts";
import { QUERIES } from "./queries.ts";
import type { BenchQuery } from "./queries.ts";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type QueryResult = {
  id: string;
  tool: string;
  latencyMs: number;
  heapDeltaKb: number;
  responseTokensApprox: number;
  recall: number;
  falsePositives: number;
  passed: boolean;
  error?: string | undefined;
};

export type BenchReport = {
  indexLatencyMs: number;
  indexNodeCount: number;
  indexEdgeCount: number;
  indexPeakHeapMb: number;
  queries: QueryResult[];
};

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

type ToolHandler = (input: unknown, store: GraphStore) => Promise<unknown>;

const TOOL_MAP: Record<string, ToolHandler> = {
  [searchGraphTool.name]: searchGraphTool.handler,
  [traceReferencesTool.name]: traceReferencesTool.handler,
  [getSchemaTool.name]: getSchemaTool.handler,
  [getSourceSnippetTool.name]: getSourceSnippetTool.handler,
  [listProjectsTool.name]: listProjectsTool.handler,
};

// ---------------------------------------------------------------------------
// Token approximation
// ---------------------------------------------------------------------------

// We approximate token count as Math.ceil(byteLength / 4).
// This matches the common rule-of-thumb that one GPT-style token is ~4 bytes
// of UTF-8 text in English/code content. A real tokenizer (e.g. tiktoken) would
// give the exact count, but that would require a new dependency. The approximation
// is defensible for relative comparison and can be swapped later.
function approximateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// ---------------------------------------------------------------------------
// Correctness scoring
// ---------------------------------------------------------------------------

type ResultNode = {
  qualifiedName?: string | undefined;
  qualified_name?: string | undefined;
  label?: string | undefined;
};

// Extract a flat array of { qualifiedName, label } objects from a tool result.
// Handles the shapes returned by search_graph, trace_references, get_schema,
// get_source_snippet, and list_projects.
function extractNodes(result: unknown): ResultNode[] {
  if (result === null || typeof result !== "object") return [];

  const r = result as Record<string, unknown>;

  // search_graph: { nodes: Node[], count: number }
  if (Array.isArray(r["nodes"])) {
    return (r["nodes"] as unknown[]).map((n) => n as ResultNode);
  }

  // trace_references: { nodes: Node[], edges: Edge[] }
  // (also has nodes array — handled above)

  // get_schema: { nodeCounts: {...}, edgeCounts: {...}, ... }
  // We treat the presence of nodeCounts as "one result" for minResults purposes.
  if (typeof r["nodeCounts"] === "object" && r["nodeCounts"] !== null) {
    return [{ qualifiedName: "__schema_summary__" }];
  }

  // get_source_snippet: { file_path, start_line, end_line, source } or { error }
  if (typeof r["source"] === "string") {
    return [{ qualifiedName: "__source_snippet__" }];
  }

  // list_projects: { projects: [...] }
  if (Array.isArray(r["projects"])) {
    return (r["projects"] as unknown[]).map((p) => p as ResultNode);
  }

  return [];
}

// Normalise a node's qualified name from either camelCase or snake_case field.
function getQName(node: ResultNode): string {
  return node.qualifiedName ?? node.qualified_name ?? "";
}

function scoreCorrectness(
  query: BenchQuery,
  result: unknown,
): { recall: number; falsePositives: number; passed: boolean } {
  const nodes = extractNodes(result);
  const gt = query.groundTruth;

  // Recall: fraction of mustContain items that appear in the result.
  let recall = 1.0;
  if (gt.mustContain !== undefined && gt.mustContain.length > 0) {
    const matched = gt.mustContain.filter((mc) =>
      nodes.some((n) => getQName(n) === mc.qualifiedName),
    ).length;
    recall = matched / gt.mustContain.length;
  }

  // False positives: count of mustNotContain items that appeared.
  let falsePositives = 0;
  if (gt.mustNotContain !== undefined) {
    falsePositives = gt.mustNotContain.filter((mnc) =>
      nodes.some((n) => getQName(n) === mnc.qualifiedName),
    ).length;
  }

  // minResults / maxResults gate.
  const meetsMin = gt.minResults === undefined ? true : nodes.length >= gt.minResults;
  const meetsMax = gt.maxResults === undefined ? true : nodes.length <= gt.maxResults;

  const passed = recall >= 1.0 && falsePositives === 0 && meetsMin && meetsMax;
  return { recall, falsePositives, passed };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export type RunBenchOpts = {
  fixturePath: string;
};

export async function runBench(opts: RunBenchOpts): Promise<BenchReport> {
  // Copy fixture to a temp dir so we don't mutate the original.
  const tempDir = join(
    tmpdir(),
    `spindle-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tempDir, { recursive: true });
  cpSync(opts.fixturePath, tempDir, { recursive: true });

  const dbDir = join(tempDir, ".sfdx-graph");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "graph.db");

  const store = new GraphStore(dbPath);

  try {
    // --- Index the project --------------------------------------------------
    const heapBeforeIndex = process.memoryUsage().heapUsed;
    const indexStart = process.hrtime.bigint();

    const indexResult = await indexProject(tempDir, store, { mode: "full" });

    const indexEndNs = process.hrtime.bigint();
    const indexLatencyMs = Number(indexEndNs - indexStart) / 1_000_000;
    const heapAfterIndex = process.memoryUsage().heapUsed;
    const indexPeakHeapMb = (heapAfterIndex - heapBeforeIndex) / (1024 * 1024);

    // Determine the real project ID from the DB.
    type Row = { id: number };
    const projectRow = store.db.query<Row, []>("SELECT id FROM projects LIMIT 1").get();
    const projectId = projectRow?.id ?? 1;

    // --- Run each query -----------------------------------------------------
    const queryResults: QueryResult[] = [];

    for (const query of QUERIES) {
      // Substitute the real project ID into the input.
      const input = substituteProjectId(query.input, projectId);

      const handler = TOOL_MAP[query.tool];
      if (handler === undefined) {
        queryResults.push({
          id: query.id,
          tool: query.tool,
          latencyMs: 0,
          heapDeltaKb: 0,
          responseTokensApprox: 0,
          recall: 0,
          falsePositives: 0,
          passed: false,
          error: `Unknown tool: ${query.tool}`,
        });
        continue;
      }

      const heapBefore = process.memoryUsage().heapUsed;
      const tStart = process.hrtime.bigint();

      let result: unknown;
      let errorMsg: string | undefined;
      try {
        result = await handler(input, store);
      } catch (err) {
        result = null;
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      const tEnd = process.hrtime.bigint();
      const latencyMs = Number(tEnd - tStart) / 1_000_000;
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDeltaKb = (heapAfter - heapBefore) / 1024;

      const responseTokensApprox = approximateTokens(result);

      const { recall, falsePositives, passed } = errorMsg !== undefined
        ? { recall: 0, falsePositives: 0, passed: false }
        : scoreCorrectness(query, result);

      const qr: QueryResult = {
        id: query.id,
        tool: query.tool,
        latencyMs: roundMs(latencyMs),
        heapDeltaKb: Math.round(heapDeltaKb),
        responseTokensApprox,
        recall,
        falsePositives,
        passed,
      };
      if (errorMsg !== undefined) {
        qr.error = errorMsg;
      }
      queryResults.push(qr);
    }

    return {
      indexLatencyMs: roundMs(indexLatencyMs),
      indexNodeCount: indexResult.nodesWritten,
      indexEdgeCount: indexResult.edgesWritten,
      indexPeakHeapMb: Math.round(indexPeakHeapMb * 100) / 100,
      queries: queryResults,
    };
  } finally {
    store.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundMs(ns: number): number {
  return Math.round(ns * 1000) / 1000;
}

// Deep-clone the input object and replace any numeric `project_id` sentinel (1)
// with the real project ID. This avoids mutating QUERIES between bench runs.
function substituteProjectId(
  input: Record<string, unknown>,
  projectId: number,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  if (typeof cloned["project_id"] === "number") {
    cloned["project_id"] = projectId;
  }
  return cloned;
}
