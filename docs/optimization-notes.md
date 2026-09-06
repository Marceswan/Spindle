# Agent output and shared service optimization

Implemented September 6, 2026. Spindle remains a Salesforce graph: Apex, SObjects,
fields, LWC, Aura, Visualforce, Flow and metadata references keep their typed model.

## Upstream review

Reviewed DeusData/codebase-memory-mcp at
[`7b0f553cbae565247aa858a4aba80b194305e7f5`](https://github.com/DeusData/codebase-memory-mcp/tree/7b0f553cbae565247aa858a4aba80b194305e7f5).
These are architectural adaptations, not copied C implementations.

| Upstream evidence | Spindle adaptation |
| --- | --- |
| [`src/daemon/host.h`](https://github.com/DeusData/codebase-memory-mcp/blob/7b0f553cbae565247aa858a4aba80b194305e7f5/src/daemon/host.h): first frontend starts the daemon; final disconnect shuts down operations and watchers | One shared graph process per canonical database path, with thin stdio adapters and last-client shutdown |
| [`src/daemon/daemon.c`](https://github.com/DeusData/codebase-memory-mcp/blob/7b0f553cbae565247aa858a4aba80b194305e7f5/src/daemon/daemon.c): client, job and watcher coordination | One in-process watcher per canonical project root; serialized graph operations and queued file changes |
| [`src/daemon/ipc.h`](https://github.com/DeusData/codebase-memory-mcp/blob/7b0f553cbae565247aa858a4aba80b194305e7f5/src/daemon/ipc.h): authenticated local IPC and lifetime ownership | Authenticated loopback RPC with a random token in an owner-readable discovery file; a held SQLite transaction provides crash-released singleton ownership using existing Bun dependencies |
| [`src/mcp/mcp.c`](https://github.com/DeusData/codebase-memory-mcp/blob/7b0f553cbae565247aa858a4aba80b194305e7f5/src/mcp/mcp.c): explicit page continuation and truncation metadata | `search_graph` returns `has_more` and `next_offset`; filters run before pagination, eliminating the old candidate-window false negatives |

## What changed

`search_graph` defaults to names, labels and source locations. `detail: "full"`
returns the former storage fields and parser properties. The page size defaults to
50 and is capped at 500. Continue with `offset: next_offset` while `has_more` is true.
Pagination is stable while the index is unchanged; reindexing can change row order.
Search streams candidates and finalizes its SQLite statement even when a page fills
early. MCP output uses compact JSON instead of pretty-printed JSON.

The graph service starts automatically. All clients using the same database share
one graph owner. Stdio still requires a separate lightweight adapter process per
client: these adapters do not open graph databases or instantiate parsers/watchers.
`--db-path` and `SFDX_GRAPH_HOME` intentionally allow isolated services for different
databases. Source-mode and compiled binaries both launch the same service command.

The service owns project watchers, debounces changes, and serializes indexing with
queries. It stops accepting work on shutdown, cancels pending debounce timers,
drains accepted operations, closes watchers and sockets, closes the graph database,
and finally releases its lifetime lock. The final client disconnect starts a
one-second idle grace period. A service with no initial client exits after ten
seconds. SIGINT, SIGTERM and SIGHUP use the same shutdown path; a forced crash releases
the OS lock, and a later startup replaces stale discovery information. Requests
interrupted by a crash fail explicitly; writes are never automatically replayed.

SessionStart now indexes through this service. New hook registration removes the
legacy SessionEnd stop-watch hook. Existing stop-watch commands are harmless
compatibility no-ops so one session cannot kill another client's watcher.
The old per-project detached daemon implementation has been removed.

## Measured output

Run `SFDX_GRAPH_LOG_LEVEL=silent bun run bench/agent-output.ts`.
For the same page of 50 Apex classes in a seeded 100-class synthetic SFDX corpus:

| Output | UTF-8 bytes |
| --- | ---: |
| Previous full nodes with pretty JSON | 33,503 |
| Full detail with compact JSON | 24,174 |
| Compact evidence with pagination metadata | 11,020 |

This is a **67.1% byte reduction** while returning identical qualified names.
The script also reports bytes/4 as a token approximation. It does not measure an
actual tokenizer or end-to-end agent answer quality. Temporary path lengths can
slightly change the byte counts across machines.

## Next Salesforce-specific work

1. Add ranked retrieval for Apex identifiers and Salesforce API names, using
   identifier splitting and structural ranking before considering embeddings.
   Evaluate whether agents find the right symbol within the first five results.
2. Give field impact answers explicit direct-field versus parent-object evidence,
   edge confidence, index freshness and unresolved-reference coverage. An empty
   result must not be interpreted as proof that a field is unused.
3. Bound trace output with continuation and preserve the paths that explain why a
   Flow, LWC or Apex caller is affected. Search pagination alone does not bound traces.
4. Benchmark real Salesforce tasks with expected answers: changing a field,
   tracing Flow-to-invocable-to-Apex calls, and locating LWC Apex controllers.
   Measure correctness, tool calls and tokenizer output together.
5. Track upstream service protocol/build compatibility and project subscriptions.
   This first implementation has a protocol handshake but does not hot-upgrade a
   running service, reconnect an established adapter after a crash, or release each
   project's watcher independently while other clients remain connected.

## Verification scope

Regression tests cover late search matches, pagination, compact/full equivalence,
simultaneous clients, singleton startup, last-client shutdown, crash restart,
SIGTERM, stdin EOF, two actual MCP adapters, and hook migration. Compiled adapter tests are
selected with `SPINDLE_TEST_BINARY=/absolute/path/to/dist/sfdx-graph-mcp`.
The full suite passed with 122 tests, including stdin EOF cleanup. Typechecking,
native compilation and all eight existing benchmark queries passed.
Cross-platform execution still belongs in the release CI matrix; local testing was
on macOS. Existing installed binaries and live client configurations are not changed
by these source edits. Restart old installed clients when deploying the new binary.
