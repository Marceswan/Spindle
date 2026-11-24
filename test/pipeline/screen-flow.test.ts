import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlow } from "../../src/parsers/metadata-xml/flow.ts";
import { Confidence } from "../../src/model/confidence.ts";
import { EdgeType } from "../../src/model/edge-types.ts";
import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler } from "../../src/tools/get-field-usage.ts";
import type { ParseResult } from "../../src/parsers/apex/types.ts";

const fixture = join(import.meta.dir, "../fixtures/screen-flow/Screen.flow-meta.xml");
const source = readFileSync(fixture, "utf8");

type FieldEdge = ParseResult["edges"][number];

function fieldEdges(parsed: ParseResult): FieldEdge[] {
  return parsed.edges.filter((e) => e.edgeType === EdgeType.FlowUsesField);
}

function edgeTo(parsed: ParseResult, qname: string): FieldEdge | undefined {
  return fieldEdges(parsed).find((e) => e.toQName === qname);
}

describe("Flow screen and choice extraction", () => {
  const parsed = parseFlow(fixture, source);

  test("reads record fields that a screen shows, at every nesting level", () => {
    const email = edgeTo(parsed, "Customer__c.Email__c");
    expect(email?.properties?.flowElementName).toBe("EditCustomer");
    expect(email?.properties?.context).toBe("screens");
    expect(email?.confidence).toBe(Confidence.Resolved);
    expect(edgeTo(parsed, "Customer__c.Name")?.properties?.flowElementName).toBe("EditCustomer");
  });

  test("reads merge fields in screen text, help text and default values", () => {
    for (const field of ["Tier__c", "Phone__c", "Contact_Name__c"]) {
      const edge = edgeTo(parsed, `Customer__c.${field}`);
      expect(edge?.properties?.flowElementName).toBe("EditCustomer");
      expect(edge?.confidence).toBe(Confidence.Regex);
    }
  });

  test("reads merge fields in choice text and text templates", () => {
    expect(edgeTo(parsed, "Customer__c.Region__c")?.properties?.flowElementName).toBe("FixedChoice");
    expect(edgeTo(parsed, "Customer__c.Summary__c")?.properties?.flowElementName).toBe("Summary");
  });

  test("reads the fields of a record choice set", () => {
    for (const field of ["Display_Name__c", "External_Id__c", "Sort_Key__c", "Active__c", "Backup_Email__c"]) {
      const edge = edgeTo(parsed, `Customer__c.${field}`);
      expect(edge?.properties?.flowElementName).toBe("CustomerChoices");
      expect(edge?.properties?.context).toBe("dynamicChoiceSets");
      expect(edge?.confidence).toBe(Confidence.Resolved);
    }
  });

  test("reads the field of a picklist choice set", () => {
    const edge = edgeTo(parsed, "Customer__c.Status__c");
    expect(edge?.properties?.flowElementName).toBe("TierChoices");
    expect(edge?.confidence).toBe(Confidence.Resolved);
  });

  test("emits no other field target and no warning", () => {
    expect(new Set(fieldEdges(parsed).map((e) => e.toQName))).toEqual(
      new Set(
        [
          "Email__c", "Name", "Tier__c", "Phone__c", "Contact_Name__c", "Region__c", "Summary__c",
          "Display_Name__c", "External_Id__c", "Sort_Key__c", "Active__c", "Backup_Email__c", "Status__c",
        ].map((f) => `Customer__c.${f}`),
      ),
    );
    expect(parsed.warnings).toEqual([]);
  });

  test("reports an unbound screen reference and an unbound merge field without a field target", () => {
    const changed = parseFlow(
      fixture,
      source
        .replace("<objectFieldReference>customer.Email__c", "<objectFieldReference>unknown.Email__c")
        .replace("{!customer.Tier__c}", "{!customer.Owner.Name}"),
    );
    const messages = changed.warnings.map((w) => w.message).join(" ");
    expect(messages).toContain("unknown.Email__c");
    expect(messages).toContain("customer.Owner.Name");
    expect(edgeTo(changed, "Customer__c.Email__c")).toBeUndefined();
    expect(fieldEdges(changed).some((e) => e.toQName.includes("Owner"))).toBe(false);
  });

  test("does not read text that is not a merge field", () => {
    const changed = parseFlow(
      fixture,
      source.replace("Owner note: {!customer.Summary__c}", "Owner note: customer.Summary__c and {customer.Other__c}"),
    );
    expect(edgeTo(changed, "Customer__c.Summary__c")).toBeUndefined();
    expect(edgeTo(changed, "Customer__c.Other__c")).toBeUndefined();
    expect(changed.warnings).toEqual([]);
  });

  test("get_field_usage lists the screen flow as a direct user of the field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spindle-screen-flow-"));
    let store: GraphStore | undefined;
    try {
      cpSync(join(import.meta.dir, "../fixtures/sample-sfdx-project"), dir, { recursive: true });
      cpSync(fixture, join(dir, "force-app/main/default/flows/Screen.flow-meta.xml"));
      store = new GraphStore(join(dir, "graph.db"));
      await indexProject(dir, store, { mode: "full" });
      const project = store.db.query<{ id: number }, []>("SELECT id FROM projects LIMIT 1").get()!;
      const result = (await handler(
        { project_id: project.id, field: "Customer__c.Email__c", include_indirect: false },
        store,
      )) as { flows: { qualified_name: string; context: string }[] };
      expect(result.flows.some((f) => f.qualified_name === "Screen" && f.context === EdgeType.FlowUsesField)).toBe(true);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
