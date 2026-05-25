import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { handler } from "../../src/tools/search-graph.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("search_graph tool", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-sg-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cpSync(FIXTURE_DIR, tempDir, { recursive: true });
    const dbDir = join(tempDir, ".sfdx-graph");
    mkdirSync(dbDir, { recursive: true });
    store = new GraphStore(join(dbDir, "graph.db"));
    await indexProject(tempDir, store, { mode: "full" });

    type Row = { id: number };
    const row = store.db.query<Row, []>("SELECT id FROM projects LIMIT 1").get();
    projectId = row?.id ?? 1;

    cleanup = () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  test("finds exactly one ApexMethod named 'cleanup'", async () => {
    const result = await handler(
      { project_id: projectId, label: NodeLabel.ApexMethod, name_pattern: "^cleanup$" },
      store,
    ) as { nodes: unknown[]; count: number };

    expect(result.count).toBe(1);
    const node = result.nodes[0] as { name: string; qualifiedName: string };
    expect(node.name).toBe("cleanup");
    expect(node.qualifiedName).toContain("AccountService");
  });

  test("finds ApexClass nodes matching 'Service' pattern", async () => {
    const result = await handler(
      { project_id: projectId, label: NodeLabel.ApexClass, name_pattern: "Service" },
      store,
    ) as { nodes: unknown[]; count: number };

    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  test("returns empty when no match", async () => {
    const result = await handler(
      { project_id: projectId, label: NodeLabel.ApexClass, name_pattern: "^NoSuchClass$" },
      store,
    ) as { nodes: unknown[]; count: number };

    expect(result.count).toBe(0);
  });
});
