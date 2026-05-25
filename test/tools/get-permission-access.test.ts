// v0.3: get_permission_access MCP tool. Asserts the tool returns the right
// PermissionSet/Profile grants for an ApexClass, SObject, and Field; and that it walks
// PermissionSetGroup membership to surface indirect grants.

import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler } from "../../src/tools/get-permission-access.ts";

setDefaultTimeout(30_000);

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

type AccessReport = {
  target: { type: string; qualified_name: string };
  permission_sets: { source_qualified_name: string; access: Record<string, unknown> }[];
  profiles: { source_qualified_name: string; access: Record<string, unknown> }[];
  permission_set_groups: { qualified_name: string; includes: string[] }[];
  total_grants: number;
};

describe("get_permission_access tool", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-pa-${Date.now()}`);
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

  test("AccountService is granted by Spindle_Reader (PermSet) and Spindle_Test_User (Profile)", async () => {
    const result = await handler(
      { project_id: projectId, target: { type: "ApexClass", qualified_name: "AccountService" } },
      store,
    ) as AccessReport;

    expect(result.permission_sets.some((g) => g.source_qualified_name === "Spindle_Reader")).toBe(true);
    expect(result.profiles.some((g) => g.source_qualified_name === "Spindle_Test_User")).toBe(true);
    expect(result.total_grants).toBeGreaterThanOrEqual(2);
  });

  test("Customer__c.Email__c grants include both Spindle_Reader (read-only) and Spindle_Editor (read+edit)", async () => {
    const result = await handler(
      { project_id: projectId, target: { type: "Field", qualified_name: "Customer__c.Email__c" } },
      store,
    ) as AccessReport;

    const reader = result.permission_sets.find((g) => g.source_qualified_name === "Spindle_Reader");
    const editor = result.permission_sets.find((g) => g.source_qualified_name === "Spindle_Editor");

    expect(reader).toBeDefined();
    expect(editor).toBeDefined();
    expect(reader!.access["read"]).toBe(true);
    expect(reader!.access["edit"]).toBe(false);
    expect(editor!.access["read"]).toBe(true);
    expect(editor!.access["edit"]).toBe(true);
  });

  test("Customer__c surfaces PermissionSetGroup that includes Spindle_Reader and Spindle_Editor", async () => {
    const result = await handler(
      { project_id: projectId, target: { type: "SObject", qualified_name: "Customer__c" } },
      store,
    ) as AccessReport;

    expect(result.permission_set_groups.length).toBe(1);
    const group = result.permission_set_groups[0]!;
    expect(group.qualified_name).toBe("Spindle_PowerUsers");
    expect(group.includes).toContain("Spindle_Reader");
    expect(group.includes).toContain("Spindle_Editor");
  });

  test("unknown target type returns an error", async () => {
    const result = await handler(
      { project_id: projectId, target: { type: "Flow", qualified_name: "Whatever" } },
      store,
    ) as { error?: string };
    expect(result.error).toBeDefined();
  });
});
