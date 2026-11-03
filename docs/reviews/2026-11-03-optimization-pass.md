# Workbench optimization pass — 2026-11-03

This pass implements the first recommended batch: reproducible performance measurements, bounded neighborhood traversal, incremental graph updates and deferred Explore loading. It builds on the locally implemented UI follow-ups; neither set of changes is included in the previously pushed `5841075` remediation commit.

## Changes

- Query frontier nodes in batches of 100 with keyset-paged candidate results (at most 256 rows per page). Separate incoming/outgoing branches use existing endpoint indexes. Project ownership and node/edge filters remain part of SQL selection; self/bidirectional matches are deduplicated by `UNION`.
- Bound results at 2,000 nodes and 5,000 edges, traversal at five hops, and candidate processing at 10,000 edges. One lookahead row distinguishes an exhausted budget from actually truncated results. The API adds `truncationReason`: `node_cap`, `edge_cap` or `work_budget`. These bound materialized/processed results, not SQLite instruction count or elapsed time.
- Preserve retained Cytoscape nodes, positions and viewport while reconciling data in a batch. New nodes are placed on an outer ring; the initial neighborhood uses a breadth-first circular layout. Explicit re-centering arranges a new neighborhood, while **Fit graph** changes only the viewport. A pending update retains the old graph with a loading notice; failed updates clear it. Labels disappear below a minimum rendered size.
- Load Explore/Cytoscape through a dynamic import. A regression test builds the actual Vite production bundle and checks that Explore is deferred and initial JavaScript remains below 200 kB.
- Keep the existing single-service architecture. These changes add no production processes or additional database owners.

## Local measurements

Bun 1.3.14, macOS arm64, Apple M3 Pro. Query measurements use five warmups and 30 iterations over identical synthetic in-memory fixtures. Values are illustrative local results, not real-org service latency guarantees.

| Fixture | Input nodes / edges | Median before → after | p95 before → after | Returned nodes / edges after |
|---|---:|---:|---:|---:|
| Hub, one hop | 10,001 / 10,000 | 2.47 → 1.27 ms | 3.00 → 1.36 ms | 500 / 499 |
| Wide, two hops | 2,001 / 2,000 | 23.13 → 3.52 ms | 24.19 → 4.30 ms | 2,000 / 1,999 |
| Dense, two hops | 160 / 12,720 | 110.11 → 6.47 ms | 114.92 → 9.01 ms | 160 / 5,000 |

The dense case now returns a truncated result instead of all 12,720 edges, so its timing improvement includes deliberately doing less work. Hub and wide output counts are unchanged. The single timer-delay sample during a wide query fell from 29.76 to 3.88 ms; this is not a concurrent-client p95 measurement. RSS snapshots varied and do not establish a memory reduction.

The new headless graph benchmark measured median expansion times of 1.19 ms (100→200 nodes), 5.52 ms (500→1,000), and 8.90 ms (1,000→2,000). Initial layouts measured 4.08, 9.28 and 18.98 ms respectively. The previous force-directed baseline run was stopped before producing a completed report; no comparable layout speedup factor is claimed. Headless results exclude canvas rendering and DOM work.

Production initial JavaScript decreased from approximately 602.82 kB to **156.30 kB** (50.43 kB gzip). The deferred Explore chunk is 449.05 kB (143.82 kB gzip). Total code is slightly larger; the benefit is avoiding graph-library loading on other tabs. No chunk exceeds Vite's default 500 kB warning threshold.

## Verification

- **227 tests passed, 0 failed**, 689 assertions across 45 files. New regressions cover edge/work limits, exact-budget boundaries, deterministic node caps, batched traversal, retained node identity/positions/viewport, pending UI updates, truncation messaging and the production bundle.
- Root and web typechecks and the compiled binary/embedded-assets build passed. The full suite includes the existing single-service, process-race and watcher regressions.
- Browser check against the compiled binary: Overview loaded; Explore loaded on selection; 500 nodes expanded to 532; a dense second-hop query stopped at 5,000 edges with the appropriate message and no ineffective “Show more.” Filtering produced the expected four-node, three-edge method graph, and **Fit graph** worked.
- Temporary browser tab, fixture database and service were cleaned up. No release, commit or push was performed during this pass.

## Subsequent work

Method-search ranking/pagination, savings rollups, parse-result caching, broader keyboard navigation, service status and project-revision invalidation remain separate follow-ups. Parsing/indexing responsiveness and browser frame rates have not been benchmarked in this pass. Future parse caching must retain complete dependency resolution and atomic graph publication, and pass the existing incremental-versus-full correctness checks.
