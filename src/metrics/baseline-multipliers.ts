// Fallback "grep+read tokens / spindle tokens" ratios for tools whose results carry no
// file paths (so the result-aware estimator can't sum file bytes). Conservative on purpose
// to avoid overclaiming. Grounded in bench/README.md Phase B (Spindle ~= 25% of grep tokens
// on the 100-class corpus => ~4x; larger corpora measured far higher, see global benchmark).
// We deliberately stay near the low end for the multiplier fallback.

export const BASELINE_MULTIPLIERS: Record<string, number> = {
  search_graph: 12,
  query_graph: 12,
  get_schema: 8,
  trace_references: 20,
  get_source_snippet: 4,
  get_field_usage: 20,
  get_permission_access: 15,
  list_projects: 1, // effectively no savings
  index_project: 1,
};

export const DEFAULT_MULTIPLIER = 10;
