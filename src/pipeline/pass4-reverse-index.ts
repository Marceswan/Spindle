// Pass 4: Reverse index build.
// For each edge whose source and target files differ, records a row in file_backrefs
// so incremental reindex can find which files need pass-3 rerun when a source file changes.

import type { GraphStore } from "../graph/store.ts";
import { logger } from "../util/logger.ts";

export type Pass4Diagnostics = {
  backrefRowsInserted: number;
};

export function runPass4(projectId: number, store: GraphStore): Pass4Diagnostics {
  // Find all edges where source node file differs from target node file.
  type BackrefRow = {
    source_file: string;
    target_file: string;
  };

  const rows = store.db
    .query<BackrefRow, [number]>(
      `SELECT DISTINCT sn.file_path AS source_file, tn.file_path AS target_file
       FROM edges e
       JOIN nodes sn ON sn.id = e.source_id
       JOIN nodes tn ON tn.id = e.target_id
       WHERE e.project_id = ?
         AND sn.file_path IS NOT NULL
         AND tn.file_path IS NOT NULL
         AND sn.file_path != tn.file_path`,
    )
    .all(projectId);

  let backrefRowsInserted = 0;

  store.transaction(() => {
    const stmt = store.db.prepare(
      `INSERT OR IGNORE INTO file_backrefs (project_id, target_file, referring_file)
       VALUES (?, ?, ?)`,
    );

    for (const row of rows) {
      stmt.run(projectId, row.target_file, row.source_file);
      backrefRowsInserted++;
    }
  });

  logger.info({ projectId, backrefRowsInserted }, "pass4: reverse index built");
  return { backrefRowsInserted };
}
