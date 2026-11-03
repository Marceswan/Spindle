# Spindle Review Remediation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore a reproducible build and correct the verified graph, query, parser, UI and metrics defects documented in the 2026-11-03 review.

**Architecture:** Keep the existing Bun/SQLite graph, parser passes, MCP tools and React Workbench. Recover the inconsistent working tree first. Establish correctness with conservative project rebuilds when inputs change, then optimize incremental resolution only against a full-index parity oracle. Keep query validation, project scoping and API response contracts explicit.

**Tech Stack:** Bun, strict TypeScript, bun:sqlite, Apex ANTLR parser, XML/Babel/GraphQL parsers, React/Vite, Cytoscape, bun:test.

---

Review: `docs/reviews/2026-11-03-full-code-review.md`. Finding IDs below refer to that report. Execution is recorded in `docs/reviews/2026-11-03-remediation-results.md`; the steps below preserve the approved plan.

## Execution order and boundaries

1. Recover sources/manifests and obtain a trustworthy test baseline.
2. Fix graph freshness and search/query correctness.
3. Fix parser precision and field-usage reporting.
4. Fix project isolation, UI lifecycle, metrics and watcher scheduling.
5. Reconcile delivered scope/docs and run release gates.

Use separate implementation checkpoints for these tasks. Preserve preexisting work and sync-conflict differences before cleanup. Never stage the entire dirty tree automatically. This review's baseline is `5fecc6e` plus substantial uncommitted work, not a clean feature branch. A future implementation checkout must include the intended working-tree changes; branching from HEAD alone would omit most reviewed functionality.

## Task 1: recover canonical sources and reproducible packaging — R1, R2

**Files:** restore `src/cli.ts`, `src/pipeline/discover.ts`, `bench/trace-accuracy/lib/derive-candidates.ts`; reconcile `package.json`, lockfiles, `.gitignore`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`; inspect conflict counterparts before moving them out of active paths. Review `scripts/gen-embedded-assets.ts`, `src/pipeline/parse-dispatch.ts`, `web/package.json`.

1. Inventory tracked deletions and conflict pairs. Preserve each version in a recovery location outside compiler, test and workflow roots. Recover the CLI from history and reconcile its required UI command; recover discovery with all current metadata/UI-bundle kinds. Restore the benchmark helper from evidence or implement its actual caller contract.
2. Reconcile package metadata without blindly adopting the conflict file's version/dependency downgrades. Declare `graphql`; retain a deliberately selected SDK version. Choose one canonical lockfile format supported by Bun 1.3.8 and remove conflicting lockfile precedence after preserving recovery copies.
3. Define the root scripts explicitly:

   ```json
   {
     "build:web": "cd web && bun install --frozen-lockfile && bun run build && cd .. && bun run scripts/gen-embedded-assets.ts",
     "build": "bun run build:web && bun build src/cli.ts --compile --outfile dist/sfdx-graph-mcp"
   }
   ```

   Generate/commit the matching web lockfile once; do not use a mutable install in CI. Run the asset generator only after the SPA build succeeds.
4. Restore CLI smoke coverage for version/help, index, MCP launch and `ui --no-open --db-path`. Add discovery assertions for the fixture's UI bundles and canonical metadata surfaces. Verify no `sync-conflict` file is included as source, a test, or an active workflow.
5. Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test --timeout 30000`, `bun run build`, `./dist/sfdx-graph-mcp --version`, and `./dist/sfdx-graph-mcp --help` under Bun 1.3.8. Record remaining semantic test failures; do not weaken checks to hide them.

**Acceptance:** clean checkout installs/builds reproducibly; all imports resolve; each workflow has one canonical definition; compiled UI assets and the CLI are present. Existing tests execute instead of failing module loading.

## Task 2: make indexing reflect the current complete source set — R9, R10

**Files:** `src/pipeline/index-project.ts`, `src/pipeline/pass1-structural.ts`, `src/graph/store.ts`, `src/pipeline/pass4-reverse-index.ts`; extend `test/pipeline/index-project.test.ts`, add `test/pipeline/incremental-parity.test.ts`.

1. Add a fixture with A calling B. Test initial indexing, body-only B edit, B deletion, B rename, addition of a formerly unresolved target, and removal of a bundle member. Compare normalized node identities and edge tuples, not SQLite IDs, with a fresh full index after each operation.
2. Run `bun test test/pipeline/incremental-parity.test.ts`; verify incoming-edge loss and stale deletion cases fail before changing production code.
3. Implement the conservative correctness baseline: compare the full discovered path/hash inventory with stored inventory. Return early only when nothing changed. On any addition/change/deletion, rebuild the project's graph from all current discovered files and regenerate reverse references. Full mode always reconciles the complete source set.
4. Publish the rebuilt graph atomically for that project using a transaction around synchronous writes/resolution, or staging if needed. Parse/read before holding a long write transaction. Preserve the project identity and metrics rows. Define parse-failure behavior explicitly; do not silently delete the last good graph after an unexpected fatal failure.
5. Test a failed pass leaves the previous published graph usable. Ensure removed paths lose hashes and references, and a no-change incremental run is a no-op.
6. Run `bun test test/pipeline test/graph test/tools` and `bun run bench`. Record the performance cost of conservative rebuilding. Any later affected-file optimization must retain the same parity tests and persist/recover all referrer inputs needed to rebuild edges.

**Acceptance:** incremental and fresh full graphs match semantically after edits, additions, deletions and renames; readers do not observe a partially rebuilt project.

## Task 3: remove search false negatives — R3

**Files:** `src/graph/queries.ts`, `src/tools/get-source-snippet.ts`; extend `test/tools/search-graph.test.ts`, `test/tools/get-source-snippet.test.ts`; add `test/graph/search.test.ts` if query-level coverage is clearer.

1. Seed at least 1,001 nodes and request an exact match beyond the current preliminary limit with `limit: 1`. Include property/relationship filtering where early candidates do not match. Confirm failure with `bun test test/graph/search.test.ts`.
2. Page candidates in deterministic ID order, apply every predicate, and stop only at the requested result limit or candidate exhaustion. Push safe exact predicates into SQLite. Apply result limits after filtering, never as an invisible search-space cutoff.
3. Use an exact project/qualified-name lookup for snippets. Preserve existing label/ambiguity semantics rather than silently selecting a different symbol.
4. Add absent-match and limit-boundary cases; run the affected graph/tool tests and benchmark a large fixture.

**Acceptance:** a valid match is discoverable regardless of insertion order or graph size; missing snippets indicate genuinely absent targets.

## Task 4: make Cypher evaluation faithful or explicitly unsupported — R4–R7

**Files:** `src/graph/cypher/tokenizer.ts`, `parser.ts`, `planner.ts`, `src/tools/query-graph.ts`; extend `test/tools/query-graph.test.ts` and add focused lexer/planner tests under `test/graph/`.

1. Add regression cases for `!=`, unknown punctuation, quoted `DELETE`/`WITH`/`CALL`, literal `%` and `_`, mixed scalar/count projection, count-only LIMIT 0 and SKIP. Exercise both node and relationship patterns.
2. Run the tests and capture the wrong results before fixing them.
3. Make unknown lexer input a parse error with a column. For now, reject `!=` as unsupported instead of adding a new operator beyond the documented subset. Move unsupported-clause recognition to tokens/parser context; strings must remain data.
4. Implement literal string predicates with `instr`/`substr` or correctly escaped LIKE with explicit case behavior. Keep all literal values parameterized.
5. Reject mixed scalar/aggregate projections with the normal unsupported-query response until grouping is deliberately supported. Apply LIMIT/SKIP to aggregate result rows, including LIMIT 0, in both planner branches.
6. Run `bun test test/tools/query-graph.test.ts test/graph` and check existing supported query examples still work. Test write clauses remain rejected.

**Acceptance:** no unsupported syntax is silently reinterpreted; supported filters and pagination return mathematically correct results.

## Task 5: preserve SOQL token and literal boundaries — R11

**Files:** `src/parsers/apex/parse.ts`, `src/parsers/apex/soql/extract.ts`; extend `test/parsers/apex/soql/extract.test.ts`, `test/pipeline/soql-fields.test.ts`, and fixture Apex source.

1. Add the four failing inputs in R11, plus lowercase/mixed-case keywords, escaped quotes, AND/OR, DESC/NULLS LAST, bind variables, keyword-containing field names, relationships and nested subqueries. Assert exact positive references and absence of invented identifiers.
2. Run `bun test test/parsers/apex/soql test/pipeline/soql-fields.test.ts` and record failures.
3. Replace keyword substring segmentation in the production path with SOQL parse contexts/token intervals already available from the Apex parser. Preserve source boundaries instead of passing ambiguous whitespace-stripped text. Keep clause and relationship context with each field reference.
4. If an independent string-extractor API remains, feed it a token-aware representation; do not claim all glued text is unambiguously recoverable. Retain coarse SObject fallback for unsupported/dynamic queries, with explicit confidence/warnings rather than fabricated precise fields.
5. Run parser and pipeline tests through actual `.cls` fixtures. Confirm final graph targets and `get_field_usage(include_indirect: false)`, not merely helper token output.

**Acceptance:** ordinary conditions/sort modifiers/literals do not hide or invent field usages; quoted content never creates clause boundaries.

## Task 6: complete Flow reference extraction and preserve usage contexts — R12, R13

**Files:** `src/parsers/metadata-xml/flow.ts`, `src/tools/get-field-usage.ts`; extend `test/parsers/metadata-xml/flow.test.ts`, `test/pipeline/flow.test.ts`, `test/tools/get-field-usage.test.ts`, and the Flow fixture.

1. Add lookup `outputAssignments.field`, assignment RHS `value.elementReference`, filter/condition RHS references, and input-assignment value references. Cover bound variables, `$Record`, ambiguous short names and scalar resources that must not become fields.
2. Add direct edges with contexts SOQL_WHERE, SOQL_ORDERBY, SOQL_GROUPBY, CONSTRUCTOR_ARG and DML_WRITE. Assert exact output contexts and deduplication precedence; the existing DML_WRITE reproduction must fail as SOQL_SELECT first.
3. Extend typed XML shapes and traverse the omitted value sites. Resolve with the existing object/variable bindings; do not guess an object for ambiguous references.
4. Select the stored edge context from properties and carry it into Usage. Use the milestone ordering: SELECT, WHERE, ORDERBY, GROUPBY, CONSTRUCTOR_ARG, DML_WRITE, DML, coarse SOQL. Define remaining clause/Flow contexts explicitly and ensure direct Flow hits outrank coarse hits. For legacy edges without context use an honest fallback, not a fabricated SELECT.
5. Align the coverage summary with the implemented direct/indirect capabilities. Run `bun test test/parsers/metadata-xml test/pipeline/flow.test.ts test/tools/get-field-usage.test.ts`.

**Acceptance:** direct-only field usage includes each documented Flow site and reports how Apex references actually use the field.

## Task 7: enforce project ownership and reset Workbench state — R8, R15

**Files:** `src/graph/queries.ts`, `src/web/api.ts`, `web/src/api.ts`, `web/src/app.tsx`, `web/src/tabs/explore.tsx`, `field-impact.tsx`, `permissions.tsx`, `overview.tsx`; extend `test/graph/neighborhood.test.ts`, `test/web/api.test.ts`; add a focused UI regression harness using the project's selected test tooling.

1. Add two-project API tests. A project-A request with a project-B center must return a clear not-found/invalid-target response and no B metadata. Reject invalid/noninteger IDs and bound depth/cap parameters.
2. Validate center ownership and scope all neighborhood node selection to projectId. Test legitimate isolated centers still appear and truncation works.
3. Key project-owned tab subtrees by project or correctly rebind callbacks and reset state when project changes. Ensure Cytoscape cleanup captures the instance it created. Cancel/ignore responses from the prior project and out-of-order queries.
4. Add a UI regression that loads A, switches to B, searches/taps a B node and asserts every neighborhood request uses B. Ensure old impact/permission reports are cleared immediately. Simulate failed/slow requests and show an actionable error state rather than stale content or indefinite loading.
5. Run `bun test test/graph/neighborhood.test.ts test/web/api.test.ts`, the UI regression harness, and `cd web && bun run build`. Manually verify the same two-project scenario in the running Workbench after CLI recovery.

**Acceptance:** selected project, request project and displayed data agree across all tabs; cross-project IDs cannot bypass API scope.

## Task 8: minimize persisted metrics parameters — R14

**Files:** `src/metrics/record-invocation.ts`, `src/server.ts`; extend `test/metrics/record-invocation.test.ts`; reconcile the Workbench privacy documentation.

1. Add sentinel tests for freeform query literals, unknown properties and arbitrary source content. Assert none appears in `tool_invocation.params_json`; existing behavior must fail these tests first.
2. Replace `safeParams` with per-tool identifier allowlists. Persist only necessary primitive identifiers such as project ID, field qualified name or target type/name. Store no `query` source, arbitrary nested payload or code content. Null parameters are an acceptable default for tools without a safe mapping.
3. Preserve disabled/read-only/error-isolation tests. Verify metrics never change tool output or cause a successful tool call to fail.
4. Run `bun test test/metrics`. Document that changing future writes does not sanitize historical rows; prepare any optional historical purge as a separately reviewable data change.

**Acceptance:** sentinel values cannot be recovered from new metric rows; safe identifiers and savings counters remain usable.

## Task 9: drain watcher work instead of dropping it — R16

**Files:** `src/hook/watch-daemon.ts`; create `test/hook/watch-daemon.test.ts` or a testable scheduling helper with equivalent coverage.

1. Inject a controllable delayed index function and timers. Start one pass, deliver an event while it runs, fire the debounce timer, then resolve the first pass. Assert a second pass occurs without a new event; assert no concurrent indexing.
2. Implement a dirty flag: scheduling marks work pending, the running pass leaves it intact, and completion drains it. Coalesce bursts while guaranteeing a final pass after the last edit.
3. Test indexing errors do not strand pending work. On shutdown cancel timers, stop accepting events, await active work where practical, then close the store and remove the PID file.
4. Run `bun test test/hook` and manually edit/add/delete files during a large-corpus reindex. Confirm the settled graph matches a fresh full index.

**Acceptance:** every burst eventually yields a graph for the final filesystem state; no overlap or write-after-close behavior.

## Task 10: filter permission grants using their access flags — R17

**Files:** `src/tools/get-permission-access.ts`; extend `test/tools/get-permission-access.test.ts` and permission/profile fixtures.

1. Add parser-to-report tests for disabled Apex/VF class/page entries, invisible record types, all-false field/object flags, and a group containing only a denied permission set. Include a second positive grant to prevent over-filtering.
2. Run `bun test test/tools/get-permission-access.test.ts`; verify denied entries currently increase `total_grants`.
3. Keep graph edges and their explicit flags intact. Before report construction/group expansion, apply target-specific predicates: `enabled === true` for Apex/VF, `visible === true` for record types, either read/edit for fields, and any relevant positive CRUD/view-all/modify-all flag for objects. Use the actual parser property names and boolean types.
4. Derive counts and permission-set groups only from the filtered grants. Document that this is metadata grant reporting, not a full Salesforce user effective-access evaluator.
5. Run the permission tests and Workbench API tests; verify its displayed grant counts agree with the tool report.

**Acceptance:** explicit denial entries do not claim access or create indirect group grants; positive entries remain visible with their original access detail.

## Task 11: resolve Apex server actions from Aura helpers — R18

**Files:** `src/parsers/aura/parse.ts`; extend `test/pipeline/aura.test.ts` and a fixture bundle under `test/fixtures/sample-sfdx-project/force-app/main/default/aura/`.

1. Add a bundle whose Controller.js delegates to Helper.js and whose helper performs `component.get("c.getCustomers")`. Assert the bundle references the bound Apex method and that an inbound trace finds it.
2. Add a declared-controller case with no direct JS action and verify the Apex-class dependency still exists. Run `bun test test/pipeline/aura.test.ts` and confirm the current omissions.
3. Share server-action extraction across controller/helper JS while preserving source filename and confidence. Emit the markup-declared Apex-class dependency independently of controller JS presence, with deduplication.
4. Test duplicate actions, absent controller binding, and unrelated JS strings against the parser's supported matching rules. Run Aura pipeline and trace-reference tests.

**Acceptance:** moving a server action from controller to helper does not erase the dependency; markup declarations remain discoverable.

## Task 12: reconcile scope and perform release validation

**Files:** `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `sfdx-graph-mcp-design.md`, Workbench/precision specs; relevant UI files only if completing the documented UI features.

1. Restore or replace dangling conventions links. Reconcile version claims with the actual shipped features. Describe the optional loopback UI accurately in SECURITY.md.
2. Track missing Explore filters/show-more, savings timeline and method-level permission selection as explicit completion items. Implement them if the approved shipped scope still requires them; otherwise record the scope amendment rather than advertising missing behavior. Verify estimator response casing/path resolution against real tool payloads.
3. Run all gates in a clean checkout using the pinned Bun version: frozen root/web installs, root/web typechecks, all tests, `build:web`, compiled binary build, version/help, sample-project index, MCP list/call smoke, and UI/API smoke from the compiled binary.
4. Run the accuracy/performance benchmark using available fixture inputs. Do not claim real-org accuracy if the configured external corpus is unavailable. Compare incremental/full graph parity and ensure repaired parser cases are represented in the benchmark or regression suite.
5. Review the final diff for conflict artifacts, stale generated assets, accidental source/secret persistence, and unrelated user edits. Update the review's finding checklist with evidence for each closed item.

**Acceptance:** all mandatory gates pass; each confirmed review finding has a regression test; remaining scope changes and measured performance tradeoffs are documented. Publishing, deployment and release creation are separate actions from this plan.
