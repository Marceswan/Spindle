// Pass 1: Structural node ingestion.
// For each discovered file: skip if content hash matches stored hash (incremental),
// otherwise dispatch to the appropriate parser and write its nodes in one transaction.
// Source reading is the dispatcher's responsibility — single-file kinds read inline,
// bundle kinds (LWC, Aura) read their own file list.
//
// A reparse keeps the id of every node that still exists. Edges from other files point
// at those ids, so they stay valid without a reparse of the other files. Only the nodes
// that are gone are deleted, and only the edges that start in this file are rewritten.

import type { ParsedEdge, ParsedNode, UnresolvedRef } from "../parsers/apex/types.ts";
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
  // Absolute paths of the files that this pass parsed, and the subset whose set of nodes
  // changed (a node appeared or disappeared). Files that refer to the second set can hold
  // references that now resolve differently.
  parsedFiles: Set<string>;
  symbolChangedFiles: string[];
};

function isPlaceholder(node: ParsedNode): boolean {
  return node.properties?.["isPlaceholder"] === true;
}

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
  const parsedFiles = new Set<string>();
  const symbolChangedFiles: string[] = [];

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

    const symbolsChanged = store.transaction(() => {
      const before = new Set(store.getNodeIdsForFile(projectId, file.absolutePath));
      const kept = new Set<number>();
      let created = false;

      for (const node of parsed.nodes) {
        const input = {
          projectId,
          label: node.label,
          name: node.name,
          qualifiedName: node.qualifiedName,
          properties: node.properties,
        };
        if (isPlaceholder(node)) {
          // Keep the id: a database from an older version has the placeholder in `before`,
          // because that version stored it with the path of this file.
          kept.add(store.ensurePlaceholderNode(input));
          continue;
        }
        const id = store.insertNode({
          ...input,
          filePath: file.absolutePath,
          startLine: node.startLine,
          endLine: node.endLine,
          contentHash: file.contentHash,
        });
        kept.add(id);
        if (!before.has(id)) created = true;
      }

      const stale = [...before].filter((id) => !kept.has(id));
      store.deleteNodesById(stale);
      store.deleteOutgoingEdgesFromFile(projectId, file.absolutePath);
      store.setFileHash(projectId, file.relativePath, file.contentHash);
      return created || stale.length > 0;
    });

    insertedFilesCount++;
    parsedFiles.add(file.absolutePath);
    if (symbolsChanged) symbolChangedFiles.push(file.absolutePath);
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
    parsedFiles,
    symbolChangedFiles,
  };
}
