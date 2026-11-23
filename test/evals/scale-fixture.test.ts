// The skill evals grade answers against the known truth of a generated project. This test
// keeps the generator, the truth and the graph in agreement: if the indexer or the
// generator changes, the eval graders must not silently go out of date.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateScaleProject, type ScaleTruth } from "../../plugins/spindle/evals/_shared/scale-project.ts";
import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler as getFieldUsage } from "../../src/tools/get-field-usage.ts";
import { handler as getPermissionAccess } from "../../src/tools/get-permission-access.ts";
import { handler as traceReferences } from "../../src/tools/trace-references.ts";

setDefaultTimeout(60_000);

type Usage = { qualified_name: string; name: string; scope: string };
type Trace = { nodes: { label: string; qualifiedName: string }[]; truncated: boolean };
type Grant = { source_qualified_name: string; access: { read?: boolean; edit?: boolean } };

describe("the generated eval project and its known answers", () => {
  let dir: string;
  let store: GraphStore;
  let truth: ScaleTruth;
  const project_id = 1;

  beforeAll(async () => {
    dir = join(realpathSync(tmpdir()), `spindle-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    truth = generateScaleProject(dir);
    store = new GraphStore(":memory:");
    const result = await indexProject(dir, store, { mode: "full" });
    expect(result.warnings).toEqual([]);
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const callersWithin = async (depth: number): Promise<string[]> => {
    const trace = await traceReferences({
      project_id, start: { qualified_name: "BillingCore.applyCredit(Decimal)", label: "ApexMethod" },
      direction: "inbound", depth, edge_types: ["CALLS"],
    }, store) as Trace;
    expect(trace.truncated).toBe(false);
    return trace.nodes
      .filter((node) => node.label === "ApexMethod" && node.qualifiedName !== "BillingCore.applyCredit(Decimal)")
      .map((node) => node.qualifiedName.replace(/\(.*$/, ""))
      .sort();
  };

  test("callers within one, two and three calls are the designed sets", async () => {
    const hop1 = [...truth.callersHop1].sort();
    const hop2 = [...new Set([...truth.callersHop1, ...truth.callersHop2])].sort();
    const hop3 = [...new Set([...truth.callersHop1, ...truth.callersHop2, ...truth.callersHop3])].sort();
    expect(await callersWithin(1)).toEqual(hop1);
    expect(await callersWithin(2)).toEqual(hop2);
    expect(await callersWithin(3)).toEqual(hop3);
    expect(hop3).toHaveLength(20);
    for (const decoy of truth.callerDecoys) expect(hop3).not.toContain(decoy);
  });

  test("field usage has each true user at field level and no decoy", async () => {
    const report = await getFieldUsage({ project_id, field: "Invoice__c.Balance__c" }, store) as Record<string, Usage[]>;
    const fieldLevel = (bucket: string): string[] =>
      (report[bucket] ?? []).filter((usage) => usage.scope === "field").map((usage) => usage.qualified_name.replace(/\(.*$/, "")).sort();
    expect(fieldLevel("apex_methods")).toEqual([...truth.fieldUsers.apex].sort());
    expect(fieldLevel("lwc_bundles")).toEqual(truth.fieldUsers.lwc.map((name) => `c/${name}`).sort());
    expect(fieldLevel("flows")).toEqual(truth.fieldUsers.flows);
    expect(fieldLevel("layouts")).toEqual([...truth.fieldUsers.flexipages, ...truth.fieldUsers.layouts].sort());
    expect(fieldLevel("validation_rules")).toEqual(truth.fieldUsers.validationRules.map((name) => `Invoice__c.${name}`));
    expect(fieldLevel("email_templates")).toEqual(truth.fieldUsers.emailTemplates.map((name) => `Billing/${name}`));
    const everything = JSON.stringify(Object.values(report).flat().filter((usage) => (usage as Usage).scope === "field"));
    for (const decoy of truth.fieldDecoys) expect(everything).not.toContain(decoy);
  });

  test("field access is the designed set of edit and read-only grants", async () => {
    const report = await getPermissionAccess({ project_id, target: { type: "Field", qualified_name: "Invoice__c.Balance__c" } }, store) as { permission_sets: Grant[]; profiles: Grant[] };
    const grants = [...report.permission_sets, ...report.profiles];
    expect(grants.filter((grant) => grant.access.edit === true).map((grant) => grant.source_qualified_name).sort()).toEqual([...truth.fieldAccess.edit].sort());
    expect(grants.filter((grant) => grant.access.edit !== true).map((grant) => grant.source_qualified_name).sort()).toEqual([...truth.fieldAccess.readOnly].sort());
  });
});
