import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlow } from "../../src/parsers/metadata-xml/flow.ts";
import { EdgeType } from "../../src/model/edge-types.ts";
import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler } from "../../src/tools/get-field-usage.ts";

const fixture = join(import.meta.dir, "../fixtures/advanced-flow/Advanced.flow-meta.xml");
const source = readFileSync(fixture, "utf8");

describe("advanced Flow extraction", () => {
  test("binds variables, trigger records and lookup outputs across decisions, assignments and formulas", () => {
    const parsed = parseFlow(fixture, source);
    const refs = parsed.edges.filter(e => e.edgeType === EdgeType.FlowUsesField);
    expect(new Set(refs.map(e => e.toQName))).toEqual(new Set(["Customer__c.Email__c", "Customer__c.Name"]));
    for (const name of ["SetEmail", "CheckEmail", "DisplayEmail", "GetCustomer", "ExplicitCustomer"]) {
      expect(refs.some(e => e.properties?.flowElementName === name)).toBe(true);
    }
    expect(parsed.edges.some(e => e.edgeType === EdgeType.FlowDmlOn && e.toQName === "Customer__c" && e.properties?.flowElementName === "SaveCustomer")).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });

  test("reports unbound and relationship references without inventing field targets", () => {
    const parsed = parseFlow(fixture, source.replace("customer.Email__c</assignToReference>", "unknown.Email__c</assignToReference>").replace("GetCustomer.Email__c</elementReference>", "customer.Owner.Name</elementReference>"));
    expect(parsed.warnings.map(w => w.message).join(" ")).toContain("unknown.Email__c");
    expect(parsed.warnings.map(w => w.message).join(" ")).toContain("customer.Owner.Name");
    expect(parsed.edges.some(e => e.toQName.includes("Owner.Name"))).toBe(false);
  });

  test("does not bind lookup names when automatic output storage is disabled", () => {
    const parsed = parseFlow(fixture, source.replace("<storeOutputAutomatically>true", "<storeOutputAutomatically>false"));
    expect(parsed.warnings.some(w => w.message.includes("GetCustomer.Email__c"))).toBe(true);
    expect(parsed.edges.some(e => e.edgeType === EdgeType.FlowUsesField && e.properties?.flowElementName === "SetEmail" && e.toQName === "Customer__c.Email__c")).toBe(true);
  });

  test("extracts formula identifiers outside quoted literals and comments only", () => {
    const parsed = parseFlow(fixture, source.replace("{!customer.Email__c}),", "{!customer.Email__c}), /* customer.Comment__c */").replace("&quot;customer.Fake__c&quot;", "&quot;customer.Fake__c&quot; &amp; 'customer.OtherFake__c'"));
    expect(parsed.edges.filter(e => e.properties?.context === "formula").map(e => e.toQName)).toEqual(["Customer__c.Email__c"]);
  });

  test("direct field usage survives the full pipeline without indirect references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spindle-advanced-flow-"));
    let store: GraphStore | undefined;
    try {
      cpSync(join(import.meta.dir, "../fixtures/sample-sfdx-project"), dir, { recursive: true });
      cpSync(fixture, join(dir, "force-app/main/default/flows/Advanced.flow-meta.xml"));
      store = new GraphStore(join(dir, "graph.db"));
      await indexProject(dir, store, { mode: "full" });
      const project = store.db.query<{id: number}, []>("SELECT id FROM projects LIMIT 1").get()!;
      const result = await handler({ project_id: project.id, field: "Customer__c.Email__c", include_indirect: false }, store) as {flows: {qualified_name: string; context: string}[]};
      expect(result.flows.some(f => f.qualified_name === "Advanced" && f.context === EdgeType.FlowUsesField)).toBe(true);
      expect(result.flows.filter(f => f.qualified_name === "Advanced")).toHaveLength(1);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
