// Results that a caller can misread: an empty answer for a wrong project or a wrong
// property name, a class trace that misses the references to its methods, and one usage
// listed two times.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler as getFieldUsage } from "../../src/tools/get-field-usage.ts";
import { handler as getPermissionAccess } from "../../src/tools/get-permission-access.ts";
import { handler as getSchema } from "../../src/tools/get-schema.ts";
import { handler as getSourceSnippet } from "../../src/tools/get-source-snippet.ts";
import { handler as queryGraph } from "../../src/tools/query-graph.ts";
import { handler as searchGraph } from "../../src/tools/search-graph.ts";
import { handler as traceReferences } from "../../src/tools/trace-references.ts";

setDefaultTimeout(30_000);

type Trace = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
type Usage = { qualified_name: string; context: string; scope: string };

describe("tool results that a caller can misread", () => {
  let dir: string;
  let store: GraphStore;
  const project_id = 1;

  beforeAll(async () => {
    dir = join(realpathSync(tmpdir()), `spindle-clarity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    cpSync(join(import.meta.dir, "..", "fixtures", "sample-sfdx-project"), dir, { recursive: true });
    store = new GraphStore(":memory:");
    await indexProject(dir, store, { mode: "full" });
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("each read tool says that a project is not indexed", async () => {
    const message = /Project 99 is not indexed.*list_projects/;
    await expect(getSchema({ project_id: 99 }, store)).rejects.toThrow(message);
    await expect(searchGraph({ project_id: 99 }, store)).rejects.toThrow(message);
    await expect(traceReferences({ project_id: 99, start: { qualified_name: "X" }, direction: "inbound" }, store)).rejects.toThrow(message);
    for (const result of [
      await queryGraph({ project_id: 99, query: "MATCH (n) RETURN count(*)" }, store),
      await getFieldUsage({ project_id: 99, field: "Customer__c.Email__c" }, store),
      await getPermissionAccess({ project_id: 99, target: { type: "SObject", qualified_name: "Customer__c" } }, store),
      await getSourceSnippet({ project_id: 99, qualified_name: "AccountService" }, store),
    ]) expect((result as { error?: string }).error).toMatch(message);
    await expect(getSchema({}, store)).rejects.toThrow(/is not indexed/);
  });

  test("query_graph accepts the camelCase names that the other tools print", async () => {
    const snake = await queryGraph({ project_id, query: "MATCH (a)-[r]->(b) WHERE b.qualified_name = 'AccountService.cleanup()' RETURN a.qualified_name, r.edge_type ORDER BY a.qualified_name" }, store) as { rows: unknown[][] };
    const camel = await queryGraph({ project_id, query: "MATCH (a)-[r]->(b) WHERE b.qualifiedName = 'AccountService.cleanup()' RETURN a.qualifiedName, r.edgeType ORDER BY a.qualifiedName" }, store) as { rows: unknown[][] };
    expect(snake.rows.length).toBeGreaterThan(0);
    expect(camel.rows).toEqual(snake.rows);
  });

  test("query_graph names the replacement for type(r) and for an inline property map", async () => {
    const typeCall = await queryGraph({ project_id, query: "MATCH (a)-[r]->(b) RETURN type(r)" }, store) as { error: string; suggestion: string };
    expect(typeCall.suggestion).toContain("r.edge_type");
    const inlineMap = await queryGraph({ project_id, query: "MATCH (n:Field {name: 'Email__c'}) RETURN n" }, store) as { error: string; suggestion: string };
    expect(inlineMap.suggestion).toContain("WHERE");
    const literal = await queryGraph({ project_id, query: "MATCH (n:ApexClass) WHERE n.name = '{x}' RETURN n.name" }, store) as { rows?: unknown[] };
    expect(literal.rows).toEqual([]);
  });

  test("a class trace with include_members finds the references to its methods", async () => {
    const start = { qualified_name: "AccountService", label: "ApexClass" };
    const names = (trace: Trace): string[] => trace.nodes.map((n) => n["qualifiedName"] as string);
    const classOnly = await traceReferences({ project_id, start, direction: "inbound", depth: 1 }, store) as Trace;
    expect(names(classOnly)).not.toContain("c/customerCard");
    const withMembers = await traceReferences({ project_id, start, direction: "inbound", depth: 1, include_members: true }, store) as Trace;
    expect(names(withMembers)).toEqual(expect.arrayContaining(["c/customerCard", "customerPanel", "Orchestrator.run()", "CustomerEditor", "Customer_Onboarding", "Spindle_Reader", "AccountService.cleanup()"]));
  });

  test("an object trace with include_members finds the references to its fields", async () => {
    const trace = await traceReferences({ project_id, start: { qualified_name: "Customer__c", label: "SObject" }, direction: "inbound", depth: 1, include_members: true }, store) as Trace;
    const names = trace.nodes.map((n) => n["qualifiedName"]);
    expect(names).toEqual(expect.arrayContaining(["Customer__c.Email__c", "Customer__c.Email_Required", "Marketing/CustomerWelcome"]));
  });

  test("trace_references is compact by default and full on request", async () => {
    const args = { project_id, start: { qualified_name: "AccountService.cleanup()" }, direction: "inbound", depth: 1 };
    const compact = await traceReferences(args, store) as Trace;
    expect(Object.keys(compact.nodes[0]!).sort()).toEqual(["endLine", "filePath", "id", "label", "name", "qualifiedName", "startLine"]);
    expect(Object.keys(compact.edges[0]!).sort()).toEqual(["confidence", "edgeType", "id", "properties", "sourceId", "sourceLine", "targetId"]);
    const full = await traceReferences({ ...args, detail: "full" }, store) as Trace;
    expect(full.nodes[0]).toHaveProperty("properties");
    await expect(traceReferences({ ...args, detail: "tiny" }, store)).rejects.toThrow("detail");
  });

  test("get_field_usage lists a source one time and marks object-level entries", async () => {
    const report = await getFieldUsage({ project_id, field: "Customer__c.Email__c" }, store) as { apex_methods: Usage[]; flows: Usage[]; lwc_bundles: Usage[] };
    const lookup = report.apex_methods.filter((usage) => usage.qualified_name === "CustomerLookup.findGoldCustomers()");
    expect(lookup).toHaveLength(1);
    expect(lookup[0]).toMatchObject({ context: "SOQL_SELECT", scope: "field" });
    expect(report.lwc_bundles.every((usage) => usage.scope === "field")).toBe(true);
    // The fixture flow is triggered on Customer__c and updates it, but names no field.
    expect(report.flows.length).toBeGreaterThan(0);
    expect(report.flows.every((usage) => usage.scope === "object")).toBe(true);
  });
});
