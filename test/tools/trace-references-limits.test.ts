import { expect, test } from "bun:test";

import { GraphStore } from "../../src/graph/store.ts";
import type { StoredNode } from "../../src/graph/store.ts";
import type { StoredEdge } from "../../src/graph/queries.ts";
import { EdgeType } from "../../src/model/edge-types.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { handler, DEFAULT_TRACE_LIMIT } from "../../src/tools/trace-references.ts";

type Out = { nodes: StoredNode[]; edges: StoredEdge[]; truncated: boolean; node_count: number; edge_count: number };

function hub(inbound: number): { store: GraphStore; projectId: number } {
  const store = new GraphStore(":memory:");
  const projectId = store.upsertProject("/p", "p", null);
  store.transaction(() => {
    const h = store.insertNode({ projectId, label: NodeLabel.ApexClass, name: "Hub", qualifiedName: "Hub" });
    for (let i = 0; i < inbound; i++) {
      const n = `N${String(i).padStart(4, "0")}`;
      const id = store.insertNode({ projectId, label: NodeLabel.ApexClass, name: n, qualifiedName: n });
      store.insertEdge({ projectId, sourceId: id, targetId: h, edgeType: EdgeType.Calls });
    }
  });
  return { store, projectId };
}

const call = (store: GraphStore, projectId: number, extra: Record<string, unknown> = {}): Promise<Out> =>
  handler({ project_id: projectId, start: { qualified_name: "Hub" }, direction: "inbound", ...extra }, store) as Promise<Out>;

test("default limit is 500", () => {
  expect(DEFAULT_TRACE_LIMIT).toBe(500);
});

test("hub with 600 inbound neighbors: default limit gives 500 nodes, truncated, no dangling edge", async () => {
  const { store, projectId } = hub(600);
  try {
    const out = await call(store, projectId);
    expect(out.nodes.length).toBe(500);
    expect(out.node_count).toBe(500);
    expect(out.truncated).toBe(true);
    const ids = new Set(out.nodes.map(n => n.id));
    expect(out.edges.length).toBe(499);
    expect(out.edge_count).toBe(499);
    for (const e of out.edges) {
      expect(ids.has(e.sourceId)).toBe(true);
      expect(ids.has(e.targetId)).toBe(true);
    }
    expect(out.nodes[0]!.qualifiedName).toBe("Hub");
  } finally { store.close(); }
});

test("limit 5000 returns all 601 nodes, not truncated", async () => {
  const { store, projectId } = hub(600);
  try {
    const out = await call(store, projectId, { limit: 5000 });
    expect(out.nodes.length).toBe(601);
    expect(out.edges.length).toBe(600);
    expect(out.truncated).toBe(false);
  } finally { store.close(); }
});

test("limit equal to the node count is not truncated", async () => {
  const { store, projectId } = hub(4);
  try {
    const out = await call(store, projectId, { limit: 5 });
    expect(out.nodes.length).toBe(5);
    expect(out.truncated).toBe(false);
    const cut = await call(store, projectId, { limit: 4 });
    expect(cut.nodes.length).toBe(4);
    expect(cut.truncated).toBe(true);
  } finally { store.close(); }
});

test("level-1 nodes come before any level-2 node when the limit cuts", async () => {
  const store = new GraphStore(":memory:");
  try {
    const projectId = store.upsertProject("/p", "p", null);
    const mk = (n: string): number => store.insertNode({ projectId, label: NodeLabel.ApexClass, name: n, qualifiedName: n });
    const h = mk("Hub");
    // Insert order puts a level-2 child between level-1 nodes.
    const a = mk("A"); const a2 = mk("A2"); const b = mk("B"); const c = mk("C");
    const edge = (s: number, t: number): number => store.insertEdge({ projectId, sourceId: s, targetId: t, edgeType: EdgeType.Calls });
    edge(a, h); edge(a2, a); edge(b, h); edge(c, h);
    const out = await call(store, projectId, { limit: 4, depth: 2 });
    expect(out.nodes.map(n => n.qualifiedName).sort()).toEqual(["A", "B", "C", "Hub"]);
    expect(out.truncated).toBe(true);
    const full = await call(store, projectId, { limit: 10, depth: 2 });
    expect(full.nodes.map(n => n.qualifiedName)).toEqual(["Hub", "A", "B", "C", "A2"]);
    expect(full.truncated).toBe(false);
  } finally { store.close(); }
});

test("invalid inputs throw errors that name the parameter", async () => {
  const { store, projectId } = hub(1);
  try {
    const base = { project_id: projectId, start: { qualified_name: "Hub" }, direction: "inbound" };
    const fails = async (patch: Record<string, unknown>, text: string): Promise<void> => {
      await expect(handler({ ...base, ...patch }, store)).rejects.toThrow(text);
    };
    await fails({ limit: 0 }, "limit");
    await fails({ limit: 5001 }, "limit");
    await fails({ limit: 1.5 }, "limit");
    await fails({ limit: "5" }, "limit");
    await fails({ start: undefined }, "start");
    await fails({ start: "Hub" }, "start");
    await fails({ start: {} }, "start.qualified_name");
    await fails({ start: { qualified_name: 3 } }, "start.qualified_name");
    await fails({ direction: "sideways" }, "direction");
    await fails({ direction: undefined }, "direction");
    await fails({ depth: 0 }, "depth");
    await fails({ depth: 6 }, "depth");
    await fails({ depth: 2.5 }, "depth");
  } finally { store.close(); }
});

test("a start node that does not exist is an error that says how to find the name", async () => {
  const { store, projectId } = hub(1);
  try {
    await expect(handler({ project_id: projectId, start: { qualified_name: "Nope" }, direction: "both" }, store))
      .rejects.toThrow(/No node has the qualified name "Nope".*search_graph/);
  } finally { store.close(); }
});
