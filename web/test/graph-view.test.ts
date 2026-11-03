import { test, expect } from "bun:test";
import cytoscape from "cytoscape";
import type { Neighborhood } from "../src/api.ts";
// Added by the optimization: exercises reconciliation with a real headless graph.
const { updateGraph } = await import("../src/graph-view.ts");
const graph = (
  ids: number[],
  edges: [number, number, number][] = [],
): Neighborhood => ({
  centerId: ids[0]!,
  truncated: false,
  nodes: ids.map((id) => ({
    id,
    name: `n${id}`,
    qualifiedName: `n${id}`,
    label: "ApexMethod",
    filePath: null,
  })),
  edges: edges.map(([id, sourceId, targetId]) => ({
    id,
    sourceId,
    targetId,
    edgeType: "CALLS",
  })),
});

test("expansion preserves existing node objects, positions and viewport", () => {
  const cy = cytoscape({ headless: true });
  try {
    updateGraph(cy, graph([1, 2], [[1, 1, 2]]));
    const original = cy.getElementById("2")[0];
    cy.getElementById("2").position({ x: 120, y: 80 });
    cy.zoom(1.7);
    cy.pan({ x: 31, y: 47 });
    updateGraph(
      cy,
      graph(
        [1, 2, 3],
        [
          [1, 1, 2],
          [2, 2, 3],
        ],
      ),
    );
    expect(cy.getElementById("2")[0] === original).toBe(true);
    expect(cy.getElementById("2").position()).toEqual({ x: 120, y: 80 });
    expect(cy.zoom()).toBe(1.7);
    expect(cy.pan()).toEqual({ x: 31, y: 47 });
    expect(cy.nodes().length).toBe(3);
    expect(cy.edges().length).toBe(2);
    expect(Number.isFinite(cy.getElementById("3").position("x"))).toBe(true);
  } finally {
    cy.destroy();
  }
});

test("filtering removes obsolete nodes and edges without moving retained nodes", () => {
  const cy = cytoscape({ headless: true });
  try {
    updateGraph(
      cy,
      graph(
        [1, 2, 3],
        [
          [1, 1, 2],
          [2, 2, 3],
        ],
      ),
    );
    cy.getElementById("2").position({ x: 120, y: 80 });
    updateGraph(cy, graph([1, 2], [[1, 1, 2]]));
    expect(cy.nodes().map((n) => n.id())).toEqual(["1", "2"]);
    expect(cy.edges().map((e) => e.id())).toEqual(["e1"]);
    expect(cy.getElementById("2").position()).toEqual({ x: 120, y: 80 });
  } finally {
    cy.destroy();
  }
});
