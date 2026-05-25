// Pass 1: Structural node ingestion.
// For each discovered file: skip if content hash matches stored hash (incremental),
// otherwise dispatch to the appropriate parser and write nodes in a single transaction,
// replacing stale nodes. Source reading is the dispatcher's responsibility — single-file
// kinds read inline, bundle kinds (LWC, Aura) read their own file list.

import type { ParsedEdge, UnresolvedRef } from "../parsers/apex/types.ts";
import type { GraphStore } from "../graph/store.ts";
import type { DiscoveredFile } from "./discover.ts";
import { parseFile } from "./parse-dispatch.ts";
import { logger } from "../util/logger.ts";

export type Pass1Result = {
  insertedFilesCount: number;
  parsedFilesCount: number;
  allUnresolved: UnresolvedRef[];
  allInFileEdges: ParsedEdge[];
  warnings: { file: string; message: string; line: number }[];
};

export function runPass1(
  projectId: number,
  files: DiscoveredFile[],
  store: GraphStore,
  forceReindex: boolean,
): Pass1Result {
  let insertedFilesCount = 0;
  let parsedFilesCount = 0;
  const allUnresolved: UnresolvedRef[] = [];
  const allInFileEdges: ParsedEdge[] = [];
  const warnings: { file: string; message: string; line: number }[] = [];

  for (const file of files) {
    if (!forceReindex) {
      const stored = store.getFileHash(projectId, file.relativePath);
      if (stored === file.contentHash) {
        logger.debug({ file: file.relativePath }, "pass1: skipping unchanged file");
        continue;
      }
    }

    parsedFilesCount++;

    let parsed;
    try {
      parsed = parseFile(file);
    } catch (err) {
      warnings.push({
        file: file.relativePath,
        message: `Cannot parse file: ${(err as Error).message}`,
        line: 0,
      });
      continue;
    }

    for (const w of parsed.warnings) {
      warnings.push({ file: file.relativePath, message: w.message, line: w.line });
    }

    store.transaction(() => {
      // Delete stale nodes (cascade removes their edges).
      store.deleteNodesFromFile(projectId, file.absolutePath);

      for (const node of parsed.nodes) {
        store.insertNode({
          projectId,
          label: node.label,
          name: node.name,
          qualifiedName: node.qualifiedName,
          filePath: file.absolutePath,
          startLine: node.startLine,
          endLine: node.endLine,
          properties: node.properties,
          contentHash: file.contentHash,
        });
      }

      store.setFileHash(projectId, file.relativePath, file.contentHash);
    });

    insertedFilesCount++;
    allUnresolved.push(...parsed.unresolved);
    allInFileEdges.push(...parsed.edges);

    logger.debug(
      {
        file: file.relativePath,
        nodes: parsed.nodes.length,
        unresolved: parsed.unresolved.length,
        edges: parsed.edges.length,
      },
      "pass1: parsed file",
    );
  }

  return {
    insertedFilesCount,
    parsedFilesCount,
    allUnresolved,
    allInFileEdges,
    warnings,
  };
}
