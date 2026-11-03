// Pure-parser tests for advanced Flow field extraction (FLOW_REFERENCES_FIELD).

import { test, expect } from "bun:test";
import { parseFlow, buildVariableBindings } from "../../../src/parsers/metadata-xml/flow.ts";
import { EdgeType } from "../../../src/model/edge-types.ts";

const FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>62.0</apiVersion>
  <label>F</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <variables>
    <name>myCust</name>
    <dataType>SObject</dataType>
    <objectType>Customer__c</objectType>
  </variables>
  <recordLookups>
    <name>load</name>
    <object>Customer__c</object>
    <queriedFields>Email__c</queriedFields>
    <queriedFields>Tier__c</queriedFields>
    <filters><field>Tier__c</field></filters>
  </recordLookups>
  <recordUpdates>
    <name>upd</name>
    <object>Customer__c</object>
    <inputAssignments><field>Email__c</field></inputAssignments>
  </recordUpdates>
  <decisions>
    <name>d</name>
    <rules>
      <name>r</name>
      <conditions><leftValueReference>myCust.Tier__c</leftValueReference></conditions>
    </rules>
  </decisions>
  <assignments>
    <name>a</name>
    <assignmentItems><assignToReference>myCust.Email__c</assignToReference></assignmentItems>
  </assignments>
  <formulas>
    <name>fx</name>
    <expression>UPPER({!myCust.Email__c})</expression>
  </formulas>
</Flow>`;

function fieldEdges(source: string): { toQName: string; clause: string }[] {
  const result = parseFlow("flows/F.flow-meta.xml", source);
  return result.edges
    .filter((e) => e.edgeType === EdgeType.FlowReferencesField)
    .map((e) => ({
      toQName: e.toQName,
      clause: (e.properties as { clause?: string } | undefined)?.clause ?? "",
    }));
}

test("buildVariableBindings binds SObject variables and record-element outputs", () => {
  const parsed = parseFlowRaw(FLOW);
  const bindings = buildVariableBindings(parsed);
  expect(bindings.get("myCust")).toBe("Customer__c");
  expect(bindings.get("load")).toBe("Customer__c"); // record element output bound to its object
});

test("emits tier-1 FLOW_REFERENCES_FIELD for record fields, filters, input assignments", () => {
  const edges = fieldEdges(FLOW);
  const qnames = edges.map((e) => e.toQName);
  expect(qnames).toContain("Customer__c.Email__c");
  expect(qnames).toContain("Customer__c.Tier__c");
  // No unresolved short-names: everything here is tier-1 (bound var or element object).
  expect(qnames.every((q) => !q.startsWith("__SHORTNAME__:"))).toBe(true);
});

test("resolves bound-variable references in decisions, assignments, and formulas", () => {
  const edges = fieldEdges(FLOW);
  const clauses = new Set(edges.map((e) => e.clause));
  expect(clauses.has("decision")).toBe(true); // myCust.Tier__c -> Customer__c.Tier__c
  expect(clauses.has("assignment")).toBe(true); // myCust.Email__c -> Customer__c.Email__c
  expect(clauses.has("formula")).toBe(true); // UPPER({!myCust.Email__c})
  expect(clauses.has("queriedField")).toBe(true);
  expect(clauses.has("filter")).toBe(true);
  expect(clauses.has("inputAssignment")).toBe(true);
});

test("unbound variable reference falls back to tier-2 __SHORTNAME__", () => {
  const flow = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>U</label><processType>AutoLaunchedFlow</processType><status>Active</status>
  <assignments><name>a</name>
    <assignmentItems><assignToReference>unbound.Mystery__c</assignToReference></assignmentItems>
  </assignments>
</Flow>`;
  const edges = fieldEdges(flow);
  expect(edges.some((e) => e.toQName === "__SHORTNAME__:Mystery__c")).toBe(true);
});

// parseFlowRaw: re-parse the XML the same way the parser does, to feed buildVariableBindings
// (which takes the parsed Flow object). We re-run the public parser's XML step indirectly by
// importing fast-xml-parser with the same config would duplicate logic; instead exercise it
// through a tiny inline parse using the same library settings.
import { XMLParser } from "fast-xml-parser";
function parseFlowRaw(source: string): Parameters<typeof buildVariableBindings>[0] {
  const p = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: true,
    trimValues: true,
    isArray: (name) =>
      ["variables", "recordLookups", "recordCreates", "recordUpdates", "queriedFields", "filters", "inputAssignments"].includes(name),
  });
  return (p.parse(source) as { Flow: Parameters<typeof buildVariableBindings>[0] }).Flow;
}

test('lookup output fields and assignment RHS references are extracted without scalar resources',()=>{
 const edges=fieldEdges(`<Flow><variables><name>cust</name><objectType>Customer__c</objectType><dataType>SObject</dataType></variables>
 <recordLookups><name>lookup</name><object>Customer__c</object><outputAssignments><field>Email__c</field><assignToReference>email</assignToReference></outputAssignments></recordLookups>
 <assignments><name>assign</name><assignmentItems><assignToReference>scalar</assignToReference><value><elementReference>cust.Tier__c</elementReference></value></assignmentItems></assignments></Flow>`);
 expect(edges.map(e=>e.toQName).sort()).toEqual(['Customer__c.Email__c','Customer__c.Tier__c']);
});
