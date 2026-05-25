// v0.3: Permission graph. Asserts PermissionSet / Profile / PermissionSetGroup nodes and
// the GRANTS_* edges resolve against existing ApexClass, SObject, Field, VisualforcePage nodes.

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

describe("permission graph pipeline", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-perm-${Date.now()}`);
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

  test("emits PermissionSet nodes for Spindle_Reader and Spindle_Editor", () => {
    expect(findNode(store, projectId, NodeLabel.PermissionSet, "Spindle_Reader")).not.toBeNull();
    expect(findNode(store, projectId, NodeLabel.PermissionSet, "Spindle_Editor")).not.toBeNull();
  });

  test("emits Profile node for Spindle_Test_User with userLicense and custom flag", () => {
    const node = findNode(store, projectId, NodeLabel.Profile, "Spindle_Test_User");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["userLicense"]).toBe("Salesforce");
    expect(props["isCustom"]).toBe(true);
  });

  test("emits PermissionSetGroup node and INCLUDES_PERMSET edges to both members", () => {
    expect(findNode(store, projectId, NodeLabel.PermissionSetGroup, "Spindle_PowerUsers")).not.toBeNull();
    expect(edgeExists(store, projectId, EdgeType.IncludesPermset, "Spindle_PowerUsers", "Spindle_Reader")).toBe(true);
    expect(edgeExists(store, projectId, EdgeType.IncludesPermset, "Spindle_PowerUsers", "Spindle_Editor")).toBe(true);
  });

  test("GRANTS_APEX_ACCESS Spindle_Reader -> AccountService resolved with enabled=true", () => {
    expect(edgeExists(store, projectId, EdgeType.GrantsApexAccess, "Spindle_Reader", "AccountService")).toBe(true);

    type Row = { properties: string };
    const row = store.db
      .query<Row, [number, string]>(
        `SELECT e.properties FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND e.edge_type = ?
           AND s.qualified_name = 'Spindle_Reader'
           AND t.qualified_name = 'AccountService'`,
      )
      .get(projectId, EdgeType.GrantsApexAccess);
    expect(row).not.toBeNull();
    const props = JSON.parse(row!.properties) as { enabled: boolean };
    expect(props.enabled).toBe(true);
  });

  test("GRANTS_OBJECT_ACCESS Spindle_Reader -> Customer__c carries CRUD properties", () => {
    type Row = { properties: string };
    const row = store.db
      .query<Row, [number, string]>(
        `SELECT e.properties FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND e.edge_type = ?
           AND s.qualified_name = 'Spindle_Reader'
           AND t.qualified_name = 'Customer__c'`,
      )
      .get(projectId, EdgeType.GrantsObjectAccess);
    expect(row).not.toBeNull();
    const props = JSON.parse(row!.properties) as Record<string, boolean>;
    expect(props["read"]).toBe(true);
    expect(props["create"]).toBe(false);
    expect(props["edit"]).toBe(false);
  });

  test("GRANTS_FIELD_ACCESS Spindle_Editor -> Customer__c.Email__c has editable=true", () => {
    type Row = { properties: string };
    const row = store.db
      .query<Row, [number, string]>(
        `SELECT e.properties FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND e.edge_type = ?
           AND s.qualified_name = 'Spindle_Editor'
           AND t.qualified_name = 'Customer__c.Email__c'`,
      )
      .get(projectId, EdgeType.GrantsFieldAccess);
    expect(row).not.toBeNull();
    const props = JSON.parse(row!.properties) as Record<string, boolean>;
    expect(props["read"]).toBe(true);
    expect(props["edit"]).toBe(true);
  });

  test("GRANTS_VISUALFORCE_ACCESS Spindle_Reader -> CustomerEditor", () => {
    expect(edgeExists(store, projectId, EdgeType.GrantsVisualforceAccess, "Spindle_Reader", "CustomerEditor")).toBe(true);
  });
});
