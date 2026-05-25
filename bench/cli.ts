// Bench CLI entry point.
//
// Subcommands:
//   bun run bench                              Phase A: run against sample fixture
//   bun run bench/cli.ts --fixture <path>      Phase A: run against specified fixture
//   bun run bench/cli.ts --generate --size 100 [--out <path>]
//                                              Generate a synthetic corpus
//   bun run bench/cli.ts --compare --corpus <path>
//                                              Run Spindle + grep baseline against corpus
//   bun run bench/cli.ts --compare --size 100  Generate ephemeral corpus + compare + clean up
//
// Writes the Markdown report to stdout.
// Exit code: 0 on success, 1 on failure.

import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";

import { runBench } from "./runner.ts";
import { formatReport } from "./report.ts";
import { generateCorpus } from "./corpus.ts";
import { runCompare } from "./compare.ts";
import { formatCompareReport } from "./compare-report.ts";

const DEFAULT_FIXTURE = join(
  import.meta.dir,
  "..",
  "test",
  "fixtures",
  "sample-sfdx-project",
);

type CliMode =
  | { kind: "phase-a"; fixturePath: string }
  | { kind: "generate"; size: number; outPath: string }
  | { kind: "compare-corpus"; corpusPath: string }
  | { kind: "compare-ephemeral"; size: number };

function parseCliArgs(): CliMode {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      fixture: { type: "string" },
      generate: { type: "boolean" },
      compare: { type: "boolean" },
      size: { type: "string" },
      out: { type: "string" },
      corpus: { type: "string" },
    },
    strict: false,
  });

  const isGenerate = values["generate"] === true;
  const isCompare = values["compare"] === true;
  const sizeRaw = typeof values["size"] === "string" ? parseInt(values["size"], 10) : NaN;
  const size = isNaN(sizeRaw) ? 100 : sizeRaw;

  if (isGenerate) {
    const outPath =
      typeof values["out"] === "string"
        ? values["out"]
        : join(tmpdir(), `spindle-corpus-${size}-${Date.now()}`);
    return { kind: "generate", size, outPath };
  }

  if (isCompare) {
    if (typeof values["corpus"] === "string") {
      return { kind: "compare-corpus", corpusPath: values["corpus"] };
    }
    return { kind: "compare-ephemeral", size };
  }

  return {
    kind: "phase-a",
    fixturePath:
      typeof values["fixture"] === "string" ? values["fixture"] : DEFAULT_FIXTURE,
  };
}

async function main(): Promise<void> {
  const mode = parseCliArgs();

  if (mode.kind === "phase-a") {
    const report = await runBench({ fixturePath: mode.fixturePath });
    const markdown = formatReport(report);
    process.stdout.write(markdown + "\n");
    process.exit(report.queries.some((q) => !q.passed) ? 1 : 0);
    return;
  }

  if (mode.kind === "generate") {
    const corpus = generateCorpus({
      rootDir: mode.outPath,
      classCount: mode.size,
      seed: 42,
    });
    process.stdout.write(
      `Generated corpus: ${corpus.classCount} classes, ${corpus.triggerCount} triggers, ${corpus.totalFiles} total files\n`,
    );
    process.stdout.write(`  Root: ${corpus.rootDir}\n`);
    process.exit(0);
    return;
  }

  if (mode.kind === "compare-corpus") {
    const report = await runCompare({ corpusRoot: mode.corpusPath });
    process.stdout.write(formatCompareReport(report) + "\n");
    process.exit(0);
    return;
  }

  // compare-ephemeral: generate a temp corpus, compare, clean up.
  const tempDir = mkdtempSync(join(tmpdir(), `spindle-corpus-${mode.size}-`));
  try {
    generateCorpus({ rootDir: tempDir, classCount: mode.size, seed: 42 });
    const report = await runCompare({ corpusRoot: tempDir });
    process.stdout.write(formatCompareReport(report) + "\n");
    process.exit(0);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `bench error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
