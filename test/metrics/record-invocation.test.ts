import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { recordInvocation } from "../../src/metrics/record-invocation.ts";

function row() {
  return {
    projectId: 1,
    toolName: "get_field_usage",
    params: { field: "A__c.B__c" },
    durationMs: 3,
    resultJson: JSON.stringify({ file_path: "/x.cls" }),
  };
}

test("recordInvocation inserts a row with estimated savings", () => {
  const store = new GraphStore(":memory:");
  recordInvocation(store, { ...row(), now: 1000, fileSize: () => 4000 });
  const r = store.db
    .query<{ tool_name: string; tokens_saved: number; method: string }, []>(
      "SELECT tool_name, tokens_saved, method FROM tool_invocation LIMIT 1",
    )
    .get();
  expect(r?.tool_name).toBe("get_field_usage");
  expect(r?.method).toBe("result-aware");
  expect(r?.tokens_saved).toBeGreaterThan(0);
  store.close();
});

test("recordInvocation is a no-op when disabled", () => {
  const store = new GraphStore(":memory:");
  recordInvocation(store, { ...row(), now: 1000, disabled: true });
  const n = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tool_invocation").get();
  expect(n?.n).toBe(0);
  store.close();
});

test("recordInvocation never throws on a write failure", () => {
  const store = new GraphStore(":memory:");
  store.db.exec("DROP TABLE tool_invocation");
  expect(() => recordInvocation(store, { ...row(), now: 1000 })).not.toThrow();
  store.close();
});
