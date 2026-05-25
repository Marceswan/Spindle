import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { EdgeType } from "../../src/model/edge-types.ts";
import { handler } from "../../src/tools/trace-references.ts";
import type { StoredNode } from "../../src/graph/store.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("trace_references tool", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanupQName: string | null = null;
  let runQName: string | null = null;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-tr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cpSync(FIXTURE_DIR, tempDir, { recursive: true });
    const dbDir = join(tempDir, ".sfdx-graph");
    mkdirSync(dbDir, { recursive: true });
    store = new GraphStore(join(dbDir, "graph.db"));
    await indexProject(tempDir, store, { mode: "full" });

    type Row = { id: number };
    const row = store.db.query<Row, []>("SELECT id FROM projects LIMIT 1").get();
    projectId = row?.id ?? 1;

    type QRow = { qualified_name: string };
    const cleanupRow = store.db
      .query<QRow, [number, string]>(
        "SELECT qualified_name FROM nodes WHERE project_id = ? AND name = ? LIMIT 1",
      )
      .get(projectId, "cleanup");
    cleanupQName = cleanupRow?.qualified_name ?? null;

    const runRow = store.db
      .query<QRow, [number, string]>(
        "SELECT qualified_name FROM nodes WHERE project_id = ? AND name = ? LIMIT 1",
      )
      .get(projectId, "run");
    runQName = runRow?.qualified_name ?? null;

    cleanup = () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  test("traces inbound CALLS from AccountService.cleanup() — Orchestrator.run() appears", async () => {
    expect(cleanupQName).not.toBeNull();

    const result = await handler(
      {
        project_id: projectId,
        start: { qualified_name: cleanupQName! },
        direction: "inbound",
        edge_types: [EdgeType.Calls],
        depth: 1,
      },
      store,
    ) as { nodes: StoredNode[]; edges: unknown[] };

    const nodeNames = result.nodes.map((n) => n.name);
    expect(nodeNames).toContain("run");
  });

  test("traces outbound from Orchestrator.run() — AccountService.cleanup() reachable", async () => {
    expect(runQName).not.toBeNull();

    const result = await handler(
      {
        project_id: projectId,
        start: { qualified_name: runQName! },
        direction: "outbound",
        edge_types: [EdgeType.Calls],
        depth: 1,
      },
      store,
    ) as { nodes: StoredNode[]; edges: unknown[] };

    const nodeNames = result.nodes.map((n) => n.name);
    expect(nodeNames).toContain("cleanup");
  });
});
