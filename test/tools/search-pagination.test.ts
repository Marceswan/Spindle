import { expect, test } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { handler } from "../../src/tools/search-graph.ts";

test("search finds late matches, pages without loss, and defaults to compact evidence", async () => {
  const store = new GraphStore(":memory:");
  try {
    const projectId = store.upsertProject("/tmp/search", "search", "64.0");
    for (let i = 0; i < 1105; i++) {
      store.insertNode({ projectId, label: NodeLabel.ApexMethod, name: i >= 1100 ? "target" : "noise",
        qualifiedName: `Service${i}.target()`, filePath: `classes/Service${i}.cls`, startLine: 12, endLine: 18,
        properties: { annotations: ["AuraEnabled"], body: "large parser metadata ".repeat(100) }, contentHash: "a".repeat(64) });
    }
    type Result = { nodes: Record<string, unknown>[]; count: number; has_more: boolean; next_offset: number | null };
    const input = { project_id: projectId, name_pattern: "^target$", limit: 2 };
    const first = await handler(input, store) as Result;
    expect(first.count).toBe(2);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(2);
    expect(first.nodes[0]?.qualifiedName).toBe("Service1100.target()");
    expect(first.nodes[0]?.startLine).toBe(12);
    expect(first.nodes[0]).not.toHaveProperty("contentHash");
    expect(first.nodes[0]).not.toHaveProperty("properties");
    const second = await handler({ ...input, offset: first.next_offset }, store) as Result;
    const third = await handler({ ...input, offset: second.next_offset }, store) as Result;
    expect(third.count).toBe(1);
    expect(third.has_more).toBe(false);
    expect(third.next_offset).toBeNull();
    expect(new Set([...first.nodes, ...second.nodes, ...third.nodes].map(n => n.qualifiedName)).size).toBe(5);
    const full = await handler({ ...input, detail: "full" }, store) as Result;
    expect(full.nodes[0]).toHaveProperty("properties");
    expect(JSON.stringify(first).length).toBeLessThan(JSON.stringify(full).length / 2);
    await expect(handler({ ...input, limit: -1 }, store)).rejects.toThrow();
    await expect(handler({ ...input, offset: 0.5 }, store)).rejects.toThrow();
  } finally { store.close(); }
});
