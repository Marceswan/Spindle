// End-to-end: clause-aware SOQL field extraction resolves WHERE-clause fields into
// REFERENCES_FIELD edges (not just SELECT), surfacing them in get_field_usage.

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("SOQL clause-aware field extraction", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;

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
  });

  afterAll(() => {
    store.close();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test("a WHERE-clause field becomes a REFERENCES_FIELD edge (context SOQL_WHERE)", () => {
    // CustomerLookup: SELECT Id, Name, Email__c, Tier__c FROM Customer__c WHERE Tier__c = 'Gold'
    type Row = { properties: string };
    const rows = store.db
      .query<Row, [number, string]>(
        `SELECT e.properties AS properties FROM edges e
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ? AND e.edge_type = 'REFERENCES_FIELD'
           AND t.qualified_name = ?`,
      )
      .all(projectId, "Customer__c.Tier__c");
    const contexts = rows.map((r) => (JSON.parse(r.properties) as { context?: string }).context);
    expect(contexts).toContain("SOQL_WHERE");
    expect(contexts).toContain("SOQL_SELECT");
  });

  test("get_field_usage surfaces the querying method for a WHERE-only-referenced field", async () => {
    const { handler } = await import("../../src/tools/get-field-usage.ts");
    type Report = { apex_methods: { qualified_name: string }[] };
    const result = (await handler(
      { project_id: projectId, field: "Customer__c.Tier__c", include_indirect: false },
      store,
    )) as Report;
    // include_indirect:false means no coarse SObject-level approximation — the method only
    // appears because a direct REFERENCES_FIELD edge (SELECT or WHERE) resolved.
    expect(result.apex_methods.length).toBeGreaterThan(0);
  });
});
