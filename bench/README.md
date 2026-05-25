# Spindle Benchmark Harness (Phase A)

## How to run

```bash
# Against the default sample fixture (test/fixtures/sample-sfdx-project)
bun run bench

# Against a different SFDX project
bun run bench/cli.ts --fixture /path/to/your/sfdx-project
```

Output is a Markdown table written to stdout. Pipe to a file to save a snapshot:

```bash
bun run bench > bench-results.md
```

Exit code is `0` if all queries pass, `1` if any fail.

## What it measures

| Metric | Description |
|--------|-------------|
| Index latency | Wall-clock time (ms) to run a full `indexProject` pass |
| Nodes / Edges | Count of nodes and edges written to SQLite |
| Peak heap delta | `process.memoryUsage().heapUsed` change across the index phase |
| Query latency | `process.hrtime.bigint()` delta around each tool handler call, in ms with 3-decimal precision |
| Heap delta (per query) | Heap change in KB across the tool call |
| Tokens (approx) | `Math.ceil(JSON.stringify(result).length / 4)` — the common 4-bytes-per-token approximation for English/code content |
| Recall | Fraction of `mustContain` ground-truth nodes that appeared in the result (0.0 to 1.0) |
| False positives | Count of `mustNotContain` ground-truth nodes that incorrectly appeared |
| Passed | `recall >= 1.0 AND falsePositives === 0 AND minResults/maxResults met` |

## What is NOT here yet (Phase B and beyond)

- **Grep+read baseline simulator**: Phase B will add a simulated grep-and-read path for each query so token reduction can be measured as a ratio (design target: under 5% of grep-equivalent token usage).
- **Synthetic corpus generator**: Fixtures at 100 / 1,000 / 10,000-class scale to test latency budgets from design section 11 (100 classes under 5 s; single-file incremental under 1 s; `search_graph` under 50 ms).
- **Real tokenizer**: Swap the bytes/4 approximation for `tiktoken` or `@anthropic-ai/tokenizer` to get exact token counts per model.
