// Formats a CompareReport as a Markdown table for stdout.

import type { CompareReport } from "./compare.ts";

export function formatCompareReport(report: CompareReport): string {
  const lines: string[] = [];

  lines.push("# Spindle vs Grep+Read Baseline");
  lines.push("");

  // --- Comparison table -----------------------------------------------------
  lines.push(
    "| Query | Spindle (tokens / ms) | Grep+Read (tokens / ms) | Token ratio | Speedup |",
  );
  lines.push(
    "|-------|----------------------|--------------------------|-------------|---------|",
  );

  for (const row of report.rows) {
    const spindleCell = `${row.spindleTokens} / ${row.spindleMs.toFixed(2)}`;
    const grepCell = `${row.grepTokens} / ${row.grepMs.toFixed(2)}`;
    const ratioCell = row.grepTokens > 0 ? `${(row.ratio * 100).toFixed(1)}%` : "N/A";
    const speedup =
      row.grepMs > 0 && row.spindleMs > 0
        ? `${(row.grepMs / row.spindleMs).toFixed(1)}x`
        : row.grepMs > 0
          ? ">100x"
          : "N/A";
    lines.push(
      `| ${row.queryId} | ${spindleCell} | ${grepCell} | ${ratioCell} | ${speedup} |`,
    );
  }

  lines.push("");

  // --- Footer ---------------------------------------------------------------
  const classCount = report.indexNodeCount;
  const indexSec = (report.indexLatencyMs / 1000).toFixed(1);

  // Average ratio across queries where grepTokens > 0.
  const ratioRows = report.rows.filter((r) => r.grepTokens > 0);
  const avgRatio =
    ratioRows.length > 0
      ? ratioRows.reduce((s, r) => s + r.ratio, 0) / ratioRows.length
      : 0;

  const minRatio = ratioRows.length > 0 ? Math.min(...ratioRows.map((r) => r.ratio)) : 0;
  const maxRatio = ratioRows.length > 0 ? Math.max(...ratioRows.map((r) => r.ratio)) : 0;

  // Average speedup across rows where both timings are positive.
  const speedupRows = report.rows.filter((r) => r.grepMs > 0 && r.spindleMs > 0);
  const avgSpeedup =
    speedupRows.length > 0
      ? speedupRows.reduce((s, r) => s + r.grepMs / r.spindleMs, 0) / speedupRows.length
      : 0;

  lines.push(
    `Indexed ${classCount} nodes in ${indexSec}s. ` +
      `Across ${report.rows.length} queries: ` +
      `Spindle uses ${(avgRatio * 100).toFixed(1)}% of grep's tokens on average ` +
      `(range ${(minRatio * 100).toFixed(1)}%-${(maxRatio * 100).toFixed(1)}%), ` +
      `and is ${avgSpeedup.toFixed(0)}x faster.`,
  );
  lines.push("");

  return lines.join("\n");
}
