import { expect, test, spyOn } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { getNeighborhood } from "../../src/graph/queries.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { EdgeType } from "../../src/model/edge-types.ts";

function fixture(count: number) {
  const s = new GraphStore(":memory:");
  const p = s.upsertProject("/budget", "budget", null);
  const ids = Array.from({ length: count }, (_, i) =>
    s.insertNode({
      projectId: p,
      label: NodeLabel.ApexMethod,
      name: `m${i}`,
      qualifiedName: `m${i}`,
    }),
  );
  const edge = (a: number, b: number) =>
    s.insertEdge({
      projectId: p,
      sourceId: ids[a]!,
      targetId: ids[b]!,
      edgeType: EdgeType.Calls,
    });
  return { s, p, ids, edge };
}

test("dense neighborhoods stop at the edge cap and say why", () => {
  const { s, p, ids, edge } = fixture(12);
  try {
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) edge(a, b);
    const graph = getNeighborhood(s, p, ids[0]!, {
      depth: 2,
      cap: 20,
      edgeCap: 15,
    });
    expect(graph.edges).toHaveLength(15);
    expect(graph.truncated).toBe(true);
    expect(graph.truncationReason).toBe("edge_cap");
    const visible = new Set(graph.nodes.map((n) => n.id));
    expect(
      graph.edges.every(
        (e) => visible.has(e.sourceId) && visible.has(e.targetId),
      ),
    ).toBe(true);
  } finally {
    s.close();
  }
});

test("revisited edges consume a work budget even when they add no new edges", () => {
  const { s, p, ids, edge } = fixture(3);
  try {
    edge(0, 1);
    edge(1, 2);
    const graph = getNeighborhood(s, p, ids[0]!, { depth: 3, workBudget: 2 });
    expect(graph.truncated).toBe(true);
    expect(graph.truncationReason).toBe("work_budget");
    expect(graph.edges).toHaveLength(1);
    // Exactly exhausting the budget with no further work is not truncation.
    expect(
      getNeighborhood(s, p, ids[0]!, { depth: 1, workBudget: 1 }).truncated,
    ).toBe(false);
  } finally {
    s.close();
  }
});

test("wide frontiers use bounded batches instead of a query per node", () => {
  const { s, p, ids, edge } = fixture(601);
  try {
    for (let i = 1; i <= 300; i++) {
      edge(0, i);
      edge(i, i + 300);
    }
    const query = spyOn(s.db, "query");
    try {
      const graph = getNeighborhood(s, p, ids[0]!, { depth: 2, cap: 1000 });
      expect(graph.nodes).toHaveLength(601);
      expect(graph.edges).toHaveLength(600);
      expect(graph.truncated).toBe(false);
      expect(query.mock.calls.length).toBeLessThan(15);
    } finally {
      query.mockRestore();
    }
  } finally {
    s.close();
  }
});

test("node cap is deterministic and increasing it preserves the selected nodes", () => {
  const { s, p, ids, edge } = fixture(8);
  try {
    for (let i = 1; i < ids.length; i++) edge(0, i);
    const small = getNeighborhood(s, p, ids[0]!, { cap: 3 });
    const large = getNeighborhood(s, p, ids[0]!, { cap: 8 });
    expect(small.truncationReason).toBe("node_cap");
    expect(small.nodes.map((n) => n.id)).toEqual(ids.slice(0, 3));
    expect(large.nodes.map((n) => n.id)).toEqual(ids);
    expect(large.truncated).toBe(false);
  } finally {
    s.close();
  }
});
