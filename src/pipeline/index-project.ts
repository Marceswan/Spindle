// Pipeline orchestrator. Coordinates all four passes for a full or incremental index run.
// Returns a summary of what was done; callers (CLI and MCP tool) format it for output.

import { basename } from "node:path";

import { discoverApexFiles, readProjectManifest } from "./discover.ts";
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

  // Pass 1: structural nodes.
  const forceReindex = opts.mode === "full";
  const pass1 = runPass1(projectId, files, store, forceReindex);
  logger.info(
    { inserted: pass1.insertedFilesCount, parsed: pass1.parsedFilesCount },
    "index-project: pass1 complete",
  );

  // Pass 2: intra-domain resolution (only if any files were actually re-parsed).
  if (pass1.parsedFilesCount > 0 || opts.mode === "full") {
    runPass2(projectId, pass1.allUnresolved, pass1.allInFileEdges, store);
  }

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
