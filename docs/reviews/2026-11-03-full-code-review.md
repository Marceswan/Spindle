# Spindle full code review — 2026-11-03

> Remediation status: R1–R18 addressed. See [results, verification and remaining scope](2026-11-03-remediation-results.md). The findings below preserve the original reviewed state.

Reviewed the current working tree against `HEAD` (`5fecc6e`, the initial v1.1.2 commit), the README, CONTRIBUTING.md, SECURITY.md, the main design document, and the approved Flow/SOQL/Workbench specs. This is a repository review, including untracked canonical files, rather than a review limited to committed changes.

**Assessment: the current checkout is not release-ready.** It cannot complete a clean install, typecheck, or root build. Independent reproductions also expose graph and query correctness defects that remain after those integration blockers are repaired.

Production source and existing user edits were not changed. Dependencies were installed with `--no-save --ignore-scripts` after frozen installation failed. The installed runtime was Bun 1.3.14; CI pins 1.3.8. Runtime evidence below is therefore local verification, not a claim that CI passed.

## Validation evidence and limits

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Failed: lockfile would change. Manifest requests SDK `^1.30.0` and omits `graphql`; text lockfile records SDK `^1.0.0` and `graphql`. |
| `bun run typecheck` | Failed: missing discovery module, missing GraphQL dependency, missing benchmark helper, and consequent type errors. Sync-conflict source copies are also included by TypeScript. |
| `SFDX_GRAPH_LOG_LEVEL=silent bun test --timeout 30000` | 43 pass, 24 fail, 24 errors across 33 files. Most failures are module-load failures, not executed failing assertions. |
| `bun test test/graph` | 9 pass, 0 fail; existing graph tests do not cover the reproduced defects. |
| `bun run build:web` | Failed: script does not exist. |
| `bun run build` | Failed: missing `src/cli.ts` entry point. |
| `cd web && bun run build` | Passed TypeScript and Vite build after web dependency installation; Vite reported a large JS chunk warning. |
| Focused in-memory reproductions | Confirmed search, Cypher, project isolation, field-context and metrics persistence defects. |
| Focused parser/pass reproductions | Confirmed SOQL/Flow omissions, incoming-edge loss and stale deleted-file nodes. Incremental reproduction used real store, Apex parser and passes, with only parser dispatch mocked to bypass the unrelated missing GraphQL dependency. |

Review coverage includes storage, queries/Cypher, indexing and watcher lifecycle, MCP handlers, Flow/SOQL extraction, web/API contracts, metrics, and build/release configuration. An additional bounded sweep covered UI-bundle/GraphQL/TypeScript resolution, LWC, Aura, Visualforce and permission/profile XML. Generated bundles and old sync-conflict versions were inspected as integration artifacts, not treated as alternative implementations. Full end-to-end indexing, compiled-binary smoke tests, and browser interaction remain blocked or unexecuted; the web lifecycle findings below are identified as static analysis.

## Integration blockers

### R1 — P1: required source files are missing

Locations: `package.json:7,14–15`, `src/pipeline/index-project.ts:6`, `bench/trace-accuracy/run.ts:13`.

`src/cli.ts` and `src/pipeline/discover.ts` are deleted in the working tree while their callers remain. The benchmark also imports an absent `bench/trace-accuracy/lib/derive-candidates.ts`. Consequently the CLI/build cannot start, most pipeline/tool tests cannot load, and the benchmark prevents typechecking. Recover and reconcile these files before evaluating a release. Restoring the old discovery implementation alone is insufficient if it lacks the new UI-bundle kinds.

### R2 — P1: manifest, dependency lock and release workflow describe different applications

Locations: `package.json:11–28`, `bun.lock:7–18`, `src/parsers/ui-bundle/parse-graphql.ts:20`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.

Both workflows call a missing `build:web` script. The root build also omits asset generation. `graphql` is imported by canonical code but absent from canonical dependencies, and the frozen install fails. The conflict manifest contains newer build wiring/dependencies, but must be reconciled deliberately rather than copied wholesale. Restore a consistent manifest, version, lockfile policy and build chain.

Sync-conflict `.ts`, test, JSON and workflow copies are a related recovery concern: compiler globs include stale source, and conflict `.yml` files would become additional workflows if committed in `.github/workflows`. Preserve useful differences outside active source/workflow paths; do not blindly delete copies or add them all to a commit. CONTRIBUTING.md also links to deleted CLAUDE.md and learnings.md.

## Standards review

These are functional contract violations, not cosmetic smell judgments. CONTRIBUTING.md requires passing typecheck, tests and compiled smoke checks; `query_graph` documents friendly rejection of unsupported syntax; the graph APIs accept explicit project scope. No cosmetic smell findings are retained.

### R3 — P1: search silently omits nodes beyond its preliminary scan

Location: `src/graph/queries.ts:300–322`.

`LIMIT max(limit * 20, 1000)` runs before regex, property and relationship filters. Seeding `Class0` through `Class1000`, then searching `qualifiedNamePattern: '^Class1000$', limit: 1`, returns `[]`. This is a false absence, not an advertised truncation. `get_source_snippet` inherits false “Node not found” results because it uses the same search. Filter before limiting results or page candidates until the result limit/exhaustion; use exact qualified-name lookup where possible.

### R4 — P1: unsupported inequality executes as equality

Location: `src/graph/cypher/tokenizer.ts:202–203`.

The tokenizer silently discards unknown characters. `MATCH (n:ApexClass) WHERE n.name != 'Class0' RETURN n.name` returns `Class0` with no warning because `!` disappears. Reject unknown syntax with location information. Do not convert unsupported syntax into a different valid query.

### R5 — P2: string predicates interpret literal characters as SQL wildcards

Location: `src/graph/cypher/planner.ts:121–135`.

CONTAINS/STARTS WITH/ENDS WITH are implemented using unescaped `LIKE`. `CONTAINS '_'` matches all 1,001 `ClassN` names even though none contains an underscore. `%` has the same problem. Implement literal predicates and explicitly preserve the intended case semantics.

### R6 — P2: unsupported-keyword checks inspect string values

Location: `src/tools/query-graph.ts:127–132`, with patterns at lines 76–114.

`WHERE n.name = 'DELETE'` is rejected as a write operation. Regex checks run over raw source instead of tokens, so ordinary string data containing keywords is rejected. Move unsupported-construct checks into lexing/parsing while retaining the read-only query contract.

### R7 — P2: accepted aggregate projections return incorrect results

Location: `src/graph/cypher/planner.ts:292–314` and the corresponding relationship-query branch.

`RETURN n.name, count(n)` produces one arbitrary name and the global count because no GROUP BY is emitted. `RETURN count(n) LIMIT 0` still returns a row because aggregate-only pagination is omitted. Implement the semantics or explicitly reject unsupported mixed projections. Apply LIMIT/SKIP to the aggregate result rows.

### R8 — P2: neighborhood lookup returns another project's center node

Location: `src/graph/queries.ts:593–601`.

Edges are scoped by project, but the final node query only checks IDs. Calling `getNeighborhood(projectA, nodeIdFromProjectB)` returns project B's node metadata. Validate center ownership and constrain node selection by project. This is a project-isolation defect within the local application, not a claim of remote access.

### R16 — P2: watcher can discard work arriving during indexing — static analysis

Location: `src/hook/watch-daemon.ts:48–73`.

When a scheduled callback fires while `running`, `reindex` returns. The timer has already been cleared, and completion does not schedule another pass. A change after its directory was scanned during sufficiently slow asynchronous discovery can remain unindexed until another filesystem event. Add a dirty flag and drain pending work after the active pass. Verify this with a delayed-index test before claiming the race is fixed.

**Standards result:** six reproduced correctness findings plus one static lifecycle finding. The highest-priority findings are silent search omissions and silently altered query meaning.

## Specification review

### R9 — P1: incremental edits delete incoming references

Locations: `src/pipeline/pass1-structural.ts:33–38,60–62`, `src/pipeline/index-project.ts:56–58`.

Unchanged referrers are skipped, but nodes in changed target files are deleted with cascading incoming-edge deletion. Pass2 receives only changed-file references. This contradicts the README's explanation of resolving “which files to re-resolve when a dependency changes.”

Reproduction: index `A.run -> B.work`; change only B's method body; run incremental passes. CALLS count changes from **1 to 0**, although A still calls B. Re-resolve affected referrers, retain sufficient per-file parse state, or conservatively rebuild the project's graph whenever its source set changes. Compare incremental and fresh full-index graph content in tests.

### R10 — P2: deleted files survive full and incremental indexing

Location: `src/pipeline/index-project.ts:44–50`.

Discovery is never reconciled with stored paths. Pass1 only removes old nodes for files still discovered. Removing B from discovery and running full passes leaves both B and B.work in the graph. Renames likewise leave stale metadata. Reconcile deletions, hashes and reverse references; full indexing must reconstruct the current source set, not just visit its surviving files.

### R11 — P1: SOQL extraction drops ordinary field references

Locations: `src/parsers/apex/soql/extract.ts:101–111,131–154,174–186`.

The SOQL spec requires extraction “Robust to ANTLR's whitespace-stripped `node.text`.” Current substring heuristics do not preserve token/string boundaries:

| Input fragment | Observed incorrect extraction |
| --- | --- |
| `WHEREEmail__c!=nullANDTier__c='Gold'` | Emits `nullANDTier__c`; misses `Tier__c`. |
| `ORDERBYEmail__cDESC` | Emits `Email__cDESC`. |
| `WHEREName='WHERE'ANDTier__c='Gold'` | Loses Name/Tier__c and emits Gold. |
| `SELECT Limit__c FROM Customer__c` | Drops `Limit__c` because its name contains a clause keyword. |

These bogus references subsequently fail graph resolution, hiding valid impact-analysis results. Prefer the existing Apex parser's SOQL contexts/token boundaries or a proper lexer over additional substring patches. Test through actual Apex parsing as well as the extractor helper.

### R12 — P2: Flow field reads are omitted on assignment RHS and lookup outputs

Location: `src/parsers/metadata-xml/flow.ts:235–248,257–263`.

The Flow spec explicitly includes `outputAssignments` and value `<elementReference>`. The implementation visits queried fields, filters, input assignments and assignment destinations, but not lookup output fields or assignment RHS references. A bound `cust:Customer__c` with RHS `cust.Email__c`, or a lookup output mapping for Email__c, produces no Email__c edge. Cover both XML shapes, along with value references in filters/conditions/input mappings, using direct field-usage integration assertions.

### R13 — P2: every direct Apex field reference is reported as SOQL_SELECT

Location: `src/tools/get-field-usage.ts:190–194`, plus its direct-edge projection and deduplication ranking.

The precision milestone specifies distinct SOQL clause and write contexts. The query does not select edge context properties and unconditionally labels every Apex method `SOQL_SELECT`. An in-memory `REFERENCES_FIELD` edge with `{context: 'DML_WRITE'}` is reported as `SOQL_SELECT`. Preserve edge context and implement the specified precedence for duplicate uses; distinguish unknown context rather than inventing a SELECT read.

### R14 — P2: metrics persist arbitrary tool arguments

Location: `src/metrics/record-invocation.ts:31–34,47–49`.

Workbench §6 says `params_json` stores “API names/identifiers, never code contents.” `safeParams` only catches JSON serialization errors; it stores every argument, including full Cypher literals and unknown source payloads. A reproduction persisted both `PRIVATE_LITERAL_SENTINEL` and `PRIVATE_SOURCE_SENTINEL`. Use per-tool identifier allowlists or omit parameters, especially freeform query text. Retain the existing opt-out and failure-isolation behavior. Existing historical rows require a separately considered retention/cleanup decision.

### R15 — P2: switching projects leaves stale UI callbacks and results — static analysis

Locations: `web/src/tabs/explore.tsx:46–60`, `web/src/app.tsx:57–63`, `web/src/tabs/field-impact.tsx:21–26`, `web/src/tabs/permissions.tsx:9–14`.

Explore installs its tap callback once with `[]`; it captures the first project's `loadNeighborhood`. App changes the project prop without remounting the tab. Searching project B works through the new render, but tapping its graph requests a neighborhood using project A. Field Impact and Permissions also retain the old project's report under the newly selected project until another query. Reset project-owned state, cancel/ignore stale responses and refresh event bindings. Verify with a two-project browser/component test. Handle rejected requests visibly rather than leaving stale data displayed.

### R17 — P2: denied permission entries are reported as grants

Location: `src/tools/get-permission-access.ts:107–123`, with group expansion following the unfiltered grants.

The README promises permission sets/profiles “that grants access.” The handler includes every stored permission edge even when all relevant access flags are false. A real profile parser → pass2 → handler reproduction with Apex class access `<enabled>false</enabled>` returned the `NoAccess` profile and `total_grants: 1`. Denied permission sets also seed group expansion. Preserve explicit denial metadata in the graph, as the design intends, but filter positive grants in this consumer before counting and expanding groups. Cover disabled Apex/VF, invisible record types, and all-false field/object entries.

### R18 — P2: Apex calls in Aura helpers disappear from dependency results

Location: `src/parsers/aura/parse.ts:147–160`.

Helper JavaScript creates an AuraHelper node but is never scanned for server actions. The declared Apex-controller fallback is also suppressed whenever a Controller.js exists. A bundle with `controller="CustomerController"`, a JS controller delegating to its helper, and the helper calling `component.get("c.getCustomers")` produced no edges and no warnings. Scan both JS surfaces and preserve the declared Apex-class dependency independently of whether a JS controller exists. Verify method edges and inbound traces with a real bundle fixture.

**Spec result:** eight reproduced findings plus one static UI lifecycle finding. Incremental graph loss and SOQL omissions are the highest-priority specification failures.

## Remaining specification and maintenance work

These are completion gaps or follow-up checks, not additional reproduced bug findings:

- Workbench Explore lacks the specified label/edge filters and “show more” control; Overview does not render the returned savings timeline. Method-level permission selection is also not implemented by the current picker/tool contract. Resolve these against the claimed shipped scope rather than silently broadening this bugfix project.
- Reconcile SECURITY.md's “does not open any network sockets” wording with the explicitly launched loopback UI; update deleted convention-file links and version/roadmap claims after recovery.
- Metrics currently recognizes only `file_path`, while some tool responses use `filePath`; verify result-aware estimates against actual response contracts and resolve relative paths against project roots. Treat this as estimator quality work, not verified token savings.
- Lock dependency versions and run the final checks under CI's Bun version. No dependency vulnerability audit, cross-platform release build, or real-org accuracy benchmark was completed in this review.

The accompanying implementation plan orders recovery and fixes by dependency, with explicit acceptance tests. It does not authorize implementing or committing them as part of this review.
