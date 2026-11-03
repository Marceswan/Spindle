// Layout/update CPU benchmark; headless Cytoscape does not measure canvas painting.
import cytoscape from "cytoscape";
import { updateGraph } from "../src/graph-view.ts";
import type { Neighborhood } from "../src/api.ts";
const graph = (count: number): Neighborhood => ({
  centerId: 1,
  truncated: false,
  nodes: Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `n${i + 1}`,
    qualifiedName: `n${i + 1}`,
    label: "ApexMethod",
    filePath: null,
  })),
  edges: Array.from({ length: count - 1 }, (_, i) => ({
    id: i + 1,
    sourceId: Math.max(1, Math.floor((i + 1) / 8)),
    targetId: i + 2,
    edgeType: "CALLS",
  })),
});
const results = [];
for (const size of [100, 500, 1000]) {
  const initial = graph(size),
    expanded = graph(size * 2);
  const initialMs = [],
    expandMs = [];
  for (let i = 0; i < 6; i++) {
    const cy = cytoscape({ headless: true });
    try {
      const start = performance.now();
      updateGraph(cy, initial);
      const middle = performance.now();
      updateGraph(cy, expanded);
      const end = performance.now();
      if (i > 0) {
        initialMs.push(middle - start);
        expandMs.push(end - middle);
      }
    } finally {
      cy.destroy();
    }
  }
  initialMs.sort((a, b) => a - b);
  expandMs.sort((a, b) => a - b);
  results.push({
    initialNodes: size,
    expandedNodes: size * 2,
    initialMedianMs: initialMs[2],
    expansionMedianMs: expandMs[2],
  });
}
console.log(
  JSON.stringify(
    { bun: Bun.version, headless: true, warmups: 1, iterations: 5, results },
    null,
    2,
  ),
);
