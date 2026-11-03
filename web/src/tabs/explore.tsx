import { useEffect, useRef, useState } from "react";
import { useRequestEpoch } from "../request-epoch.ts";
import cytoscape from "cytoscape";
import { updateGraph } from "../graph-view.ts";
import {
  api,
  type SearchNode,
  type Schema,
  type Neighborhood,
} from "../api.ts";

const INITIAL_CAP = 500;
const MAX_CAP = 2000;
const MAX_DEPTH = 5;

export function Explore({ project }: { project: number }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schema, setSchema] = useState<Schema>({
    nodeCounts: {},
    edgeCounts: {},
  });
  const beginSearch = useRequestEpoch();
  const cyRef = useRef<HTMLDivElement>(null);
  const cyInst = useRef<cytoscape.Core | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchNode[]>([]);
  const [nodeLabel, setNodeLabel] = useState("");
  const [edgeType, setEdgeType] = useState("");
  const [centerId, setCenterId] = useState<number | null>(null);
  const [depth, setDepth] = useState(1);
  const [cap, setCap] = useState(INITIAL_CAP);
  const [requestVersion, setRequestVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [graph, setGraph] = useState<Neighborhood | null>(null);

  // The tap callback only changes state; the fetch effect always sees current filters.
  function recenter(id: number): void {
    setGraph(null);
    setCenterId(id);
    setDepth(1);
    setCap(INITIAL_CAP);
    setRequestVersion((v) => v + 1);
  }

  useEffect(() => {
    let current = true;
    api
      .schema(project)
      .then((result) => {
        if (current) setSchema(result);
      })
      .catch((err: Error) => {
        if (current) setSchemaError(err.message);
      });
    return () => {
      current = false;
    };
  }, [project]);

  useEffect(() => {
    if (!cyRef.current) return;
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
            "min-zoomed-font-size": 8,
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
            "min-zoomed-font-size": 8,
            color: "#94a3b8",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#475569",
          },
        },
      ],
      layout: { name: "preset" },
    });
    cyInst.current = cy;
    cy.on("tap", "node", (evt) => recenter(Number(evt.target.data().id)));
    return () => {
      cy.destroy();
      cyInst.current = null;
    };
  }, [project]);

  useEffect(() => {
    if (centerId === null) return;
    let current = true;
    setLoading(true);
    setError(null);
    api
      .neighborhood(project, centerId, { depth, cap, nodeLabel, edgeType })
      .then((result) => {
        if (current) setGraph(result);
      })
      .catch((err: Error) => {
        if (current) {
          setError(err.message);
          setGraph(null);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [project, centerId, depth, cap, nodeLabel, edgeType, requestVersion]);

  useEffect(() => {
    const cy = cyInst.current;
    if (!cy) return;
    if (!graph) {
      cy.elements().remove();
      return;
    }
    updateGraph(cy, graph);
  }, [graph]);

  async function runSearch(): Promise<void> {
    const current = beginSearch();
    setError(null);
    setHits([]);
    setSearching(true);
    try {
      const res = await api.search(project, query, nodeLabel);
      if (current()) setHits(res.nodes);
    } catch (err) {
      if (current()) setError((err as Error).message);
    } finally {
      if (current()) setSearching(false);
    }
  }
  const selected = graph?.nodes.find((n) => n.id === graph.centerId);
  return (
    <div>
      <div className="row controls">
        <input
          aria-label="Node search"
          placeholder="search nodes (e.g. Projection)"
          value={query}
          onChange={(e) => {
            beginSearch();
            setSearching(false);
            setHits([]);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <button onClick={() => void runSearch()} disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
        {hits.length > 0 && (
          <select
            aria-label="Search result"
            value={hits.some((h) => h.id === centerId) ? String(centerId) : ""}
            onChange={(e) => recenter(Number(e.target.value))}
          >
            <option value="" disabled>
              pick a node ({hits.length})
            </option>
            {hits.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}: {h.qualifiedName}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="row controls">
        <label>
          Node label{" "}
          <select
            aria-label="Node label"
            value={nodeLabel}
            onChange={(e) => {
              beginSearch();
              setSearching(false);
              setHits([]);
              setNodeLabel(e.target.value);
              setCap(INITIAL_CAP);
            }}
          >
            <option value="">All labels</option>
            {Object.keys(schema.nodeCounts)
              .sort()
              .map((label) => (
                <option key={label}>{label}</option>
              ))}
          </select>
        </label>
        <label>
          Edge type{" "}
          <select
            aria-label="Edge type"
            value={edgeType}
            onChange={(e) => {
              setEdgeType(e.target.value);
              setCap(INITIAL_CAP);
            }}
          >
            <option value="">All edge types</option>
            {Object.keys(schema.edgeCounts)
              .sort()
              .map((type) => (
                <option key={type}>{type}</option>
              ))}
          </select>
        </label>
        <button
          disabled={centerId === null || loading || depth >= MAX_DEPTH}
          onClick={() => setDepth((d) => Math.min(MAX_DEPTH, d + 1))}
        >
          Expand one hop
        </button>
        <button
          disabled={!graph || loading}
          onClick={() => cyInst.current?.fit(undefined, 40)}
        >
          Fit graph
        </button>
        {centerId !== null && (
          <span>
            {depth} of {MAX_DEPTH} hops · up to {cap.toLocaleString()} nodes
          </span>
        )}
        {graph?.truncated && (
          <>
            {graph.truncationReason === "edge_cap" ||
            graph.truncationReason === "work_budget" ? (
              <span className="notice">
                {graph.truncationReason === "edge_cap"
                  ? "Graph reached the 5,000 edge limit."
                  : "Graph reached the traversal work limit."}{" "}
                Narrow the filters or re-center on a node.
              </span>
            ) : (
              <>
                <span className="notice">Graph trimmed to node cap.</span>
                <button
                  disabled={loading || cap >= MAX_CAP}
                  onClick={() => setCap((n) => Math.min(MAX_CAP, n + 500))}
                >
                  Show more
                </button>
                {cap >= MAX_CAP && (
                  <span>Maximum reached; narrow the filters.</span>
                )}
              </>
            )}
          </>
        )}
      </div>
      <p className="muted">
        Filters apply to traversal; the center always remains visible. Select a
        node to re-center at one hop. Expansion preserves positions and zoom;
        use Fit graph to see added nodes.
      </p>
      {schemaError && (
        <p role="alert">
          Cannot load filters: {schemaError}. Reopen this tab to retry.
        </p>
      )}
      {error && (
        <div role="alert">
          {error}.{" "}
          {centerId !== null ? (
            <button onClick={() => setRequestVersion((v) => v + 1)}>
              Retry graph
            </button>
          ) : (
            "Try the search again."
          )}
        </div>
      )}
      {loading && (
        <p role="status">
          Loading graph…
          {graph &&
            " Previous graph remains visible until the update completes."}
        </p>
      )}
      {selected && (
        <div className="node-details">
          <div className="row controls">
            <b>{selected.label}</b> {selected.qualifiedName}{" "}
            {selected.filePath && <code>{selected.filePath}</code>}
          </div>
          <p className="muted">
            Visible graph: {graph!.nodes.length} nodes, {graph!.edges.length}{" "}
            edges. Center:{" "}
            {graph!.edges.filter((e) => e.targetId === selected.id).length}{" "}
            incoming,{" "}
            {graph!.edges.filter((e) => e.sourceId === selected.id).length}{" "}
            outgoing.
          </p>
          {graph!.nodes.length === 1 && (
            <p>No neighbors match these filters at this depth.</p>
          )}
        </div>
      )}
      <div id="cy" ref={cyRef} />
    </div>
  );
}
