// Pure estimator for "how many grep+read tokens did this Spindle call avoid?"
//
// Two methods:
//  - result-aware: if the result references files (any nested `file_path`), the grep+read
//    baseline is the bytes of those files / 4 (chars-per-token heuristic) plus a small
//    per-file allowance for grep output the agent would have scanned.
//  - multiplier: otherwise, scale the result's own token size by a per-tool constant.
//
// All numbers are estimates; the UI labels them as such and surfaces `method`.

import { statSync } from "node:fs";
import { BASELINE_MULTIPLIERS, DEFAULT_MULTIPLIER } from "./baseline-multipliers.ts";

export type SavingsMethod = "result-aware" | "multiplier";

export type SavingsEstimate = {
  resultTokens: number;
  baselineTokens: number;
  tokensSaved: number;
  method: SavingsMethod;
};

type EstimateOpts = {
  fileSize?: (path: string) => number;
  multipliers?: Record<string, number>;
};

const GREP_ALLOWANCE_PER_FILE = 50; // tokens of grep match output the agent would scan per file
const BYTES_PER_TOKEN = 4;

export function collectFilePaths(value: unknown, acc: Set<string> = new Set()): string[] {
  if (value === null || value === undefined) return [...acc];
  if (Array.isArray(value)) {
    for (const item of value) collectFilePaths(item, acc);
    return [...acc];
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === "file_path" || k === "filePath") && typeof v === "string" && v.length > 0) {
        acc.add(v);
      } else {
        collectFilePaths(v, acc);
      }
    }
  }
  return [...acc];
}

function safeFileSize(path: string, fileSize: (p: string) => number): number {
  try {
    return fileSize(path);
  } catch {
    return 0;
  }
}

export function estimateSavings(
  toolName: string,
  resultJson: string,
  opts: EstimateOpts = {},
): SavingsEstimate {
  const fileSize = opts.fileSize ?? ((p: string) => statSync(p).size);
  const multipliers = opts.multipliers ?? BASELINE_MULTIPLIERS;

  const resultTokens = Math.ceil(Buffer.byteLength(resultJson, "utf8") / BYTES_PER_TOKEN);

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    parsed = null;
  }
  const files = collectFilePaths(parsed);

  let baselineTokens: number;
  let method: SavingsMethod;
  if (files.length > 0) {
    let totalBytes = 0;
    for (const f of files) totalBytes += safeFileSize(f, fileSize);
    baselineTokens = Math.ceil(totalBytes / BYTES_PER_TOKEN) + files.length * GREP_ALLOWANCE_PER_FILE;
    method = "result-aware";
  } else {
    const m = multipliers[toolName] ?? DEFAULT_MULTIPLIER;
    baselineTokens = resultTokens * m;
    method = "multiplier";
  }

  return {
    resultTokens,
    baselineTokens,
    tokensSaved: Math.max(0, baselineTokens - resultTokens),
    method,
  };
}
