// v0.2: object metadata XML pipeline. Asserts SObject, Field, ValidationRule nodes are
// emitted alongside Apex nodes for the same project, and that placeholder SObjects from
// SOQL-derived Apex edges (e.g., Account) coexist with real metadata-parsed SObjects
// (e.g., Customer__c).

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

describe("metadata-xml pipeline", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-mx-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    // Skip the polluting .sfdx/ subtree if present.
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

  test("emits real SObject node for Customer__c", () => {
    const node = findNode(store, projectId, NodeLabel.SObject, "Customer__c");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["label"]).toBe("Customer");
    expect(props["isCustom"]).toBe(true);
    expect(props["isPlaceholder"]).toBe(false);
    expect(props["sharingModel"]).toBe("ReadWrite");
  });

  test("keeps Account as placeholder SObject (no metadata file)", () => {
    const node = findNode(store, projectId, NodeLabel.SObject, "Account");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["isPlaceholder"]).toBe(true);
  });

  test("emits Email__c Field node with correct type and required flag", () => {
    const node = findNode(store, projectId, NodeLabel.Field, "Customer__c.Email__c");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["type"]).toBe("Email");
    expect(props["required"]).toBe(true);
    expect(props["unique"]).toBe(true);
    expect(props["parentSObject"]).toBe("Customer__c");
  });

  test("emits Tier__c Field node with picklist values", () => {
    const node = findNode(store, projectId, NodeLabel.Field, "Customer__c.Tier__c");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["type"]).toBe("Picklist");
    expect(props["picklistValues"]).toEqual(["Bronze", "Silver", "Gold"]);
  });

  test("emits ValidationRule node for Email_Required", () => {
    const node = findNode(store, projectId, NodeLabel.ValidationRule, "Customer__c.Email_Required");
    expect(node).not.toBeNull();
    const props = JSON.parse(node!.properties) as Record<string, unknown>;
    expect(props["active"]).toBe(true);
    expect(props["errorDisplayField"]).toBe("Email__c");
  });

  test("emits VALIDATION_REFERENCES_FIELD edges from Email_Required to Customer__c.Tier__c and Email__c", () => {
    const rule = findNode(store, projectId, NodeLabel.ValidationRule, "Customer__c.Email_Required");
    const tier = findNode(store, projectId, NodeLabel.Field, "Customer__c.Tier__c");
    const email = findNode(store, projectId, NodeLabel.Field, "Customer__c.Email__c");
    expect(rule).not.toBeNull();
    expect(tier).not.toBeNull();
    expect(email).not.toBeNull();

    type EdgeRow = { n: number };
    const tierEdge = store.db
      .query<EdgeRow, [number, number, string]>(
        "SELECT COUNT(*) AS n FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?",
      )
      .get(rule!.id, tier!.id, EdgeType.ValidationReferencesField);
    const emailEdge = store.db
      .query<EdgeRow, [number, number, string]>(
        "SELECT COUNT(*) AS n FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?",
      )
      .get(rule!.id, email!.id, EdgeType.ValidationReferencesField);
    expect(tierEdge?.n ?? 0).toBe(1);
    expect(emailEdge?.n ?? 0).toBe(1);
  });
});
