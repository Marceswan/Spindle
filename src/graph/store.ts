// SQLite-backed graph store. The only module that talks directly to the database.
// All reads and writes flow through the typed helpers in this file.

import { Database } from "bun:sqlite";

import type { EdgeType } from "../model/edge-types.ts";
import type { NodeLabel } from "../model/node-labels.ts";

import { CURRENT_SCHEMA_VERSION, SCHEMA_DDL } from "./schema.ts";

export type NodeInput = {
  projectId: number;
  label: NodeLabel;
  name: string;
  qualifiedName: string;
  filePath?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  properties?: Record<string, unknown> | undefined;
  contentHash?: string | undefined;
};

export type EdgeInput = {
  projectId: number;
  sourceId: number;
  targetId: number;
  edgeType: EdgeType;
  confidence?: number | undefined;
  properties?: Record<string, unknown> | undefined;
  sourceFile?: string | undefined;
  sourceLine?: number | undefined;
};

export type StoredNode = {
  id: number;
  projectId: number;
  label: NodeLabel;
  name: string;
  qualifiedName: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  properties: Record<string, unknown>;
  contentHash: string | null;
};

export class GraphStore {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.applySchema();
    this.ensureSchemaVersion();
  }

  private applySchema(): void {
    this.db.exec(SCHEMA_DDL);
  }

  private ensureSchemaVersion(): void {
    const row = this.db
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get();

    if (row === null) {
      this.db
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(CURRENT_SCHEMA_VERSION);
      return;
    }

    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Graph database schema version ${row.version} is newer than this binary supports (${CURRENT_SCHEMA_VERSION}). Upgrade sfdx-graph-mcp.`,
      );
    }

    // Migrations from row.version to CURRENT_SCHEMA_VERSION go here in future versions.
  }

  close(): void {
    this.db.close();
  }

  // --- Projects -----------------------------------------------------------

  upsertProject(rootPath: string, name: string, apiVersion: string | null): number {
    const existing = this.db
      .query<{ id: number }, [string]>("SELECT id FROM projects WHERE root_path = ?")
      .get(rootPath);

    if (existing) {
      this.db
        .prepare("UPDATE projects SET name = ?, api_version = ? WHERE id = ?")
        .run(name, apiVersion, existing.id);
      return existing.id;
    }

    const result = this.db
      .prepare(
        "INSERT INTO projects (root_path, name, api_version) VALUES (?, ?, ?)",
      )
      .run(rootPath, name, apiVersion);
    return Number(result.lastInsertRowid);
  }

  markProjectIndexed(projectId: number, indexedAt: number): void {
    this.db
      .prepare("UPDATE projects SET indexed_at = ? WHERE id = ?")
      .run(indexedAt, projectId);
  }

  // --- Nodes / edges ------------------------------------------------------

  insertNode(input: NodeInput): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO nodes (
           project_id, label, name, qualified_name,
           file_path, start_line, end_line,
           properties, content_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, label, qualified_name) DO UPDATE SET
           name = excluded.name,
           file_path = excluded.file_path,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           properties = excluded.properties,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        input.projectId,
        input.label,
        input.name,
        input.qualifiedName,
        input.filePath ?? null,
        input.startLine ?? null,
        input.endLine ?? null,
        JSON.stringify(input.properties ?? {}),
        input.contentHash ?? null,
        now,
        now,
      ) as { id: number } | null;

    if (result === null) {
      throw new Error(
        `insertNode failed for ${input.label} ${input.qualifiedName}`,
      );
    }
    return result.id;
  }

  insertEdge(input: EdgeInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO edges (
           project_id, source_id, target_id, edge_type,
           confidence, properties, source_file, source_line
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.sourceId,
        input.targetId,
        input.edgeType,
        input.confidence ?? 1.0,
        JSON.stringify(input.properties ?? {}),
        input.sourceFile ?? null,
        input.sourceLine ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  // Atomic batch writes. The pipeline wraps every pass in this.
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  // --- File hashes (for incremental reindex) ------------------------------

  getFileHash(projectId: number, filePath: string): string | null {
    const row = this.db
      .query<{ content_hash: string }, [number, string]>(
        "SELECT content_hash FROM file_hashes WHERE project_id = ? AND file_path = ?",
      )
      .get(projectId, filePath);
    return row?.content_hash ?? null;
  }

  setFileHash(projectId: number, filePath: string, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO file_hashes (project_id, file_path, content_hash, indexed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, file_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at`,
      )
      .run(projectId, filePath, hash, Date.now());
  }

  deleteNodesFromFile(projectId: number, filePath: string): void {
    // Cascade removes outgoing/incoming edges.
    this.db
      .prepare("DELETE FROM nodes WHERE project_id = ? AND file_path = ?")
      .run(projectId, filePath);
  }
}
