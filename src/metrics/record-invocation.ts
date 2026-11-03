// Thin glue: estimate savings for a completed tool call and insert a tool_invocation row.
// Must never throw into the caller — a metrics failure must not break a tool response.

import type { GraphStore } from "../graph/store.ts";
import { estimateSavings } from "./estimate-savings.ts";
import { logger } from "../util/logger.ts";

export type RecordArgs = {
  projectId: number | null;
  toolName: string;
  params: unknown;
  durationMs: number;
  resultJson: string;
  now: number;
  disabled?: boolean;
  fileSize?: (p: string) => number;
};

export function metricsDisabled(): boolean {
  return process.env["SFDX_GRAPH_NO_METRICS"] === "1";
}

export function recordInvocation(store: GraphStore, args: RecordArgs): void {
  if (args.disabled ?? metricsDisabled()) return;
  try {
    const est = estimateSavings(
      args.toolName,
      args.resultJson,
      args.fileSize ? { fileSize: args.fileSize } : {},
    );
    store.recordToolInvocation({
      projectId: args.projectId,
      toolName: args.toolName,
      paramsJson: safeParams(args.toolName, args.params),
      durationMs: args.durationMs,
      resultTokens: est.resultTokens,
      baselineTokens: est.baselineTokens,
      tokensSaved: est.tokensSaved,
      method: est.method,
      createdAt: args.now,
    });
  } catch (err) {
    logger.warn({ err, toolName: args.toolName }, "metrics record failed (ignored)");
  }
}

function safeParams(toolName: string, params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const input = params as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof input["project_id"] === "number") safe["project_id"] = input["project_id"];
  const keys = toolName === "get_field_usage" ? ["field"] : toolName === "get_source_snippet" ? ["qualified_name"] : [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:()<> ,\[\]]{0,499}$/.test(value)) safe[key] = value;
  }
  return Object.keys(safe).length ? JSON.stringify(safe) : null;
}
