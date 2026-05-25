import { describe, expect, test, setDefaultTimeout } from "bun:test";

// Index + 8 queries against the real fixture; allow up to 30 s under contention.
setDefaultTimeout(30_000);

import { join } from "node:path";

import { runBench } from "../../bench/runner.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "sample-sfdx-project");

describe("runBench smoke test", () => {
  test("returns a non-empty report with indexNodeCount > 0 and all query slots populated", async () => {
    const report = await runBench({ fixturePath: FIXTURE_DIR });

    expect(report.indexNodeCount).toBeGreaterThan(0);
    expect(report.indexEdgeCount).toBeGreaterThan(0);
    expect(report.indexLatencyMs).toBeGreaterThan(0);
    expect(report.queries.length).toBeGreaterThan(0);

    // Every query entry must have an id and a tool name.
    for (const q of report.queries) {
      expect(typeof q.id).toBe("string");
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.tool).toBe("string");
      expect(q.latencyMs).toBeGreaterThanOrEqual(0);
      expect(q.recall).toBeGreaterThanOrEqual(0);
      expect(q.recall).toBeLessThanOrEqual(1);
      expect(q.falsePositives).toBeGreaterThanOrEqual(0);
    }
  });
});
