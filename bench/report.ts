// Formats a BenchReport into a Markdown string suitable for stdout or file output.

import type { BenchReport, QueryResult } from "./runner.ts";

export function formatReport(report: BenchReport): string {
  const lines: string[] = [];

  // --- Header section -------------------------------------------------------
  lines.push("# Spindle Benchmark Report");
  lines.push("");
  lines.push("## Index Phase");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Index latency | ${report.indexLatencyMs.toFixed(3)} ms |`);
  lines.push(`| Nodes written | ${report.indexNodeCount} |`);
  lines.push(`| Edges written | ${report.indexEdgeCount} |`);
  lines.push(`| Peak heap delta | ${report.indexPeakHeapMb.toFixed(2)} MB |`);
  lines.push("");

  // --- Query results table --------------------------------------------------
  lines.push("## Query Results");
  lines.push("");
  lines.push(
    "| Query ID | Tool | Latency (ms) | Tokens | Recall | False Pos | Passed |",
  );
  lines.push(
    "|----------|------|-------------|--------|--------|-----------|--------|",
  );

  for (const q of report.queries) {
    lines.push(formatQueryRow(q));
  }
  lines.push("");

  // --- Summary line ---------------------------------------------------------
  const total = report.queries.length;
  const passed = report.queries.filter((q) => q.passed).length;
  lines.push(`**${passed}/${total} queries passed**`);
  lines.push("");

  // Append errors if any.
  const errored = report.queries.filter((q) => q.error !== undefined);
  if (errored.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const q of errored) {
      lines.push(`- **${q.id}**: ${q.error ?? ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatQueryRow(q: QueryResult): string {
  const latency = q.latencyMs.toFixed(3);
  const recall = (q.recall * 100).toFixed(0) + "%";
  const passed = q.passed ? "YES" : "NO";
  return `| ${q.id} | ${q.tool} | ${latency} | ${q.responseTokensApprox} | ${recall} | ${q.falsePositives} | ${passed} |`;
}
