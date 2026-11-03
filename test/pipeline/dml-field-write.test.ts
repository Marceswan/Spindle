// v0.8: DML field-write detection. The Apex parser captures `obj.Field__c = value`
// assignments and emits REFERENCES_FIELD edges resolved via pass2's short-name fallback
// (with SObject-context disambiguation when multiple candidates exist).

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler as getFieldUsageHandler } from "../../src/tools/get-field-usage.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("v0.8 DML field-write detection", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-dml-write-${Date.now()}`);
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

  test("get_field_usage(Customer__c.Email__c) includes DML-write methods", async () => {
    const result = await getFieldUsageHandler(
      { project_id: projectId, field: "Customer__c.Email__c", include_indirect: false },
      store,
    ) as { apex_methods: { qualified_name: string; context: string }[] };

    const qnames = new Set(result.apex_methods.map((m) => m.qualified_name));
    // promoteToGold writes Tier__c (not Email__c), but also SELECTs Email__c — so it's a TP via SOQL_SELECT path.
    expect(qnames.has("CustomerWriter.promoteToGold(Id)")).toBe(true);
    // setEmail does only a DML write to Email__c with no SOQL — only the v0.8 DML-write
    // detector catches it. Parameter-type disambiguation resolves `rec` (Customer__c) -> Email__c.
    expect(qnames.has("CustomerWriter.setEmail(Customer__c, String)")).toBe(true);
  });

  test("get_field_usage(Customer__c.Tier__c) includes DML-write to Tier__c", async () => {
    const result = await getFieldUsageHandler(
      { project_id: projectId, field: "Customer__c.Tier__c", include_indirect: false },
      store,
    ) as { apex_methods: { qualified_name: string; context: string }[] };

    const qnames = new Set(result.apex_methods.map((m) => m.qualified_name));
    // promoteToGold writes Tier__c via `c.Tier__c = 'Gold'`.
    expect(qnames.has("CustomerWriter.promoteToGold(Id)")).toBe(true);
  });

  test("v0.9 constructor-arg field writes resolve directly (no short-name fallback)", async () => {
    const emailResult = await getFieldUsageHandler(
      { project_id: projectId, field: "Customer__c.Email__c", include_indirect: false },
      store,
    ) as { apex_methods: { qualified_name: string; context: string }[] };
    const tierResult = await getFieldUsageHandler(
      { project_id: projectId, field: "Customer__c.Tier__c", include_indirect: false },
      store,
    ) as { apex_methods: { qualified_name: string; context: string }[] };

    const emailQNames = new Set(emailResult.apex_methods.map((m) => m.qualified_name));
    const tierQNames = new Set(tierResult.apex_methods.map((m) => m.qualified_name));

    // makeGoldCustomer constructs `new Customer__c(Email__c = ..., Tier__c = 'Gold')`.
    expect(emailQNames.has("CustomerWriter.makeGoldCustomer(String)")).toBe(true);
    expect(tierQNames.has("CustomerWriter.makeGoldCustomer(String)")).toBe(true);

    // seedBatch constructs Customer__c inside a List<Customer__c> literal — recursion
    // into the nested CreatorContext should catch both inner constructors.
    expect(emailQNames.has("CustomerWriter.seedBatch()")).toBe(true);
    expect(tierQNames.has("CustomerWriter.seedBatch()")).toBe(true);
  });

  test("Constructor-arg edges carry CONSTRUCTOR_ARG context with parentSObject", () => {
    type Row = { properties: string };
    const rows = store.db
      .query<Row, [number]>(
        `SELECT e.properties FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND s.qualified_name = 'CustomerWriter.makeGoldCustomer(String)'
           AND t.qualified_name = 'Customer__c.Email__c'`,
      )
      .all(projectId);
    expect(rows.length).toBeGreaterThan(0);
    const ctorEdges = rows.filter((r) => {
      try {
        const props = JSON.parse(r.properties) as Record<string, unknown>;
        return props["context"] === "CONSTRUCTOR_ARG" && props["parentSObject"] === "Customer__c";
      } catch {
        return false;
      }
    });
    expect(ctorEdges.length).toBeGreaterThan(0);
  });

  test("DML-write edges carry context DML_WRITE in properties", () => {
    type Row = { edge_type: string; properties: string };
    const rows = store.db
      .query<Row, [number]>(
        `SELECT e.edge_type, e.properties
         FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND s.qualified_name = 'CustomerWriter.setEmail(Customer__c, String)'
           AND t.qualified_name = 'Customer__c.Email__c'`,
      )
      .all(projectId);
    expect(rows.length).toBeGreaterThan(0);
    const writeEdges = rows.filter((r) => {
      try {
        const props = JSON.parse(r.properties) as Record<string, unknown>;
        return props["context"] === "DML_WRITE";
      } catch {
        return false;
      }
    });
    expect(writeEdges.length).toBeGreaterThan(0);
  });
});

describe("v0.8 call-graph propagation", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-propagate-${Date.now()}`);
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

  test("propagate=true adds callers of direct-field methods", async () => {
    // Without propagate: just direct hits.
    const direct = await getFieldUsageHandler(
      { project_id: projectId, field: "Customer__c.Email__c", include_indirect: false, propagate: false },
      store,
    ) as { apex_methods: { qualified_name: string }[] };

    // With propagate: should include any callers of CustomerWriter.setEmail.
    const propagated = await getFieldUsageHandler(
      { project_id: projectId, field: "Customer__c.Email__c", include_indirect: false, propagate: true, propagate_depth: 2 },
      store,
    ) as { apex_methods: { qualified_name: string; context: string }[] };

    // Propagated result is a superset (or equal in fixtures with no callers).
    expect(propagated.apex_methods.length).toBeGreaterThanOrEqual(direct.apex_methods.length);
    // Any propagated additions have context starting with CALL_GRAPH.
    const propagatedHits = propagated.apex_methods.filter((m) => m.context.startsWith("CALL_GRAPH"));
    for (const p of propagatedHits) {
      expect(p.context).toMatch(/^CALL_GRAPH\(d\d+\)$/);
    }
  });
});
