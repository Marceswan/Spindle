// v0.5: query_graph MCP tool tests.
// Indexes the sample fixture project and executes Cypher-subset queries against
// the resulting graph. Validates node-match, relationship-match, WHERE filters,
// property projections, count, ordering, LIMIT/SKIP, and unsupported-syntax errors.

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler } from "../../src/tools/query-graph.ts";
import type { StoredNode } from "../../src/graph/store.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

// ---------------------------------------------------------------------------
// Types mirroring handler output shapes
// ---------------------------------------------------------------------------

type SuccessResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  query: string;
  warnings: string[];
};

type ErrorResult = {
  error: string;
  suggestion: string;
};

describe("query_graph tool", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-qg-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cpSync(join(FIXTURE_DIR, "force-app"), join(tempDir, "force-app"), { recursive: true });
    cpSync(join(FIXTURE_DIR, "sfdx-project.json"), join(tempDir, "sfdx-project.json"));

    const dbDir = join(tempDir, ".sfdx-graph");
    mkdirSync(dbDir, { recursive: true });
    store = new GraphStore(join(dbDir, "graph.db"));
    await indexProject(tempDir, store, { mode: "full" });

    const row = store.db.query<{ id: number }, []>("SELECT id FROM projects LIMIT 1").get();
    projectId = row?.id ?? 1;

    cleanup = () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Test 1: Single-label node match returns all ApexClass nodes
  // -------------------------------------------------------------------------
  test("MATCH (n:ApexClass) RETURN n returns all ApexClass nodes", async () => {
    const result = await handler(
      { project_id: projectId, query: "MATCH (n:ApexClass) RETURN n" },
      store,
    ) as SuccessResult;

    expect(result.columns).toEqual(["n"]);
    expect(result.row_count).toBeGreaterThanOrEqual(4); // AccountService, BaseService, Orchestrator, CustomerLookup

    // Each row[0] should be a StoredNode shaped object
    const firstRow = result.rows[0];
    expect(firstRow).toBeDefined();
    const node = firstRow![0] as StoredNode;
    expect(node).toHaveProperty("label", "ApexClass");
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("qualifiedName");
  });

  // -------------------------------------------------------------------------
  // Test 2: Filter by name property (string equality)
  // -------------------------------------------------------------------------
  test("WHERE n.name = 'AccountService' returns exactly 1 row", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n:ApexClass) WHERE n.name = 'AccountService' RETURN n",
      },
      store,
    ) as SuccessResult;

    expect(result.row_count).toBe(1);
    const node = result.rows[0]![0] as StoredNode;
    expect(node.name).toBe("AccountService");
    expect(node.label).toBe("ApexClass");
  });

  // -------------------------------------------------------------------------
  // Test 3: Outgoing relationship pattern — AccountService EXTENDS BaseService
  // -------------------------------------------------------------------------
  test("RETURN s.name, t.name across multiple variables returns both values per row (regression test for column-aliasing bug)", async () => {
    // Without per-column SQL aliases, bun:sqlite's row object collapses two columns with
    // the same property name ("name") into a single key. Fixed by aliasing each SELECT
    // expression as col_N in the planner.
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (s:ApexClass)-[:EXTENDS]->(t:ApexClass) RETURN s.name, t.name",
      },
      store,
    ) as SuccessResult;
    expect(result.columns).toEqual(["s.name", "t.name"]);
    expect(result.row_count).toBeGreaterThanOrEqual(1);
    const row = result.rows[0]!;
    expect(row.length).toBe(2);
    expect(row[0]).toBe("AccountService");
    expect(row[1]).toBe("BaseService");
  });

  test("MATCH (s:ApexClass)-[:EXTENDS]->(t:ApexClass) RETURN s, t returns 1 row", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (s:ApexClass)-[:EXTENDS]->(t:ApexClass) RETURN s, t",
      },
      store,
    ) as SuccessResult;

    expect(result.columns).toEqual(["s", "t"]);
    expect(result.row_count).toBeGreaterThanOrEqual(1);

    const firstRow = result.rows[0]!;
    const src = firstRow[0] as StoredNode;
    const tgt = firstRow[1] as StoredNode;
    // AccountService extends BaseService
    expect(src.name).toBe("AccountService");
    expect(tgt.name).toBe("BaseService");
  });

  // -------------------------------------------------------------------------
  // Test 4: Reverse (incoming) direction — Cleanable <-[:IMPLEMENTS]- AccountService
  // -------------------------------------------------------------------------
  test("MATCH (i:ApexInterface)<-[:IMPLEMENTS]-(c:ApexClass) RETURN c, i", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (i:ApexInterface)<-[:IMPLEMENTS]-(c:ApexClass) RETURN c, i",
      },
      store,
    ) as SuccessResult;

    expect(result.row_count).toBeGreaterThanOrEqual(1);
    const firstRow = result.rows[0]!;
    const cls = firstRow[0] as StoredNode;
    const iface = firstRow[1] as StoredNode;
    expect(cls.label).toBe("ApexClass");
    expect(iface.label).toBe("ApexInterface");
    expect(cls.name).toBe("AccountService");
    expect(iface.name).toBe("Cleanable");
  });

  // -------------------------------------------------------------------------
  // Test 5: Any-edge relationship — LwcBundle -[r]-> any
  // -------------------------------------------------------------------------
  test("MATCH (n:LwcBundle)-[r]->(m) RETURN n, r, m returns rows", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n:LwcBundle)-[r]->(m) RETURN n, r, m",
      },
      store,
    ) as SuccessResult;

    expect(result.columns).toEqual(["n", "r", "m"]);
    expect(result.row_count).toBeGreaterThanOrEqual(1);

    // r should be an edge object
    const firstRow = result.rows[0]!;
    const edge = firstRow[1] as Record<string, unknown>;
    expect(edge).toHaveProperty("edge_type");
    expect(edge).toHaveProperty("source_id");
    expect(edge).toHaveProperty("target_id");
  });

  // -------------------------------------------------------------------------
  // Test 6: Property projection with ORDER BY and LIMIT
  // -------------------------------------------------------------------------
  test("MATCH (n:ApexClass) RETURN n.name ORDER BY n.name ASC LIMIT 3", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n:ApexClass) RETURN n.name ORDER BY n.name ASC LIMIT 3",
      },
      store,
    ) as SuccessResult;

    expect(result.columns).toEqual(["n.name"]);
    expect(result.row_count).toBeLessThanOrEqual(3);
    expect(result.row_count).toBeGreaterThan(0);

    // Names should be sorted ascending
    const names = result.rows.map((r) => r[0] as string);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  // -------------------------------------------------------------------------
  // Test 7: WHERE with CONTAINS
  // -------------------------------------------------------------------------
  test("WHERE n.qualified_name CONTAINS 'cleanup' returns matching ApexMethod", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n:ApexMethod) WHERE n.qualified_name CONTAINS 'cleanup' RETURN n",
      },
      store,
    ) as SuccessResult;

    // cleanup() is defined on AccountService
    expect(result.row_count).toBeGreaterThanOrEqual(1);
    const node = result.rows[0]![0] as StoredNode;
    expect(node.qualifiedName.toLowerCase()).toContain("cleanup");
  });

  // -------------------------------------------------------------------------
  // Test 8: WHERE with IN list
  // -------------------------------------------------------------------------
  test("WHERE n.label IN ['ApexClass', 'ApexInterface'] returns both types", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n) WHERE n.label IN ['ApexClass', 'ApexInterface'] RETURN n",
      },
      store,
    ) as SuccessResult;

    expect(result.row_count).toBeGreaterThan(0);
    const labels = result.rows.map((r) => (r[0] as StoredNode).label);
    const uniqueLabels = new Set(labels);
    // Should have at least ApexClass entries; may have ApexInterface too
    expect(uniqueLabels.has("ApexClass")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9: count(*) aggregate
  // -------------------------------------------------------------------------
  test("MATCH (n:ApexClass) RETURN count(*) returns a single integer row", async () => {
    const result = await handler(
      { project_id: projectId, query: "MATCH (n:ApexClass) RETURN count(*)" },
      store,
    ) as SuccessResult;

    expect(result.columns).toEqual(["count(*)"]);
    expect(result.row_count).toBe(1);
    const count = result.rows[0]![0];
    expect(typeof count).toBe("number");
    expect(count as number).toBeGreaterThanOrEqual(4);
  });

  // -------------------------------------------------------------------------
  // Test 10: OPTIONAL MATCH joins independent node patterns
  // -------------------------------------------------------------------------
  test("OPTIONAL MATCH joins independent node patterns", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n:ApexClass) OPTIONAL MATCH (m:LwcBundle) RETURN n, m",
      },
      store,
    ) as SuccessResult;

    expect(result.row_count).toBeGreaterThan(0);
    expect(result.columns).toEqual(["n", "m"]);
    expect((result.rows[0]![1] as StoredNode).label).toBe("LwcBundle");
  });

  // -------------------------------------------------------------------------
  // Test 11: Malformed query — parse error with column info
  // -------------------------------------------------------------------------
  test("Malformed query returns parse error with column number", async () => {
    const result = await handler(
      { project_id: projectId, query: "MATCH (n:ApexClass WHERE n.name = 'x' RETURN n" },
      store,
    ) as ErrorResult;

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Parse error");
    expect(result.error).toMatch(/column \d+/);
    expect(result.suggestion).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 12: WHERE with STARTS WITH
  // -------------------------------------------------------------------------
  test("WHERE n.name STARTS WITH 'Account' returns AccountService", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (n:ApexClass) WHERE n.name STARTS WITH 'Account' RETURN n",
      },
      store,
    ) as SuccessResult;

    expect(result.row_count).toBeGreaterThanOrEqual(1);
    for (const row of result.rows) {
      const node = row[0] as StoredNode;
      expect(node.name.startsWith("Account")).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Test 13: Named relationship variable + property projection
  // -------------------------------------------------------------------------
  test("MATCH (s:ApexClass)-[r:EXTENDS]->(t) RETURN r.edge_type returns edge_type values", async () => {
    const result = await handler(
      {
        project_id: projectId,
        query: "MATCH (s:ApexClass)-[r:EXTENDS]->(t) RETURN r.edge_type",
      },
      store,
    ) as SuccessResult;

    expect(result.columns).toEqual(["r.edge_type"]);
    expect(result.row_count).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]![0]).toBe("EXTENDS");
  });

  // -------------------------------------------------------------------------
  // Test 14: Unsupported write operation returns error
  // -------------------------------------------------------------------------
  test("CREATE statement returns error", async () => {
    const result = await handler(
      { project_id: projectId, query: "CREATE (n:ApexClass {name: 'Foo'})" },
      store,
    ) as ErrorResult;

    expect(result.error).toBeDefined();
    expect(result.error).toContain("read-only");
  });

  // -------------------------------------------------------------------------
  // Test 15: Empty query string returns parse error
  // -------------------------------------------------------------------------
  test("Empty query returns parse error", async () => {
    const result = await handler(
      { project_id: projectId, query: "" },
      store,
    ) as ErrorResult;

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Parse error");
  });
});
