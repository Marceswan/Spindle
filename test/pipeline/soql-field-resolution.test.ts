// v0.2 task #15: SOQL SELECT-clause identifiers resolve into REFERENCES_FIELD edges
// when the target Field nodes exist in the graph (i.e., custom objects whose metadata
// we've parsed). Standard objects (Account, Contact) still get only the coarse
// SOQL_QUERIES edge to the SObject node.

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

function edgeExists(
  store: GraphStore,
  projectId: number,
  edgeType: string,
  fromQNameContains: string,
  toQName: string,
): boolean {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, string, string, string]>(
      `SELECT COUNT(*) AS n FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ? AND e.edge_type = ?
         AND s.qualified_name LIKE ?
         AND t.qualified_name = ?`,
    )
    .get(projectId, edgeType, `%${fromQNameContains}%`, toQName);
  return (row?.n ?? 0) > 0;
}

describe("SOQL field-list resolution", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-soql-${Date.now()}`);
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

  test("CustomerLookup.findGoldCustomers -> Customer__c.Email__c REFERENCES_FIELD edge exists", () => {
    expect(edgeExists(store, projectId, EdgeType.ReferencesField, "findGoldCustomers", "Customer__c.Email__c")).toBe(true);
  });

  test("CustomerLookup.findGoldCustomers -> Customer__c.Tier__c REFERENCES_FIELD edge exists", () => {
    expect(edgeExists(store, projectId, EdgeType.ReferencesField, "findGoldCustomers", "Customer__c.Tier__c")).toBe(true);
  });

  test("AccountService.purge does NOT emit REFERENCES_FIELD for Account.Id (no metadata)", () => {
    // Account.Id Field node does not exist — pass2 drops the edge cleanly.
    expect(edgeExists(store, projectId, EdgeType.ReferencesField, "purge", "Account.Id")).toBe(false);
  });

  test("AccountService.purge still keeps the coarse SOQL_QUERIES edge to Account SObject", () => {
    type Row = { n: number };
    const row = store.db
      .query<Row, [number, string]>(
        `SELECT COUNT(*) AS n FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND s.name = 'purge'
           AND t.label = 'SObject'
           AND t.qualified_name = 'Account'
           AND e.edge_type = ?`,
      )
      .get(projectId, EdgeType.SoqlQueries);
    expect(row?.n ?? 0).toBeGreaterThanOrEqual(1);
  });
});
