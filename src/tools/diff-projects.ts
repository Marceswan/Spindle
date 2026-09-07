import type { GraphStore } from "../graph/store.ts";
import { diffProjects } from "../graph/diff.ts";
export const name = "diff_projects";
export const description = "Compare two indexed SFDX snapshots (e.g. sandbox and production source). Reports added, removed and changed metadata nodes and relationships by API name, ignoring local paths/IDs. Index both snapshots first; this does not connect to live orgs.";
export const inputSchema = { type: "object", properties: {
  base_project_id: { type: "integer" }, target_project_id: { type: "integer" },
  include_source: { type: "boolean", description: "Compare content hashes too. Default true; hashes may include formatting changes." },
  limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0 },
}, required: ["base_project_id", "target_project_id"] } as const;
export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const i = input as { base_project_id: number; target_project_id: number; include_source?: boolean; limit?: number; offset?: number };
  if (i.include_source !== undefined && typeof i.include_source !== "boolean") throw new Error("include_source must be a boolean");
  const limit = i.limit ?? 50, offset = i.offset ?? 0;
  if (![i.base_project_id, i.target_project_id, limit, offset].every(Number.isSafeInteger) || limit < 1 || limit > 500 || offset < 0) throw new Error("Project IDs and pagination must be valid integers; limit 1–500, offset >= 0");
  const changes = diffProjects(store, i.base_project_id, i.target_project_id, i.include_source ?? true);
  const page = changes.slice(offset, offset + limit), hasMore = offset + page.length < changes.length;
  return { base_project_id: i.base_project_id, target_project_id: i.target_project_id, total: changes.length,
    summary: { added: changes.filter(c => c.change === "added").length, removed: changes.filter(c => c.change === "removed").length, changed: changes.filter(c => c.change === "changed").length },
    changes: page, has_more: hasMore, next_offset: hasMore ? offset + page.length : null,
    scope: "Indexed metadata and static references only; not live org state or runtime permissions." };
}
