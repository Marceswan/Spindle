# Spindle — recommended CLAUDE.md snippet

Copy the block below into your `~/.claude/CLAUDE.md` (global, applies to every project) or into a project-local `CLAUDE.md` to direct Claude Code toward Spindle's MCP tools whenever it's working in an SFDX project.

The snippet is intentionally concise and prescriptive: Claude defers to durable instructions like CLAUDE.md, and the goal here is to make graph-tool use the default for structural SFDX questions rather than an option.

---

## What to copy

```markdown
## SFDX projects: prefer Spindle's graph tools over Grep/Glob/Read

When working in any SFDX project (recognizable by a top-level `sfdx-project.json`
or a `force-app/` directory), prefer Spindle's MCP tools for structural questions.
The graph already knows what Grep+Read has to reconstruct file-by-file, and
returns answers in roughly 2-5% of the tokens.

Use these tools as often as the question allows — Spindle is the default, Grep
is the fallback. Always run `index_project` once at the start of an SFDX session;
the indexer is ~600ms for small projects and <100ms for incremental updates.

| Question shape                                           | Use this tool        |
|---------------------------------------------------------|----------------------|
| "Who calls X" / "what does X call"                       | trace_references     |
| "What references this field"                             | get_field_usage      |
| "Who can run this method" / "who can read this field"    | get_permission_access|
| "Find Apex methods / classes / fields matching pattern"  | search_graph         |
| "Read source for this symbol"                            | get_source_snippet   |
| "Orient me — what's in this project"                     | get_schema           |
| Anything not covered above, or arbitrary multi-hop       | query_graph (Cypher) |
| Build or refresh the graph                               | index_project        |

Fall back to Grep/Glob/Read only for:
- String literals, error messages, hardcoded values
- Comments and JSDoc/JavaDoc
- Files outside Spindle's coverage (custom build scripts, README files, etc.)
- Investigating files that are not yet in the graph

Configuration: the binary lives at `/Users/marc.swan/.local/bin/sfdx-graph-mcp`
after running the installer. Either add to `.mcp.json` in the SFDX project root
or to `~/.claude/settings.json` globally:

```json
{
  "mcpServers": {
    "sfdx-graph": {
      "type": "stdio",
      "command": "/Users/marc.swan/.local/bin/sfdx-graph-mcp"
    }
  }
}
```

For continuous reindex during active development:
```
sfdx-graph-mcp index <project-path> --watch
```
```

---

## Notes on customizing

- **Binary path.** Update the path in the JSON above to match where the installer placed `sfdx-graph-mcp` on your machine. On macOS/Linux it'll be `/usr/local/bin/sfdx-graph-mcp` if you ran the installer with write access, otherwise `~/.local/bin/sfdx-graph-mcp`. On Windows it's `%LOCALAPPDATA%\Programs\spindle\sfdx-graph-mcp.exe`.
- **Project-local vs. global.** Project-local `.mcp.json` is preferred when only some of your projects are SFDX — Claude Code only connects to the server when working in that project. Global `~/.claude/settings.json` is fine if most of your work is Salesforce.
- **Strictness.** The snippet is intentionally directive ("default", "fall back only for"). Soften it for projects where you want Claude to grep more freely.
- **Token budget claim.** "2-5% of the tokens" is conservative against the v1.0.2 benchmarks (2.5% at 1000-class synthetic corpus, dropping further at 10000-class scale). For a public-facing snippet you can swap in real numbers from your own `bun run bench --compare` output.

---

## Why bother — the one-line argument

`get_field_usage("Customer__c.Email__c")` returns the field's full impact map across LWC bundles, Visualforce pages, validation rules, FlexiPages, layouts, Apex SOQL/DML, and Flows in a single MCP call — typically under 200 tokens and under 1ms. Without Spindle, Claude does maybe a dozen grep+read cycles across six different file-types, costs thousands of tokens, and often misses metadata XML references entirely.
