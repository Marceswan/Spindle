// Grep+read baseline simulator for Spindle Phase B benchmarks.
//
// For each canonical query, simulates what an agent without Spindle would do:
// grep for a pattern across the corpus, then "read" (stat) each matched file.
// Token cost = Math.ceil(totalBytesRead / 4).
//
// We use child_process.spawn (NOT exec) to avoid shell injection.

// Suppress pino logs before any src/ imports.
process.env["SFDX_GRAPH_LOG_LEVEL"] = "silent";

import { statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { QUERIES } from "./queries.ts";
import type { BenchQuery } from "./queries.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GrepQueryResult = {
  queryId: string;
  filesMatched: number;
  totalBytesRead: number;
  tokensApprox: number;
  latencyMs: number;
};

export type GrepBaselineReport = {
  corpusRoot: string;
  results: GrepQueryResult[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `grep -rln <pattern> <dir>` via spawn (no shell) and return the list
 * of matched file paths. Returns [] if grep exits with code 1 (no matches).
 * Throws on other non-zero exit codes.
 */
function runGrep(pattern: string, searchDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const proc = spawn("grep", ["-rln", pattern, searchDir]);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    proc.on("close", (code) => {
      const _ = start; // referenced to avoid unused warning
      if (code === 0 || code === 1) {
        // code 1 = no matches (normal)
        const output = Buffer.concat(chunks).toString("utf8").trim();
        const files = output.length > 0 ? output.split("\n").filter(Boolean) : [];
        resolve(files);
      } else {
        reject(new Error(`grep exited with code ${code}: ${Buffer.concat(errChunks).toString("utf8").trim()}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

/**
 * Stat a file and return its byte size. Returns 0 if the file cannot be read.
 */
function fileSizeBytes(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * For get_schema (grepPattern === null), simulate an `ls -R classes/` by
 * returning the total byte length of all file names in the classes dir.
 * We don't read file contents — just enumerate names.
 */
function lsSchemaBytes(corpusRoot: string): number {
  const classesDir = join(corpusRoot, "force-app", "main", "default", "classes");
  let bytes = 0;
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(classesDir);
    for (const name of entries) {
      bytes += (name as string).length + 1; // +1 for newline
    }
  } catch {
    // dir doesn't exist in the fixture — return a small constant
    bytes = 512;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Search directories: classes, triggers, lwc, pages, aura, objects
// ---------------------------------------------------------------------------

function searchDirForKind(corpusRoot: string, queryTool: string): string {
  const base = join(corpusRoot, "force-app", "main", "default");
  // For field usage, search broadly. For class/trigger searches, focus dirs.
  if (queryTool === "get_field_usage") {
    // broadest search possible
    return base;
  }
  if (queryTool === "search_graph") {
    return join(base, "classes");
  }
  if (queryTool === "trace_references") {
    return join(base, "classes");
  }
  if (queryTool === "get_source_snippet") {
    return join(base, "classes");
  }
  // fallback
  return base;
}

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------

async function simulateQuery(
  query: BenchQuery,
  corpusRoot: string,
): Promise<GrepQueryResult> {
  const tStart = process.hrtime.bigint();

  let filesMatched = 0;
  let totalBytesRead = 0;

  if (query.grepPattern === null) {
    // get_schema equivalent: ls the classes directory, count file name bytes.
    totalBytesRead = lsSchemaBytes(corpusRoot);
    filesMatched = 0;
  } else {
    const searchDir = searchDirForKind(corpusRoot, query.tool);
    let matchedFiles: string[] = [];

    try {
      matchedFiles = await runGrep(query.grepPattern, searchDir);
    } catch {
      // If grep fails entirely (e.g. directory absent), treat as 0 matches.
      matchedFiles = [];
    }

    filesMatched = matchedFiles.length;

    // For get_source_snippet: grep finds the file, agent reads the ONE file.
    // For all others: agent reads every matched file in full.
    for (const filePath of matchedFiles) {
      totalBytesRead += fileSizeBytes(filePath);
    }
  }

  const tEnd = process.hrtime.bigint();
  const latencyMs = Number(tEnd - tStart) / 1_000_000;

  return {
    queryId: query.id,
    filesMatched,
    totalBytesRead,
    tokensApprox: Math.ceil(totalBytesRead / 4),
    latencyMs: Math.round(latencyMs * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runGrepBaseline(opts: {
  corpusRoot: string;
}): Promise<GrepBaselineReport> {
  const results: GrepQueryResult[] = [];

  for (const query of QUERIES) {
    const result = await simulateQuery(query, opts.corpusRoot);
    results.push(result);
  }

  return { corpusRoot: opts.corpusRoot, results };
}
