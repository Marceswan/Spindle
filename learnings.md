# Spindle Learnings

Project-specific gotchas that took more than one self-correction to land. Read before
authoring metadata, writing parsers, or running the bench.

If you hit a new failure that takes 2+ iterations to converge, add it here. If a learning
takes 3+ iterations to land OR repeats across sessions, promote it to `CLAUDE.md` so future
sessions never hit it again.

---

## ANTLR `node.text` strips whitespace

`ParserRuleContext.text` returns the concatenation of all matched tokens **without**
intervening whitespace. So an Apex SOQL literal like `[SELECT Id, Name FROM Account]`
comes through as `[SELECTId,NameFROMAccount]`.

**Implication:** any regex that operates on `.text` must tolerate the no-whitespace form.
Don't anchor on `\s` after keywords like `FROM` — use either `\s*` (zero-or-more) or no
anchor at all. See `src/parsers/apex/soql-extract.ts` for the field-list and FROM regexes
that already handle both shapes.

If your regex works on the raw `.cls` source but fails after the parser, this is why.

---

## `exactOptionalPropertyTypes` does not accept `undefined` for `?:` fields

Spindle's `tsconfig.json` enables `exactOptionalPropertyTypes: true`. Under this mode an
optional property `sourceLine?: number` accepts a `number` value or being absent, but does
NOT accept being explicitly set to `undefined`.

**Wrong (compiler error):**

```ts
const edge = {
  edgeType: EdgeType.Calls,
  sourceLine: someValue,  // someValue: number | undefined
};
```

**Right (spread the property only when defined):**

```ts
const sourceLine = someValue;
const edge = {
  edgeType: EdgeType.Calls,
  ...(sourceLine !== undefined ? { sourceLine } : {}),
};
```

The Apex parser, LWC parser, and pass2 all use this pattern. Mirror it when adding new
parsers or edge-emitting code.

---

## bun:test default hook timeout is 5s; parallel test files exceed it

Bun runs test files in separate processes in parallel. When multiple files do expensive
beforeAll work (cpSync a fixture, build a GraphStore, index a full project) they contend
for disk I/O and cross the 5-second default hook timeout.

**Fix:** every test file that does heavyweight setup calls
`setDefaultTimeout(30_000)` at the top:

```ts
import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
```

This is per-file (Bun loads each test file in a fresh worker; preload via bunfig.toml
doesn't propagate `setDefaultTimeout` cleanly).

The `bun:test` API does **not** accept a numeric second argument to `beforeAll` —
`beforeAll(fn, 30_000)` silently ignores the timeout. Don't try it.

---

## Logger env var must be set BEFORE Bun starts, not at module top

`src/util/logger.ts` reads `process.env["SFDX_GRAPH_LOG_LEVEL"]` to pick the pino level.
Setting that env var at the top of `bench/runner.ts` or `bench/compare.ts` does NOT work —
ES module imports are hoisted above all runtime statements, so the logger module evaluates
(and reads the env var) before the assignment runs.

**Fix:** set the env var in the shell command that launches the script. The `bench` npm
script does this:

```json
"bench": "SFDX_GRAPH_LOG_LEVEL=silent bun run bench/cli.ts"
```

Pino accepts `silent` (level 100, no output), `fatal`, `error`, `warn`, `info`, `debug`,
`trace`.

---

## Salesforce CLI silently creates `.sfdx/` and `.sf/` in your fixture root

Any `sf` invocation against the fixture directory creates a `.sfdx/` cache (typically
40-100 MB of Apex stdlib + tooling state) inside the fixture itself. This gets picked up
by `cp -r` operations in tests and inflates everything.

**Fixes:**
1. `.gitignore` excludes `.sfdx/` and `.sf/`.
2. Tests should `cpSync` the `force-app/` directory and `sfdx-project.json` separately
   rather than the entire fixture root (see `test/pipeline/metadata-xml.test.ts` for the
   pattern).

---

## `@apexdevtools/vf-parser` doesn't export `CaseInsensitiveInputStream`

The VF parser package re-exports most antlr4ts helpers but skips
`CaseInsensitiveInputStream`. Import that one from `@apexdevtools/apex-parser` instead;
it's literally the same class.

```ts
import { CommonTokenStream, ElementContext, VFLexer, VFParser } from "@apexdevtools/vf-parser";
import { CaseInsensitiveInputStream } from "@apexdevtools/apex-parser";
```

---

## `@lwc/metadata` peer deps must resolve in the project that calls it

`@lwc/metadata`'s `collectBundleMetadata` requires `@lwc/template-compiler` and
`@lwc/errors` as peer dependencies. Bun's normal install resolves these via the project's
own `node_modules` tree. A standalone script in a scratch directory (no `node_modules`)
will fail with `Cannot find module '@lwc/template-compiler'`.

**Implication:** any inspection or debugging script that imports `@lwc/metadata` must run
from inside the Spindle project root, not from `/tmp/`.

---

## `fast-xml-parser` preserve-order output puts attrs `:@` at sibling level

When you set `preserveOrder: true`, each XML node parses to an object with **exactly one**
tag-name key plus an optional `:@` sibling holding attributes. The `:@` is NOT nested
inside the tag's value.

**Shape:**

```js
{
  "aura:dependency": [],            // tag children (here: empty)
  ":@": { "@_resource": "..." }     // tag's own attributes
}
```

When walking, attributes live at the SAME level as the tag key. The Aura parser's
`walkAuraXml` shows the correct pattern; copy it for any future preserve-order XML
parser.

---

## `bun build --compile` does not bundle arbitrary asset files

`readFileSync("./schema.sql")` (or any `path.join(import.meta.dir, "asset.ext")`-style asset
load) works fine under `bun run` because the file lives next to the source. The same code
fails inside a Bun-compiled binary with `ENOENT: ... /$bunfs/root/<file>`. The compiler
bundles **source modules**, not arbitrary files.

**Fix:** convert the asset to a TypeScript module that exports the content as a string
constant (or use `Bun.embeddedFiles` for binary assets in v1.2+). The schema DDL lives in
`src/graph/schema.ts` as `SCHEMA_DDL: string`. The sibling `schema.sql` is preserved as the
human-readable canonical for sqlite-shell convenience but is NOT loaded at runtime.

If any future code is tempted to read a config/template/asset file relative to its module
path, route it through a TypeScript constant instead and the binary keeps working.

---

## Claude Code SessionStart hook stdout is invisible in the chat UI

Per https://code.claude.com/docs/en/hooks: "Any text your hook script prints to stdout is added as context for Claude. This context is visible to Claude for decision-making but **does not appear as a chat message in the user interface**."

So a SessionStart hook that "works" (fires and emits stdout) produces no user-visible output. The model sees the context in a `<system-reminder>` block, but the user reading the chat won't see the hook's message scroll by. If a user reports "I don't see the hook fire", they probably actually do have a working hook — they're just expecting visible confirmation.

**Fixes adopted:**
1. Use the documented JSON output shape `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }` — the contract Claude Code's parser is built around.
2. Write a diagnostic log to `~/.cache/sfdx-graph-mcp/hook.log` (one JSON line per invocation). This is the user-visible proof the hook fired. Users `tail` it to confirm.
3. Read stdin JSON per spec rather than relying on `CLAUDE_PROJECT_DIR` (which isn't propagated by all shells).

If a future feature needs user-visible chat output, hook stdout is the wrong channel. Consider `initialUserMessage` (creates an actual user turn in non-interactive `-p` mode) or just print to stderr with `exit 2` (shown to the user as a warning, but doesn't block).

---

## Claude Code SessionStart matchers: "startup" only fires on fresh sessions

Claude Code's `SessionStart` event has four subtypes — `startup`, `resume`, `clear`, `compact`. A hook entry with `matcher: "startup"` ONLY fires when a brand-new session is created. Resumed sessions (`claude -c` / `claude --resume`), `/clear`, and post-compact restarts each trigger their own matcher and do NOT fire the startup hook.

For hooks that need to run on every kind of session start (re-spawn watcher daemons, refresh context, ensure indexes are current), **omit the matcher**. A hook entry with no matcher fires on all four subtypes.

We initially registered Spindle under `matcher: "startup"` and users reported the hook didn't fire on new sessions in SFDX projects. Diagnosis: the sessions were being resumed, not freshly started. Fix: drop the matcher in `register.ts`'s `upsertHook` call for SessionStart.

The hook is idempotent (watch-daemon checks an existing-PID file before spawning), so firing on every SessionStart subtype is safe and the right default.

---

## Bun-compiled binaries: argv[0] is "bun", not the binary path

When you run a Bun `--compile` binary, `process.argv` is `["bun", "/$bunfs/root/<name>", ...userArgs]`. So `process.argv[0]` is the literal string `"bun"` (the embedded runtime name), NOT the path to the compiled executable. Use `process.execPath` to get the actual binary path.

This bit the SessionStart hook registration: the first install wrote `bun session-start-hook` into `~/.claude/settings.json` instead of `/Users/marc.swan/.local/bin/sfdx-graph-mcp session-start-hook`. The hook would have failed to fire because Claude Code can't resolve `bun` to anything meaningful.

**Rule:** any code that needs to re-exec the running binary (spawn a daemon, persist a command in config) must use `process.execPath`. Never `process.argv[0]`.

The fix sites are in `src/hook/register.ts` (writing settings.json commands) and `src/hook/session-start.ts` (spawning the watch daemon). If a future subcommand needs to spawn another instance of itself, mirror those.

---

## SObject placeholder nodes from SOQL are intentional

`parseApex` emits placeholder `SObject` nodes (with `properties.isPlaceholder = true`)
when it sees `[... FROM SomeObject]` so SOQL_QUERIES edges have a target node even when
no metadata file exists for `SomeObject`. The metadata-XML object parser later upserts
the same qname with `isPlaceholder: false` when it parses a real `.object-meta.xml`.

**Don't** filter placeholders out of search results; the user might want to know that
their code references an object whose metadata isn't tracked.


## v1.2 SOQL extraction supersedes regex guidance

Use original source intervals and the Apex grammar query tree for static SOQL, not
`node.text` or a whitespace-tolerant regex. Preserve nested query scope and each
field's clause context through edge resolution and get_field_usage. Bind variables
are Apex expressions, not fields. Dynamic queries must remain unresolved warnings.
