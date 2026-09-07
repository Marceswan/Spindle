# Public roadmap implementation plan

> **For Codex:** Use the executing-plans workflow to implement and verify each independent task.

**Goal:** Deliver advanced Flow extraction, grammar-based SOQL parsing, OPTIONAL MATCH / WITH, signed self-update, a read-only local UI, and indexed-project diffs.

**Architecture:** Keep Salesforce parsers pure and preserve the shared graph service as the single graph owner. Add read-only comparison and UI tools, and an explicit standalone updater that verifies a detached GPG signature and SHA256 before replacing the executable. UI uses local system fonts and embedded assets; no external CDN or hosted service.

**Tech Stack:** TypeScript, Bun, SQLite, existing ANTLR Apex/SOQL grammar, fast-xml-parser, native HTTP and GPG CLI for explicit updates.

### 1. Advanced Flow
- Files: src/parsers/metadata-xml/flow.ts, src/tools/get-field-usage.ts, dedicated fixtures/tests.
- Write tests for variable and $Record binding, assignments, decisions, formulas and record operations.
- Implement typed direct field edges; leave unresolved dynamic references diagnostic.
- Run dedicated tests and typecheck.

### 2. Cypher chaining
- Files: src/graph/cypher/*, src/tools/query-graph.ts, dedicated tests.
- Test optional null bindings, alias scope, WITH filtering/grouping and project isolation.
- Implement parser AST and SQL stages with parameterized bindings.
- Run prior query tests and new chaining tests.

### 3. Full SOQL grammar
- Files: src/parsers/apex/soql-extract.ts, parse.ts, pass2-intra-domain.ts, dedicated tests.
- Test nested queries, TYPEOF, aggregates, aliases, filters, relationship paths and bind expressions.
- Use existing ANTLR grammar and original token spans; resolve only supported metadata paths.
- Run Apex and pipeline tests.

### 4. Multi-project diff
- Files: src/tools/diff-projects.ts, src/graph/diff.ts, test/tools/diff-projects.test.ts.
- Compare semantic node identities and typed edges, ignoring database IDs, paths and source line movement.
- Paginate changes with totals; expose snapshots and source/hash changes separately from metadata properties.
- Add service registry and CLI integration.

### 5. Read-only UI
- Files: src/web/server.ts, src/web/page.ts, tests, CLI.
- Embedded workspace: project selection, search, symbol details, references and comparison.
- Loopback binding, token-based sessions, same-origin checks, GET-only read-tool allowlist.
- UI connects to shared service, owns no SQLite handle, closes on shutdown.
- Test access boundary and inspect browser rendering.

### 6. Signed self-update
- Files: src/update/*, .github/workflows/release.yml, docs/release-signing.md, tests, CLI.
- Test signature/hash failures, version validation, platform mapping and atomic replacement/rollback.
- Embed trusted public key at release build time. Fail closed if unconfigured.
- Sign checksum manifest in CI; user will provision private key/passphrase secrets per documented setup.
- Keep downloads explicit, public GitHub release URLs only, no background update traffic.

### 7. Integrate and verify
- Update public repository URLs and roadmap/docs to actual behavior.
- Run typecheck, all tests, compiled-binary checks and existing benchmarks.
- Commit and push under the previously authorized Marceswan identity; do not publish a release without configured signing secrets.
