import { expect, test } from "bun:test";

import { parseCypher } from "../../src/graph/cypher/parser.ts";
import { GraphStore } from "../../src/graph/store.ts";
import { EdgeType } from "../../src/model/edge-types.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { handler } from "../../src/tools/query-graph.ts";

test("an edge type that is spelled like a keyword can be queried", async () => {
  const store = new GraphStore(":memory:");
  try {
    const projectId = store.upsertProject("/p", "p", null);
    const parent = store.insertNode({ projectId, label: NodeLabel.ApexClass, name: "Outer", qualifiedName: "Outer", properties: { count: 2 } });
    const child = store.insertNode({ projectId, label: NodeLabel.ApexClass, name: "Inner", qualifiedName: "Outer.Inner" });
    store.insertEdge({ projectId, sourceId: parent, targetId: child, edgeType: EdgeType.Contains });

    const byType = await handler({ project_id: projectId, query: "MATCH (a)-[:CONTAINS]->(b) RETURN a.name, b.name" }, store) as { rows: unknown[][] };
    expect(byType.rows).toEqual([["Outer", "Inner"]]);

    const byProperty = await handler({ project_id: projectId, query: "MATCH (n:ApexClass) WHERE n.count = 2 RETURN n.name" }, store) as { rows: unknown[][] };
    expect(byProperty.rows).toEqual([["Outer"]]);

    const operator = await handler({ project_id: projectId, query: "MATCH (n:ApexClass) WHERE n.name CONTAINS 'nne' RETURN n.name" }, store) as { rows: unknown[][] };
    expect(operator.rows).toEqual([["Inner"]]);
  } finally {
    store.close();
  }
});

test("a string or number is still not a label, edge type or property name", () => {
  expect(parseCypher("MATCH (n:'ApexClass') RETURN n").ok).toBe(false);
  expect(parseCypher("MATCH (a)-[:1]->(b) RETURN a").ok).toBe(false);
  expect(parseCypher("MATCH (n) RETURN n.'name'").ok).toBe(false);
});
