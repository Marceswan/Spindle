import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphStore } from "../../src/graph/store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/graph/schema.ts";

test("fresh db has tool_invocation table and schema version 2", () => {
  const store = new GraphStore(":memory:");
  const cols = store.db
    .query<{ name: string }, []>("PRAGMA table_info(tool_invocation)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("tool_name");
  expect(cols).toContain("tokens_saved");
  expect(cols).toContain("method");
  const v = store.db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  expect(v?.version).toBe(CURRENT_SCHEMA_VERSION);
  expect(CURRENT_SCHEMA_VERSION).toBe(2);
  store.close();
});

test("existing v1 db gains tool_invocation on open (idempotent DDL)", () => {
  // Simulate a v1 db: only the v1 tables, schema_version = 1.
  const path = `/tmp/spindle-mig-${Math.floor(performance.now())}.db`;
  const raw = new Database(path, { create: true });
  raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version (version) VALUES (1);");
  raw.close();
  const store = new GraphStore(path); // applySchema runs IF NOT EXISTS DDL + migration
  const cols = store.db.query<{ name: string }, []>("PRAGMA table_info(tool_invocation)").all();
  expect(cols.length).toBeGreaterThan(0);
  const v = store.db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  expect(v?.version).toBe(2);
  store.close();
});
