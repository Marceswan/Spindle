import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EdgeType } from "../../src/model/edge-types.ts";
import { NodeLabel } from "../../src/model/node-labels.ts";
import { GraphStore } from "../../src/graph/store.ts";

function freshStore(): { store: GraphStore; cleanup: () => void } {
  const dbPath = join(tmpdir(), `spindle-test-${Date.now()}-${Math.random()}.db`);
  const store = new GraphStore(dbPath);
  return {
    store,
    cleanup: () => {
      store.close();
      try {
        rmSync(dbPath);
        rmSync(`${dbPath}-wal`);
        rmSync(`${dbPath}-shm`);
      } catch {
        // best-effort
      }
    },
  };
}

describe("GraphStore", () => {
  test("applies schema on first open and records version", () => {
    const { store, cleanup } = freshStore();
    try {
      const version = store.db
        .query<{ version: number }, []>("SELECT version FROM schema_version")
        .get();
      expect(version?.version).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("upserts a project and inserts nodes and edges", () => {
    const { store, cleanup } = freshStore();
    try {
      const projectId = store.upsertProject("/tmp/sample", "sample", "62.0");
      expect(projectId).toBeGreaterThan(0);

      const classId = store.insertNode({
        projectId,
        label: NodeLabel.ApexClass,
        name: "AccountService",
        qualifiedName: "AccountService",
        filePath: "classes/AccountService.cls",
        startLine: 1,
        endLine: 50,
      });

      const methodId = store.insertNode({
        projectId,
        label: NodeLabel.ApexMethod,
        name: "cleanup",
        qualifiedName: "AccountService.cleanup()",
        filePath: "classes/AccountService.cls",
        startLine: 10,
        endLine: 20,
      });

      const edgeId = store.insertEdge({
        projectId,
        sourceId: classId,
        targetId: methodId,
        edgeType: EdgeType.DefinesMethod,
      });

      expect(edgeId).toBeGreaterThan(0);

      const edgeRow = store.db
        .query<{ edge_type: string; confidence: number }, [number]>(
          "SELECT edge_type, confidence FROM edges WHERE id = ?",
        )
        .get(edgeId);
      expect(edgeRow?.edge_type).toBe("DEFINES_METHOD");
      expect(edgeRow?.confidence).toBe(1.0);
    } finally {
      cleanup();
    }
  });

  test("insertNode upserts on (project, label, qualified_name)", () => {
    const { store, cleanup } = freshStore();
    try {
      const projectId = store.upsertProject("/tmp/sample2", "sample2", null);

      const first = store.insertNode({
        projectId,
        label: NodeLabel.ApexClass,
        name: "Foo",
        qualifiedName: "Foo",
        filePath: "classes/Foo.cls",
      });

      const second = store.insertNode({
        projectId,
        label: NodeLabel.ApexClass,
        name: "Foo",
        qualifiedName: "Foo",
        filePath: "classes/Foo.cls",
        startLine: 1,
      });

      expect(second).toBe(first);
    } finally {
      cleanup();
    }
  });

  test("getFileHash / setFileHash round-trip", () => {
    const { store, cleanup } = freshStore();
    try {
      const projectId = store.upsertProject("/tmp/sample3", "sample3", null);
      expect(store.getFileHash(projectId, "classes/Foo.cls")).toBeNull();

      store.setFileHash(projectId, "classes/Foo.cls", "abc123");
      expect(store.getFileHash(projectId, "classes/Foo.cls")).toBe("abc123");

      store.setFileHash(projectId, "classes/Foo.cls", "def456");
      expect(store.getFileHash(projectId, "classes/Foo.cls")).toBe("def456");
    } finally {
      cleanup();
    }
  });
});
