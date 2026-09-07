import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { handler } from "../../src/tools/diff-projects.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";

test("diff uses semantic identities, ignores paths and pages real changes", async () => {
  const store = new GraphStore(":memory:");
  try {
    const left = store.upsertProject("/dev", "dev", "64.0");
    const right = store.upsertProject("/prod", "prod", "64.0");
    for (const [projectId, filePath] of [[left, "/dev/Account.xml"], [right, "/prod/Account.xml"]] as const) {
      store.insertNode({ projectId, filePath, label: NodeLabel.Field, name: "Name", qualifiedName: "Account.Name", properties: { type: "Text" } });
    }
    store.insertNode({ projectId: left, label: NodeLabel.Field, name: "Old__c", qualifiedName: "Account.Old__c" });
    store.insertNode({ projectId: right, label: NodeLabel.Field, name: "New__c", qualifiedName: "Account.New__c" });
    const result = await handler({ base_project_id: left, target_project_id: right, limit: 1 }, store) as { total: number; changes: unknown[]; next_offset: number };
    expect(result.total).toBe(2); expect(result.changes).toHaveLength(1); expect(result.next_offset).toBe(1);
    await expect(handler({ base_project_id: left, target_project_id: 999 }, store)).rejects.toThrow("not indexed");
  } finally { store.close(); }
});

type DiffResult = { total: number; summary: { added: number; removed: number; changed: number }; changes: { kind: string; identity: string; change: string; before?: { properties: unknown }; after?: { properties: unknown } }[]; has_more: boolean; next_offset: number | null };

test("diff compares nested properties canonically and optionally includes source hashes", async () => {
  const store = new GraphStore(":memory:");
  try {
    const base = store.upsertProject("/base", "base", null), target = store.upsertProject("/target", "target", null);
    for (const [projectId, contentHash, properties] of [
      [base, "abc", { nested: { a: 1, b: 2 }, list: [1, 2] }],
      [target, "def", { list: [1, 2], nested: { b: 2, a: 1 } }],
    ] as const) store.insertNode({ projectId, contentHash, properties, label: NodeLabel.ApexClass, name: "Service", qualifiedName: "Service" });
    const call = (include_source: boolean): Promise<unknown> => handler({ base_project_id: base, target_project_id: target, include_source }, store);
    expect((await call(false) as DiffResult).total).toBe(0);
    expect((await call(true) as DiffResult).summary).toEqual({ added: 0, removed: 0, changed: 1 });
    store.db.run("UPDATE nodes SET properties=? WHERE project_id=?", [JSON.stringify({ nested: { a: 1, b: 3 }, list: [2, 1] }), target]);
    const result = await call(false) as DiffResult;
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.before?.properties).toEqual({ nested: { a: 1, b: 2 }, list: [1, 2] });
    expect(result.changes[0]?.after?.properties).toEqual({ nested: { a: 1, b: 3 }, list: [2, 1] });
  } finally { store.close(); }
});

test("diff treats parallel edges as an order-independent multiset and detects changed confidence", async () => {
  const store = new GraphStore(":memory:");
  try {
    const base = store.upsertProject("/base", "base", null), target = store.upsertProject("/target", "target", null);
    for (const projectId of [base, target]) {
      const source = store.insertNode({ projectId, label: NodeLabel.ApexClass, name: "A", qualifiedName: "A" });
      const destination = store.insertNode({ projectId, label: NodeLabel.ApexClass, name: "B", qualifiedName: "B" });
      const values = projectId === base ? [1, 2] : [2, 1];
      for (const value of values) store.db.run("INSERT INTO edges (project_id,source_id,target_id,edge_type,confidence,properties,source_line) VALUES (?,?,?,'CALLS',?,?,?)", [projectId, source, destination, 0.8, JSON.stringify({ value }), projectId === base ? 5 : 50]);
    }
    const call = (): Promise<unknown> => handler({ base_project_id: base, target_project_id: target }, store);
    expect((await call() as DiffResult).total).toBe(0);
    store.db.run("UPDATE edges SET confidence=1 WHERE project_id=? AND json_extract(properties,'$.value')=1", [target]);
    let result = await call() as DiffResult;
    expect(result.summary).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(result.changes[0]?.kind).toBe("edge");
    store.db.run("DELETE FROM edges WHERE project_id=?", [target]);
    result = await call() as DiffResult;
    expect(result.summary).toEqual({ added: 0, removed: 1, changed: 0 });
    const reverse = await handler({ base_project_id: target, target_project_id: base }, store) as DiffResult;
    expect(reverse.summary).toEqual({ added: 1, removed: 0, changed: 0 });
  } finally { store.close(); }
});

test("diff pagination has stable complete identities, summaries and terminal offsets", async () => {
  const store = new GraphStore(":memory:");
  try {
    const base = store.upsertProject("/base", "base", null), target = store.upsertProject("/target", "target", null);
    for (const name of ["Z", "B", "A", "C", "Y"]) store.insertNode({ projectId: target, label: NodeLabel.ApexClass, name, qualifiedName: name });
    const call = (offset: number): Promise<unknown> => handler({ base_project_id: base, target_project_id: target, limit: 2, offset }, store);
    const first = await call(0) as DiffResult, second = await call(first.next_offset!) as DiffResult, third = await call(second.next_offset!) as DiffResult;
    expect(first.next_offset).toBe(2); expect(second.next_offset).toBe(4); expect(third.next_offset).toBeNull();
    expect(third.has_more).toBeFalse();
    const ids = [...first.changes, ...second.changes, ...third.changes].map(c => c.identity);
    expect(ids).toEqual([...ids].sort()); expect(new Set(ids).size).toBe(5);
    expect((await call(0) as DiffResult).changes).toEqual(first.changes);
    for (const result of [first, second, third, await call(99) as DiffResult]) expect(result.summary).toEqual({ added: 5, removed: 0, changed: 0 });
    expect((await call(99) as DiffResult).changes).toEqual([]);
  } finally { store.close(); }
});

test("diff rejects malformed pagination, project IDs and source flag", async () => {
  const store = new GraphStore(":memory:");
  try {
    const project = store.upsertProject("/one", "one", null);
    for (const override of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }, { offset: Number.NaN }, { base_project_id: "1" }, { target_project_id: 999 }, { include_source: "false" }, { include_source: 0 }]) {
      await expect(handler({ base_project_id: project, target_project_id: project, ...override }, store)).rejects.toThrow();
    }
  } finally { store.close(); }
});

test("diff ignores malformed edges whose endpoints belong to another project", async () => {
  const store = new GraphStore(":memory:");
  try {
    const base = store.upsertProject("/base", "base", null), target = store.upsertProject("/target", "target", null);
    const foreign = store.upsertProject("/foreign", "foreign", null);
    const source = store.insertNode({ projectId: foreign, label: NodeLabel.ApexClass, name: "Secret", qualifiedName: "Secret" });
    store.db.run("INSERT INTO edges (project_id,source_id,target_id,edge_type) VALUES (?,?,?,'CALLS')", [base, source, source]);
    const result = await handler({ base_project_id: base, target_project_id: target }, store) as DiffResult;
    expect(result.total).toBe(0);
  } finally { store.close(); }
});
