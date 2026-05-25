# CLAUDE.md — Spindle (sfdx-graph-mcp)

Project instructions for working on **Spindle**, an MCP server that indexes SFDX projects into a queryable metadata graph.

Read `sfdx-graph-mcp-design.md` (project root) before doing anything non-trivial. It is the authoritative source of truth for architecture, schema, tool surface, and roadmap. If this file conflicts with the design doc, the design doc wins.

---

## What this project is

A local-first MCP stdio server, written in TypeScript and compiled with `bun build --compile` to a single self-contained binary distributed via GitHub Releases. It parses an SFDX project (Apex, LWC, Aura, metadata XML, Flow XML) into a typed graph of nodes and edges stored in SQLite, then exposes ~12 MCP tools (`search_graph`, `trace_references`, `get_field_usage`, `get_permission_access`, etc.) that Claude Code calls instead of grep/glob/read for structural SFDX questions.

The product is *about* Salesforce but the codebase is **not a Salesforce project**. There is no `force-app/`, no `sf` CLI, no Apex code, no permission sets. Ignore the Salesforce conventions in the parent `~/.claude/CLAUDE.md` and `~/Documents/Code/CLAUDE.md` when authoring code in this directory — they describe the Univision Matrix project, not Spindle.

The only Salesforce-shaped files in this repo are **test fixtures** under `test/fixtures/sample-sfdx-project/`. Those are intentional inputs to the parsers, not production metadata.

---

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Runtime / bundler | Bun 1.1+ (`bun build --compile` for release binaries) |
| Database | `bun:sqlite` (built into the runtime; no native module concerns) |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Apex parser | `@apexdevtools/apex-parser` (ANTLR-based, pure JS) |
| VF parser | `@apexdevtools/vf-parser` (ANTLR-based, pure JS — same ecosystem as the Apex parser) |
| LWC metadata | `@lwc/metadata` (pinned to 15.0.5; "as-is with no support" per upstream — pin exact, do not float major) |
| LWC JS parser | `@babel/parser` (transitively used by `@lwc/metadata`) |
| HTML parser | `parse5` |
| XML parser | `fast-xml-parser` |
| File watcher | `chokidar` |
| Logging | `pino` (structured, low overhead) |
| CLI | `commander` |
| Test runner | `bun test` (built-in) |

Development can run under Node 20+ as a fallback; release builds always use Bun. Pin the Bun version in CI; treat Bun upgrades as deliberate events with a full test pass.

---

## Phase and scope

**v0.1 (shipped):** Apex-only graph. Classes, triggers, methods, properties, interfaces; CALLS / INSTANTIATES / EXTENDS / IMPLEMENTS / DEFINES_METHOD / TRIGGERS_ON / SOQL_QUERIES / SOSL_QUERIES edges. Six MCP tools, full incremental reindex.

**v0.2 (shipped):** Object metadata XML (SObject + Field + ValidationRule + RecordType), LWC via `@lwc/metadata`, Visualforce via `@apexdevtools/vf-parser`, Aura (handwritten), formula token walker, SOQL SELECT-clause field resolution, `get_field_usage` MCP tool, bench Phase A + B.

**v0.3 (shipped):** CustomLabel parser, Permission graph (PermissionSet + Profile + PermissionSetGroup with `GRANTS_*` edges), `get_permission_access` MCP tool, FlexiPage parser, Layout parser, Flow XML parser (actionCalls + record DML + subflows; advanced extraction deferred).

**v0.4 (shipped):** StaticResource parser, EmailTemplate parser (with merge-field scanning), chokidar watch mode (`--watch` flag on `index` subcommand), Bun-compiled single-binary distribution validated end-to-end. The schema DDL was moved from a sibling `.sql` file to a TypeScript string constant so it bundles correctly into the compiled binary.

**v0.5 (shipped):** Cypher query layer + `query_graph` MCP tool. Hand-rolled tokenizer + recursive-descent parser + SQL planner + executor under `src/graph/cypher/`. Supports MATCH (single + relationship + reverse + any-edge), WHERE (`=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS [NOT] NULL`, `AND`/`OR`), RETURN (whole variable, property, `count(*)`/`count(n)`), ORDER BY, LIMIT, SKIP. Unsupported syntax (OPTIONAL MATCH, WITH, UNWIND, aggregates beyond count, write ops) returns a friendly error with suggestion.

**v1.0 distribution (shipped):** GitHub Actions `release.yml` does the 5-target matrix build on tag push (darwin-arm64/x64, linux-x64/arm64, windows-x64), computes SHA256 checksums, attaches everything to a GitHub Release. `install.sh` + `install.ps1` provide one-line installers with SHA256 verification. CI workflow (`ci.yml`) runs typecheck + tests + compile smoke test on every PR. LICENSE (MIT), SECURITY.md, CONTRIBUTING.md added.

**v0.6+ pending:** Advanced Flow extraction (variables, decisions, assignments, formula refs); OPTIONAL MATCH + WITH chaining + aggregates beyond `count` in Cypher; full SOQL parser replacement (currently regex).

**v1.1+ pending:** Self-update command with GPG-signed checksums; multi-org diff mode; read-only web UI.

**Demo target (current):** `get_field_usage("Customer__c.Email__c")` returns the field's full impact map across SIX metadata surfaces (LWC + VF + validation rule + FlexiPage + Layout + Apex SOQL_SELECT) plus indirect Flow hits — one MCP call, sub-millisecond after index. `get_permission_access` answers "who can read this field" symmetrically. Bench Phase B headline: Spindle uses ~25% of grep's tokens and is 100-160x faster on a 100-class synthetic corpus.

Do not pull v0.4+ scope forward unless explicitly asked. Email templates, advanced Flow, full SOQL parser, and Cypher land in their own phases.

---

## Code conventions

### TypeScript

- `"strict": true` in `tsconfig.json`. No implicit `any`. No `// @ts-ignore`.
- Prefer `type` aliases for shapes, `interface` only when declaration merging or class implementation is needed.
- All exported functions and types have explicit return types. Inference is fine inside function bodies.
- One default export per file is fine when the file is a single thing (a parser, a tool handler); otherwise named exports only.
- No barrel files (`index.ts` re-exports). They defeat tree-shaking and obscure imports.

### Module layout

Follow section 13 of the design doc. The key directories:

- `src/server.ts` — MCP stdio bootstrap; no business logic.
- `src/cli.ts` — `commander` entry; subcommands delegate to library functions.
- `src/tools/` — one file per MCP tool. Each file exports `{ name, description, inputSchema, handler }`.
- `src/pipeline/` — `discover.ts`, `pass1_structural.ts`, `pass2_intra_domain.ts`, `pass3_cross_domain.ts`, `pass4_reverse_index.ts`. Each pass is a pure function over the graph store.
- `src/parsers/<domain>/` — parsers are pure: `(filePath, fileContents) => { nodes, edges, unresolvedRefs }`. They never touch SQLite.
- `src/graph/store.ts` — the only place that talks to SQLite. All reads and writes go through typed query functions in `graph/queries.ts`.
- `src/model/` — node label constants, edge type constants, confidence levels. Single source of truth for these strings; never hardcode them at call sites.
- `src/util/` — keep small; resist the temptation to make this a dumping ground.

### Naming

- Files: kebab-case (`pass1-structural.ts`, `get-field-usage.ts`). The design doc uses underscores in some places; convert to kebab on the way in.
- Variables and functions: camelCase.
- Types and classes: PascalCase.
- Constants: SCREAMING_SNAKE_CASE for true compile-time constants only; otherwise camelCase.
- Database columns: snake_case (matches `schema.sql`).
- Edge type strings: SCREAMING_SNAKE_CASE matching the design doc table (e.g., `"CALLS"`, `"REFERENCES_FIELD"`).

### Parsers

- Pure functions. No I/O beyond receiving file contents as a string.
- Return `unresolvedRefs[]` for anything that requires cross-file knowledge. Pass 3 resolves these; the parser never does.
- Confidence is set at edge creation. A parser that emits a regex-derived edge sets `confidence: 0.6`; a fully-typed call resolution sets `1.0`. See section 5.4 of the design doc.
- Surface what couldn't be resolved via the diagnostics log, not by silently dropping it.

### Storage

- All writes happen inside transactions opened in `graph/store.ts`. Parsers and pipeline stages return data; they don't write.
- WAL mode on at startup. Single writer (the pipeline); reads are non-blocking.
- Schema changes go through versioned migrations in `src/graph/migrations/`. Bumping `schema_version` requires a migration script even if it's a no-op for fresh installs.
- Never assume the schema is fresh. On startup, check `schema_version`; run pending migrations or refuse to start with a clear error if the binary is older than the db.

### Tests

- `bun test` is the runner. Tests live under `test/` mirroring `src/` layout.
- Parser tests are the priority: each parser has a fixture file under `test/fixtures/sample-sfdx-project/` and a snapshot test of the emitted nodes/edges.
- Pipeline tests assert end-to-end: ingest the fixture project, query the graph, assert exact counts and qualified names.
- Tool tests run the tool handler against a pre-built graph fixture; don't spin up the MCP server in unit tests.
- Coverage isn't gated in v0.1 but parsers must have at least one happy-path test per supported syntactic form before merging.

### Performance discipline

- Section 11 of the design doc is the budget. Initial index of 100 classes under 5s; incremental reindex of one file under 1s; `search_graph` under 50ms.
- Always batch SQLite writes. Single-statement inserts inside a loop will blow the budget.
- Prefer prepared statements; the bun:sqlite API supports them — use `db.prepare(...)` once and reuse.
- Profile before optimizing. `bun --inspect` plus the built-in profiler is enough for v0.1.

### Logging

- `pino` for structured logs. JSON to stderr in production; pretty-printed in dev (`pino-pretty` via dev dep only).
- **Never log to stdout.** Stdout is the MCP transport. Anything written to stdout corrupts the protocol stream.
- Log levels: `error` for unrecoverable, `warn` for degraded operation (parser fallback, low-confidence edge), `info` for lifecycle events (index started, watch attached), `debug` for per-file work.
- No PII. The graph stores file paths and code structure; logs should never repeat code contents.

### MCP transport hygiene

- Stdout is reserved for MCP framed messages. Any console.log, console.error, or write to stdout outside the MCP SDK breaks the client.
- The SDK takes care of framing; do not write to the transport directly.
- The version-check notify message (section 15.5 of the design doc) writes to **stderr**, not stdout. Same rule for any future startup banners.

---

## What to ask vs. what to assume

### Ask

- Anything where the design doc is silent or marked "TBD". Don't invent.
- Bun version pin if it isn't set in `package.json` yet.
- Whether to add a new dependency. v0.1 keeps the dependency tree small on purpose — every dep ships inside the final binary.

### Assume from the design doc

- Architecture (four-pass pipeline, SQLite, single binary via Bun compile, GitHub Releases distribution).
- Stack choices (apex-parser, Babel, parse5, fast-xml-parser, bun:sqlite, MCP SDK).
- Node labels and edge types in section 5.
- Tool input/output shapes in section 9.
- Confidence model in section 5.4.
- Phased roadmap in section 14.
- Distribution and update flow in section 15.

If the design doc and reality diverge during implementation, update the design doc in the same change as the code; don't let drift accumulate.

---

## What not to do

- Don't write Apex, Salesforce metadata XML, or anything that looks like production Salesforce code outside of `test/fixtures/`. This project consumes those formats; it doesn't produce them.
- Don't add a Node-specific dependency that breaks under Bun. Test every new dep with `bun test` before committing.
- Don't introduce `tsc` as the build tool. Bun compiles the binary; `tsc --noEmit` is fine for type-checking in CI.
- Don't add a network call at runtime except for the explicit, documented update check (section 15.5).
- Don't read or write outside the project root unless invoked via a CLI subcommand the user explicitly pointed at a path.
- Don't add a web UI, telemetry, or analytics. The project's privacy stance is no outbound calls; that's a feature.
- Don't pull v0.2+ scope forward. Object metadata, LWC, Aura, permissions, and Flow each land in their own phase.

---

## Build and run

```bash
# Install deps (one-time)
bun install

# Type check
bun run typecheck             # tsc --noEmit

# Run tests
bun test

# Run the MCP server in dev mode against a sample project
bun run src/cli.ts             # default: stdio MCP server

# One-shot index from the CLI
bun run src/cli.ts index ./test/fixtures/sample-sfdx-project --full

# Build the release binary for the current platform
bun run build                  # -> dist/sfdx-graph-mcp
./dist/sfdx-graph-mcp --version
```

Cross-platform release binaries are built in CI; do not invoke `bun build --target=...` locally for a release unless you're debugging a build failure.

---

## Definition of done — work item

A change is done when:

1. Code compiles under `bun run typecheck` with no errors.
2. New code paths have tests under `test/`. Parser changes include a fixture.
3. `bun test` passes locally.
4. No new dependency without a one-line justification in the PR description.
5. The design doc is updated if the change altered architecture, schema, or the tool surface.
6. Logs don't write to stdout. Verified by running `bun run src/cli.ts --version 2>/dev/null | head -1` and confirming it produces only the version (or nothing, for server mode).

---

## Things that have gone wrong before

Empty for now. Add entries as we discover them. If a failure takes more than two iterations to converge, write it down here so the next session doesn't relearn it.
