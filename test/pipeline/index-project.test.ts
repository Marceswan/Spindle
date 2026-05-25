import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

// beforeAll cpSync + full index can take 5-7s under parallel test-file contention; bump from 5s default.
setDefaultTimeout(30_000);
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store.ts";
import { indexProject } from "../../src/pipeline/index-project.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { EdgeType } from "../../src/model/edge-types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

function makeTempProject(): { tempDir: string; dbPath: string; cleanup: () => void } {
  const tempDir = join(tmpdir(), `spindle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  cpSync(FIXTURE_DIR, tempDir, { recursive: true });
  const dbDir = join(tempDir, ".sfdx-graph");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "graph.db");
  return {
    tempDir,
    dbPath,
    cleanup: () => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function countNodes(store: GraphStore, projectId: number, label: string): number {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, string]>(
      "SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND label = ?",
    )
    .get(projectId, label);
  return row?.n ?? 0;
}

function findNode(
  store: GraphStore,
  projectId: number,
  label: string,
  qname: string,
): { id: number } | null {
  type Row = { id: number };
  return store.db
    .query<Row, [number, string, string]>(
      "SELECT id FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
    )
    .get(projectId, label, qname);
}

function findNodeByName(
  store: GraphStore,
  projectId: number,
  label: string,
  name: string,
): { id: number; qualified_name: string } | null {
  type Row = { id: number; qualified_name: string };
  return store.db
    .query<Row, [number, string, string]>(
      "SELECT id, qualified_name FROM nodes WHERE project_id = ? AND label = ? AND name = ?",
    )
    .get(projectId, label, name);
}

function countEdges(
  store: GraphStore,
  sourceId: number,
  targetId: number,
  edgeType: string,
): number {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, number, string]>(
      "SELECT COUNT(*) AS n FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?",
    )
    .get(sourceId, targetId, edgeType);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Full index assertions
// ---------------------------------------------------------------------------

describe("indexProject – full mode", () => {
  let store: GraphStore;
  let tempDir: string;
  let projectId: number;
  let cleanup: () => void;

  beforeAll(async () => {
    const tmp = makeTempProject();
    tempDir = tmp.tempDir;
    cleanup = tmp.cleanup;
    store = new GraphStore(tmp.dbPath);
    await indexProject(tempDir, store, { mode: "full" });
    type Row = { id: number };
    const row = store.db.query<Row, []>("SELECT id FROM projects LIMIT 1").get();
    projectId = row?.id ?? 1;
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  test("emits at least 4 ApexClass nodes", () => {
    expect(countNodes(store, projectId, NodeLabel.ApexClass)).toBeGreaterThanOrEqual(4);
  });

  test("emits at least 1 ApexInterface node", () => {
    expect(countNodes(store, projectId, NodeLabel.ApexInterface)).toBeGreaterThanOrEqual(1);
  });

  test("emits at least 1 ApexTrigger node", () => {
    expect(countNodes(store, projectId, NodeLabel.ApexTrigger)).toBeGreaterThanOrEqual(1);
  });

  test("emits SObject placeholder for Account", () => {
    const node = findNode(store, projectId, NodeLabel.SObject, "Account");
    expect(node).not.toBeNull();
  });

  test("emits DEFINES_METHOD edges from ApexClass to its methods", () => {
    type Row = { n: number };
    const row = store.db
      .query<Row, [number, string]>(
        "SELECT COUNT(*) AS n FROM edges WHERE project_id = ? AND edge_type = ?",
      )
      .get(projectId, EdgeType.DefinesMethod);
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });

  test("emits EXTENDS edge AccountService -> BaseService", () => {
    const accountSvc = findNode(store, projectId, NodeLabel.ApexClass, "AccountService");
    const baseSvc = findNode(store, projectId, NodeLabel.ApexClass, "BaseService");
    expect(accountSvc).not.toBeNull();
    expect(baseSvc).not.toBeNull();
    expect(countEdges(store, accountSvc!.id, baseSvc!.id, EdgeType.Extends)).toBe(1);
  });

  test("emits IMPLEMENTS edge AccountService -> Cleanable", () => {
    const accountSvc = findNode(store, projectId, NodeLabel.ApexClass, "AccountService");
    const cleanable = findNode(store, projectId, NodeLabel.ApexInterface, "Cleanable");
    expect(accountSvc).not.toBeNull();
    expect(cleanable).not.toBeNull();
    expect(countEdges(store, accountSvc!.id, cleanable!.id, EdgeType.Implements)).toBe(1);
  });

  test("emits CALLS edge from Orchestrator.run() -> AccountService.cleanup()", () => {
    const orchestratorRun = findNodeByName(store, projectId, NodeLabel.ApexMethod, "run");
    const cleanupMethod = findNodeByName(store, projectId, NodeLabel.ApexMethod, "cleanup");
    expect(orchestratorRun).not.toBeNull();
    expect(cleanupMethod).not.toBeNull();
    expect(countEdges(store, orchestratorRun!.id, cleanupMethod!.id, EdgeType.Calls)).toBe(1);
  });

  test("emits INSTANTIATES edge from Orchestrator.run() -> AccountService", () => {
    const orchestratorRun = findNodeByName(store, projectId, NodeLabel.ApexMethod, "run");
    const accountSvc = findNode(store, projectId, NodeLabel.ApexClass, "AccountService");
    expect(orchestratorRun).not.toBeNull();
    expect(accountSvc).not.toBeNull();
    expect(countEdges(store, orchestratorRun!.id, accountSvc!.id, EdgeType.Instantiates)).toBe(1);
  });

  test("emits SOQL_QUERIES edge with confidence 0.6 from AccountService.purge() -> Account", () => {
    const purgeMethod = findNodeByName(store, projectId, NodeLabel.ApexMethod, "purge");
    const accountSObj = findNode(store, projectId, NodeLabel.SObject, "Account");
    expect(purgeMethod).not.toBeNull();
    expect(accountSObj).not.toBeNull();

    type EdgeRow = { confidence: number };
    const edge = store.db
      .query<EdgeRow, [number, number, string]>(
        "SELECT confidence FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?",
      )
      .get(purgeMethod!.id, accountSObj!.id, EdgeType.SoqlQueries);
    expect(edge).not.toBeNull();
    expect(edge?.confidence).toBe(0.6);
  });

  test("emits TRIGGERS_ON edge AccountTrigger -> Account", () => {
    const trigger = findNode(store, projectId, NodeLabel.ApexTrigger, "AccountTrigger");
    const accountSObj = findNode(store, projectId, NodeLabel.SObject, "Account");
    expect(trigger).not.toBeNull();
    expect(accountSObj).not.toBeNull();
    expect(countEdges(store, trigger!.id, accountSObj!.id, EdgeType.TriggersOn)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Incremental reindex: no-op when nothing changed
// ---------------------------------------------------------------------------

describe("indexProject – incremental no-op", () => {
  let store: GraphStore;
  let tempDir: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const tmp = makeTempProject();
    tempDir = tmp.tempDir;
    cleanup = tmp.cleanup;
    store = new GraphStore(tmp.dbPath);
    await indexProject(tempDir, store, { mode: "full" });
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  test("incremental reindex inserts zero new nodes when no files changed", async () => {
    type Row = { n: number };
    const before = store.db.query<Row, []>("SELECT COUNT(*) AS n FROM nodes").get()?.n ?? 0;
    const result = await indexProject(tempDir, store, { mode: "incremental" });
    const after = store.db.query<Row, []>("SELECT COUNT(*) AS n FROM nodes").get()?.n ?? 0;
    expect(result.filesParsed).toBe(0);
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Incremental reindex: only changed file is re-emitted
// ---------------------------------------------------------------------------

describe("indexProject – incremental partial reindex", () => {
  let store: GraphStore;
  let tempDir: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const tmp = makeTempProject();
    tempDir = tmp.tempDir;
    cleanup = tmp.cleanup;
    store = new GraphStore(tmp.dbPath);
    await indexProject(tempDir, store, { mode: "full" });
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  test("only the modified file is re-parsed on incremental reindex", async () => {
    const orchPath = join(
      tempDir,
      "force-app",
      "main",
      "default",
      "classes",
      "Orchestrator.cls",
    );
    const originalText = await Bun.file(orchPath).text();
    writeFileSync(orchPath, originalText + "\n// modified for test\n");

    const result = await indexProject(tempDir, store, { mode: "incremental" });
    expect(result.filesParsed).toBe(1);
  });
});
