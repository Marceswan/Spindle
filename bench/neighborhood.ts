// Deterministic synthetic benchmark. No live service or user database is touched.
// Run: bun run bench/neighborhood.ts > /tmp/spindle-neighborhood.json
import { GraphStore } from "../src/graph/store.ts";
import { getNeighborhood } from "../src/graph/queries.ts";
import { NodeLabel } from "../src/model/node-labels.ts";
import { EdgeType } from "../src/model/edge-types.ts";
import { cpus } from "node:os";

const results = [];
for (const shape of ["hub", "wide", "dense"] as const) {
  const store = new GraphStore(":memory:");
  try {
    const projectId = store.upsertProject(`/benchmark/${shape}`, shape, null);
    const count = shape === "hub" ? 10001 : shape === "wide" ? 2001 : 160;
    const ids: number[] = [];
    let edgeCount = 0;
    store.transaction(() => {
      for (let i = 0; i < count; i++)
        ids.push(
          store.insertNode({
            projectId,
            label: NodeLabel.ApexMethod,
            name: `node${i}`,
            qualifiedName: `node${i}`,
          }),
        );
      const edge = (a: number, b: number) => {
        store.insertEdge({
          projectId,
          sourceId: ids[a]!,
          targetId: ids[b]!,
          edgeType: EdgeType.Calls,
        });
        edgeCount++;
      };
      if (shape === "dense") {
        for (let a = 0; a < count; a++)
          for (let b = a + 1; b < count; b++) edge(a, b);
      } else {
        for (let i = 1; i < count; i++)
          edge(shape === "hub" || i <= 200 ? 0 : 1 + ((i - 201) % 200), i);
      }
    });
    const opts = {
      depth: shape === "hub" ? 1 : 2,
      cap: shape === "hub" ? 500 : 2000,
    };
    let graph = getNeighborhood(store, projectId, ids[0]!, opts);
    for (let i = 0; i < 4; i++)
      getNeighborhood(store, projectId, ids[0]!, opts);
    const ms = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      graph = getNeighborhood(store, projectId, ids[0]!, opts);
      ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    // Synchronous queries delay other clients on the shared event loop.
    const start = performance.now();
    const tick = new Promise<number>((resolve) =>
      setTimeout(() => resolve(performance.now() - start), 0),
    );
    getNeighborhood(store, projectId, ids[0]!, opts);
    const eventLoopDelayMs = await tick;
    results.push({
      shape,
      inputNodes: count,
      inputEdges: edgeCount,
      ...opts,
      outputNodes: graph.nodes.length,
      outputEdges: graph.edges.length,
      truncated: graph.truncated,
      p50Ms: ms[14],
      p95Ms: ms[28],
      eventLoopDelayMs,
      rssMiB: process.memoryUsage().rss / 1024 ** 2,
    });
  } finally {
    store.close();
  }
}
console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      iterations: 30,
      warmups: 5,
      results,
    },
    null,
    2,
  ),
);
