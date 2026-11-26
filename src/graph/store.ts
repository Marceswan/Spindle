// SQLite-backed graph store. The only module that talks directly to the database.
// All reads and writes flow through the typed helpers in this file.

import { Database } from "bun:sqlite";

import type { EdgeType } from "../model/edge-types.ts";
import type { NodeLabel } from "../model/node-labels.ts";

import { CURRENT_DATA_EPOCH, CURRENT_SCHEMA_VERSION, SCHEMA_DDL } from "./schema.ts";

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
    this.ensureDataEpoch();
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

  // The graph is a cache of the source files. When an indexer fix makes stored rows
  // unreliable, a higher data epoch drops the file hashes, so the next index of each
  // project parses every file again. The schema version does not change, so an older
  // binary can still open the database.
  private ensureDataEpoch(): void {
    const row = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if ((row?.user_version ?? 0) >= CURRENT_DATA_EPOCH) return;
    this.db.exec(`DELETE FROM file_hashes; DELETE FROM file_backrefs; PRAGMA user_version = ${CURRENT_DATA_EPOCH}`);
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

  /**
   * Older versions stored the root as the caller gave it, so a row can hold a symlinked
   * path of this same directory. Give that row the canonical root, and keep its id. Its
   * node paths have the old prefix; with the hashes gone, the next index removes those
   * nodes and parses every file again.
   */
  adoptProjectAlias(canonicalRoot: string, isSameDirectory: (rootPath: string) => boolean): void {
    const current = this.db
      .query<{ id: number }, [string]>("SELECT id FROM projects WHERE root_path = ?")
      .get(canonicalRoot);
    if (current !== null) return;
    const alias = this.db
      .query<{ id: number; root_path: string }, []>("SELECT id, root_path FROM projects ORDER BY id")
      .all()
      .find((row) => isSameDirectory(row.root_path));
    if (alias === undefined) return;
    this.transaction(() => {
      this.db.query("UPDATE projects SET root_path = ? WHERE id = ?").run(canonicalRoot, alias.id);
      this.db.query("DELETE FROM file_hashes WHERE project_id = ?").run(alias.id);
      this.db.query("DELETE FROM file_backrefs WHERE project_id = ?").run(alias.id);
    });
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
      .query(
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
      .query(
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
      .query(
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
      .query("DELETE FROM nodes WHERE project_id = ? AND file_path = ?")
      .run(projectId, filePath);
  }

  // --- Incremental reindex helpers ----------------------------------------

  /**
   * A placeholder stands for metadata that has no source file in the project (for example
   * a standard object that Apex queries). It never replaces a real node, and no file owns
   * it, so the reparse or removal of one referring file cannot delete it.
   */
  ensurePlaceholderNode(input: NodeInput): number {
    const existing = this.db
      .query<{ id: number; file_path: string | null; placeholder: number | null }, [number, string, string]>(
        `SELECT id, file_path, json_extract(properties, '$.isPlaceholder') AS placeholder
         FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?`,
      )
      .get(input.projectId, input.label, input.qualifiedName);
    if (existing === null) {
      return this.insertNode({ ...input, filePath: undefined, startLine: undefined, endLine: undefined, contentHash: undefined });
    }
    if (existing.placeholder === 1 && existing.file_path !== null) {
      // Rows written before placeholders became ownerless.
      this.db
        .query("UPDATE nodes SET file_path = NULL, start_line = NULL, end_line = NULL, content_hash = NULL WHERE id = ?")
        .run(existing.id);
    }
    return existing.id;
  }

  /**
   * Salesforce API names are not case-sensitive, but node rows are. When an object or field
   * exists under two spellings, keep one node: the real one (it has a source file), or else
   * the oldest. Edges of a placeholder move to the kept node and the placeholder is deleted.
   * Two real nodes that differ only in case are left as they are.
   */
  mergeCaseVariantPlaceholders(projectId: number): number {
    type Row = { id: number; label: string; key: string; placeholder: number | null };
    const rows = this.db
      .query<Row, [number, number]>(
        `SELECT n.id AS id, n.label AS label, lower(n.qualified_name) AS key,
                json_extract(n.properties, '$.isPlaceholder') AS placeholder
         FROM nodes n
         JOIN (SELECT label, lower(qualified_name) AS key FROM nodes
               WHERE project_id = ? AND label IN ('SObject', 'Field')
               GROUP BY label, lower(qualified_name) HAVING count(*) > 1) d
           ON d.label = n.label AND d.key = lower(n.qualified_name)
         WHERE n.project_id = ?
         ORDER BY n.label, key, n.id`,
      )
      .all(projectId, projectId);
    if (rows.length === 0) return 0;

    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.label}::${row.key}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }

    let merged = 0;
    this.transaction(() => {
      const moveTargets = this.db.query("UPDATE edges SET target_id = ? WHERE target_id = ?");
      const moveSources = this.db.query("UPDATE edges SET source_id = ? WHERE source_id = ?");
      const remove = this.db.query("DELETE FROM nodes WHERE id = ?");
      for (const group of groups.values()) {
        const keep = group.find((r) => r.placeholder !== 1) ?? group[0]!;
        for (const row of group) {
          if (row.id === keep.id || row.placeholder !== 1) continue;
          moveTargets.run(keep.id, row.id);
          moveSources.run(keep.id, row.id);
          remove.run(row.id);
          merged++;
        }
      }
    });
    return merged;
  }

  /** Placeholders that no edge uses any more: their last referring file changed or is gone. */
  deleteOrphanPlaceholders(projectId: number): void {
    this.db
      .query(
        `DELETE FROM nodes
         WHERE project_id = ? AND file_path IS NULL
           AND json_extract(properties, '$.isPlaceholder') = 1
           AND NOT EXISTS (SELECT 1 FROM edges WHERE edges.source_id = nodes.id)
           AND NOT EXISTS (SELECT 1 FROM edges WHERE edges.target_id = nodes.id)`,
      )
      .run(projectId);
  }

  getNodeIdsForFile(projectId: number, filePath: string): number[] {
    return this.db
      .query<{ id: number }, [number, string]>("SELECT id FROM nodes WHERE project_id = ? AND file_path = ?")
      .all(projectId, filePath)
      .map((row) => row.id);
  }

  deleteNodesById(ids: number[]): void {
    const statement = this.db.query("DELETE FROM nodes WHERE id = ?");
    for (const id of ids) statement.run(id);
  }

  /** Edges that start at a node of this file. The next pass 2 writes them again. */
  deleteOutgoingEdgesFromFile(projectId: number, filePath: string): void {
    this.db
      .query(
        `DELETE FROM edges WHERE project_id = ? AND source_id IN (
           SELECT id FROM nodes WHERE project_id = ? AND file_path = ?)`,
      )
      .run(projectId, projectId, filePath);
  }

  /** Source files (or bundle directories) that own at least one node. */
  getIndexedFilePaths(projectId: number): string[] {
    return this.db
      .query<{ file_path: string }, [number]>(
        "SELECT DISTINCT file_path FROM nodes WHERE project_id = ? AND file_path IS NOT NULL",
      )
      .all(projectId)
      .map((row) => row.file_path);
  }

  getHashedFilePaths(projectId: number): string[] {
    return this.db
      .query<{ file_path: string }, [number]>("SELECT file_path FROM file_hashes WHERE project_id = ?")
      .all(projectId)
      .map((row) => row.file_path);
  }

  deleteFileHash(projectId: number, filePath: string): void {
    this.db.query("DELETE FROM file_hashes WHERE project_id = ? AND file_path = ?").run(projectId, filePath);
  }

  /** The `@RestResource` urlMapping values of the Apex classes in one file, sorted. */
  getRestUrlMappingsForFile(projectId: number, filePath: string): string[] {
    return this.db
      .query<{ mapping: string }, [number, string]>(
        `SELECT json_extract(properties, '$.restUrlMapping') AS mapping FROM nodes
         WHERE project_id = ? AND file_path = ? AND json_extract(properties, '$.restUrlMapping') IS NOT NULL
         ORDER BY 1`,
      )
      .all(projectId, filePath)
      .map((row) => row.mapping);
  }

  /** Files that have, or once had, an edge into a node of one of the target files. */
  getReferringFiles(projectId: number, targetFiles: string[]): Set<string> {
    const out = new Set<string>();
    const statement = this.db.query<{ referring_file: string }, [number, string]>(
      "SELECT referring_file FROM file_backrefs WHERE project_id = ? AND target_file = ?",
    );
    for (const target of targetFiles) {
      for (const row of statement.all(projectId, target)) out.add(row.referring_file);
    }
    return out;
  }

  clearFileBackrefs(projectId: number): void {
    this.db.query("DELETE FROM file_backrefs WHERE project_id = ?").run(projectId);
  }
}
