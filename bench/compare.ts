// Side-by-side comparison runner for Spindle Phase B benchmarks.
// Runs both the Spindle tool pipeline and the grep+read baseline against the
// same corpus, then aligns results by query id and computes token ratios.

// To suppress pino logs, set SFDX_GRAPH_LOG_LEVEL=silent before invoking
// (the `bench` npm script does this).

import { runBench } from "./runner.ts";
import { runGrepBaseline } from "./grep-baseline.ts";
import type { BenchReport } from "./runner.ts";
import type { GrepBaselineReport } from "./grep-baseline.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CompareRow = {
  queryId: string;
  spindleTokens: number;
  grepTokens: number;
  ratio: number;
  spindleMs: number;
  grepMs: number;
};

export type CompareReport = {
  corpusRoot: string;
  indexLatencyMs: number;
  indexNodeCount: number;
  indexEdgeCount: number;
  rows: CompareRow[];
  spindleResult: BenchReport;
  grepResult: GrepBaselineReport;
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runCompare(opts: {
  corpusRoot: string;
}): Promise<CompareReport> {
  const { corpusRoot } = opts;

  // Run Spindle benchmark against the corpus.
  const spindleReport = await runBench({ fixturePath: corpusRoot });

  // Run grep baseline against the same corpus.
  const grepReport = await runGrepBaseline({ corpusRoot });

  // Align by query id.
  const grepMap = new Map<string, (typeof grepReport.results)[number]>();
  for (const r of grepReport.results) {
    grepMap.set(r.queryId, r);
  }

  const rows: CompareRow[] = [];
  for (const sq of spindleReport.queries) {
    const gr = grepMap.get(sq.id);
    const grepTokens = gr?.tokensApprox ?? 0;
    const grepMs = gr?.latencyMs ?? 0;

    // ratio: spindleTokens / grepTokens. Guard against division by zero.
    const ratio = grepTokens > 0 ? sq.responseTokensApprox / grepTokens : 0;

    rows.push({
      queryId: sq.id,
      spindleTokens: sq.responseTokensApprox,
      grepTokens,
      ratio,
      spindleMs: sq.latencyMs,
      grepMs,
    });
  }

  return {
    corpusRoot,
    indexLatencyMs: spindleReport.indexLatencyMs,
    indexNodeCount: spindleReport.indexNodeCount,
    indexEdgeCount: spindleReport.indexEdgeCount,
    rows,
    spindleResult: spindleReport,
    grepResult: grepReport,
  };
}
