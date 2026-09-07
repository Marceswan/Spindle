# Contributing to Spindle

Spindle is a local-first MCP server that indexes SFDX projects into a queryable metadata graph. Patches welcome — particularly new parsers, better resolution heuristics, and bug fixes for edge cases in Apex / LWC / Aura / VF / metadata XML.

## Development setup

```bash
git clone https://github.com/Marceswan/Spindle.git
cd Spindle
bun install
bun test                  # 85+ tests should pass
bun run typecheck         # tsc --noEmit, strict + exactOptionalPropertyTypes
```

Requirements:
- Bun 1.3.8 (pinned for reproducibility; bumps go through CI)
- macOS, Linux, or Windows for development

## Read these before submitting a PR

1. **`CLAUDE.md`** — project conventions. Strict TypeScript, kebab-case filenames, no barrel files, no writes to stdout outside the MCP SDK, etc.
2. **`learnings.md`** — accumulated gotchas. ANTLR whitespace stripping, `exactOptionalPropertyTypes` spread patterns, bun:test timeouts, asset bundling in `bun build --compile`, etc. Read it; save yourself iterations.
3. **`sfdx-graph-mcp-design.md`** — the architectural reference. The full graph model is in §5; tool specs are in §9.

## Adding a new parser

The pipeline routes each discovered file to a parser via `src/pipeline/parse-dispatch.ts`. To add a new metadata surface:

1. Add a new `DiscoveredFileKind` to `src/pipeline/discover.ts` and extend the walker to find the relevant files.
2. Add any new node labels to `src/model/node-labels.ts` and edge types to `src/model/edge-types.ts`. **Never hardcode label or edge-type strings at call sites.**
3. Create `src/parsers/<domain>/parse.ts` (or a metadata-xml subfile) exporting a function `(filePath, source, ...) => ParseResult`. See `src/parsers/metadata-xml/object.ts` for the simplest reference pattern, or `src/parsers/metadata-xml/permission-set.ts` for a more complex one.
4. Wire the parser into the dispatcher's switch.
5. Add a fixture under `test/fixtures/sample-sfdx-project/force-app/main/default/<your-dir>/`.
6. Add a pipeline test under `test/pipeline/<your-domain>.test.ts` — mirror the pattern in `test/pipeline/metadata-xml.test.ts`. Always include `setDefaultTimeout(30_000)` at the top.
7. If the new parser unlocks a new bucket in `get_field_usage`, update `src/tools/get-field-usage.ts` and its test.

## Adding a new MCP tool

1. Create `src/tools/<tool-name>.ts` exporting `{ name, description, inputSchema, handler }`. See `src/tools/get-permission-access.ts` for the canonical pattern.
2. Register it in `src/server.ts` in the appropriate array (`toolsWithStore` if it needs the shared `GraphStore`, `toolsStandalone` if not).
3. Add a tool test under `test/tools/<tool-name>.test.ts`.

## Commit and PR conventions

- One logical change per PR. If you're touching three unrelated surfaces, split it.
- Commit messages: imperative mood, first line under 70 chars, body explains the why if non-obvious.
- All PRs must pass CI (`bun run typecheck` + `bun test` + `bun build --compile` smoke test). The compile step catches asset-bundling regressions; don't skip it.
- New deps require a one-line justification in the PR description and a note in `SECURITY.md` if relevant.

## Running the benchmarks

```bash
bun run bench                                # Phase A: canonical queries vs sample fixture
bun run bench --compare --size 100           # Phase B: vs grep+read at 100-class scale
bun run bench --generate --size 1000 --out /tmp/big-corpus
```

If your change touches indexing performance, run the bench before and after — large regressions should be flagged in the PR.

## License

By contributing, you agree your contributions are licensed under the MIT license, the same as the project.
