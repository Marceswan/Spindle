import type { GraphStore } from "./store.ts";
import { getAllNodesForProject, listProjects } from "./queries.ts";

type Snapshot = { properties: unknown; contentHash?: string | null; confidence?: number };
export type GraphChange = { kind: "node" | "edge"; identity: string; change: "added" | "removed" | "changed"; before?: Snapshot; after?: Snapshot };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function diffProjects(store: GraphStore, baseId: number, targetId: number, includeSource: boolean): GraphChange[] {
  const projects = listProjects(store);
  for (const id of [baseId, targetId]) if (!projects.some(p => p.id === id)) throw new Error(`Project ${id} is not indexed`);
  const snapshot = (id: number): Map<string, Snapshot> => {
    const out = new Map<string, Snapshot>();
    for (const node of getAllNodesForProject(store, id)) out.set(`node:${JSON.stringify([node.label, node.qualifiedName])}`, {
      properties: node.properties, ...(includeSource ? { contentHash: node.contentHash } : {}),
    });
    type Row = { sl: string; sq: string; type: string; tl: string; tq: string; properties: string; confidence: number };
    const rows = store.db.query<Row, [number]>(`SELECT s.label sl,s.qualified_name sq,e.edge_type type,t.label tl,t.qualified_name tq,e.properties,e.confidence
      FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id WHERE e.project_id=? AND s.project_id=e.project_id AND t.project_id=e.project_id`).all(id);
    // Parallel edges are a multiset; line movement and insertion order must not create differences.
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.sl, row.sq, row.type, row.tl, row.tq]);
      const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    for (const [key, rows] of groups) out.set(`edge:${key}`, {
      properties: rows.map(r => ({ properties: JSON.parse(r.properties) as unknown, confidence: r.confidence })).sort((a, b) => stable(a).localeCompare(stable(b))),
    });
    return out;
  };
  const base = snapshot(baseId), target = snapshot(targetId);
  const changes: GraphChange[] = [];
  for (const key of [...new Set([...base.keys(), ...target.keys()])].sort()) {
    const before = base.get(key), after = target.get(key);
    if (before && after && stable(before) === stable(after)) continue;
    changes.push({ kind: key.startsWith("node:") ? "node" : "edge", identity: key.slice(5), change: !before ? "added" : !after ? "removed" : "changed",
      ...(before ? { before } : {}), ...(after ? { after } : {}) });
  }
  return changes;
}
