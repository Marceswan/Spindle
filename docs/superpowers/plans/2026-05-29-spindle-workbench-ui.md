# Spindle Workbench UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first web Workbench (`spindle ui`) that explores the graph and shows live, instrumented token-savings — served by a loopback HTTP server reusing the existing query/tool layer, with the SPA embedded into the compiled binary.

**Architecture:** Two entry points (MCP stdio + `spindle ui`) share one SQLite db and the existing tool handlers. A new `src/metrics/` records every MCP tool call and estimates grep+read tokens avoided into a new `tool_invocation` table. A new `src/web/` exposes `/api/*` (thin wrappers over existing tool handlers + a new neighborhood query) and serves a React/Vite SPA from assets embedded at build time.

**Tech Stack:** TypeScript (strict), Bun (`bun:sqlite`, `Bun.serve`, `bun build --compile`), React + Vite + cytoscape.js (frontend, built to static assets only — no new runtime dep in the binary).

---

## File structure

**New (backend):**
- `src/metrics/baseline-multipliers.ts` — per-tool fallback multipliers (bench-derived).
- `src/metrics/estimate-savings.ts` — pure savings estimator.
- `src/metrics/record-invocation.ts` — writes one `tool_invocation` row (no-op on disable/read-only; never throws).
- `src/web/serve.ts` — loopback HTTP bootstrap + router + browser open.
- `src/web/api.ts` — `/api/*` route handlers (reuse tool handlers + queries).
- `src/web/assets.ts` — serve embedded SPA assets with content types + SPA fallback.
- `src/web/embedded-assets.ts` — **generated** at build; committed as a dev stub.
- `scripts/gen-embedded-assets.ts` — reads `web/dist/` → writes `src/web/embedded-assets.ts`.

**New (frontend, under `web/`):** `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/app.tsx`, `web/src/api.ts`, `web/src/tabs/overview.tsx`, `web/src/tabs/explore.tsx`, `web/src/tabs/field-impact.tsx`, `web/src/tabs/permissions.tsx`, `web/src/styles.css`.

**Modified:**
- `src/graph/schema.ts` — add `tool_invocation` table to DDL; bump `CURRENT_SCHEMA_VERSION` to 2.
- `src/graph/store.ts` — add `recordToolInvocation` + `getSavings`/neighborhood helpers via queries; migration note.
- `src/graph/queries.ts` — add `getNeighborhood` + `getSavingsSummary`.
- `src/server.ts` — wrap dispatch to record metrics.
- `src/cli.ts` — add `ui` subcommand.
- `package.json` — `build:web`, updated `build`.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml` — run `build:web`.
- `sfdx-graph-mcp-design.md` — reconcile NG7 + roadmap; add v1.1 section.

**Tests:** `test/metrics/estimate-savings.test.ts`, `test/metrics/record-invocation.test.ts`, `test/graph/migration-v2.test.ts`, `test/graph/neighborhood.test.ts`, `test/web/api.test.ts`.

---

# Phase 1 — Metrics core

Shippable on its own: records savings even before the UI exists.

### Task 1: `tool_invocation` table + schema version bump

**Files:**
- Modify: `src/graph/schema.ts`
- Test: `test/graph/migration-v2.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/graph/migration-v2.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphStore } from "../../src/graph/store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/graph/schema.ts";

test("fresh db has tool_invocation table and schema version 2", () => {
  const store = new GraphStore(":memory:");
  const cols = store.db
    .query<{ name: string }, []>("PRAGMA table_info(tool_invocation)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("tool_name");
  expect(cols).toContain("tokens_saved");
  expect(cols).toContain("method");
  const v = store.db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  expect(v?.version).toBe(CURRENT_SCHEMA_VERSION);
  expect(CURRENT_SCHEMA_VERSION).toBe(2);
  store.close();
});

test("existing v1 db gains tool_invocation on open (idempotent DDL)", () => {
  // Simulate a v1 db: only the v1 tables, schema_version = 1.
  const path = `/tmp/spindle-mig-${Math.floor(performance.now())}.db`;
  const raw = new Database(path, { create: true });
  raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version (version) VALUES (1);");
  raw.close();
  const store = new GraphStore(path); // applySchema runs IF NOT EXISTS DDL + migration
  const cols = store.db.query<{ name: string }, []>("PRAGMA table_info(tool_invocation)").all();
  expect(cols.length).toBeGreaterThan(0);
  const v = store.db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  expect(v?.version).toBe(2);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/graph/migration-v2.test.ts`
Expected: FAIL — `tool_invocation` table missing; `CURRENT_SCHEMA_VERSION` is 1.

- [ ] **Step 3: Add the table to DDL and bump the version**

In `src/graph/schema.ts`, change `export const CURRENT_SCHEMA_VERSION = 1;` to `= 2;` and append this block inside the `SCHEMA_DDL` template string, before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS tool_invocation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    tool_name TEXT NOT NULL,
    params_json TEXT,
    duration_ms INTEGER,
    result_tokens INTEGER,
    baseline_tokens INTEGER,
    tokens_saved INTEGER,
    method TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_invocation_project ON tool_invocation(project_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocation_created ON tool_invocation(created_at);
```

- [ ] **Step 4: Make `ensureSchemaVersion` advance an existing db's version**

In `src/graph/store.ts`, replace the body comment at the migration site (the `// Migrations from row.version ...` line inside `ensureSchemaVersion`) with:

```ts
    // Idempotent forward migration. applySchema() already ran the IF NOT EXISTS DDL
    // (which adds any new tables to an existing db), so a version bump only needs to
    // advance the stored version row.
    if (row.version < CURRENT_SCHEMA_VERSION) {
      this.db.prepare("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION);
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/graph/migration-v2.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Mirror DDL into `schema.sql` if present, then commit**

If `src/graph/schema.sql` exists, append the same `tool_invocation` block to keep it in sync (it is human-reference only, not loaded at runtime).

```bash
git add src/graph/schema.ts src/graph/store.ts src/graph/schema.sql test/graph/migration-v2.test.ts
git commit -m "feat(metrics): add tool_invocation table + schema v2 migration"
```

---

### Task 2: Per-tool baseline multipliers

**Files:**
- Create: `src/metrics/baseline-multipliers.ts`

- [ ] **Step 1: Write the module (no test — pure constants)**

```ts
// src/metrics/baseline-multipliers.ts
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
```

- [ ] **Step 2: Commit**

```bash
git add src/metrics/baseline-multipliers.ts
git commit -m "feat(metrics): bench-derived baseline multipliers"
```

---

### Task 3: Pure savings estimator

**Files:**
- Create: `src/metrics/estimate-savings.ts`
- Test: `test/metrics/estimate-savings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/metrics/estimate-savings.test.ts
import { test, expect } from "bun:test";
import { estimateSavings, collectFilePaths } from "../../src/metrics/estimate-savings.ts";

test("collectFilePaths walks nested file_path values, deduped", () => {
  const result = {
    apex_methods: [{ file_path: "/a/Foo.cls" }, { file_path: "/a/Foo.cls" }],
    lwc_bundles: [{ file_path: "/b/bar.js" }, { file_path: null }],
    nested: { deep: [{ file_path: "/c/baz.html" }] },
  };
  const paths = collectFilePaths(result).sort();
  expect(paths).toEqual(["/a/Foo.cls", "/b/bar.js", "/c/baz.html"]);
});

test("result-aware: sums file bytes / 4 plus a per-file grep allowance", () => {
  const result = { hits: [{ file_path: "/x/A.cls" }, { file_path: "/y/B.cls" }] };
  const json = JSON.stringify(result);
  const est = estimateSavings("get_field_usage", json, {
    fileSize: (p) => (p === "/x/A.cls" ? 4000 : 8000),
  });
  expect(est.method).toBe("result-aware");
  // resultTokens = ceil(json.length/4)
  expect(est.resultTokens).toBe(Math.ceil(json.length / 4));
  // baseline = ceil((4000+8000)/4) + 2 files * 50 allowance = 3000 + 100 = 3100
  expect(est.baselineTokens).toBe(3100);
  expect(est.tokensSaved).toBe(Math.max(0, 3100 - est.resultTokens));
});

test("multiplier fallback when result has no file paths", () => {
  const json = JSON.stringify({ count: 3 });
  const est = estimateSavings("search_graph", json, { multipliers: { search_graph: 10 } });
  expect(est.method).toBe("multiplier");
  expect(est.baselineTokens).toBe(est.resultTokens * 10);
});

test("tokensSaved floors at 0", () => {
  const json = JSON.stringify({ file_path: "/tiny.cls" });
  const est = estimateSavings("get_field_usage", json, { fileSize: () => 1 });
  expect(est.tokensSaved).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/metrics/estimate-savings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the estimator**

```ts
// src/metrics/estimate-savings.ts
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
      if (k === "file_path" && typeof v === "string" && v.length > 0) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/metrics/estimate-savings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/metrics/estimate-savings.ts test/metrics/estimate-savings.test.ts
git commit -m "feat(metrics): pure savings estimator (result-aware + multiplier)"
```

---

### Task 4: Record-invocation writer + store helper

**Files:**
- Modify: `src/graph/store.ts`
- Create: `src/metrics/record-invocation.ts`
- Test: `test/metrics/record-invocation.test.ts`

- [ ] **Step 1: Add the store write helper**

In `src/graph/store.ts`, add this method to the `GraphStore` class (after `setFileHash`):

```ts
  // --- Metrics ------------------------------------------------------------

  recordToolInvocation(row: {
    projectId: number | null;
    toolName: string;
    paramsJson: string | null;
    durationMs: number;
    resultTokens: number;
    baselineTokens: number;
    tokensSaved: number;
    method: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_invocation
           (project_id, tool_name, params_json, duration_ms,
            result_tokens, baseline_tokens, tokens_saved, method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.projectId,
        row.toolName,
        row.paramsJson,
        row.durationMs,
        row.resultTokens,
        row.baselineTokens,
        row.tokensSaved,
        row.method,
        row.createdAt,
      );
  }
```

- [ ] **Step 2: Write the failing test**

```ts
// test/metrics/record-invocation.test.ts
import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { recordInvocation } from "../../src/metrics/record-invocation.ts";

function row() {
  return {
    projectId: 1, toolName: "get_field_usage", params: { field: "A__c.B__c" },
    durationMs: 3, resultJson: JSON.stringify({ file_path: "/x.cls" }),
  };
}

test("recordInvocation inserts a row with estimated savings", () => {
  const store = new GraphStore(":memory:");
  recordInvocation(store, { ...row(), now: 1000, fileSize: () => 4000 });
  const r = store.db.query<{ tool_name: string; tokens_saved: number; method: string }, []>(
    "SELECT tool_name, tokens_saved, method FROM tool_invocation LIMIT 1",
  ).get();
  expect(r?.tool_name).toBe("get_field_usage");
  expect(r?.method).toBe("result-aware");
  expect(r?.tokens_saved).toBeGreaterThan(0);
  store.close();
});

test("recordInvocation is a no-op when disabled", () => {
  const store = new GraphStore(":memory:");
  recordInvocation(store, { ...row(), now: 1000, disabled: true });
  const n = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tool_invocation").get();
  expect(n?.n).toBe(0);
  store.close();
});

test("recordInvocation never throws on a write failure", () => {
  const store = new GraphStore(":memory:");
  store.db.exec("DROP TABLE tool_invocation");
  expect(() => recordInvocation(store, { ...row(), now: 1000 })).not.toThrow();
  store.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/metrics/record-invocation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the writer**

```ts
// src/metrics/record-invocation.ts
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
      paramsJson: safeParams(args.params),
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

function safeParams(params: unknown): string | null {
  try {
    return JSON.stringify(params ?? null);
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/metrics/record-invocation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/graph/store.ts src/metrics/record-invocation.ts test/metrics/record-invocation.test.ts
git commit -m "feat(metrics): record-invocation writer (no-op safe)"
```

---

### Task 5: Wire metrics into MCP dispatch

**Files:**
- Modify: `src/server.ts:109-127`

- [ ] **Step 1: Update the CallTool handler**

Replace the success path inside `server.setRequestHandler(CallToolRequestSchema, ...)` (the `try` block at lines ~115-119) so it times the call, stringifies once, and records:

```ts
    const withStore = toolsWithStore.find((t) => t.name === toolName);
    if (withStore !== undefined) {
      const startedAt = Date.now();
      try {
        const result = await withStore.handler(toolInput, store);
        const resultJson = JSON.stringify(result, null, 2);
        recordInvocation(store, {
          projectId: typeof (toolInput as { project_id?: unknown }).project_id === "number"
            ? (toolInput as { project_id: number }).project_id
            : null,
          toolName,
          params: toolInput,
          durationMs: Date.now() - startedAt,
          resultJson,
          now: Date.now(),
        });
        return { content: [{ type: "text" as const, text: resultJson }] };
      } catch (err) {
        logger.error({ toolName, err }, "tool handler error");
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
```

Add the import near the other imports at the top of `src/server.ts`:

```ts
import { recordInvocation } from "./metrics/record-invocation.ts";
```

- [ ] **Step 2: Typecheck + full test run**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all tests pass (existing + new metrics/migration tests).

- [ ] **Step 3: Manual smoke — record a real invocation**

Run:
```bash
bun run src/cli.ts index ./test/fixtures/sample-sfdx-project --full
# Then exercise a tool through the server is harder to script; instead assert the table exists and is writable:
bun -e 'import {GraphStore} from "./src/graph/store.ts"; import {getDefaultDbPath} from "./src/util/db-path.ts"; const s=new GraphStore(getDefaultDbPath()); console.log("tool_invocation rows:", s.db.query("SELECT COUNT(*) AS n FROM tool_invocation").get());'
```
Expected: prints a row count (0 or more) with no error.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(metrics): record every MCP tool call into tool_invocation"
```

---

# Phase 2 — Web server + API

### Task 6: Neighborhood + savings-summary queries

**Files:**
- Modify: `src/graph/queries.ts`
- Test: `test/graph/neighborhood.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/graph/neighborhood.test.ts
import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { getNeighborhood, getSavingsSummary } from "../../src/graph/queries.ts";

function seed(store: GraphStore) {
  const pid = store.upsertProject("/p", "p", "64.0");
  const a = store.insertNode({ projectId: pid, label: "ApexClass" as any, name: "A", qualifiedName: "A" });
  const b = store.insertNode({ projectId: pid, label: "ApexClass" as any, name: "B", qualifiedName: "B" });
  const c = store.insertNode({ projectId: pid, label: "ApexClass" as any, name: "C", qualifiedName: "C" });
  store.insertEdge({ projectId: pid, sourceId: a, targetId: b, edgeType: "CALLS" as any });
  store.insertEdge({ projectId: pid, sourceId: c, targetId: a, edgeType: "CALLS" as any });
  return { pid, a, b, c };
}

test("getNeighborhood returns the center node + 1-hop neighbors both directions", () => {
  const store = new GraphStore(":memory:");
  const { pid, a } = seed(store);
  const nb = getNeighborhood(store, pid, a, { depth: 1, cap: 100 });
  const ids = nb.nodes.map((n) => n.id).sort();
  expect(ids.length).toBe(3); // A + B (out) + C (in)
  expect(nb.edges.length).toBe(2);
  expect(nb.truncated).toBe(false);
  store.close();
});

test("getNeighborhood sets truncated when cap is hit", () => {
  const store = new GraphStore(":memory:");
  const { pid, a } = seed(store);
  const nb = getNeighborhood(store, pid, a, { depth: 1, cap: 1 });
  expect(nb.truncated).toBe(true);
  store.close();
});

test("getSavingsSummary aggregates totals and per-tool", () => {
  const store = new GraphStore(":memory:");
  const pid = store.upsertProject("/p", "p", "64.0");
  const base = { projectId: pid, paramsJson: null, durationMs: 1, resultTokens: 10, baselineTokens: 110, tokensSaved: 100, method: "multiplier", createdAt: 1000 };
  store.recordToolInvocation({ ...base, toolName: "search_graph" });
  store.recordToolInvocation({ ...base, toolName: "search_graph" });
  store.recordToolInvocation({ ...base, toolName: "get_field_usage" });
  const s = getSavingsSummary(store, pid);
  expect(s.totalCalls).toBe(3);
  expect(s.totalTokensSaved).toBe(300);
  expect(s.perTool.find((t) => t.toolName === "search_graph")?.calls).toBe(2);
  expect(s.timeline.length).toBeGreaterThan(0);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/graph/neighborhood.test.ts`
Expected: FAIL — `getNeighborhood`/`getSavingsSummary` not exported.

- [ ] **Step 3: Implement both queries**

Append to `src/graph/queries.ts`:

```ts
// ---------------------------------------------------------------------------
// Neighborhood (Explore tab) — subgraph around a node, all edge types, both directions
// ---------------------------------------------------------------------------

export type NeighborhoodNode = {
  id: number;
  label: string;
  name: string;
  qualifiedName: string;
  filePath: string | null;
};

export type NeighborhoodEdge = {
  id: number;
  sourceId: number;
  targetId: number;
  edgeType: string;
};

export type Neighborhood = {
  centerId: number;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  truncated: boolean;
};

export function getNeighborhood(
  store: GraphStore,
  projectId: number,
  centerId: number,
  opts: { depth?: number; cap?: number } = {},
): Neighborhood {
  const cap = opts.cap ?? 500;
  const depth = Math.max(1, opts.depth ?? 1);

  const visited = new Set<number>([centerId]);
  let frontier = [centerId];
  const edges = new Map<number, NeighborhoodEdge>();
  let truncated = false;

  type ERow = { id: number; source_id: number; target_id: number; edge_type: string };
  for (let d = 0; d < depth && frontier.length > 0 && !truncated; d++) {
    const next: number[] = [];
    for (const nodeId of frontier) {
      const rows = store.db
        .query<ERow, [number, number, number]>(
          `SELECT id, source_id, target_id, edge_type FROM edges
           WHERE project_id = ? AND (source_id = ? OR target_id = ?)`,
        )
        .all(projectId, nodeId, nodeId);
      for (const r of rows) {
        edges.set(r.id, { id: r.id, sourceId: r.source_id, targetId: r.target_id, edgeType: r.edge_type });
        const other = r.source_id === nodeId ? r.target_id : r.source_id;
        if (!visited.has(other)) {
          if (visited.size >= cap) { truncated = true; break; }
          visited.add(other);
          next.push(other);
        }
      }
      if (truncated) break;
    }
    frontier = next;
  }

  const ids = [...visited];
  const placeholders = ids.map(() => "?").join(",");
  type NRow = { id: number; label: string; name: string; qualified_name: string; file_path: string | null };
  const nodeRows = ids.length
    ? store.db
        .query<NRow, number[]>(
          `SELECT id, label, name, qualified_name, file_path FROM nodes WHERE id IN (${placeholders})`,
        )
        .all(...ids)
    : [];

  // Keep only edges whose both endpoints are in the visited set.
  const keptEdges = [...edges.values()].filter((e) => visited.has(e.sourceId) && visited.has(e.targetId));

  return {
    centerId,
    nodes: nodeRows.map((n) => ({
      id: n.id, label: n.label, name: n.name, qualifiedName: n.qualified_name, filePath: n.file_path,
    })),
    edges: keptEdges,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Savings summary (Overview tab)
// ---------------------------------------------------------------------------

export type SavingsSummary = {
  totalCalls: number;
  totalTokensSaved: number;
  totalResultTokens: number;
  totalBaselineTokens: number;
  perTool: { toolName: string; calls: number; tokensSaved: number }[];
  timeline: { day: string; tokensSaved: number; calls: number }[];
};

export function getSavingsSummary(store: GraphStore, projectId: number): SavingsSummary {
  const totals = store.db
    .query<{ calls: number; saved: number; rt: number; bt: number }, [number]>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_saved),0) AS saved,
              COALESCE(SUM(result_tokens),0) AS rt, COALESCE(SUM(baseline_tokens),0) AS bt
       FROM tool_invocation WHERE project_id = ?`,
    )
    .get(projectId) ?? { calls: 0, saved: 0, rt: 0, bt: 0 };

  const perTool = store.db
    .query<{ tool_name: string; calls: number; saved: number }, [number]>(
      `SELECT tool_name, COUNT(*) AS calls, COALESCE(SUM(tokens_saved),0) AS saved
       FROM tool_invocation WHERE project_id = ? GROUP BY tool_name ORDER BY saved DESC`,
    )
    .all(projectId)
    .map((r) => ({ toolName: r.tool_name, calls: r.calls, tokensSaved: r.saved }));

  const timeline = store.db
    .query<{ day: string; saved: number; calls: number }, [number]>(
      `SELECT date(created_at/1000, 'unixepoch') AS day,
              COALESCE(SUM(tokens_saved),0) AS saved, COUNT(*) AS calls
       FROM tool_invocation WHERE project_id = ? GROUP BY day ORDER BY day`,
    )
    .all(projectId)
    .map((r) => ({ day: r.day, tokensSaved: r.saved, calls: r.calls }));

  return {
    totalCalls: totals.calls,
    totalTokensSaved: totals.saved,
    totalResultTokens: totals.rt,
    totalBaselineTokens: totals.bt,
    perTool,
    timeline,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/graph/neighborhood.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/graph/queries.ts test/graph/neighborhood.test.ts
git commit -m "feat(web): neighborhood + savings-summary queries"
```

---

### Task 7: API router

**Files:**
- Create: `src/web/api.ts`
- Test: `test/web/api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/web/api.test.ts
import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { handleApi } from "../../src/web/api.ts";

function seeded(): GraphStore {
  const store = new GraphStore(":memory:");
  store.upsertProject("/p", "p", "64.0");
  return store;
}

async function call(store: GraphStore, path: string): Promise<{ status: number; body: any }> {
  const res = await handleApi(new Request(`http://localhost${path}`), store);
  if (res === null) return { status: 404, body: null };
  return { status: res.status, body: await res.json() };
}

test("GET /api/projects returns the project list", async () => {
  const store = seeded();
  const { status, body } = await call(store, "/api/projects");
  expect(status).toBe(200);
  expect(body[0].name).toBe("p");
  store.close();
});

test("GET /api/savings returns a summary shape", async () => {
  const store = seeded();
  const { status, body } = await call(store, "/api/savings?project=1");
  expect(status).toBe(200);
  expect(body).toHaveProperty("totalTokensSaved");
  expect(body).toHaveProperty("perTool");
  store.close();
});

test("unknown /api path returns 404 json", async () => {
  const store = seeded();
  const { status } = await call(store, "/api/nope");
  expect(status).toBe(404);
  store.close();
});

test("non-/api path returns null (handled by asset layer)", async () => {
  const store = seeded();
  const res = await handleApi(new Request("http://localhost/index.html"), store);
  expect(res).toBeNull();
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/web/api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router (reuse existing tool handlers)**

```ts
// src/web/api.ts
// Thin HTTP API over the existing graph queries and MCP tool handlers. Returns a Response
// for any /api/* path, or null for non-API paths (so the caller can serve static assets).
// No logic is duplicated: field-usage / permission / search / trace reuse the tool handlers.

import type { GraphStore } from "../graph/store.ts";
import { listProjects, getSchemaSummary, getNeighborhood, getSavingsSummary } from "../graph/queries.ts";
import * as toolSearch from "../tools/search-graph.ts";
import * as toolTrace from "../tools/trace-references.ts";
import * as toolFieldUsage from "../tools/get-field-usage.ts";
import * as toolPermission from "../tools/get-permission-access.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function num(v: string | null, fallback: number | null = null): number | null {
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function handleApi(req: Request, store: GraphStore): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const q = url.searchParams;

  try {
    switch (url.pathname) {
      case "/api/projects":
        return json(listProjects(store));

      case "/api/schema": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        return json(getSchemaSummary(store, project));
      }

      case "/api/savings": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        return json(getSavingsSummary(store, project));
      }

      case "/api/neighborhood": {
        const project = num(q.get("project"));
        const id = num(q.get("id"));
        if (project === null || id === null) return json({ error: "project and id required" }, 400);
        return json(getNeighborhood(store, project, id, {
          depth: num(q.get("depth"), 1) ?? 1,
          cap: num(q.get("cap"), 500) ?? 500,
        }));
      }

      case "/api/search": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const input = {
          project_id: project,
          name_pattern: q.get("q") ?? undefined,
          label: q.get("label") ?? undefined,
          limit: num(q.get("limit"), 50) ?? 50,
        };
        return json(await toolSearch.handler(input, store));
      }

      case "/api/trace": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const input = {
          project_id: project,
          start: q.get("start") ?? "",
          direction: q.get("direction") ?? "callers",
        };
        return json(await toolTrace.handler(input, store));
      }

      case "/api/field-usage": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const input = { project_id: project, field: q.get("field") ?? "" };
        return json(await toolFieldUsage.handler(input, store));
      }

      case "/api/permission-access": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const input = {
          project_id: project,
          target: { type: q.get("type") ?? "Field", qualified_name: q.get("target") ?? "" },
        };
        return json(await toolPermission.handler(input, store));
      }

      default:
        return json({ error: `Unknown API path: ${url.pathname}` }, 404);
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}
```

> Note: confirm `search-graph.ts`'s input field name for the pattern. The plan assumes `name_pattern`; if `search-graph.ts` uses a different key (e.g. `pattern`), match the actual `type Input` in that file. Check `src/tools/search-graph.ts:63-74` before running.

- [ ] **Step 4: Reconcile the search input key**

Read `src/tools/search-graph.ts` lines 63-74 and `src/tools/trace-references.ts` lines 43-52. Adjust the `input` objects in `/api/search` and `/api/trace` to match the actual property names (e.g. `name_pattern` vs `pattern`, `direction` enum values). This is a 1-line-each correction, not a redesign.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/web/api.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts test/web/api.test.ts
git commit -m "feat(web): /api router reusing existing tool handlers"
```

---

### Task 8: Embedded-asset serving + dev stub

**Files:**
- Create: `src/web/embedded-assets.ts` (dev stub, regenerated at build)
- Create: `src/web/assets.ts`

- [ ] **Step 1: Write the dev stub**

```ts
// src/web/embedded-assets.ts
// GENERATED at build time by scripts/gen-embedded-assets.ts from web/dist/.
// This committed version is a dev stub: empty map => assets served from web/dist on disk
// if present (dev), or a "run build:web" placeholder otherwise.

export type EmbeddedAsset = { contentType: string; base64: string };

export const EMBEDDED_ASSETS: Record<string, EmbeddedAsset> = {};
```

- [ ] **Step 2: Implement the asset server**

```ts
// src/web/assets.ts
// Serves the SPA. Prefers compiled-in EMBEDDED_ASSETS; in dev (empty map) falls back to
// reading web/dist from disk. Unknown non-API paths fall back to index.html (SPA routing).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_ASSETS } from "./embedded-assets.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot)] ?? "application/octet-stream";
}

const DEV_DIST = join(process.cwd(), "web", "dist");

export function serveAsset(pathname: string): Response {
  const key = pathname === "/" ? "/index.html" : pathname;

  const embedded = EMBEDDED_ASSETS[key] ?? EMBEDDED_ASSETS["/index.html"];
  if (embedded !== undefined && Object.keys(EMBEDDED_ASSETS).length > 0) {
    const bytes = Buffer.from(embedded.base64, "base64");
    return new Response(bytes, { headers: { "content-type": embedded.contentType } });
  }

  // Dev fallback: read from web/dist on disk.
  const onDisk = join(DEV_DIST, key.replace(/^\//, ""));
  if (existsSync(onDisk)) {
    return new Response(readFileSync(onDisk), { headers: { "content-type": contentTypeFor(key) } });
  }
  const indexOnDisk = join(DEV_DIST, "index.html");
  if (existsSync(indexOnDisk)) {
    return new Response(readFileSync(indexOnDisk), { headers: { "content-type": "text/html" } });
  }
  return new Response(
    "Spindle Workbench assets not built. Run `bun run build:web` (or `cd web && bun install && vite build`).",
    { status: 503, headers: { "content-type": "text/plain" } },
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/web/embedded-assets.ts src/web/assets.ts
git commit -m "feat(web): embedded asset server with dev disk fallback"
```

---

### Task 9: HTTP server + `ui` CLI subcommand

**Files:**
- Create: `src/web/serve.ts`
- Modify: `src/cli.ts` (add `ui` command near the other `program.command(...)` blocks, before the default action at line ~213)

- [ ] **Step 1: Implement the server**

```ts
// src/web/serve.ts
// Loopback-only HTTP server for the Workbench UI. Reads the shared graph db, serves /api/*
// (api.ts) and the embedded SPA (assets.ts). Binds 127.0.0.1, prints the URL to STDERR
// (stdout is reserved for the MCP transport elsewhere), optionally opens the browser.

import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

import { GraphStore } from "../graph/store.ts";
import { getDefaultDbPath } from "../util/db-path.ts";
import { logger } from "../util/logger.ts";
import { handleApi } from "./api.ts";
import { serveAsset } from "./assets.ts";

export type ServeOpts = { port?: number; open?: boolean; dbPath?: string };

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch (err) {
    logger.warn({ err }, "could not open browser automatically");
  }
}

export async function startUiServer(opts: ServeOpts = {}): Promise<void> {
  const dbPath = opts.dbPath ?? getDefaultDbPath();
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new GraphStore(dbPath);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0, // 0 => OS picks a free port
    async fetch(req) {
      const apiRes = await handleApi(req, store);
      if (apiRes !== null) return apiRes;
      return serveAsset(new URL(req.url).pathname);
    },
  });

  const url = `http://localhost:${server.port}`;
  // STDERR, not STDOUT.
  process.stderr.write(`Spindle Workbench: ${url}\n`);
  logger.info({ url, dbPath }, "workbench ui started");
  if (opts.open ?? true) openBrowser(url);
}
```

- [ ] **Step 2: Add the CLI subcommand**

In `src/cli.ts`, add before the default action (`program.action(...)` at line ~213):

```ts
program
  .command("ui [project-path]")
  .description("Launch the Spindle Workbench (local web UI) for graph exploration and savings")
  .option("--port <n>", "Preferred port (default: auto-pick a free port)")
  .option("--no-open", "Do not open the browser automatically")
  .option("--db-path <path>", "Override the graph database path")
  .action(async (_projectPath: string | undefined, opts: { port?: string; open?: boolean; dbPath?: string }) => {
    const { startUiServer } = await import("./web/serve.ts");
    await startUiServer({
      port: opts.port ? Number(opts.port) : undefined,
      open: opts.open,
      dbPath: opts.dbPath,
    });
    // Keep the process alive; Bun.serve runs until the process is killed.
    await new Promise<never>(() => {});
  });
```

- [ ] **Step 3: Typecheck + smoke run**

Run:
```bash
bun run typecheck
bun run src/cli.ts index ./test/fixtures/sample-sfdx-project --full
bun run src/cli.ts ui --no-open --port 7799 &
sleep 1
curl -s http://localhost:7799/api/projects | head -c 300
curl -s http://localhost:7799/ | head -c 80   # 503 placeholder until web is built — expected
kill %1
```
Expected: `/api/projects` returns JSON array; `/` returns the "assets not built" placeholder (web SPA comes in Phase 3). Typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add src/web/serve.ts src/cli.ts
git commit -m "feat(web): spindle ui subcommand + loopback HTTP server"
```

---

# Phase 3 — SPA (web/)

> No unit tests by design (spec §7); the gate is `tsc --noEmit` + a Vite build. Keep components minimal and working.

### Task 10: Scaffold web/ (Vite + React + cytoscape)

**Files:** `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/styles.css`

- [ ] **Step 1: Create the project files**

`web/package.json`:
```json
{
  "name": "spindle-workbench",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cytoscape": "^3.30.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/cytoscape": "^3.21.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:7799" } },
});
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Spindle Workbench</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
```

`web/src/styles.css`:
```css
:root { --bg:#0f172a; --panel:#1e293b; --line:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#5b8def; --good:#16a34a; }
* { box-sizing: border-box; }
body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
.tabs { display:flex; gap:4px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
.tab { padding:6px 14px; border-radius:6px; cursor:pointer; color:var(--muted); }
.tab.active { background:var(--accent); color:#fff; }
.page { padding:16px; }
.kpi { display:inline-block; border:1px solid var(--line); border-radius:8px; padding:12px 16px; margin:6px; background:var(--panel); min-width:140px; }
.kpi b { display:block; font-size:24px; color:var(--good); }
.kpi span { color:var(--muted); font-size:12px; }
.bar { height:14px; background:var(--accent); border-radius:3px; }
.row { display:flex; align-items:center; gap:8px; margin:4px 0; font-size:13px; }
input, select { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
#cy { width:100%; height:70vh; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
.tooltip { border-bottom:1px dotted var(--muted); cursor:help; }
table { border-collapse:collapse; width:100%; font-size:13px; }
td, th { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; }
```

- [ ] **Step 2: Install + verify dev typecheck**

Run:
```bash
cd web && bun install && bun run typecheck
```
Expected: install succeeds; typecheck fails only because `app.tsx` etc. don't exist yet (next task) — that's fine, proceed.

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/vite.config.ts web/tsconfig.json web/index.html web/src/main.tsx web/src/styles.css
git commit -m "feat(web): scaffold Vite + React + cytoscape SPA"
```

---

### Task 11: API client + app shell

**Files:** `web/src/api.ts`, `web/src/app.tsx`

- [ ] **Step 1: API client**

```ts
// web/src/api.ts
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export type Project = { id: number; name: string; rootPath: string; nodeCount: number; edgeCount: number };
export type Savings = {
  totalCalls: number; totalTokensSaved: number; totalResultTokens: number; totalBaselineTokens: number;
  perTool: { toolName: string; calls: number; tokensSaved: number }[];
  timeline: { day: string; tokensSaved: number; calls: number }[];
};
export type Schema = { nodeCounts: Record<string, number>; edgeCounts: Record<string, number> };
export type Neighborhood = {
  centerId: number; truncated: boolean;
  nodes: { id: number; label: string; name: string; qualifiedName: string; filePath: string | null }[];
  edges: { id: number; sourceId: number; targetId: number; edgeType: string }[];
};

export const api = {
  projects: () => get<Project[]>("/api/projects"),
  savings: (p: number) => get<Savings>(`/api/savings?project=${p}`),
  schema: (p: number) => get<Schema>(`/api/schema?project=${p}`),
  search: (p: number, q: string) => get<{ results: { id: number; name: string; label: string }[] }>(`/api/search?project=${p}&q=${encodeURIComponent(q)}`),
  neighborhood: (p: number, id: number) => get<Neighborhood>(`/api/neighborhood?project=${p}&id=${id}`),
  fieldUsage: (p: number, field: string) => get<any>(`/api/field-usage?project=${p}&field=${encodeURIComponent(field)}`),
  permission: (p: number, type: string, target: string) => get<any>(`/api/permission-access?project=${p}&type=${type}&target=${encodeURIComponent(target)}`),
};
```

> Note: `/api/search` returns whatever `search_graph`'s handler returns. Inspect that shape once at runtime and adjust the `search` return type + the Explore search rendering accordingly.

- [ ] **Step 2: App shell with project picker + tabs**

```tsx
// web/src/app.tsx
import { useEffect, useState } from "react";
import { api, type Project } from "./api.ts";
import { Overview } from "./tabs/overview.tsx";
import { Explore } from "./tabs/explore.tsx";
import { FieldImpact } from "./tabs/field-impact.tsx";
import { Permissions } from "./tabs/permissions.tsx";

const TABS = ["Overview", "Explore", "Field Impact", "Permissions"] as const;
type Tab = typeof TABS[number];

export function App(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      if (ps.length > 0) setProject(ps[0].id);
    }).catch(() => setProjects([]));
  }, []);

  return (
    <div>
      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={`tab ${t === tab ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
        <div style={{ marginLeft: "auto" }}>
          <select value={project ?? ""} onChange={(e) => setProject(Number(e.target.value))}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.nodeCount} nodes)</option>)}
          </select>
        </div>
      </div>
      <div className="page">
        {project === null ? <p>No indexed project found. Run <code>spindle index &lt;path&gt;</code> first.</p>
          : tab === "Overview" ? <Overview project={project} />
          : tab === "Explore" ? <Explore project={project} />
          : tab === "Field Impact" ? <FieldImpact project={project} />
          : <Permissions project={project} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit (compiles after Task 12-13 add the tab files)**

```bash
git add web/src/api.ts web/src/app.tsx
git commit -m "feat(web): api client + app shell with project picker + tabs"
```

---

### Task 12: Overview + Explore tabs

**Files:** `web/src/tabs/overview.tsx`, `web/src/tabs/explore.tsx`

- [ ] **Step 1: Overview tab (savings KPIs + per-tool bars + corpus)**

```tsx
// web/src/tabs/overview.tsx
import { useEffect, useState } from "react";
import { api, type Savings, type Schema } from "../api.ts";

function fmt(n: number): string { return n.toLocaleString(); }

export function Overview({ project }: { project: number }): JSX.Element {
  const [s, setS] = useState<Savings | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);

  useEffect(() => {
    api.savings(project).then(setS).catch(() => setS(null));
    api.schema(project).then(setSchema).catch(() => setSchema(null));
  }, [project]);

  if (s === null) return <p>Loading savings…</p>;
  const minutes = Math.round(s.totalTokensSaved / 1000); // ~1k tokens/min reading, rough
  const max = Math.max(1, ...s.perTool.map((t) => t.tokensSaved));

  return (
    <div>
      <div>
        <div className="kpi"><b>{fmt(s.totalTokensSaved)}</b><span>tokens saved (estimated)</span></div>
        <div className="kpi"><b>{fmt(s.totalCalls)}</b><span>graph queries</span></div>
        <div className="kpi"><b>~{fmt(minutes)}m</b><span title="≈ tokens saved / 1000 tokens-per-min reading" className="tooltip">reading avoided</span></div>
        <div className="kpi"><b>{s.totalBaselineTokens > 0 ? Math.round((1 - s.totalResultTokens / s.totalBaselineTokens) * 100) : 0}%</b><span>vs grep+read</span></div>
      </div>

      <h3>Savings by tool <span className="tooltip" title="Estimated. result-aware tools sum the bytes of files grep+read would have opened; others use a bench-derived multiplier.">(how?)</span></h3>
      {s.perTool.map((t) => (
        <div className="row" key={t.toolName}>
          <div style={{ width: 160 }}>{t.toolName}</div>
          <div className="bar" style={{ width: `${(t.tokensSaved / max) * 50}%` }} />
          <div>{fmt(t.tokensSaved)} ({t.calls})</div>
        </div>
      ))}

      <h3>Corpus</h3>
      {schema && Object.entries(schema.nodeCounts).sort((a, b) => b[1] - a[1]).map(([label, n]) => (
        <div className="row" key={label}><div style={{ width: 200 }}>{label}</div><div>{fmt(n)}</div></div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Explore tab (cytoscape force graph)**

```tsx
// web/src/tabs/explore.tsx
import { useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import { api } from "../api.ts";

export function Explore({ project }: { project: number }): JSX.Element {
  const cyRef = useRef<HTMLDivElement>(null);
  const cyInst = useRef<cytoscape.Core | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: number; name: string; label: string }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<{ name: string; label: string; filePath: string | null } | null>(null);

  useEffect(() => {
    if (cyRef.current === null) return;
    cyInst.current = cytoscape({
      container: cyRef.current,
      style: [
        { selector: "node", style: { label: "data(name)", "background-color": "#5b8def", color: "#e2e8f0", "font-size": 9 } },
        { selector: "node.center", style: { "background-color": "#16a34a" } },
        { selector: "edge", style: { label: "data(edgeType)", width: 1, "line-color": "#475569", "font-size": 7, color: "#94a3b8", "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#475569" } },
      ],
      layout: { name: "cose" },
    });
    cyInst.current.on("tap", "node", (evt) => {
      const d = evt.target.data();
      setSelected({ name: d.qualifiedName, label: d.label, filePath: d.filePath });
      void loadNeighborhood(Number(d.id));
    });
    return () => cyInst.current?.destroy();
  }, []);

  async function runSearch(): Promise<void> {
    const res = await api.search(project, query);
    const results = (res as any).results ?? [];
    setHits(results.map((r: any) => ({ id: r.id, name: r.name ?? r.qualifiedName, label: r.label })));
  }

  async function loadNeighborhood(id: number): Promise<void> {
    const nb = await api.neighborhood(project, id);
    setTruncated(nb.truncated);
    const cy = cyInst.current;
    if (!cy) return;
    cy.elements().remove();
    cy.add(nb.nodes.map((n) => ({ data: { id: String(n.id), name: n.name, qualifiedName: n.qualifiedName, label: n.label, filePath: n.filePath }, classes: n.id === id ? "center" : "" })));
    cy.add(nb.edges.map((e) => ({ data: { id: `e${e.id}`, source: String(e.sourceId), target: String(e.targetId), edgeType: e.edgeType } })));
    cy.layout({ name: "cose" }).run();
  }

  return (
    <div>
      <div className="row">
        <input placeholder="search nodes (e.g. Projection)" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }} />
        <button onClick={() => void runSearch()}>Search</button>
        {hits.length > 0 && (
          <select onChange={(e) => void loadNeighborhood(Number(e.target.value))} defaultValue="">
            <option value="" disabled>pick a node ({hits.length})</option>
            {hits.map((h) => <option key={h.id} value={h.id}>{h.label}: {h.name}</option>)}
          </select>
        )}
        {truncated && <span style={{ color: "#f59e0b" }}>graph trimmed to cap</span>}
      </div>
      {selected && (
        <div className="row" style={{ color: "#94a3b8" }}>
          <b>{selected.label}</b> {selected.name} {selected.filePath && <code>{selected.filePath}</code>}
        </div>
      )}
      <div id="cy" ref={cyRef} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/tabs/overview.tsx web/src/tabs/explore.tsx
git commit -m "feat(web): Overview (savings) + Explore (cytoscape) tabs"
```

---

### Task 13: Field Impact + Permissions tabs; verify build

**Files:** `web/src/tabs/field-impact.tsx`, `web/src/tabs/permissions.tsx`

- [ ] **Step 1: Field Impact tab**

```tsx
// web/src/tabs/field-impact.tsx
import { useState } from "react";
import { api } from "../api.ts";

const BUCKETS = [
  ["apex_methods", "Apex"], ["lwc_bundles", "LWC"], ["vf_pages", "VF Pages"],
  ["vf_components", "VF Components"], ["validation_rules", "Validation Rules"],
  ["layouts", "Layouts / FlexiPages"], ["flows", "Flows"], ["ui_bundles", "UI Bundles"],
  ["permission_sets", "Permission Sets"], ["formula_fields", "Formula Fields"],
] as const;

export function FieldImpact({ project }: { project: number }): JSX.Element {
  const [field, setField] = useState("");
  const [report, setReport] = useState<any | null>(null);

  async function run(): Promise<void> {
    setReport(await api.fieldUsage(project, field));
  }

  return (
    <div>
      <div className="row">
        <input placeholder="Object__c.Field__c" value={field}
          onChange={(e) => setField(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }} />
        <button onClick={() => void run()}>Impact</button>
      </div>
      {report?.error && <p style={{ color: "#ef4444" }}>{report.error}</p>}
      {report && !report.error && BUCKETS.map(([key, label]) => {
        const items = report[key] as { qualified_name: string; file_path: string | null; context: string }[] | undefined;
        if (!items || items.length === 0) return null;
        return (
          <div key={key}>
            <h3>{label} ({items.length})</h3>
            <table><tbody>
              {items.map((it, i) => (
                <tr key={i}><td>{it.qualified_name}</td><td>{it.context}</td><td><code>{it.file_path ?? ""}</code></td></tr>
              ))}
            </tbody></table>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Permissions tab**

```tsx
// web/src/tabs/permissions.tsx
import { useState } from "react";
import { api } from "../api.ts";

export function Permissions({ project }: { project: number }): JSX.Element {
  const [type, setType] = useState("Field");
  const [target, setTarget] = useState("");
  const [report, setReport] = useState<any | null>(null);

  async function run(): Promise<void> {
    setReport(await api.permission(project, type, target));
  }

  return (
    <div>
      <div className="row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {["Field", "SObject", "ApexClass", "VisualforcePage", "RecordType"].map((t) => <option key={t}>{t}</option>)}
        </select>
        <input placeholder={type === "Field" ? "Object__c.Field__c" : "ApiName"} value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }} />
        <button onClick={() => void run()}>Who has access?</button>
      </div>
      {report?.error && <p style={{ color: "#ef4444" }}>{report.error}</p>}
      {report && !report.error && (
        <>
          <h3>Permission Sets ({report.permission_sets?.length ?? 0})</h3>
          <table><tbody>
            {(report.permission_sets ?? []).map((g: any, i: number) => (
              <tr key={i}><td>{g.source_qualified_name}</td><td>{JSON.stringify(g.access)}</td></tr>
            ))}
          </tbody></table>
          <h3>Profiles ({report.profiles?.length ?? 0})</h3>
          <table><tbody>
            {(report.profiles ?? []).map((g: any, i: number) => (
              <tr key={i}><td>{g.source_qualified_name}</td><td>{JSON.stringify(g.access)}</td></tr>
            ))}
          </tbody></table>
          {(report.permission_set_groups ?? []).length > 0 && (
            <>
              <h3>Permission Set Groups</h3>
              {report.permission_set_groups.map((grp: any, i: number) => (
                <div className="row" key={i}><b>{grp.qualified_name}</b>: {grp.includes.join(", ")}</div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the SPA and verify**

Run:
```bash
cd web && bun run build
```
Expected: `tsc --noEmit` clean, `web/dist/` produced with `index.html` + hashed JS/CSS.

- [ ] **Step 4: End-to-end dev smoke**

Run (two terminals or background):
```bash
# backend
bun run src/cli.ts ui --no-open --port 7799 &
sleep 1
# the asset server now serves web/dist from disk (dev fallback)
curl -s http://localhost:7799/ | grep -o "<title>.*</title>"
kill %1
```
Expected: `<title>Spindle Workbench</title>`.

- [ ] **Step 5: Commit**

```bash
git add web/src/tabs/field-impact.tsx web/src/tabs/permissions.tsx
git commit -m "feat(web): Field Impact + Permissions tabs; SPA builds"
```

---

# Phase 4 — Build, embed, CI

### Task 14: Embedded-assets generator + build wiring

**Files:** `scripts/gen-embedded-assets.ts`, `package.json`

- [ ] **Step 1: Write the generator**

```ts
// scripts/gen-embedded-assets.ts
// Reads web/dist and writes src/web/embedded-assets.ts as a base64 map so `bun build --compile`
// bundles the SPA into the binary. Run by `build:web` after `vite build`.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = join(process.cwd(), "web", "dist");
const OUT = join(process.cwd(), "src", "web", "embedded-assets.ts");

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot)] ?? "application/octet-stream";
}

const files = walk(DIST);
const entries: string[] = [];
for (const file of files) {
  const key = "/" + relative(DIST, file).split("\\").join("/");
  const b64 = readFileSync(file).toString("base64");
  entries.push(`  ${JSON.stringify(key)}: { contentType: ${JSON.stringify(contentType(file))}, base64: ${JSON.stringify(b64)} },`);
}

const content = `// GENERATED by scripts/gen-embedded-assets.ts — do not edit by hand.
export type EmbeddedAsset = { contentType: string; base64: string };

export const EMBEDDED_ASSETS: Record<string, EmbeddedAsset> = {
${entries.join("\n")}
};
`;
writeFileSync(OUT, content);
process.stderr.write(`Embedded ${files.length} asset(s) into ${OUT}\n`);
```

- [ ] **Step 2: Wire package.json scripts**

In root `package.json`, set:
```json
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test --timeout 30000",
    "build:web": "cd web && bun install && bun run build && cd .. && bun run scripts/gen-embedded-assets.ts",
    "build": "bun run build:web && bun build src/cli.ts --compile --outfile dist/sfdx-graph-mcp",
    "start": "bun run src/cli.ts",
    "bench": "SFDX_GRAPH_LOG_LEVEL=silent bun run bench/cli.ts"
  }
```

- [ ] **Step 3: Verify embedded build end-to-end**

Run:
```bash
bun run build:web
git diff --stat src/web/embedded-assets.ts   # should show it grew (no longer empty)
bun run build
./dist/sfdx-graph-mcp --version
./dist/sfdx-graph-mcp ui --no-open --port 7798 &
sleep 1
curl -s http://localhost:7798/ | grep -o "<title>.*</title>"   # served from EMBEDDED_ASSETS now
kill %1
```
Expected: version prints; `<title>Spindle Workbench</title>` served from the compiled binary (no web/dist on the path).

- [ ] **Step 4: Keep the dev stub out of commits of generated content**

The generated `src/web/embedded-assets.ts` is large. Decide: commit it (simplest; CI doesn't need to rebuild web before compile if committed) OR gitignore it and always regenerate in CI. **This plan commits it** for reproducible binaries. Add a `.gitattributes` line so diffs stay quiet:

```
src/web/embedded-assets.ts linguist-generated=true -diff
```

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-embedded-assets.ts package.json .gitattributes src/web/embedded-assets.ts
git commit -m "build(web): embed SPA assets into the compiled binary"
```

---

### Task 15: CI wiring

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: Inspect existing workflows**

Read `.github/workflows/ci.yml` and `.github/workflows/release.yml` to match their step style and Bun setup.

- [ ] **Step 2: Add a web build step to CI**

In `ci.yml`, after deps install and before/alongside typecheck, add:
```yaml
      - name: Build web SPA
        run: bun run build:web
      - name: Typecheck web
        run: cd web && bun run typecheck
```

- [ ] **Step 3: Ensure release embeds assets**

In `release.yml`, before the matrix `bun build --compile` step, ensure `bun run build:web` runs (or rely on `bun run build` which now calls it). If the release calls `bun build ... --compile` directly, change it to `bun run build` so assets are embedded, or add an explicit `bun run build:web` step before it.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: build + embed web SPA in CI and release"
```

---

# Phase 5 — Docs reconciliation

### Task 16: Update the design doc

**Files:** `sfdx-graph-mcp-design.md`

- [ ] **Step 1: Reconcile NG7**

Find the NG7 line ("A web UI. Stdio MCP server only.") near line 49 and replace with:
```
- **NG7 (revised v1.1).** The MCP server itself remains stdio-only. A separate,
  opt-in local Workbench UI ships as the `spindle ui` subcommand (loopback HTTP,
  embedded SPA, read-only over the same SQLite db). See the v1.1 section.
```

- [ ] **Step 2: Mark the roadmap item delivered**

Find the roadmap line ("Web UI for offline exploration (Vite + the same SQLite db).") near line 1219 and mark it delivered, referencing `docs/superpowers/specs/2026-05-29-spindle-workbench-ui-design.md`.

- [ ] **Step 3: Add a v1.1 section**

Add a "v1.1 — Workbench UI" section documenting: the `spindle ui` subcommand and flags; the `/api/*` surface; the `tool_invocation` schema; the savings estimator (result-aware + multiplier, `SFDX_GRAPH_NO_METRICS`); the embedded-asset build flow. Keep it consistent with the spec.

- [ ] **Step 4: Update CLAUDE.md phase list**

In `Spindle/CLAUDE.md`, move "read-only web UI" from "v1.1+ pending" to a shipped "v1.1" line, and update the `v0.6+ pending` note if needed.

- [ ] **Step 5: Full verification + commit**

Run:
```bash
bun run typecheck && bun test
```
Expected: clean typecheck, all tests pass.

```bash
git add sfdx-graph-mcp-design.md CLAUDE.md
git commit -m "docs: reconcile NG7 + roadmap; document v1.1 Workbench UI"
```

---

## Self-review notes

- **Spec coverage:** delivery (T9), shared core reuse (T7 reuses tool handlers), live instrumentation (T1-T5), savings table (T1), estimator hybrid (T3), 4 tabs (T12-T13), embed/build (T14-T15), privacy `SFDX_GRAPH_NO_METRICS` (T4) + stderr URL (T9) + loopback (T9), testing (T1,T3,T4,T6,T7), doc reconciliation (T16). All spec sections map to a task.
- **Migrations reality vs spec:** the spec named `src/graph/migrations/`; the codebase has no such dir — it uses idempotent `SCHEMA_DDL` + `ensureSchemaVersion`. Plan follows the existing pattern (Task 1) and the design-doc update (Task 16) records this divergence.
- **Reuse vs extraction:** spec §4.1 allowed extracting field-usage/permission logic into `queries.ts`; the existing tool handlers are already reusable `(input, store) => result`, so the plan reuses them directly (Task 7) — less risk, still DRY. Noted as an intentional simplification.
- **Runtime-dep invariant:** cytoscape/react live only in `web/package.json`; only built static output is embedded (Task 14), so the binary's runtime dep tree is unchanged.
- **Known runtime-shape checks flagged inline:** search/trace input keys (Task 7 Step 4) and search result shape (Task 11/12) must be reconciled against the actual tool files at implementation time — these are the only places the plan can't fully pin without running the tools.
```
