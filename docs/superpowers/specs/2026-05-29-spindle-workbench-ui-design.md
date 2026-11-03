# Spindle Workbench — local UI for graph exploration and savings

> Implementation update (2026-11-03): one authenticated shared service now owns the database, all project watchers, HTTP MCP and the Workbench on 127.0.0.1:47839; stdio is a forwarding adapter. Changed projects rebuild atomically. Earlier per-client ownership, unauthenticated UI, and file-only incremental descriptions are superseded. Explore filters/expansion, the UTC savings timeline and the method-to-class permission picker are implemented. See `docs/reviews/2026-11-03-remediation-results.md` and `docs/reviews/2026-11-03-ui-follow-ups.md` for implemented scope and evidence.

**Status:** Approved (brainstorm 2026-05-29)
**Phase:** v1.1 (promotes the web UI out of NG7)
**Author:** brainstorming session, marc.swan

---

## 1. Summary

Add a local-first web UI to Spindle — the **Workbench** — launched by a new
`spindle ui` CLI subcommand. It is a single-page app served by a loopback HTTP
server that reads the existing `graph.db` and reuses `src/graph/queries.ts`. It
has four tabs:

- **Overview** — savings (estimated tokens/time saved vs grep+read) and corpus KPIs.
- **Explore** — a force-directed graph (cytoscape.js) of the indexed metadata.
- **Field Impact** — `get_field_usage` rendered as an impact map across surfaces.
- **Permissions** — `get_permission_access`: who can read a field / run a method.

Savings are **live-instrumented**: the MCP server records every tool call into a
new `tool_invocation` table and estimates the grep+read tokens that call avoided.

This was a non-goal (NG7). This spec promotes it to a shipped v1.1 feature.

---

## 2. Goals / non-goals

### Goals

- One self-contained binary still — UI assets are embedded at compile time.
- No new **runtime** dependency in the binary's dep tree (frontend deps build to
  static assets only).
- No logic duplication: the web API is a thin HTTP skin over `queries.ts`.
- Honest savings: numbers labeled "estimated", method documented in-UI.
- Loopback-only; no outbound network; stdout stays reserved for MCP.

### Non-goals (v1 of the UI)

- Cypher query console.
- Inline source-snippet viewer.
- Multi-project diff mode.
- Savings history export / CSV.
- Authentication (loopback-only; single local user).

---

## 3. Architecture

Two entry points share one query core and one SQLite db:

```
Clients:        Claude Code (stdio MCP)          Browser (localhost:<port>)
                        |                                   |
Entry points:   src/server.ts                       src/web/serve.ts   (NEW)
                MCP dispatch + metrics wrap (NEW)    loopback HTTP: /api/* + embedded SPA
                        \                                   /
Shared core:             graph/queries.ts   +   metrics/estimate-savings.ts (NEW, pure)
                                     |
Storage (WAL):          graph.db  —  nodes / edges  +  tool_invocation (NEW table)

Frontend:       web/  (React + Vite + cytoscape)  ->  build  ->  embedded into binary
```

Green/NEW components: `src/web/`, `src/metrics/`, the `tool_invocation` migration,
the metrics wrapper in `src/server.ts`, the `ui` CLI subcommand, the `web/` SPA,
and the `build:web` step. Everything else is reused unchanged.

---

## 4. Component design

### 4.1 `src/web/` — local HTTP server

- `serve.ts` — bootstraps `Bun.serve` bound to `127.0.0.1`, picks a free port,
  resolves the project + db path (reuse `util/db-path.ts`), prints the URL to
  **stderr**, opens the browser unless `--no-open`. Owns the request router.
- `api.ts` — route handlers. Each handler validates query params, calls the
  matching `queries.ts` function (or a metrics query), returns JSON. Routes:
  - `GET /api/projects` -> `listProjects`
  - `GET /api/schema?project=` -> `getSchemaSummary` + node/edge counts
  - `GET /api/search?project=&q=&label=` -> `searchNodes`
  - `GET /api/neighborhood?project=&id=&depth=` -> nodes+edges around a node
    (for the Explore canvas; depth default 1, capped node count with a
    `truncated` flag)
  - `GET /api/field-usage?project=&field=` -> field-usage query logic
  - `GET /api/permission-access?project=&target=` -> permission-access query logic
  - `GET /api/savings?project=` -> aggregated metrics (totals, per-tool, timeline)
- `assets.ts` — serves embedded SPA files (index.html, JS, CSS) with correct
  content types; SPA-fallback to index.html for client routes.
- `embedded-assets.ts` — **generated** at build time from `web/dist/`. A map of
  `path -> { contentType, bytes }`. Committed as a generated stub for dev (dev
  mode can read `web/dist` from disk if present; prod uses the embedded map).

The field-usage and permission-access logic currently lives in the MCP tool
handlers (`src/tools/get-field-usage.ts`, `src/tools/get-permission-access.ts`).
If that logic is not already a reusable function in `queries.ts`, extract the
pure query portion into `queries.ts` so both the tool and the API call it. The
tool handler keeps only its MCP-shaped formatting.

### 4.2 `src/metrics/` — savings instrumentation

- `estimate-savings.ts` — **pure**:
  `estimateSavings(toolName, params, resultJson, store) => { resultTokens, baselineTokens, tokensSaved, method }`
  - `resultTokens = ceil(byteLength(resultJson) / 4)`.
  - `baselineTokens`:
    - **Result-aware** (preferred) for `get_field_usage`, `trace_references`,
      `get_permission_access`: sum the byte sizes of the distinct files the agent
      would have had to grep + read to answer (the files referenced by the result
      nodes), divided by 4, plus a small fixed grep-output allowance. File sizes
      come from the graph (node file paths -> `statSync` size, cached per file
      per server run) or a stored `file_bytes` column if available.
    - **Multiplier fallback** for tools without a clean file set
      (`search_graph`, `query_graph`, `get_schema`): `resultTokens * (M - 1)`,
      where `M` is a per-tool constant **derived from the bench harness**
      (`bench/`) measured grep-vs-spindle ratios. Constants live in
      `src/metrics/baseline-multipliers.ts` with a comment citing the bench run.
  - `tokensSaved = max(0, baselineTokens - resultTokens)`.
  - `method` is `"result-aware"` or `"multiplier"` (surfaced in the UI tooltip).
- `record-invocation.ts` — `recordInvocation(store, row)` inserts one
  `tool_invocation` row inside a transaction. No-op if `SFDX_GRAPH_NO_METRICS=1`
  or the db is read-only / migration pending. Never throws into the caller —
  failures are logged at `warn` and swallowed so metrics never break a tool call.

### 4.3 `src/server.ts` — metrics wrapper

Wrap the existing tool-dispatch path. After a tool handler returns successfully,
compute `duration_ms`, call `estimateSavings`, then `recordInvocation`. The
wrapper is thin and additive; it must not change tool output or latency
materially (estimate + insert are sub-millisecond). Errors in the metrics path
are caught and logged, never propagated.

### 4.4 `tool_invocation` table + migration

New migration in `src/graph/migrations/` bumping `schema_version`.

```sql
CREATE TABLE tool_invocation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER,
  tool_name     TEXT NOT NULL,
  params_json   TEXT,            -- API names only, never code contents
  duration_ms   INTEGER,
  result_tokens INTEGER,
  baseline_tokens INTEGER,
  tokens_saved  INTEGER,
  method        TEXT,            -- 'result-aware' | 'multiplier'
  created_at    INTEGER NOT NULL -- epoch ms
);
CREATE INDEX idx_tool_invocation_project ON tool_invocation(project_id);
CREATE INDEX idx_tool_invocation_created ON tool_invocation(created_at);
```

Migration must apply cleanly to a fresh db and to an existing prior-version db.
Startup migration runner already exists; add this migration to the list.

### 4.5 CLI

`src/cli.ts` gains:

```
spindle ui [project-path]
  --port <n>      preferred port (default: auto-pick free)
  --no-open       don't auto-open the browser
  --db-path <p>   override db path (same semantics as `index`)
```

Delegates to `src/web/serve.ts`. No business logic in the CLI layer.

### 4.6 `web/` — the SPA

- React + Vite + TypeScript, `web/package.json` separate from the root.
- `cytoscape.js` for Explore. Default layout `cose` (force-directed); controls:
  filter by node label, filter by edge type, node cap (default ~500) with a
  "show more" button; `truncated` flag from the API drives a "graph trimmed" notice.
- Hand-rolled inline SVG for savings bars/sparkline (no charting dependency).
- Tabs:
  - **Overview** — total tokens saved, total calls, est. time saved, per-tool
    breakdown bars, savings-over-time sparkline, corpus KPIs (node/edge counts by
    label). Each savings figure carries an "estimated — how?" tooltip.
  - **Explore** — search box -> pick a node -> canvas centers it + neighborhood;
    click node -> details panel (label, qname, file path, in/out edge counts,
    neighbor list); expand/re-center controls.
  - **Field Impact** — field picker -> impact map grouped by surface
    (LWC / VF / VR / FlexiPage / Layout / Apex SOQL) + indirect Flow hits.
  - **Permissions** — target picker (field or method) -> grant chains via
    permission sets / profiles / permission-set groups.
- A tiny typed API client (`web/src/api.ts`) wrapping `fetch` to `/api/*`.

### 4.7 Build & distribution

- Root `package.json` scripts:
  - `build:web` — `cd web && vite build` then run a generator that writes
    `src/web/embedded-assets.ts` from `web/dist/`.
  - `build` — runs `build:web` first, then `bun build --compile`.
- CI `release.yml` runs `bun run build:web` before the matrix compile so every
  platform binary embeds the SPA. `ci.yml` adds a `build:web` typecheck/build
  smoke step.

---

## 5. Data flow

1. `spindle ui ./project` -> `serve.ts` resolves db, starts loopback HTTP, opens browser.
2. SPA loads from embedded assets; calls `/api/projects` + `/api/schema`.
3. User explores: each tab calls its `/api/*` endpoint; handlers call `queries.ts`.
4. Independently, while Claude Code uses MCP tools, `server.ts` records each call
   into `tool_invocation`; `/api/savings` aggregates these for the Overview tab.

---

## 6. Privacy & safety

- Loopback bind only (`127.0.0.1`). No outbound calls. Stdout untouched (URL to stderr).
- `tool_invocation.params_json` stores API names/identifiers, never code contents
  (consistent with the existing logging rule).
- Metrics on by default (local-only); `SFDX_GRAPH_NO_METRICS=1` disables writes.
- Savings are labeled estimates with an in-UI explanation of the method.

---

## 7. Testing

- `estimate-savings.ts`: unit tests for both estimator paths with known inputs
  (result-aware file-sum and multiplier fallback), and the `tokensSaved >= 0` floor.
- Migration: test that it applies to a fresh db and an existing prior-version db,
  and that `schema_version` advances.
- API handlers: tested against a pre-built fixture graph db (mirror the existing
  tool-test pattern); assert JSON shape and that handlers reuse `queries.ts`.
- `record-invocation.ts`: test the no-op paths (disabled env, read-only db) and
  that it never throws.
- Frontend: a smoke build under CI (`build:web`) and `tsc --noEmit` for `web/`.
  Component-level tests are out of scope for v1.

---

## 8. Design-doc reconciliation

- Update NG7 (currently "A web UI. Stdio MCP server only.") to note the UI is now
  a shipped v1.1 capability launched via `spindle ui`, distinct from the MCP server.
- Update the roadmap line ("Web UI for offline exploration (Vite + the same
  SQLite db)") to reference this spec and mark it delivered.
- Add a v1.1 section documenting the `ui` subcommand, the `/api/*` surface, the
  `tool_invocation` schema, and the savings estimator method.

---

## 9. Phasing for implementation

1. **Metrics core** — migration + `tool_invocation` + `estimate-savings.ts`
   (pure, TDD) + `record-invocation.ts` + `server.ts` wrapper. Shippable alone;
   adds value even before the UI exists.
2. **Web server + API** — `src/web/serve.ts` + `api.ts` + `assets.ts`, reusing
   `queries.ts`; extract field-usage / permission-access query logic into
   `queries.ts` if needed. `ui` CLI subcommand.
3. **SPA** — `web/` scaffold, API client, four tabs (Overview, Explore, Field
   Impact, Permissions).
4. **Build & embed** — `build:web`, `embedded-assets.ts` generator, CI wiring.
5. **Docs** — design-doc reconciliation + README/`ui` usage.

---

## 10. Open questions (none blocking)

- Exact per-tool multiplier constants: pull from the latest bench run during
  Phase 1; if a tool has no bench coverage, use a conservative default and note it.
- Cytoscape default layout tuning (cose vs fcose) — decide during Phase 3 by feel
  on the sample fixture; fcose only if it doesn't add a heavy dependency.
