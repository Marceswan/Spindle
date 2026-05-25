import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { handler } from "../../src/tools/get-source-snippet.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("get_source_snippet tool", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanupQName: string | null = null;
  let cleanup: () => void;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `spindle-gs-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cpSync(FIXTURE_DIR, tempDir, { recursive: true });
    const dbDir = join(tempDir, ".sfdx-graph");
    mkdirSync(dbDir, { recursive: true });
    store = new GraphStore(join(dbDir, "graph.db"));
    await indexProject(tempDir, store, { mode: "full" });

    type Row = { id: number };
    const row = store.db.query<Row, []>("SELECT id FROM projects LIMIT 1").get();
    projectId = row?.id ?? 1;

    type QRow = { qualified_name: string };
    const qrow = store.db
      .query<QRow, [number, string]>(
        "SELECT qualified_name FROM nodes WHERE project_id = ? AND name = ? LIMIT 1",
      )
      .get(projectId, "cleanup");
    cleanupQName = qrow?.qualified_name ?? null;

    cleanup = () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  test("returns source for AccountService.cleanup() containing 'purge()'", async () => {
    expect(cleanupQName).not.toBeNull();

    const result = await handler(
      { project_id: projectId, qualified_name: cleanupQName! },
      store,
    ) as { file_path: string; start_line: number; end_line: number; source: string };

    expect(result.source).toContain("purge()");
    expect(result.file_path).toContain("AccountService");
    expect(result.start_line).toBeGreaterThan(0);
  });

  test("returns error for unknown qualified name", async () => {
    const result = await handler(
      { project_id: projectId, qualified_name: "DoesNotExist.method()" },
      store,
    ) as { error?: string };

    expect(result.error).toBeDefined();
    expect(result.error).toContain("not found");
  });

  test("context_lines expands the returned source", async () => {
    expect(cleanupQName).not.toBeNull();

    const noCtx = await handler(
      { project_id: projectId, qualified_name: cleanupQName! },
      store,
    ) as { source: string; start_line: number };

    const withCtx = await handler(
      { project_id: projectId, qualified_name: cleanupQName!, context_lines: 3 },
      store,
    ) as { source: string; start_line: number };

    expect(withCtx.source.split("\n").length).toBeGreaterThanOrEqual(noCtx.source.split("\n").length);
    expect(withCtx.start_line).toBeLessThanOrEqual(noCtx.start_line);
  });
});
