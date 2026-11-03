// Pipeline orchestrator. Coordinates all four passes for a full or incremental index run.
// Returns a summary of what was done; callers (CLI and MCP tool) format it for output.

import { basename } from "node:path";

import { discoverApexFiles, readProjectManifest } from "./discover.ts";
import { parseFile } from "./parse-dispatch.ts";
import { runPass1 } from "./pass1-structural.ts";
import { runPass2 } from "./pass2-intra-domain.ts";
import { runPass3 } from "./pass3-cross-domain.ts";
import { runPass4 } from "./pass4-reverse-index.ts";
import { runPassTsResolve } from "./pass-ts-resolve.ts";
import { getAllNodesForProject, getNodeCounts, getEdgeCounts } from "../graph/queries.ts";
import type { GraphStore } from "../graph/store.ts";
import { NodeLabel } from "../model/node-labels.ts";
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

export async function indexProject(
  projectRoot: string,
  store: GraphStore,
  opts: IndexProjectOptions,
): Promise<IndexProjectResult> {
  const start = Date.now();
  logger.info({ projectRoot, mode: opts.mode }, "index-project: starting");

  // Read manifest to get project name and API version.
  const manifest = readProjectManifest(projectRoot);
  const projectName = basename(projectRoot);
  const apiVersion = manifest.sourceApiVersion ?? null;

  const projectId = store.upsertProject(projectRoot, projectName, apiVersion);

  // Discover files.
  const files = await discoverApexFiles(projectRoot);
  logger.info({ fileCount: files.length }, "index-project: discovered files");

  const previous = store.db.query<{ file_path: string; content_hash: string }, [number]>(
    "SELECT file_path, content_hash FROM file_hashes WHERE project_id = ?",
  ).all(projectId);
  const hashes = new Map(previous.map((f) => [f.file_path, f.content_hash]));
  const changed = opts.mode === "full" || previous.length !== files.length ||
    files.some((f) => hashes.get(f.relativePath) !== f.contentHash);
  let filesParsed = 0;
  let warnings: IndexProjectResult["warnings"] = [];
  if (changed) {
    // Prepare outside the write transaction; unexpected parser failures retain the old graph.
    const prepared = new Map(files.map((file) => [file.relativePath, parseFile(file)]));
    store.transaction(() => {
      // Rebuild all references, including those from unchanged referrers and removed files.
      store.clearProjectGraph(projectId);
      const pass1 = runPass1(projectId, files, store, true, prepared);
      filesParsed = pass1.parsedFilesCount;
      warnings = pass1.warnings;
      runPass2(projectId, pass1.allUnresolved, pass1.allInFileEdges, store);
      const bundles = getAllNodesForProject(store, projectId).filter((n) => n.label === NodeLabel.UiBundle);
      if (bundles.length) runPassTsResolve(projectId, store, bundles);
      runPass3(projectId, [], store);
      runPass4(projectId, store);
      store.markProjectIndexed(projectId, Date.now());
    });
  }
  const now = Date.now();

  const nodeCounts = getNodeCounts(store, projectId);
  const edgeCounts = getEdgeCounts(store, projectId);
  const nodesWritten = Object.values(nodeCounts).reduce((a, b) => a + b, 0);
  const edgesWritten = Object.values(edgeCounts).reduce((a, b) => a + b, 0);

  const durationMs = now - start;
  logger.info({ projectId, nodesWritten, edgesWritten, durationMs }, "index-project: complete");

  return {
    filesParsed,
    nodesWritten,
    edgesWritten,
    durationMs,
    warnings,
  };
}
