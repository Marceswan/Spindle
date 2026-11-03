// v0.6: uiBundle pipeline. Asserts the agentConsole fixture produces UiBundle/TsModule/
// TsFunction/ReactComponent nodes, intra-bundle TS_IMPORTS / TS_CALLS / TS_RENDERS edges,
// and cross-domain UI_BUNDLE_USES_APEX / UI_BUNDLE_USES_FIELD edges into the existing
// Apex / Field graph. Also verifies node_modules + dist are skipped.

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

type NodeRow = {
  id: number;
  name: string;
  qualified_name: string;
  properties: string;
};

function findNode(
  store: GraphStore,
  projectId: number,
  label: string,
  qname: string,
): NodeRow | null {
  return store.db
    .query<NodeRow, [number, string, string]>(
      "SELECT id, name, qualified_name, properties FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
    )
    .get(projectId, label, qname);
}

function findNodes(store: GraphStore, projectId: number, label: string): NodeRow[] {
  return store.db
    .query<NodeRow, [number, string]>(
      "SELECT id, name, qualified_name, properties FROM nodes WHERE project_id = ? AND label = ?",
    )
    .all(projectId, label);
}

function countEdgesByType(store: GraphStore, projectId: number, edgeType: string): number {
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
  fromQNameLike: string,
  toQNameLike: string,
): boolean {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, string, string, string]>(
      `SELECT COUNT(*) AS n FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ? AND e.edge_type = ?
         AND s.qualified_name LIKE ?
         AND t.qualified_name LIKE ?`,
    )
    .get(projectId, edgeType, `%${fromQNameLike}%`, `%${toQNameLike}%`);
  return (row?.n ?? 0) > 0;
}

describe("uiBundle pipeline (v0.6)", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-uibundle-${Date.now()}`);
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

  test("emits UiBundle node for agentConsole", () => {
    const node = findNode(store, projectId, NodeLabel.UiBundle, "uiBundle:agentConsole");
    expect(node).not.toBeNull();
  });

  test("emits TsModule node for src/app.tsx", () => {
    const node = findNode(
      store,
      projectId,
      NodeLabel.TsModule,
      "uiBundle:agentConsole:src/app.tsx",
    );
    expect(node).not.toBeNull();
  });

  test("emits TsModule nodes for all src files", () => {
    const modules = findNodes(store, projectId, NodeLabel.TsModule);
    const qnames = new Set(modules.map((m) => m.qualified_name));
    expect(qnames.has("uiBundle:agentConsole:src/app.tsx")).toBe(true);
    expect(qnames.has("uiBundle:agentConsole:src/pages/Home.tsx")).toBe(true);
    expect(qnames.has("uiBundle:agentConsole:src/components/Card.tsx")).toBe(true);
    expect(qnames.has("uiBundle:agentConsole:src/lib/utils.ts")).toBe(true);
    expect(qnames.has("uiBundle:agentConsole:src/hooks/useFetch.ts")).toBe(true);
  });

  test("skips node_modules and dist (no TsModule for poison-pill files)", () => {
    const modules = findNodes(store, projectId, NodeLabel.TsModule);
    for (const m of modules) {
      expect(m.qualified_name).not.toContain("node_modules");
      expect(m.qualified_name).not.toContain("/dist/");
    }
  });

  test("emits ReactComponent label for JSX-returning functions", () => {
    const components = findNodes(store, projectId, NodeLabel.ReactComponent);
    const names = new Set(components.map((c) => c.name));
    expect(names.has("App")).toBe(true);
    expect(names.has("HomePage")).toBe(true);
    expect(names.has("Card")).toBe(true);
  });

  test("emits TsFunction label for non-JSX exports", () => {
    const fns = findNodes(store, projectId, NodeLabel.TsFunction);
    const names = new Set(fns.map((f) => f.name));
    expect(names.has("cn")).toBe(true);
    expect(names.has("useFetch")).toBe(true);
  });

  test("emits TS_IMPORTS edges for intra-bundle imports (alias + relative)", () => {
    // app.tsx -> @/pages/Home (alias-resolved) and ./components/Card (relative)
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.TsImports,
        "uiBundle:agentConsole:src/app.tsx",
        "src/pages/Home.tsx::HomePage",
      ),
    ).toBe(true);
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.TsImports,
        "uiBundle:agentConsole:src/app.tsx",
        "src/components/Card.tsx::Card",
      ),
    ).toBe(true);
  });

  test("emits TS_RENDERS edges for JSX component usage", () => {
    // HomePage renders <Card>
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.TsRenders,
        "src/pages/Home.tsx::HomePage",
        "src/components/Card.tsx::Card",
      ),
    ).toBe(true);
    // App renders <HomePage>
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.TsRenders,
        "src/app.tsx::App",
        "src/pages/Home.tsx::HomePage",
      ),
    ).toBe(true);
  });

  test("emits TS_CALLS edge for useFetch() hook invocation in HomePage", () => {
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.TsCalls,
        "src/pages/Home.tsx::HomePage",
        "src/hooks/useFetch.ts::useFetch",
      ),
    ).toBe(true);
  });

  test("cross-domain: UI_BUNDLE_USES_APEX resolves to existing ApexMethod node", () => {
    // @salesforce/apex/AccountService.cleanup -> AccountService.cleanup (existing in fixture)
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.UiBundleUsesApex,
        "uiBundle:agentConsole:src/pages/Home.tsx",
        "AccountService.cleanup",
      ),
    ).toBe(true);
  });

  test("cross-domain: UI_BUNDLE_USES_FIELD resolves to existing Field node", () => {
    // @salesforce/schema/Customer__c.Email__c -> Customer__c.Email__c (existing field)
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.UiBundleUsesField,
        "uiBundle:agentConsole:src/pages/Home.tsx",
        "Customer__c.Email__c",
      ),
    ).toBe(true);
  });

  test("external npm package emits ExternalNamespace + DEPENDS_ON_EXTERNAL", () => {
    const ext = findNode(store, projectId, NodeLabel.ExternalNamespace, "react");
    expect(ext).not.toBeNull();
    expect(
      edgeExists(
        store,
        projectId,
        EdgeType.DependsOnExternal,
        "uiBundle:agentConsole:src/hooks/useFetch.ts",
        "react",
      ),
    ).toBe(true);
  });

  test("at least one edge of each new uiBundle type was emitted", () => {
    expect(countEdgesByType(store, projectId, EdgeType.TsImports)).toBeGreaterThan(0);
    expect(countEdgesByType(store, projectId, EdgeType.TsCalls)).toBeGreaterThan(0);
    expect(countEdgesByType(store, projectId, EdgeType.TsRenders)).toBeGreaterThan(0);
    expect(countEdgesByType(store, projectId, EdgeType.UiBundleUsesApex)).toBeGreaterThan(0);
    expect(countEdgesByType(store, projectId, EdgeType.UiBundleUsesField)).toBeGreaterThan(0);
  });
});
