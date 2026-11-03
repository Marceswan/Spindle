async function get<T>(path: string): Promise<T> {
  // The launcher supplies the secret in a fragment (never sent in HTTP URLs).
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token");
  if (token) {
    sessionStorage.setItem("spindle-token", token);
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  const res = await fetch(path, {
    headers: {
      authorization: `Bearer ${sessionStorage.getItem("spindle-token") ?? ""}`,
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export type Project = {
  id: number;
  name: string;
  rootPath: string;
  nodeCount: number;
  edgeCount: number;
};

export type Savings = {
  totalCalls: number;
  totalTokensSaved: number;
  totalResultTokens: number;
  totalBaselineTokens: number;
  perTool: { toolName: string; calls: number; tokensSaved: number }[];
  timeline: { day: string; tokensSaved: number; calls: number }[];
};

export type Schema = {
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
};

export type SearchNode = {
  id: number;
  name: string;
  qualifiedName: string;
  label: string;
  filePath: string | null;
};

export type Neighborhood = {
  centerId: number;
  truncated: boolean;
  truncationReason?: "node_cap" | "edge_cap" | "work_budget";
  nodes: {
    id: number;
    label: string;
    name: string;
    qualifiedName: string;
    filePath: string | null;
  }[];
  edges: { id: number; sourceId: number; targetId: number; edgeType: string }[];
};

export type NeighborhoodOptions = {
  depth?: number;
  cap?: number;
  nodeLabel?: string;
  edgeType?: string;
};

export const api = {
  projects: () => get<Project[]>("/api/projects"),
  savings: (p: number) => get<Savings>(`/api/savings?project=${p}`),
  schema: (p: number) => get<Schema>(`/api/schema?project=${p}`),
  search: (p: number, q: string, label = "") =>
    get<{ nodes: SearchNode[]; count: number }>(
      `/api/search?project=${p}&q=${encodeURIComponent(q)}&label=${encodeURIComponent(label)}`,
    ),
  neighborhood: (p: number, id: number, options: NeighborhoodOptions = {}) => {
    const query = new URLSearchParams({
      project: String(p),
      id: String(id),
      depth: String(options.depth ?? 1),
      cap: String(options.cap ?? 500),
    });
    if (options.nodeLabel) query.set("label", options.nodeLabel);
    if (options.edgeType) query.set("edge_type", options.edgeType);
    return get<Neighborhood>(`/api/neighborhood?${query}`);
  },
  fieldUsage: (p: number, field: string) =>
    get<Record<string, unknown>>(
      `/api/field-usage?project=${p}&field=${encodeURIComponent(field)}`,
    ),
  permission: (p: number, type: string, target: string) =>
    get<Record<string, unknown>>(
      `/api/permission-access?project=${p}&type=${type}&target=${encodeURIComponent(target)}`,
    ),
};
