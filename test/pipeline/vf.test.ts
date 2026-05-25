// v0.2: Visualforce pipeline. Asserts VisualforcePage nodes, VF_USES_APEX to controller +
// extensions, and VF_USES_FIELD edges from {!Object.Field} bindings.

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

function edgeExists(
  store: GraphStore,
  projectId: number,
  edgeType: string,
  fromQName: string,
  toQName: string,
): boolean {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, string, string, string]>(
      `SELECT COUNT(*) AS n FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ? AND e.edge_type = ?
         AND s.qualified_name = ? AND t.qualified_name = ?`,
    )
    .get(projectId, edgeType, fromQName, toQName);
  return (row?.n ?? 0) > 0;
}

describe("Visualforce pipeline", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-vf-${Date.now()}`);
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

  test("emits VisualforcePage node for CustomerEditor", () => {
    const node = findNode(store, projectId, NodeLabel.VisualforcePage, "CustomerEditor");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["rootTag"]).toContain("page");
    expect(props["controller"]).toBe("AccountService");
    expect(props["extensions"]).toBe("Orchestrator");
  });

  test("emits VF_USES_APEX edge CustomerEditor -> AccountService (controller)", () => {
    expect(edgeExists(store, projectId, EdgeType.VfUsesApex, "CustomerEditor", "AccountService")).toBe(true);
  });

  test("emits VF_USES_APEX edge CustomerEditor -> Orchestrator (extensions)", () => {
    expect(edgeExists(store, projectId, EdgeType.VfUsesApex, "CustomerEditor", "Orchestrator")).toBe(true);
  });

  test("emits VF_USES_FIELD edges CustomerEditor -> Customer__c.Email__c and Tier__c", () => {
    expect(edgeExists(store, projectId, EdgeType.VfUsesField, "CustomerEditor", "Customer__c.Email__c")).toBe(true);
    expect(edgeExists(store, projectId, EdgeType.VfUsesField, "CustomerEditor", "Customer__c.Tier__c")).toBe(true);
  });
});
