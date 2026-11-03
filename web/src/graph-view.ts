import type cytoscape from "cytoscape";
import type { Neighborhood } from "./api.ts";

/** Reconcile graph data without discarding node positions or the user's viewport. */
export function updateGraph(cy: cytoscape.Core, graph: Neighborhood): void {
  const centerId = String(graph.centerId);
  const nodes = new Map(graph.nodes.map((n) => [String(n.id), n]));
  const edges = new Map(graph.edges.map((e) => [`e${e.id}`, e]));
  const retained = cy.nodes().filter((n) => nodes.has(n.id()));
  const resetLayout =
    retained.empty() || cy.nodes(".center")[0]?.id() !== centerId;
  const anchor = cy.getElementById(centerId).position() ?? { x: 0, y: 0 };
  const added = graph.nodes.filter((n) =>
    cy.getElementById(String(n.id)).empty(),
  );
  // New nodes occupy an outer ring. Retained nodes (including manually dragged
  // ones) stay fixed. Fit graph is explicit so expansion never resets pan/zoom.
  let radius = 80;
  if (!resetLayout)
    retained.forEach((n) => {
      const p = n.position();
      radius = Math.max(
        radius,
        Math.hypot(p.x - anchor.x, p.y - anchor.y) + 80,
      );
    });
  radius = Math.max(radius, (added.length * 60) / (2 * Math.PI));
  cy.batch(() => {
    cy.edges()
      .filter((e) => {
        const next = edges.get(e.id());
        return (
          !next ||
          e.source().id() !== String(next.sourceId) ||
          e.target().id() !== String(next.targetId)
        );
      })
      .remove();
    cy.nodes()
      .filter((n) => !nodes.has(n.id()))
      .remove();
    let index = 0;
    for (const node of graph.nodes) {
      const id = String(node.id);
      let element = cy.getElementById(id);
      if (element.empty()) {
        const angle = (2 * Math.PI * index++) / Math.max(1, added.length);
        element = cy.add({
          data: { ...node, id },
          position: {
            x: anchor.x + radius * Math.cos(angle),
            y: anchor.y + radius * Math.sin(angle),
          },
        });
      } else element.data({ ...node, id });
      element.toggleClass("center", id === centerId);
    }
    for (const edge of graph.edges) {
      const id = `e${edge.id}`;
      const data = {
        id,
        source: String(edge.sourceId),
        target: String(edge.targetId),
        edgeType: edge.edgeType,
      };
      const existing = cy.getElementById(id);
      if (existing.empty()) cy.add({ data });
      else existing.data(data);
    }
  });
  if (resetLayout && graph.nodes.length) {
    cy.layout({
      name: "breadthfirst",
      roots: [centerId],
      circle: true,
      directed: false,
      animate: false,
      spacingFactor: 1.4,
    }).run();
  }
}
