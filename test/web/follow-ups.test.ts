import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { handleApi } from "../../src/web/api.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { EdgeType } from "../../src/model/edge-types.ts";

async function call(
  store: GraphStore,
  path: string,
): Promise<{ status: number; body: any }> {
  const res = (await handleApi(
    new Request("http://localhost/api/" + path),
    store,
  ))!;
  return { status: res.status, body: await res.json() };
}
test("Explore filters apply before the cap and expansion keeps endpoints scoped", async () => {
  const s = new GraphStore(":memory:");
  const p = s.upsertProject("/p", "p", null);
  const node = (name: string, label: NodeLabel) =>
    s.insertNode({ projectId: p, label, name, qualifiedName: name });
  const edge = (a: number, b: number, type: EdgeType) =>
    s.insertEdge({ projectId: p, sourceId: a, targetId: b, edgeType: type });
  try {
    const center = node("Center", NodeLabel.ApexClass),
      ignored = node("Ignored", NodeLabel.Field),
      first = node("First", NodeLabel.ApexMethod),
      second = node("Second", NodeLabel.ApexMethod);
    edge(center, ignored, EdgeType.ReferencesField);
    edge(center, first, EdgeType.Calls);
    edge(first, second, EdgeType.Calls);
    const path = `neighborhood?project=${p}&id=${center}&label=ApexMethod&edge_type=CALLS&cap=2`;
    const near = await call(s, path + "&depth=1");
    expect(near.body.nodes.map((n: any) => n.name)).toEqual([
      "Center",
      "First",
    ]);
    expect(near.body.truncated).toBe(false);
    const capped = await call(s, path + "&depth=2");
    expect(capped.body.truncated).toBe(true);
    const expanded = await call(s, path.replace("cap=2", "cap=3") + "&depth=2");
    expect(expanded.body.nodes.map((n: any) => n.name)).toEqual([
      "Center",
      "First",
      "Second",
    ]);
    expect(expanded.body.edges).toHaveLength(2);
    expect(expanded.body.truncated).toBe(false);
    expect(
      (await call(s, `neighborhood?project=${p}&id=${center}&depth=0`)).body
        .nodes,
    ).toHaveLength(1);
    expect(
      (await call(s, path.replace("edge_type=CALLS", "edge_type=garbage")))
        .status,
    ).toBe(400);
  } finally {
    s.close();
  }
});
test("method permission lookup uses the declaring-class edge and stays project scoped", async () => {
  const s = new GraphStore(":memory:");
  const p = s.upsertProject("/p", "p", null),
    other = s.upsertProject("/other", "other", null);
  try {
    const cls = s.insertNode({
      projectId: p,
      label: NodeLabel.ApexClass,
      name: "Outer.Inner",
      qualifiedName: "Outer.Inner",
    });
    const method = s.insertNode({
      projectId: p,
      label: NodeLabel.ApexMethod,
      name: "run",
      qualifiedName: "Outer.Inner.run(Map<String,Integer>)",
    });
    s.insertEdge({
      projectId: p,
      sourceId: cls,
      targetId: method,
      edgeType: EdgeType.DefinesMethod,
    });
    const perm = s.insertNode({
      projectId: p,
      label: NodeLabel.PermissionSet,
      name: "Runner",
      qualifiedName: "Runner",
    });
    s.insertEdge({
      projectId: p,
      sourceId: perm,
      targetId: cls,
      edgeType: EdgeType.GrantsApexAccess,
      properties: { enabled: true },
    });
    const path = `permission-access?type=ApexMethod&target=${encodeURIComponent("Outer.Inner.run(Map<String,Integer>)")}`;
    const result = await call(s, path + `&project=${p}`);
    expect(result.status).toBe(200);
    expect(result.body.declaringClass).toBe("Outer.Inner");
    expect(result.body.method).toBe("Outer.Inner.run(Map<String,Integer>)");
    expect(result.body.permission_sets[0].source_qualified_name).toBe("Runner");
    expect((await call(s, path + `&project=${other}`)).status).toBe(404);
    expect(
      (
        await call(
          s,
          `permission-access?project=${p}&type=ApexMethod&target=Missing.run()`,
        )
      ).status,
    ).toBe(404);
  } finally {
    s.close();
  }
});

test("method search accepts a literal full signature and returns only methods", async () => {
  const s = new GraphStore(":memory:");
  const p = s.upsertProject("/search", "search", null);
  try {
    s.insertNode({
      projectId: p,
      label: NodeLabel.ApexMethod,
      name: "run",
      qualifiedName: "Outer.Inner.run(Map<String,Integer>)",
    });
    s.insertNode({
      projectId: p,
      label: NodeLabel.ApexClass,
      name: "run",
      qualifiedName: "run",
    });
    const result = await call(
      s,
      `search?project=${p}&label=ApexMethod&q=${encodeURIComponent("Outer.Inner.run(Map<String,Integer>)")}`,
    );
    expect(result.body.nodes.map((n: any) => n.qualifiedName)).toEqual([
      "Outer.Inner.run(Map<String,Integer>)",
    ]);
  } finally {
    s.close();
  }
});
