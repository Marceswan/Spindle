// Thin HTTP API over the existing graph queries and MCP tool handlers. Returns a Response
// for any /api/* path, or null for non-API paths (so the caller can serve static assets).
// No logic is duplicated: field-usage / permission / search / trace reuse the tool handlers.

import { NodeLabel } from "../model/node-labels.ts";
import { EdgeType } from "../model/edge-types.ts";
import type { GraphStore } from "../graph/store.ts";
import {
  listProjects,
  getSchemaSummary,
  getNeighborhood,
  getSavingsSummary,
  getMethodDeclaringClass,
} from "../graph/queries.ts";
import * as toolSearch from "../tools/search-graph.ts";
import * as toolTrace from "../tools/trace-references.ts";
import * as toolFieldUsage from "../tools/get-field-usage.ts";
import * as toolPermission from "../tools/get-permission-access.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class InvalidInput extends Error {}

function num(
  v: string | null,
  fallback: number | null = null,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  if (v === null) return fallback;
  const n = Number(v);
  if (v.trim() === "" || !Number.isSafeInteger(n) || n < min || n > max)
    throw new InvalidInput(`Expected integer between ${min} and ${max}`);
  return n;
}

export async function handleApi(
  req: Request,
  store: GraphStore,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const q = url.searchParams;

  try {
    switch (url.pathname) {
      case "/api/projects":
        return json(listProjects(store));

      case "/api/schema": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        return json(getSchemaSummary(store, project));
      }

      case "/api/savings": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        return json(getSavingsSummary(store, project));
      }

      case "/api/neighborhood": {
        const project = num(q.get("project"));
        const id = num(q.get("id"));
        if (project === null || id === null)
          return json({ error: "project and id required" }, 400);
        const label = q.get("label") || undefined,
          edgeType = q.get("edge_type") || undefined;
        if (label && !Object.values(NodeLabel).some((v) => v === label))
          throw new InvalidInput("Unknown node label");
        if (edgeType && !Object.values(EdgeType).some((v) => v === edgeType))
          throw new InvalidInput("Unknown edge type");
        const neighborhood = getNeighborhood(store, project, id, {
          depth: num(q.get("depth"), 1, 0, 5) ?? 1,
          cap: num(q.get("cap"), 500, 1, 2000) ?? 500,
          ...(label ? { nodeLabel: label } : {}),
          ...(edgeType ? { edgeType } : {}),
        });
        if (!neighborhood.nodes.length)
          return json({ error: "Node not found in project" }, 404);
        return json(neighborhood);
      }

      case "/api/search": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const input: Record<string, unknown> = {
          project_id: project,
          limit: num(q.get("limit"), 50, 1, 1000) ?? 50,
        };
        const pattern = q.get("q");
        const label = q.get("label");
        if (pattern)
          input[
            label === "ApexMethod" ? "qualified_name_pattern" : "name_pattern"
          ] =
            label === "ApexMethod"
              ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              : pattern;
        if (label) input["label"] = label;
        return json(await toolSearch.handler(input, store));
      }

      case "/api/trace": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const start = q.get("start");
        if (!start) return json({ error: "start required" }, 400);
        const direction = q.get("direction") ?? "inbound";
        return json(
          await toolTrace.handler(
            {
              project_id: project,
              start: { qualified_name: start },
              direction,
            },
            store,
          ),
        );
      }

      case "/api/field-usage": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        const input = { project_id: project, field: q.get("field") ?? "" };
        return json(await toolFieldUsage.handler(input, store));
      }

      case "/api/permission-access": {
        const project = num(q.get("project"));
        if (project === null) return json({ error: "project required" }, 400);
        if (q.get("type") === "ApexMethod") {
          const method = q.get("target") ?? "";
          const declaringClass = getMethodDeclaringClass(
            store,
            project,
            method,
          );
          if (!declaringClass)
            return json(
              {
                error:
                  "Method or declaring Apex class not found in this project",
              },
              404,
            );
          const report = await toolPermission.handler(
            {
              project_id: project,
              target: { type: "ApexClass", qualified_name: declaringClass },
            },
            store,
          );
          return json({
            ...(report as Record<string, unknown>),
            method,
            declaringClass,
          });
        }
        const input = {
          project_id: project,
          target: {
            type: q.get("type") ?? "Field",
            qualified_name: q.get("target") ?? "",
          },
        };
        return json(await toolPermission.handler(input, store));
      }

      default:
        return json({ error: `Unknown API path: ${url.pathname}` }, 404);
    }
  } catch (err) {
    return json(
      { error: (err as Error).message },
      err instanceof InvalidInput ? 400 : 500,
    );
  }
}
