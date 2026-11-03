# Workbench UI follow-ups — 2026-11-03

Before implementation, the prior remediation was committed and pushed as Marceswan: [`5841075`](https://github.com/Marceswan/Spindle/commit/5841075), on `codex/review-remediation`. That commit does not include these subsequent UI changes.

## Implemented behavior

- **Explore:** project-schema node-label and edge-type filters apply during traversal, before the node cap. The center remains visible. Expansion adds one hop up to five; “Show more” adds 500 nodes up to 2,000. Re-centering retains filters and resets depth/cap. Obsolete responses are ignored, and failed requests can be retried.
- **Savings:** daily estimated token savings appear in an SVG chart and accessible daily-values table. UTC aggregation matches the backend. Missing days have zero calls/savings. Latest 30/90-day windows end on the latest recorded activity; full history is also available. Empty history and a single zero-valued day are supported.
- **Permissions:** users can search indexed Apex methods by class, method name or literal full signature. Selection resolves the declaring class through a project-scoped `DEFINES_METHOD` edge, including nested classes and parameterized signatures. Reports show class metadata grants, not effective execution access for a user. Search returns up to 50 methods and prompts refinement at that limit. Switching targets invalidates old requests.

## Validation

- Bun 1.3.14: **218 tests passed, 0 failed**, 655 assertions across 42 files; test process exited 0.
- Focused API and UI suites: **12 tests passed**, covering graph filter/cap ordering, hop expansion, project isolation, method ownership and literal signature matching, stale responses, retries and timeline gaps/zero values. New behavior was exercised with failing tests before implementation.
- Root and web TypeScript checks passed. The embedded UI and compiled binary build passed. Vite's approximately 603 kB JavaScript chunk warning remains nonblocking.
- The compiled Workbench was verified in a browser using a temporary fixture. A capped 500-node graph expanded to 532 nodes; method/relationship filters produced the expected four-node graph. Timeline daily values included zero-activity dates. Selecting `AccountService.cleanup()` resolved `AccountService` and returned the expected permission set, profile and permission-set group.
- The temporary service, database and browser tab were cleaned up. No release was published.
