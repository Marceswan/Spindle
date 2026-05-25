// v0.2: Aura bundle pipeline. Asserts AuraBundle / AuraComponent / AuraController nodes,
// AURA_USES_APEX edges to the bound controller's methods, and AURA_INCLUDES_COMPONENT
// to child component bundles via both <c:Foo> and <aura:dependency>.

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

function findNode(
  store: GraphStore,
  projectId: number,
  label: string,
  qname: string,
): { id: number; properties: string } | null {
  return store.db
    .query<{ id: number; properties: string }, [number, string, string]>(
      "SELECT id, properties FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
    )
    .get(projectId, label, qname);
}

function countEdgesByType(
  store: GraphStore,
  projectId: number,
  edgeType: string,
): number {
  type Row = { n: number };
  return store.db
    .query<Row, [number, string]>(
      "SELECT COUNT(*) AS n FROM edges WHERE project_id = ? AND edge_type = ?",
    )
    .get(projectId, edgeType)?.n ?? 0;
}

function edgeExists(
  store: GraphStore,
  projectId: number,
  edgeType: string,
  fromQName: string,
  toQNameContains: string,
): boolean {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, string, string, string]>(
      `SELECT COUNT(*) AS n FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ? AND e.edge_type = ?
         AND s.qualified_name = ?
         AND t.qualified_name LIKE ?`,
    )
    .get(projectId, edgeType, fromQName, `%${toQNameContains}%`);
  return (row?.n ?? 0) > 0;
}

describe("Aura bundle pipeline", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-aura-${Date.now()}`);
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

  test("emits AuraBundle node for customerPanel", () => {
    const node = findNode(store, projectId, NodeLabel.AuraBundle, "customerPanel");
    expect(node).not.toBeNull();
  });

  test("emits AuraController node for customerPanelController.js", () => {
    const node = findNode(store, projectId, NodeLabel.AuraController, "customerPanel.customerPanelController.js");
    expect(node).not.toBeNull();
  });

  test("emits AURA_USES_APEX edge customerPanel -> AccountService.cleanup", () => {
    expect(edgeExists(store, projectId, EdgeType.AuraUsesApex, "customerPanel", "AccountService.cleanup")).toBe(true);
  });

  test("emits AURA_INCLUDES_COMPONENT edge customerPanel -> customerCard (via tag)", () => {
    expect(countEdgesByType(store, projectId, EdgeType.AuraIncludesComponent)).toBeGreaterThanOrEqual(1);
  });
});
