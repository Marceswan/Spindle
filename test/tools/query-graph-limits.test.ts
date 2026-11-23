import { expect, test } from "bun:test";

import { GraphStore } from "../../src/graph/store.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { handler, DEFAULT_ROW_CAP } from "../../src/tools/query-graph.ts";

type Out = { rows: unknown[][]; row_count: number; truncated: boolean; warnings: string[]; error?: string };

function build(count: number): { store: GraphStore; projectId: number } {
  const store = new GraphStore(":memory:");
  const projectId = store.upsertProject("/p", "p", null);
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const n = `C${String(i).padStart(4, "0")}`;
      store.insertNode({ projectId, label: NodeLabel.ApexClass, name: n, qualifiedName: n });
    }
  });
  return { store, projectId };
}

async function run(store: GraphStore, projectId: number, query: string): Promise<Out> {
  return (await handler({ project_id: projectId, query }, store)) as Out;
}

test("cap constant is 1000", () => {
  expect(DEFAULT_ROW_CAP).toBe(1000);
});

test("no LIMIT and more rows than the cap: first 1000 rows, truncated, warning", async () => {
  const { store, projectId } = build(1005);
  try {
    const out = await run(store, projectId, "MATCH (n:ApexClass) RETURN n.name");
    expect(out.error).toBeUndefined();
    expect(out.rows.length).toBe(1000);
    expect(out.row_count).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.warnings.some(w => w.includes("1000") && w.includes("LIMIT") && w.includes("SKIP") && w.includes("count(*)"))).toBe(true);
  } finally { store.close(); }
});

test("explicit LIMIT above the cap is obeyed", async () => {
  const { store, projectId } = build(1005);
  try {
    const out = await run(store, projectId, "MATCH (n:ApexClass) RETURN n.name LIMIT 1003");
    expect(out.rows.length).toBe(1003);
    expect(out.truncated).toBe(false);
  } finally { store.close(); }
});

test("exactly 1000 rows and no LIMIT: not truncated", async () => {
  const { store, projectId } = build(1000);
  try {
    const out = await run(store, projectId, "MATCH (n:ApexClass) RETURN n.name");
    expect(out.rows.length).toBe(1000);
    expect(out.truncated).toBe(false);
    expect(out.warnings.some(w => w.includes("first 1000"))).toBe(false);
  } finally { store.close(); }
});

test("count(*) returns the real count", async () => {
  const { store, projectId } = build(1005);
  try {
    const out = await run(store, projectId, "MATCH (n:ApexClass) RETURN count(*)");
    expect(out.rows).toEqual([[1005]]);
    expect(out.truncated).toBe(false);
  } finally { store.close(); }
});

test("a LIMIT inside WITH does not count as a final limit", async () => {
  const { store, projectId } = build(1005);
  try {
    const out = await run(store, projectId, "MATCH (n:ApexClass) WITH n LIMIT 5 RETURN n.name");
    expect(out.rows.length).toBe(5);
    expect(out.truncated).toBe(false);
    const big = await run(store, projectId, "MATCH (n:ApexClass) WITH n LIMIT 1004 RETURN n.name");
    expect(big.rows.length).toBe(1000);
    expect(big.truncated).toBe(true);
  } finally { store.close(); }
});

test("ORDER BY with no LIMIT returns the first 1000 in order", async () => {
  const { store, projectId } = build(1005);
  try {
    const asc = await run(store, projectId, "MATCH (n:ApexClass) RETURN n.name ORDER BY n.name");
    expect(asc.rows.length).toBe(1000);
    expect(asc.rows[0]).toEqual(["C0000"]);
    expect(asc.rows[999]).toEqual(["C0999"]);
    const desc = await run(store, projectId, "MATCH (n:ApexClass) RETURN n.name ORDER BY n.name DESC");
    expect(desc.rows[0]).toEqual(["C1004"]);
    expect(desc.rows[999]).toEqual(["C0005"]);
    expect(desc.truncated).toBe(true);
  } finally { store.close(); }
});

test("small result sets report truncated false", async () => {
  const { store, projectId } = build(3);
  try {
    const out = await run(store, projectId, "MATCH (n:ApexClass) RETURN n.name");
    expect(out.truncated).toBe(false);
    expect(out.rows.length).toBe(3);
  } finally { store.close(); }
});
