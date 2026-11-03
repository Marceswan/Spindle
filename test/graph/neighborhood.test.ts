import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { getNeighborhood, getSavingsSummary } from "../../src/graph/queries.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { EdgeType } from "../../src/model/edge-types.ts";

function seed(store: GraphStore) {
  const pid = store.upsertProject("/p", "p", "64.0");
  const a = store.insertNode({ projectId: pid, label: NodeLabel.ApexClass, name: "A", qualifiedName: "A" });
  const b = store.insertNode({ projectId: pid, label: NodeLabel.ApexClass, name: "B", qualifiedName: "B" });
  const c = store.insertNode({ projectId: pid, label: NodeLabel.ApexClass, name: "C", qualifiedName: "C" });
  store.insertEdge({ projectId: pid, sourceId: a, targetId: b, edgeType: EdgeType.Calls });
  store.insertEdge({ projectId: pid, sourceId: c, targetId: a, edgeType: EdgeType.Calls });
  return { pid, a, b, c };
}

test("getNeighborhood returns the center node + 1-hop neighbors both directions", () => {
  const store = new GraphStore(":memory:");
  const { pid, a } = seed(store);
  const nb = getNeighborhood(store, pid, a, { depth: 1, cap: 100 });
  const ids = nb.nodes.map((n) => n.id).sort();
  expect(ids.length).toBe(3); // A + B (out) + C (in)
  expect(nb.edges.length).toBe(2);
  expect(nb.truncated).toBe(false);
  store.close();
});

test("getNeighborhood sets truncated when cap is hit", () => {
  const store = new GraphStore(":memory:");
  const { pid, a } = seed(store);
  const nb = getNeighborhood(store, pid, a, { depth: 1, cap: 1 });
  expect(nb.truncated).toBe(true);
  store.close();
});

test("getSavingsSummary aggregates totals and per-tool", () => {
  const store = new GraphStore(":memory:");
  const pid = store.upsertProject("/p", "p", "64.0");
  const base = {
    projectId: pid, paramsJson: null, durationMs: 1, resultTokens: 10,
    baselineTokens: 110, tokensSaved: 100, method: "multiplier", createdAt: 1000,
  };
  store.recordToolInvocation({ ...base, toolName: "search_graph" });
  store.recordToolInvocation({ ...base, toolName: "search_graph" });
  store.recordToolInvocation({ ...base, toolName: "get_field_usage" });
  const s = getSavingsSummary(store, pid);
  expect(s.totalCalls).toBe(3);
  expect(s.totalTokensSaved).toBe(300);
  expect(s.perTool.find((t) => t.toolName === "search_graph")?.calls).toBe(2);
  expect(s.timeline.length).toBeGreaterThan(0);
  store.close();
});
