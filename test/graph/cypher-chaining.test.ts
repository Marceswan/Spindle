import { afterEach, beforeEach, expect, test } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { handler } from "../../src/tools/query-graph.ts";

let store: GraphStore;
let project: number;
beforeEach(() => {
  store = new GraphStore(":memory:");
  project = store.upsertProject("/one", "one", null);
  const other = store.upsertProject("/two", "two", null);
  const insert = store.db.prepare("INSERT INTO nodes (project_id,label,name,qualified_name,created_at,updated_at) VALUES (?, 'ApexClass', ?, ?, 0, 0)");
  for (const name of ["A", "B", "C"]) insert.run(project, name, name);
  insert.run(other, "Foreign", "Foreign");
  store.db.run("INSERT INTO edges (project_id,source_id,target_id,edge_type) VALUES (?,1,2,'EXTENDS'), (?,2,3,'EXTENDS'), (?,1,4,'EXTENDS')", [project, project, project]);
});
afterEach(() => store.close());
async function rows(query: string): Promise<unknown[][]> {
  const result = await handler({ project_id: project, query }, store) as { rows?: unknown[][]; error?: string };
  expect(result.error).toBeUndefined();
  return result.rows!;
}
test("optional joins preserve unmatched nodes and reject cross-project targets", async () => {
  expect(await rows("MATCH (n:ApexClass) OPTIONAL MATCH (n)-[e:EXTENDS]->(m) RETURN n.name, m.name, e.edge_type ORDER BY n.name"))
    .toEqual([["A", "B", "EXTENDS"], ["B", "C", "EXTENDS"], ["C", null, null]]);
  expect(await rows("MATCH (n) WHERE n.name = 'C' OPTIONAL MATCH (n)-[e]->(m) RETURN m, e"))
    .toEqual([[null, null]]);
});
test("optional WHERE filters candidate matches without removing input rows", async () => {
  expect(await rows("MATCH (n) OPTIONAL MATCH (n)-[:EXTENDS]->(m) WHERE m.name = 'B' RETURN n.name, m.name ORDER BY n.name"))
    .toEqual([["A", "B"], ["B", null], ["C", null]]);
});
test("WITH aliases nodes and scalars and permits subsequent MATCH", async () => {
  expect(await rows("MATCH (n) WHERE n.name = 'A' WITH n AS source, n.name AS original MATCH (source)-[:EXTENDS]->(m) WITH m AS source, original MATCH (source)-[:EXTENDS]->(last) RETURN original, last.name"))
    .toEqual([["A", "C"]]);
});
test("WITH aggregation groups projections and counts null matches correctly", async () => {
  expect(await rows("MATCH (n) OPTIONAL MATCH (n)-[:EXTENDS]->(m) WITH n.name AS name, count(m) AS total WHERE total = 0 RETURN name, total"))
    .toEqual([["C", 0]]);
});
test("WITH ordering pagination and DISTINCT apply before the next match", async () => {
  expect(await rows("MATCH (n) WITH n ORDER BY n.name DESC SKIP 1 LIMIT 1 MATCH (n)-[:EXTENDS]->(m) RETURN m.name AS target"))
    .toEqual([["C"]]);
  expect(await rows("MATCH (n) WITH DISTINCT n.label AS label RETURN label"))
    .toEqual([["ApexClass"]]);
});
test("WITH drops variables from scope and rejects scalar use in patterns", async () => {
  for (const query of ["MATCH (n) WITH n.name AS name RETURN n", "MATCH (n) WITH n.name AS n MATCH (n)-[:EXTENDS]->(m) RETURN m"]) {
    const result = await handler({ project_id: project, query }, store) as { error: string };
    expect(result.error).toMatch(/scope|node/i);
  }
});
test("initial OPTIONAL MATCH on no match yields one null row", async () => {
  expect(await rows("OPTIONAL MATCH (n:Missing) RETURN n" )).toEqual([[null]]);
});
test("repeated bound variables preserve identity", async () => {
  expect(await rows("MATCH (n) MATCH (n)-[:EXTENDS]->(n) RETURN n")).toEqual([]);
});
test("WITH star carries nullable bindings forward and supports aliases", async () => {
  expect(await rows("MATCH (n) WHERE n.name = 'C' OPTIONAL MATCH (n)-[e]->(m) WITH *, n.name AS name RETURN name, m, e"))
    .toEqual([["C", null, null]]);
});
test("keywords in literal strings are data, and malformed tokens fail closed", async () => {
  expect(await rows("MATCH (n) WHERE n.name = 'DELETE WITH CALL' RETURN n")).toEqual([]);
  for (const query of ["MATCH (n) RETURN n!", "MATCH (n) WHERE n.name = 'oops", "OPTIONAL (n) RETURN n", "MATCH (n) RETURN n LIMIT 1.5", "MATCH (n) RETURN n LIMIT -1"]) {
    const result = await handler({ project_id: project, query }, store) as { error: string };
    expect(result.error).toBeDefined();
  }
});
test("literal equality with null is unknown and string predicates are literal", async () => {
  expect(await rows("MATCH (n) WHERE n.file_path = null RETURN n")).toEqual([]);
  expect(await rows("MATCH (n) WHERE n.name CONTAINS '%' RETURN n")).toEqual([]);
});
