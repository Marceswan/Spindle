// Pipeline orchestrator. Coordinates all four passes for a full or incremental index run.
// Returns a summary of what was done; callers (CLI and MCP tool) format it for output.

import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

import { discoverApexFiles, readProjectManifest, type DiscoveredFile } from "./discover.ts";
import { runPass1 } from "./pass1-structural.ts";
import { runPass2 } from "./pass2-intra-domain.ts";
import { runPass3 } from "./pass3-cross-domain.ts";
import { runPass4 } from "./pass4-reverse-index.ts";
import { getNodeCounts, getEdgeCounts } from "../graph/queries.ts";
import type { GraphStore } from "../graph/store.ts";
import { logger } from "../util/logger.ts";

export type IndexProjectOptions = {
  mode: "full" | "incremental";
};

export type IndexProjectResult = {
  filesParsed: number;
  nodesWritten: number;
  edgesWritten: number;
  durationMs: number;
  warnings: { file: string; message: string; line: number }[];
};

// One project has one row. A symlinked path, a relative path and a path with a trailing
// slash must all map to the row of the real directory.
export function canonicalProjectRoot(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  try { return realpathSync(absolute); } catch { return absolute; }
}

// Removes the nodes and hashes of files that are no longer in the project. Returns the
// absolute paths of the removed files.
function removeDeletedFiles(projectId: number, projectRoot: string, files: DiscoveredFile[], store: GraphStore): string[] {
  const present = new Set(files.map((f) => f.absolutePath));
  const presentRelative = new Set(files.map((f) => f.relativePath));
  const removed = store.getIndexedFilePaths(projectId).filter((path) => !present.has(path));
  const staleHashes = store.getHashedFilePaths(projectId).filter((path) => !presentRelative.has(path));
  if (removed.length === 0 && staleHashes.length === 0) return removed;
  store.transaction(() => {
    for (const path of removed) store.deleteNodesFromFile(projectId, path);
    for (const path of staleHashes) store.deleteFileHash(projectId, path);
  });
  logger.info({ projectRoot, removedFiles: removed.length }, "index-project: removed deleted files");
  return removed;
}

export async function indexProject(
  rawProjectRoot: string,
  store: GraphStore,
  opts: IndexProjectOptions,
): Promise<IndexProjectResult> {
  const start = Date.now();
  const projectRoot = canonicalProjectRoot(rawProjectRoot);
  logger.info({ projectRoot, mode: opts.mode }, "index-project: starting");

  // Read manifest to get project name and API version.
  const manifest = readProjectManifest(projectRoot);
  const projectName = basename(projectRoot);
  const apiVersion = manifest.sourceApiVersion ?? null;

  store.adoptProjectAlias(projectRoot, (rootPath) => canonicalProjectRoot(rootPath) === projectRoot);
  const projectId = store.upsertProject(projectRoot, projectName, apiVersion);

  // Discover files.
  const files = await discoverApexFiles(projectRoot);
  logger.info({ fileCount: files.length }, "index-project: discovered files");

  const forceReindex = opts.mode === "full";
  // A full index writes the reverse index again from the current edges.
  if (forceReindex) store.clearFileBackrefs(projectId);
  const removedFiles = removeDeletedFiles(projectId, projectRoot, files, store);

  // Pass 1: structural nodes.
  const pass1 = runPass1(projectId, files, store, forceReindex);

  // A file whose nodes appeared or disappeared changes how other files resolve. The
  // reverse index names the files that referred to it; parse those again too. Their own
  // nodes do not change, so one round is sufficient.
  if (!forceReindex) {
    const targets = [...pass1.symbolChangedFiles, ...removedFiles];
    const referring = targets.length > 0 ? store.getReferringFiles(projectId, targets) : new Set<string>();
    const dependents = files.filter((f) => referring.has(f.absolutePath) && !pass1.parsedFiles.has(f.absolutePath));
    if (dependents.length > 0) {
      const extra = runPass1(projectId, dependents, store, true);
      pass1.parsedFilesCount += extra.parsedFilesCount;
      pass1.insertedFilesCount += extra.insertedFilesCount;
      // Loops, not spread: a large referring set can exceed the argument limit.
      for (const ref of extra.allUnresolved) pass1.allUnresolved.push(ref);
      for (const edge of extra.allInFileEdges) pass1.allInFileEdges.push(edge);
      for (const warning of extra.warnings) pass1.warnings.push(warning);
      logger.info({ dependents: dependents.length }, "index-project: reparsed referring files");
    }
  }
  logger.info(
    { inserted: pass1.insertedFilesCount, parsed: pass1.parsedFilesCount },
    "index-project: pass1 complete",
  );

  // Pass 2: intra-domain resolution (only if any files were actually re-parsed).
  if (pass1.parsedFilesCount > 0 || opts.mode === "full") {
    runPass2(projectId, pass1.allUnresolved, pass1.allInFileEdges, store);
  }
  if (pass1.parsedFilesCount > 0 || removedFiles.length > 0) store.deleteOrphanPlaceholders(projectId);

  // Pass 3: cross-domain stub.
  runPass3(projectId, [], store);

  // Pass 4: reverse index.
  runPass4(projectId, store);

  const now = Date.now();
  store.markProjectIndexed(projectId, now);

  const nodeCounts = getNodeCounts(store, projectId);
  const edgeCounts = getEdgeCounts(store, projectId);
  const nodesWritten = Object.values(nodeCounts).reduce((a, b) => a + b, 0);
  const edgesWritten = Object.values(edgeCounts).reduce((a, b) => a + b, 0);

  const durationMs = now - start;
  logger.info({ projectId, nodesWritten, edgesWritten, durationMs }, "index-project: complete");

  return {
    filesParsed: pass1.parsedFilesCount,
    nodesWritten,
    edgesWritten,
    durationMs,
    warnings: pass1.warnings,
  };
}
