// v0.3: CustomLabel parser. Asserts CustomLabel nodes parse with `c.<fullName>` qnames
// (matching the LWC/VF import convention) and that the previously-dropped LWC_USES_LABEL
// edge to c.Greeting now resolves.

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { EdgeType } from "../../src/model/edge-types.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("CustomLabel parser", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-labels-${Date.now()}`);
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

  test("emits CustomLabel nodes with c.<fullName> qnames", () => {
    type Row = { id: number; properties: string };
    const greeting = store.db
      .query<Row, [number, string, string]>(
        "SELECT id, properties FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
      )
      .get(projectId, NodeLabel.CustomLabel, "c.Greeting");
    const farewell = store.db
      .query<Row, [number, string, string]>(
        "SELECT id, properties FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
      )
      .get(projectId, NodeLabel.CustomLabel, "c.FarewellMessage");

    expect(greeting).not.toBeNull();
    expect(farewell).not.toBeNull();

    const props = JSON.parse(greeting!.properties) as Record<string, unknown>;
    expect(props["value"]).toBe("Welcome, Customer");
    expect(props["language"]).toBe("en_US");
    expect(props["protected"]).toBe(false);
  });

  test("LWC_USES_LABEL edge from customerCard -> c.Greeting now resolves", () => {
    type Row = { n: number };
    const row = store.db
      .query<Row, [number, string]>(
        `SELECT COUNT(*) AS n FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND e.edge_type = ?
           AND s.qualified_name = 'c/customerCard'
           AND t.qualified_name = 'c.Greeting'`,
      )
      .get(projectId, EdgeType.LwcUsesLabel);
    expect(row?.n ?? 0).toBe(1);
  });
});
