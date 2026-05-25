// v0.3: FlexiPage + Layout parsers. Asserts nodes and field-edge resolution land for both.

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

describe("FlexiPage + Layout pipeline", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-fpl-${Date.now()}`);
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

  test("emits FlexiPage node for Customer_Record_Page with sobjectType property", () => {
    const node = findNode(store, projectId, NodeLabel.FlexiPage, "Customer_Record_Page");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["type"]).toBe("RecordPage");
    expect(props["sobjectType"]).toBe("Customer__c");
  });

  test("FLEXIPAGE_INCLUDES_COMPONENT customerRecordPage -> c/customerCard (LWC)", () => {
    expect(edgeExists(store, projectId, EdgeType.FlexipageIncludesComponent, "Customer_Record_Page", "c/customerCard")).toBe(true);
  });

  test("FLEXIPAGE_REFERENCES_FIELD Customer_Record_Page -> Customer__c.Email__c (via fieldInstance)", () => {
    expect(edgeExists(store, projectId, EdgeType.FlexipageReferencesField, "Customer_Record_Page", "Customer__c.Email__c")).toBe(true);
    expect(edgeExists(store, projectId, EdgeType.FlexipageReferencesField, "Customer_Record_Page", "Customer__c.Tier__c")).toBe(true);
  });

  test("emits Layout node with parentSObject parsed from filename", () => {
    const node = findNode(store, projectId, NodeLabel.Layout, "Customer__c-Customer Layout");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["parentSObject"]).toBe("Customer__c");
  });

  test("LAYOUT_INCLUDES_FIELD Customer__c-Customer Layout -> Customer__c.Email__c and Tier__c", () => {
    expect(edgeExists(store, projectId, EdgeType.LayoutIncludesField, "Customer__c-Customer Layout", "Customer__c.Email__c")).toBe(true);
    expect(edgeExists(store, projectId, EdgeType.LayoutIncludesField, "Customer__c-Customer Layout", "Customer__c.Tier__c")).toBe(true);
  });

  test("emptySpace layoutItems do not produce edges", () => {
    // Sanity: total LAYOUT_INCLUDES_FIELD edges from the Customer layout = 2 (Email, Tier)
    // — Name field is a standard field with no metadata so the edge drops; emptySpace is skipped.
    type Row = { n: number };
    const row = store.db
      .query<Row, [number, string]>(
        `SELECT COUNT(*) AS n FROM edges e
         JOIN nodes s ON s.id = e.source_id
         WHERE e.project_id = ?
           AND e.edge_type = ?
           AND s.qualified_name = 'Customer__c-Customer Layout'`,
      )
      .get(projectId, EdgeType.LayoutIncludesField);
    expect(row?.n ?? 0).toBe(2);
  });
});
