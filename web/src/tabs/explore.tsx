import { useEffect, useRef, useState } from "react";
import { useRequestEpoch } from "../request-epoch.ts";
import cytoscape from "cytoscape";
import { api, type SearchNode } from "../api.ts";

export function Explore({ project }: { project: number }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const beginSearch = useRequestEpoch();
  const beginNeighborhood = useRequestEpoch();
  const cyRef = useRef<HTMLDivElement>(null);
  const cyInst = useRef<cytoscape.Core | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<{
    name: string;
    label: string;
    filePath: string | null;
  } | null>(null);

  useEffect(() => {
    if (cyRef.current === null) return;
    const cy = cytoscape({
      container: cyRef.current,
      style: [
        {
          selector: "node",
          style: {
            label: "data(name)",
            "background-color": "#5b8def",
            color: "#e2e8f0",
            "font-size": 9,
          },
        },
        { selector: "node.center", style: { "background-color": "#16a34a" } },
        {
          selector: "edge",
          style: {
            label: "data(edgeType)",
            width: 1,
            "line-color": "#475569",
            "font-size": 7,
            color: "#94a3b8",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#475569",
          },
        },
      ],
      layout: { name: "cose" },
    });
    cyInst.current = cy;
    cy.on("tap", "node", (evt) => {
      const d = evt.target.data();
      setSelected({
        name: d.qualifiedName,
        label: d.label,
        filePath: d.filePath,
      });
      void loadNeighborhood(Number(d.id));
    });
    return () => {
      cy.destroy();
      cyInst.current = null;
    };
  }, [project]);

  async function runSearch(): Promise<void> {
    const current = beginSearch();
    setError(null);
    setHits([]);
    try {
      const res = await api.search(project, query);
      if (current()) setHits(res.nodes);
    } catch (error) {
      if (current()) setError((error as Error).message);
    }
  }

  async function loadNeighborhood(id: number): Promise<void> {
    const current = beginNeighborhood();
    setError(null);
    setSelected(null);
    cyInst.current?.elements().remove();
    try {
      const nb = await api.neighborhood(project, id);
      if (!current()) return;
      const center = nb.nodes.find((n) => n.id === id);
      if (center)
        setSelected({
          name: center.qualifiedName,
          label: center.label,
          filePath: center.filePath,
        });
      setTruncated(nb.truncated);
      const cy = cyInst.current;
      if (!cy) return;
      cy.elements().remove();
      cy.add(
        nb.nodes.map((n) => ({
          data: {
            id: String(n.id),
            name: n.name,
            qualifiedName: n.qualifiedName,
            label: n.label,
            filePath: n.filePath,
          },
          classes: n.id === id ? "center" : "",
        })),
      );
      cy.add(
        nb.edges.map((e) => ({
          data: {
            id: `e${e.id}`,
            source: String(e.sourceId),
            target: String(e.targetId),
            edgeType: e.edgeType,
          },
        })),
      );
      cy.layout({ name: "cose" }).run();
    } catch (error) {
      if (current()) setError((error as Error).message);
    }
  }

  return (
    <div>
      <div className="row">
        <input
          placeholder="search nodes (e.g. Projection)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <button onClick={() => void runSearch()}>Search</button>
        {hits.length > 0 && (
          <select
            onChange={(e) => void loadNeighborhood(Number(e.target.value))}
            defaultValue=""
          >
            <option value="" disabled>
              pick a node ({hits.length})
            </option>
            {hits.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}: {h.name}
              </option>
            ))}
          </select>
        )}
        {truncated && (
          <span style={{ color: "#f59e0b" }}>graph trimmed to cap</span>
        )}
      </div>
      {error && <p role="alert">{error}. Try the search again.</p>}
      {selected && (
        <div className="row" style={{ color: "#94a3b8" }}>
          <b>{selected.label}</b> {selected.name}{" "}
          {selected.filePath && <code>{selected.filePath}</code>}
        </div>
      )}
      <div id="cy" ref={cyRef} />
    </div>
  );
}
