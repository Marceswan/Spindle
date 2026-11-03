# Remediation results — 2026-11-03

The confirmed review findings R1–R18 were addressed on `codex/review-remediation`. The user-selected architecture is one shared background service for all projects and clients. This remediation was subsequently committed as `5841075` and pushed to `Marceswan/Spindle` as Marceswan, before beginning the separately requested [UI follow-ups](2026-11-03-ui-follow-ups.md). No release or merge was performed. Recovered conflict copies are retained under ignored `.recovery/`.

## What changed

- `src/service/host.ts` owns the fixed `127.0.0.1:47839` listener, SQLite store, project watchers, authenticated API, native HTTP MCP and embedded Workbench. Binding precedes opening the database. The socket remains owned through shutdown until in-flight work drains and the database closes. Stale discovery never authorizes killing a PID.
- Stdio MCP processes are forwarding adapters. CLI index/UI/hooks connect to the same service. Multiple adapters may exist, but they cannot create additional database/indexing owners. One watcher is registered per canonical project root. Watchers survive client departure and restore on service restart. SessionEnd hooks no longer stop another client's watcher.
- Changed project inventories rebuild transactionally, including incoming references and deletions. A no-change run skips parsing. Email body bytes and presence participate in inventory fingerprints. Failed publication rolls back graph state.
- Query/search, SOQL/Flow/Aura parsing, field contexts, permission grants, metrics privacy and Workbench lifecycle fixes are covered by regressions.

## Finding closure

| Finding | Resolution | Evidence |
|---|---|---|
| R1 missing source | Restore CLI/discovery and benchmark candidate helper | root typecheck, benchmark and compiled CLI gates |
| R2 inconsistent build | Canonical text locks, GraphQL/runtime TypeScript deps, web asset generation and CI installs | frozen installs in a clean source copy; root/web typechecks; compiled build |
| R3 search cutoff | Page all candidates before applying output limit; exact snippet lookup | 1,001-node/property-filter regression; snippet tests |
| R4 inequality | Reject unknown lexer characters/operators | `test/graph/review-regressions.test.ts` |
| R5 wildcard predicates | Literal `instr`/`substr`, SQL character lengths for Unicode | wildcard and Unicode regressions |
| R6 keyword literals | Inspect tokenized syntax while preserving literal tokens | quoted keywords and multiword whitespace tests |
| R7 aggregates | Reject mixed scalar/count; paginate aggregate rows | count LIMIT/SKIP regressions and existing query tests |
| R8 project isolation | Validate center ownership and scope final nodes | graph and two-project API regressions; invalid ranges return 400 |
| R9 incoming edge loss | Resolve the complete project after changes | incremental/fresh semantic parity after edits/additions/renames |
| R10 stale deletions | Reconcile full inventory in full and incremental modes | deletion parity, transactional rollback, email body lifecycle |
| R11 SOQL omissions | Traverse original Apex SOQL parse contexts | AST/standalone extractor and pipeline tests |
| R12 Flow missing sites | Traverse lookup outputs and RHS values | Flow parser/pipeline regressions |
| R13 fabricated SELECT context | Carry stored edge context into reports | direct-context regression and coverage tests |
| R14 arbitrary metric payloads | Per-tool identifier allowlists; omit query/source payloads | sentinel and existing disabled/write-failure tests |
| R15 stale Workbench state | Remount project-owned views; ignore superseded responses; error states | four React lifecycle tests; actual two-project browser check |
| R16 lost watcher events | Dirty-flag scheduler drains changes serially | in-flight event/error tests; live add/delete/restart service test |
| R17 denial counted as grant | Target-specific positive access predicates before grouping | denial/group regression and existing permission tests |
| R18 Aura helper omissions | Scan helper/controller actions and preserve markup class dependency | helper parser and existing Aura pipeline/trace tests |

## Fresh review

A separate read-only reviewer found four additional issues. All four were reproduced as failing tests and fixed: release the singleton socket only after shutdown finishes; apply watcher exclusions relative to the project root; hash sibling email bodies; use SQLite character lengths for Unicode prefix/suffix matching. The focused review suite passes 13 tests. No review findings remain deferred as minor issues.

## Verification

Final toolchain: **Bun 1.3.14** (now pinned in CI/release and the package minimum).

- Frozen root and web installs, root and web TypeScript checks, **210 tests passed / 0 failed**, and compiled UI/binary builds passed in a fresh temporary source copy with independently installed dependencies. The test process exited 0.
- Compiled binary `--version` reports `1.1.2`; `--help` succeeds. A temporary service served two stdio MCP clients and two separately indexed projects, list/call requests, authenticated APIs and embedded UI. Native HTTP MCP list/call is also tested with two clients.
- Service tests cover independent-process launch races, failed ownership acquisition without discovery overwrite, crash replacement, origin/auth rejection, canonical-root deduplication, hidden worktree paths, add/delete updates, restart restoration and shutdown ownership.
- The compiled Workbench was inspected in the browser: project A graph search, switch to B (state cleared), B search and graph rendering showed B's source paths. Temporary service/database and browser tab were cleaned up.
- Sample benchmark: **8/8 canonical queries passed**, 72 nodes and 146 edges. 100-class synthetic comparison: 907 nodes, approximately 0.3 seconds initial indexing in that run. A separate cold/warm inventory measurement: full 1,038 ms / 104 files; unchanged 5 ms / 0 files; one changed file caused the intended full project rebuild, 131 ms / 104 files. These are local illustrative measurements, not real-org accuracy or a controlled before/after performance study.
- `git diff --check` passes. Vite reports a nonblocking ~596 kB JavaScript chunk warning.

Bun 1.3.8 was also tested: builds and compiled smoke passed, but the complete test process repeatedly exited 133 after all assertions passed. macOS crash reports identify an invalid free in pthread thread-local teardown. Core-only and UI-only subsets exited 0; the identical full suite exits 0 on 1.3.14. The pin change avoids this observed runtime failure; it is not a claim that an upstream root cause was independently proven.

## Decisions and remaining scope

- Work in a new branch in the existing dirty checkout, with a preserved baseline, because a HEAD-only worktree would omit the application being repaired. No unrelated changes were committed. Cost: the final tree still includes the user's preexisting work and should be reviewed as such.
- Rebuild a changed project instead of repairing incremental dependency bookkeeping prematurely. Cost: one edit reparses all files; no-change runs stay cheap. A later optimization must pass the same parity oracle.
- Reject ambiguous whitespace-stripped standalone SOQL strings; production passes original parse contexts. Cost: callers of the standalone helper must provide valid spaced source.
- Explore label/edge filters and “show more,” the savings timeline, and the method-to-class permission picker were deferred from this remediation under plan Task 12, then implemented in the separately requested [UI follow-ups](2026-11-03-ui-follow-ups.md). Permission reports describe metadata grants, not effective access for a Salesforce user.
- Historical metrics rows are preserved; the privacy fix applies to new writes. Cost: old rows may still contain previously persisted arguments. No destructive purge was performed.
- Update the Bun pin from 1.3.8 to 1.3.14 based on the reproduced teardown failure. Cost: the supported runtime minimum changes.
- Trusted local-user operation remains the security model. Cross-platform release execution, an independent dependency audit, and real-org corpus accuracy are not claimed by this local validation. The broader SOQL relationship/subquery terminal-resolution milestone remains separate work.

The baseline/recovery files remain available to preserve the precise pre-remediation snapshot.
