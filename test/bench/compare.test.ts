import { describe, expect, test, setDefaultTimeout } from "bun:test";

// Generate a 20-class corpus, index it, run grep baseline — allow generous time.
setDefaultTimeout(60_000);

import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { generateCorpus } from "../../bench/corpus.ts";
import { runCompare } from "../../bench/compare.ts";
import { QUERIES } from "../../bench/queries.ts";

describe("Phase B: runCompare smoke test", () => {
  test("generates a 20-class corpus, runs compare, validates report shape", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "spindle-compare-test-"));

    try {
      // Generate corpus.
      const corpus = generateCorpus({
        rootDir: join(tempDir, "corpus"),
        classCount: 20,
        seed: 7,
      });

      expect(corpus.classCount).toBeGreaterThanOrEqual(20);
      expect(corpus.triggerCount).toBeGreaterThan(0);
      expect(corpus.totalFiles).toBeGreaterThan(0);

      // Run compare.
      const report = await runCompare({ corpusRoot: corpus.rootDir });

      // All expected query ids present in Spindle results.
      const expectedIds = QUERIES.map((q) => q.id);
      const spindleIds = report.spindleResult.queries.map((q) => q.id);
      for (const id of expectedIds) {
        expect(spindleIds).toContain(id);
      }

      // All expected query ids present in grep results.
      const grepIds = report.grepResult.results.map((r) => r.queryId);
      for (const id of expectedIds) {
        expect(grepIds).toContain(id);
      }

      // rows array aligns with the number of queries.
      expect(report.rows.length).toBe(expectedIds.length);

      // Sanity check: for at least one query, Spindle uses fewer tokens than grep.
      // (If this fails it means either Spindle output grew unexpectedly or grep
      // baseline is returning 0 for everything.)
      const queriesWithGrepTokens = report.rows.filter((r) => r.grepTokens > 0);
      expect(queriesWithGrepTokens.length).toBeGreaterThan(0);

      const spindleWins = report.rows.some(
        (r) => r.grepTokens > 0 && r.spindleTokens < r.grepTokens,
      );
      expect(spindleWins).toBe(true);

      // ratios are non-negative numbers.
      for (const row of report.rows) {
        expect(row.ratio).toBeGreaterThanOrEqual(0);
        expect(row.spindleTokens).toBeGreaterThanOrEqual(0);
        expect(row.grepTokens).toBeGreaterThanOrEqual(0);
      }
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
