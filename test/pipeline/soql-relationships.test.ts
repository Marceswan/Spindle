import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GraphStore } from "../../src/graph/store.ts";
import { runPass2 } from "../../src/pipeline/pass2-intra-domain.ts";
import { parseApex } from "../../src/parsers/apex/parse.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";

test("SOQL child queries and parent field paths resolve using lookup metadata", () => {
  const store = new GraphStore(":memory:");
  try {
    const projectId = store.upsertProject("/sample", "sample", "62.0");
    const parsed = parseApex("AdvancedQueries.cls",readFileSync(new URL("../fixtures/soql/advanced.cls",import.meta.url),"utf8"));
    const nodes = [
      ...parsed.nodes,
      {label:NodeLabel.SObject,name:"Child__c",qualifiedName:"Child__c",startLine:1,endLine:1},
      {label:NodeLabel.Field,name:"Name",qualifiedName:"Parent__c.Name",startLine:1,endLine:1},
      {label:NodeLabel.Field,name:"Email__c",qualifiedName:"Child__c.Email__c",startLine:1,endLine:1},
      {label:NodeLabel.Field,name:"Parent__c",qualifiedName:"Child__c.Parent__c",startLine:1,endLine:1,properties:{referenceTo:"Parent__c",relationshipName:"Children"}},
    ];
    for (const node of nodes) store.insertNode({...node, projectId,filePath:"AdvancedQueries.cls"});
    runPass2(projectId,parsed.unresolved,parsed.edges,store);
    const targets = store.db.query<{qualified_name:string;edge_type:string},[]>("SELECT n.qualified_name,e.edge_type FROM edges e JOIN nodes n ON n.id=e.target_id").all();
    expect(targets.some(t=>t.qualified_name==="Child__c" && t.edge_type==="SOQL_QUERIES")).toBe(true);
    expect(targets.some(t=>t.qualified_name==="Child__c.Email__c" && t.edge_type==="REFERENCES_FIELD")).toBe(true);
    expect(targets.some(t=>t.qualified_name==="Parent__c.Name" && t.edge_type==="REFERENCES_FIELD")).toBe(true);
    expect(parsed.nodes.some(n=>n.qualifiedName==="Children__r")).toBe(false);
    // No relationship metadata means no guesses based on plural names.
    const unresolvedEdges = parsed.edges.filter(e => (e.properties?.soqlObjectPath as string[] | undefined)?.length === 2);
    expect(unresolvedEdges.length).toBeGreaterThan(0);
    store.db.run("DELETE FROM edges");
    store.db.run("DELETE FROM nodes WHERE qualified_name = 'Child__c.Parent__c'");
    const diagnostics = runPass2(projectId,[],unresolvedEdges,store);
    expect(diagnostics.resolvedCount).toBe(0);
    expect(diagnostics.unresolvedCount).toBe(unresolvedEdges.length);
  } finally {store.close();}
});
