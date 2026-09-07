# Changelog

All notable changes to Spindle (`sfdx-graph-mcp`). See `sfdx-graph-mcp-design.md` §14 for
the roadmap; this file records what's actually shipped.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow SemVer once a v1.0 binary ships.

---

## [v1.2.0] — 2026-09-07 (release setup pending)

- Extract advanced Flow variable, decision, assignment, formula, and record references.
- Parse static SOQL with the Apex grammar, retaining clause context and resolving
  metadata-backed parent and child relationships.
- Support OPTIONAL MATCH and WITH chaining with scoped, parameterized Cypher stages.
- Add paginated `diff_projects` and CLI comparison of indexed org source snapshots.
- Add a read-only local browser UI using the existing shared service.
- Add verified self-update and rollback for macOS/Linux, with GPG-signed version-bound
  checksum manifests. Windows replacement is manual. Release signing requires the
  documented public-key and Actions-secret setup; no production key is included.
- Full reindex required to refresh references in previously indexed projects.

## [v1.1.2] — patch

### Fixed

- **SessionStart hook output now uses Claude Code's documented JSON contract.** Per https://code.claude.com/docs/en/hooks, the modern shape is `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }` on stdout. v1.1.0–v1.1.1 wrote plain text which Claude Code does inject into the model's context — but only the JSON form survives schema-strict consumers reliably, and the `additionalContext` framing makes the model treat it as documented session info rather than a stray log line.
- **Hook now reads stdin JSON** per the spec. Claude Code pipes `{ session_id, cwd, source, hook_event_name, model }` to the hook. We extract `cwd` and `source` from there (with a 200ms timeout fallback to `CLAUDE_PROJECT_DIR` / `process.cwd()`). This makes the hook robust against shells that don't propagate `CLAUDE_PROJECT_DIR`.
- **Stronger context message.** When indexing succeeds the hook tells the model to prefer Spindle MCP tools over Grep/Read in this project, so the graph actually gets used.

### Added

- **Diagnostic log at `~/.cache/sfdx-graph-mcp/hook.log`** (one JSON line per invocation: timestamp, cwd, source, result). This is the user-visible proof the hook fired — Claude Code's docs explicitly state hook stdout is invisible in the chat UI, so the log is the way to confirm the hook ran. Tail it to watch hooks in real time:
  ```
  tail -f ~/.cache/sfdx-graph-mcp/hook.log
  ```
- **`--source` CLI flag** for the `session-start-hook` subcommand (lets you simulate a SessionStart subtype manually).

---

## [v1.1.1] — patch

### Fixed

- **SessionStart hook didn't fire on resumed sessions.** v1.1.0 registered the hook under `matcher: "startup"`, which only fires when Claude Code creates a brand-new session. Resumed sessions (`claude -c` / `claude --resume`), `/clear`, and post-compact restarts trigger their own SessionStart subtypes (`resume`, `clear`, `compact`) and skipped the startup-matchered entry entirely. The hook now registers with no matcher, matching the pattern of `session-init.py` and similar always-on hooks; it fires on all four SessionStart subtypes. The watch-daemon is idempotent (PID-file-guarded), so re-firing is safe.
- **`register-hook` now strips stale Spindle entries from ALL SessionStart matcher entries** before placing the new one. Previously a reinstall that moved the hook between matcher scopes left an orphan copy under the old matcher. Two new tests cover the cross-matcher cleanup path.

### Migration

Users who installed v1.1.0 should re-run `sfdx-graph-mcp register-hook` to relocate their hook entry. No settings.json data is lost; existing non-Spindle hooks are preserved.

---

## [v1.1.0] — Claude Code SessionStart hook

### Added

- **`session-start-hook` subcommand.** Detects an SFDX project at `$CLAUDE_PROJECT_DIR` (or process.cwd()), walks up to find the `sfdx-project.json` or `force-app/` anchor, runs an incremental index, then spawns a detached `watch-daemon` for the lifetime of the session. Always exits 0 so a malformed project never blocks Claude Code startup. Detection respects subdirectories — `cd force-app/main/default/classes && claude` finds the project root.
- **`watch-daemon <project-root>` subcommand.** Long-lived per-project watcher. PID-tracked at `<db-dir>/watchers/<sha256(root):16>.pid`; idempotent (a second daemon for the same root exits immediately). chokidar-driven incremental reindex with 300ms debounce.
- **`stop-watch` subcommand.** Sends SIGTERM to the watcher for the current (or given) project. Used by the SessionEnd hook for cleanup.
- **`register-hook` / `unregister-hook` subcommands.** Idempotent management of two entries in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`): a SessionStart `startup` matcher running `session-start-hook`, and a SessionEnd entry running `stop-watch`. Preserves unrelated settings; replaces stale Spindle entries when the binary path changes between installs; refuses to overwrite malformed JSON.
- **Installers auto-register.** Both `install.sh` and `install.ps1` invoke `register-hook` after binary placement. Set `SPINDLE_SKIP_HOOK=1` (POSIX) or `$env:SPINDLE_SKIP_HOOK = "1"` (Windows) to opt out.

### Changed

- **Unified default graph database path.** Previously the CLI `index` subcommand and the `index_project` MCP tool wrote to `<project-root>/.sfdx-graph/graph.db` (per-project), while the MCP server read from `~/.cache/sfdx-graph-mcp/graph.db` (shared) — writes and reads didn't meet. Both now use the shared store (overridable via `$SFDX_GRAPH_HOME` or `index --db-path <path>`). The shared store is keyed by `project_id` so multiple SFDX projects coexist in one db; this matches `list_projects` semantics.
- **`index_project` tool now uses the shared store.** Moved from `toolsStandalone` to `toolsWithStore` in the MCP server. Writes from the tool are immediately visible to `search_graph`, `trace_references`, etc. in the same session.

### Tests

- `test/hook/register.test.ts` — 9 tests covering create-from-scratch, preserve-unrelated, idempotency, stale-entry replacement, coexistence with other hooks, and malformed-JSON refusal.
- `test/hook/session-start.test.ts` — 5 tests covering non-SFDX skip, `sfdx-project.json` detection, walk-up from subdirectory, malformed manifest graceful skip, and `force-app/`-only detection.

---

## [v1.0.2] — patch

### Fixed

- **`install.sh` binary download failed for internal/private repos** even with `Authorization: Bearer <token>`. GitHub's `browser_download_url` 302-redirects to a CDN, and `curl`/`wget` strip the auth header on cross-host redirects (a security feature, not a bug). The installer now prefers `gh release download` when `gh` is available — gh handles the auth+redirect natively. Public-repo behavior is unchanged.
- Dogfooded the patched installer end-to-end against the v1.0.1 internal release: clean SHA256 verification, correct binary install, `--version` reports `1.0.2`.

### Added

- **`claude-md-snippet.md`** at repo root — a copy-paste CLAUDE.md block that instructs Claude Code to prefer Spindle's MCP tools over Grep/Glob/Read for structural SFDX questions. Mirrors the design doc §15.7 plan.

---

## [v1.0.1] — patch

### Fixed

- **`--version` reported `0.1.0` after v1.0.0 release.** The `VERSION` constant in `src/cli.ts`, the `version` field in `package.json`, and the MCP server's advertised version in `src/server.ts` were never bumped. All three now read `1.0.1`. Caught by installing the v1.0.0 binary and running `--version` against it.
- **`install.sh` / `install.ps1` failed against internal-visibility GitHub repos.** Anonymous `curl` / `Invoke-WebRequest` returns 404 on `raw.githubusercontent.com` and `api.github.com` for repos that aren't public. Both scripts now look for a token in (in order) `$GITHUB_TOKEN`, `$GH_TOKEN`, or `gh auth token`, and thread `Authorization: Bearer <token>` through every API and asset fetch. Public-repo behavior is unchanged.

Bug discovered by dogfooding the v1.0.0 distribution flow.

---

## [Unreleased] — v0.5 + v1.0 distribution

### v0.5 — Cypher query layer (`query_graph`)

The 9th and final MCP tool from the design doc. A hand-rolled openCypher subset (no new deps) that compiles to SQL and runs against the graph store.

**Supported syntax:**
- `MATCH (n:Label)` — labelled and unlabelled node patterns
- `MATCH (n:LabelA)-[r:EDGE_TYPE]->(m:LabelB)` — directed rel patterns with both endpoints labelled
- `MATCH (n)<-[r:EDGE_TYPE]-(m)` — incoming direction
- `MATCH (n)-[r]->(m)` — any-edge match
- `WHERE` with `=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN [...]`, `IS NULL`, `IS NOT NULL`, `AND`/`OR`, parenthesized grouping
- `RETURN` a whole variable, a property (`n.name`), or `count(*)`/`count(n)`
- `ORDER BY n.prop [ASC|DESC]`, `LIMIT N`, `SKIP N`
- First-class node columns (`name`, `qualified_name`, `label`, `file_path`, `start_line`, `end_line`); JSON-blob properties via `json_extract`

**Layout** (`src/graph/cypher/`):
- `tokenizer.ts` — multi-word keyword collapsing (ORDER BY, STARTS WITH, ENDS WITH, OPTIONAL MATCH)
- `parser.ts` — recursive descent, returns `{ ok: true, query }` or `{ ok: false, message, column }`
- `planner.ts` — AST → parameterized SQL, with `col_N` aliases per projection so multi-variable returns don't collide
- `executor.ts` — runs the plan, post-processes node/edge JSON blobs back into `StoredNode` shape
- `types.ts` — shared AST types

**Unsupported (returns a friendly error with suggestion):** `OPTIONAL MATCH`, `WITH` chaining, `UNWIND`, variable-length paths, aggregates beyond `count`, `CALL`, path variables, `CREATE`/`MERGE`/`DELETE`/`SET` (Spindle is read-only by design).

**Bug fixed during validation.** A live demo of `RETURN s.name, t.name` returned only one value per row because bun:sqlite's row object collapses duplicate column keys. The planner now aliases every SELECT expression as `col_N`. Regression test added (`test/tools/query-graph.test.ts`).

### v1.0 — distribution and release infrastructure

**GitHub Actions workflows** (`.github/workflows/`):
- `ci.yml` — typecheck + tests + single-binary compile smoke test on every PR/push. The compile step is a regression guard for asset-bundling bugs like the `schema.sql` one in v0.4.
- `release.yml` — on `v*.*.*` tag push, builds the 5-target binary matrix (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64), computes SHA256 checksums, attaches everything to a GitHub Release with auto-generated notes.

**Install scripts:**
- `install.sh` — POSIX shell. Detects platform via `uname`, resolves the latest release manifest from the GitHub API (or a pinned `SPINDLE_VERSION`), downloads the matching binary, verifies SHA256 against the release's `SHA256SUMS`, installs to `/usr/local/bin` or falls back to `~/.local/bin`. Pure shell — no jq/jq-like dep.
- `install.ps1` — PowerShell equivalent for Windows. Installs to `$LOCALAPPDATA\Programs\spindle` by default.

**Cross-compile validated locally** for all five targets from a macOS arm64 host. Each binary is ~60-105 MB and boots cleanly — `--version` and `--help` work on the linux-x64 binary smoke-tested in CI.

**Project docs:**
- `LICENSE` (MIT, was missing from the v0.2 initial commit)
- `SECURITY.md` — threat model, privacy stance ("no outbound network calls at runtime"), responsible disclosure address
- `CONTRIBUTING.md` — development setup, parser-adding workflow, tool-adding workflow, commit conventions

### Test count

- **101 tests across 20 files, 0 failures.** (15 new Cypher tests + 1 regression test + 85 pre-existing.)

---

## [Unreleased] — v0.4 development

### v0.4 — StaticResource, EmailTemplate, watch mode, binary distribution validation

**StaticResource parser.** `StaticResource` nodes from `staticresources/<name>.resource-meta.xml`. The previously-dropped `LWC_USES_RESOURCE` edges now resolve when an LWC imports a real resource.

**EmailTemplate parser.** `EmailTemplate` nodes from `email/<folder>/<name>.email-meta.xml` with `<folder>/<templateName>` qnames. Reads the associated `.email` body file (when present) and scans both subject + body for `{!Object.Field}` merge fields and `{!$Label.X}` references, emitting `EMAIL_REFERENCES_FIELD` and `REFERENCES_LABEL` edges.

**Watch mode** (design §9.1 / §7.5). `bun run src/cli.ts index <project> --watch` starts a `chokidar` watcher after the initial index. File changes trigger debounced (300ms) incremental reindex runs. Verified hot-loop end-to-end: full index 600ms → single-file change → incremental reindex **24ms** → SIGINT graceful shutdown. Hits the design §11 target with margin.

**Bun-compiled binary** (design §15.2, §15.10 dry-run). `bun run build` produces a single 62MB Mach-O arm64 executable (`dist/sfdx-graph-mcp`). The compiled binary:
- Indexes the full sample fixture (23 files → 38 nodes / 58 edges) in ~1.0s
- Serves the MCP stdio protocol; `tools/list` returns all 8 tools
- Has no runtime dependency on Node, npm, or any package registry

### Fixed

- **`schema.sql` loaded via `readFileSync` failed inside Bun-compiled binaries** (`ENOENT: /$bunfs/root/schema.sql`). The bundler doesn't include sibling asset files. Refactored: DDL now lives in `src/graph/schema.ts` as a string constant; the `.sql` file is preserved as the human-readable canonical only. Captured in `learnings.md`.

### Test count

- **85 tests across 19 files, 0 failures.**

### Surfaces covered (cumulative)

Apex, Object metadata (SObject + Field + ValidationRule + RecordType), Custom Labels, LWC, Aura, Visualforce, Permission Sets / Profiles / Permission Set Groups, FlexiPages, Layouts, Flows, **StaticResources, Email Templates** (new in v0.4).

---

## [v0.3 snapshot — second commit]

## [Unreleased] — v0.3 development

### v0.3 — Permissions, FlexiPages, Layouts, Flows, CustomLabels

Added in v0.3 (a single development push completing several originally-separate phases):

**CustomLabel parser.** `CustomLabel` nodes from `labels/CustomLabels.labels-meta.xml` with `c.<fullName>` qualified names matching the LWC and VF import convention. The previously-dropped `LWC_USES_LABEL → c.Greeting` edge now resolves.

**Permission graph.** `PermissionSet`, `Profile`, `PermissionSetGroup` nodes; `GRANTS_APEX_ACCESS` / `GRANTS_OBJECT_ACCESS` / `GRANTS_FIELD_ACCESS` / `GRANTS_VISUALFORCE_ACCESS` / `GRANTS_RECORDTYPE_ACCESS` / `INCLUDES_PERMSET` edges with full access detail (CRUD, read/edit, enabled) on each edge's properties.

**`get_permission_access` MCP tool** (design §9.9). The second headline tool — "who can run this Apex method", "who can read this field". Walks PermissionSetGroup membership to surface indirect grants. Supports ApexClass, SObject, Field, VisualforcePage, RecordType targets.

**FlexiPage parser.** `FlexiPage` nodes; `FLEXIPAGE_INCLUDES_COMPONENT` to LwcBundle/AuraBundle (both candidates emitted, pass 2 keeps whichever resolves); `FLEXIPAGE_REFERENCES_FIELD` from both `componentInstanceProperties` value attributes and explicit `fieldInstance` elements (Record.X rewritten to SObject.X using the FlexiPage's bound `sobjectType`).

**Layout parser.** `Layout` nodes with parent SObject parsed from the `SObject-Label` filename convention; `LAYOUT_INCLUDES_FIELD` edges from layoutSections → layoutColumns → layoutItems. `emptySpace` items skipped.

**Flow XML parser** (minimum viable; design §6.9). `Flow` nodes with processType, triggerType, triggerObject, recordTriggerType; `INVOCABLE_FROM_FLOW` for actionCalls with actionType=apex; `FLOW_DML_ON` for recordCreates/Updates/Deletes/Lookups (operation property captures the verb); record-trigger start emits a `FLOW_DML_ON` with `operation=trigger`; `FLOW_INVOKES_FLOW` for subflows. Variables, decisions, assignments, formulas deferred to v0.4.

**`get_field_usage` extensions.** Tool now populates the `layouts` bucket (Layout + FlexiPage field references) and `flows` bucket (Flow record-DML/lookup hits via parent-SObject approximation). `coverage` field now has three tiers: `authoritative`, `indirect`, `pending`.

**MCP server.** Now exposes **8 tools**: `index_project`, `list_projects`, `get_schema`, `search_graph`, `trace_references`, `get_source_snippet`, `get_field_usage`, `get_permission_access`.

### Test count

- **81 tests across 18 files, 0 failures.**

### Sample fixture census

Indexing the full sample fixture (now covering Apex, Object Metadata, LWC, Aura, VF, CustomLabels, PermSets/Profile/PSG, FlexiPage, Layout, Flow) produces **36 nodes across 22 labels and 55 edges across 25 edge types in ~985ms.**

Live `get_field_usage("Customer__c.Email__c")` returns the field's full impact map across SIX metadata surfaces in one MCP call (LWC, VF, validation rule, layout, FlexiPage, indirect Apex via SOQL_SELECT) — the design §9.7 headline query working end-to-end.

---

## [v0.2 snapshot — initial commit]

### Headline numbers (sample fixture, 13 files / 27 nodes / 30 edges)

- Index latency: ~580ms full, sub-100ms incremental
- Query latency: 0.2-1.5 ms across all 7 MCP tools
- Bench Phase B (vs grep+read at 100-class scale): **Spindle uses 25% of grep's tokens, 161x faster** on average

### Added — parsers and graph coverage

- **Object metadata XML parser** (§6.5). `SObject`, `Field`, `ValidationRule`, `RecordType` nodes from `objects/<Name>/{*.object-meta.xml, fields/, validationRules/, recordTypes/}`. Picklist values, formula expressions, reference targets, roll-up summaries all captured.
- **Formula token walker.** Validation-rule and formula-field expressions parse into `VALIDATION_REFERENCES_FIELD` / `FORMULA_REFERENCES_FIELD` edges. Reserved-word filter excludes common functions (IF, ISBLANK, etc.). Confidence 0.6 (Regex).
- **LWC parser** via `@lwc/metadata` (pinned 15.0.5). `LwcBundle`, `LwcModule`, `LwcTemplate` nodes; `LWC_USES_APEX`, `LWC_USES_FIELD`, `LWC_USES_LABEL`, `LWC_USES_RESOURCE`, `LWC_INCLUDES_COMPONENT` edges. Handles all 28 `@salesforce/*` scoped import variants.
- **Visualforce parser** via `@apexdevtools/vf-parser` (promoted from v1.1 to v0.2). `VisualforcePage`, `VisualforceComponent` nodes; `VF_USES_APEX` (controller + extensions), `VF_USES_FIELD` (`{!Object.Field}` bindings), `VF_INCLUDES_COMPONENT`.
- **Aura parser** (built from scratch with `fast-xml-parser` + regex). `AuraBundle`, `AuraComponent`, `AuraController`, `AuraHelper` nodes; `AURA_USES_APEX` (via `component.get("c.X")` regex pass), `AURA_INCLUDES_COMPONENT` (both Aura and LWC namespace candidates emitted).
- **SOQL SELECT-clause field resolution.** `[SELECT Id, Email__c FROM Customer__c]` now emits per-field `REFERENCES_FIELD` edges in addition to the coarse `SOQL_QUERIES`-to-SObject edge. Edges to unmodelled fields (standard objects, missing custom metadata) are dropped cleanly by pass 2.

### Added — MCP tools

- **`get_field_usage`** — the headline tool from design §9.7. Returns LWC bundles, VF pages/components, validation rules, Apex methods (direct via REFERENCES_FIELD, indirect via parent-SObject SOQL/DML), and a `coverage` summary distinguishing authoritative buckets from pending ones (flows, layouts, etc.).

### Added — pipeline

- **Generalized parser dispatcher.** `src/pipeline/parse-dispatch.ts` routes discovered files by `DiscoveredFileKind` to the right parser. Source reading is the dispatcher's responsibility; bundle-shaped parsers (LWC, Aura) read their own file lists from disk.
- **Short-name fallback in pass 2.** When an in-file edge targets an `ApexMethod` by unparameterized qname (e.g., `AccountService.cleanup` from an LWC `@salesforce/apex` import), pass 2 falls back to a `methodsByClassAndName` lookup, preferring `@AuraEnabled` overloads.
- **Bundle discovery.** `discoverApexFiles` now also walks `lwc/`, `aura/`, `pages/`, `components/`, and `objects/`. Each bundle gets a composite SHA-1 hash so incremental reindex covers it.

### Added — benchmarks

- **Phase A** (`bench/{queries,runner,report,cli}.ts`): per-query latency, memory, token approximation, and recall/false-positive scoring against the sample fixture. 8 canonical queries, 100% recall, 0 false positives.
- **Phase B** (`bench/{corpus,grep-baseline,compare,compare-report}.ts`): synthetic-corpus generator (parameterized by class count + seed), grep+read baseline simulator, and side-by-side compare table. New CLI modes: `--generate`, `--compare --corpus <path>`, `--compare --size <N>` (ephemeral).
- **`learnings.md`** at repo root captures project-specific gotchas (ANTLR whitespace stripping, `exactOptionalPropertyTypes`, bun:test timeouts, etc.) so future sessions don't rediscover them.

### Changed

- **Scope decision (April 2026 user call):** LWC, Aura, and Visualforce all promoted from v0.3 / v1.1 into v0.2. Design doc §14 roadmap is now ahead of schedule.
- **Bench logger output.** `package.json`'s `bench` script now sets `SFDX_GRAPH_LOG_LEVEL=silent` so pipeline pino logs don't interleave with stdout. The previous attempt to set it via `process.env` assignment at module top didn't work due to ESM import hoisting.

### Fixed

- **SOQL field-list regex** previously required whitespace or `[` after `FROM`, which never appears in ANTLR's whitespace-stripped `node.text`. Now uses `\s*FROM` with no trailing anchor.
- **Aura controller binding.** Bundle file processing now sorts `.cmp` before `*Controller.js` so the `controller=` attribute is read before the regex pass that depends on it.
- **Aura `<c:foo>` resolution.** Emits TWO candidate edges (one to `AuraBundle:foo`, one to `LwcBundle:c/foo`) since Aura can host LWCs. Pass 2 keeps whichever target node actually exists.
- **`.sfdx/` cache pollution** in the sample fixture removed (was ~41MB of Salesforce stdlib snapshots from a stray `sf` invocation). Added to `.gitignore`.

### Test count

- **56 tests across 13 files, 0 failures.**

---

## [0.1.0] — Apex MVP

Initial Apex-only graph.

### Added

- File discovery for `force-app/main/default/classes/` and `triggers/`.
- Apex parser via `@apexdevtools/apex-parser` (ANTLR). Extracts `ApexClass`, `ApexInterface`, `ApexEnum`, `ApexTrigger`, `ApexMethod`, `ApexProperty` nodes plus `CALLS`, `INSTANTIATES`, `EXTENDS`, `IMPLEMENTS`, `DEFINES_METHOD`, `DEFINES_PROPERTY`, `TRIGGERS_ON`, `SOQL_QUERIES`, `SOSL_QUERIES` edges.
- SQLite-backed graph store with content-hash-based incremental reindex.
- 6 MCP tools: `index_project`, `list_projects`, `get_schema`, `search_graph`, `trace_references`, `get_source_snippet`.
- Local CLI with `index` / `reset` / `doctor` subcommands.
- Sample SFDX fixture (4 Apex classes, 1 trigger, all meta XML).
- 25 tests across 5 files, 0 failures.
