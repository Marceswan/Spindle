// v0.2 headline tool. Indexes the full sample fixture and queries usages of
// Customer__c.Email__c, asserting that LWC, VF, and validation-rule references all appear.

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler } from "../../src/tools/get-field-usage.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

type FieldUsageReport = {
  field: string;
  parent_sobject: string | null;
  apex_methods: { qualified_name: string }[];
  lwc_bundles: { qualified_name: string }[];
  vf_pages: { qualified_name: string }[];
  vf_components: { qualified_name: string }[];
  validation_rules: { qualified_name: string }[];
  formula_fields: { qualified_name: string }[];
  aura_components: { qualified_name: string }[];
  flows: { qualified_name: string }[];
  layouts: { qualified_name: string }[];
  permission_sets: { qualified_name: string }[];
  email_templates: { qualified_name: string }[];
  coverage: { authoritative: string[]; indirect: string[]; pending: string[] };
};

describe("get_field_usage tool", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-gfu-${Date.now()}`);
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

  test("Customer__c.Email__c is found in LWC, VF, and validation rules", async () => {
    const result = await handler(
      { project_id: projectId, field: "Customer__c.Email__c" },
      store,
    ) as FieldUsageReport;

    expect(result.field).toBe("Customer__c.Email__c");
    expect(result.parent_sobject).toBe("Customer__c");

    // LWC: customerCard imports Customer__c.Email__c via @salesforce/schema
    expect(result.lwc_bundles.some((u) => u.qualified_name === "c/customerCard")).toBe(true);

    // VF: CustomerEditor binds {!Customer__c.Email__c}
    expect(result.vf_pages.some((u) => u.qualified_name === "CustomerEditor")).toBe(true);

    // Validation rule: Email_Required formula references Email__c
    expect(result.validation_rules.some((u) => u.qualified_name === "Customer__c.Email_Required")).toBe(true);
  });

  test("returns coverage metadata listing what's authoritative vs pending", async () => {
    const result = await handler(
      { project_id: projectId, field: "Customer__c.Email__c" },
      store,
    ) as FieldUsageReport;

    expect(result.coverage.authoritative).toContain("lwc_bundles");
    expect(result.coverage.authoritative).toContain("vf_pages");
    expect(result.coverage.authoritative).toContain("validation_rules");
    // flows graduated from "pending" to "indirect" once the Flow parser landed.
    expect(result.coverage.indirect).toContain("flows");
    expect(result.coverage.pending).toContain("aura_components");
  });

  test("Account.Id (indirect via SOQL) surfaces AccountService.purge() as an apex_methods entry", async () => {
    // The fixture's AccountService.purge() runs SELECT Id, Name FROM Account.
    // Until SOQL field-list resolution lands (task #15) we treat any field on Account as
    // possibly used by anything that queries Account.
    const result = await handler(
      { project_id: projectId, field: "Account.Id" },
      store,
    ) as FieldUsageReport;

    expect(result.parent_sobject).toBe("Account");
    expect(result.apex_methods.length).toBeGreaterThan(0);
    expect(result.apex_methods.some((u) => u.qualified_name.includes("purge"))).toBe(true);
  });

  test("include_indirect=false excludes Apex SOQL/DML approximations", async () => {
    const result = await handler(
      { project_id: projectId, field: "Account.Id", include_indirect: false },
      store,
    ) as FieldUsageReport;

    expect(result.apex_methods).toEqual([]);
  });

  test("malformed field input returns an error", async () => {
    const result = await handler(
      { project_id: projectId, field: "NotAField" },
      store,
    ) as { error?: string };
    expect(result.error).toBeDefined();
  });
});
