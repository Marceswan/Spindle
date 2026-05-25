// MCP tool: search_graph
// Filtered structural search over graph nodes.

import { GraphStore } from "../graph/store.ts";
import { searchNodes } from "../graph/queries.ts";
import type { EdgeType } from "../model/edge-types.ts";

export const name = "search_graph";

export const description =
  "Search the metadata graph by label, name pattern, qualified name pattern, file path, " +
  "or property values. Prefer this over grep for structural questions like 'find all " +
  "@AuraEnabled methods' or 'find classes that extend BatchableContext'.";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: { type: "number", description: "Project ID from list_projects." },
    label: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
      ],
      description:
        "Node label(s) to filter by: ApexClass, ApexMethod, ApexInterface, ApexTrigger, SObject, etc.",
    },
    name_pattern: { type: "string", description: "Regex applied to the short name." },
    qualified_name_pattern: {
      type: "string",
      description: "Regex applied to the fully qualified name.",
    },
    file_pattern: { type: "string", description: "Glob applied to the file path." },
    property_filters: {
      type: "object",
      description: "Exact-match filters on node properties JSON. E.g. {isStatic: true}.",
    },
    relationship: {
      type: "object",
      properties: {
        edge_type: { type: "string" },
        direction: { type: "string", enum: ["inbound", "outbound", "both"] },
        min_degree: { type: "number" },
        max_degree: { type: "number" },
      },
      required: ["edge_type", "direction"],
    },
    exclude_entry_points: {
      type: "boolean",
      description: "Exclude @AuraEnabled, @InvocableMethod, @IsTest, triggers, and @Http* methods.",
    },
    limit: { type: "number", description: "Max results. Default 50." },
  },
  required: ["project_id"],
} as const;

type RelationshipInput = {
  edge_type: string;
  direction: "inbound" | "outbound" | "both";
  min_degree?: number | undefined;
  max_degree?: number | undefined;
};

type Input = {
  project_id: number;
  label?: string | string[] | undefined;
  name_pattern?: string | undefined;
  qualified_name_pattern?: string | undefined;
  file_pattern?: string | undefined;
  property_filters?: Record<string, unknown> | undefined;
  relationship?: RelationshipInput | undefined;
  exclude_entry_points?: boolean | undefined;
  limit?: number | undefined;
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const i = input as Input;

  const relationship = i.relationship !== undefined
    ? {
        edgeType: i.relationship.edge_type as EdgeType,
        direction: i.relationship.direction,
        ...(i.relationship.min_degree !== undefined ? { minDegree: i.relationship.min_degree } : {}),
        ...(i.relationship.max_degree !== undefined ? { maxDegree: i.relationship.max_degree } : {}),
      }
    : undefined;

  const nodes = searchNodes(store, {
    projectId: i.project_id,
    ...(i.label !== undefined ? { label: i.label } : {}),
    ...(i.name_pattern !== undefined ? { namePattern: i.name_pattern } : {}),
    ...(i.qualified_name_pattern !== undefined ? { qualifiedNamePattern: i.qualified_name_pattern } : {}),
    ...(i.file_pattern !== undefined ? { filePattern: i.file_pattern } : {}),
    ...(i.property_filters !== undefined ? { propertyFilters: i.property_filters } : {}),
    ...(relationship !== undefined ? { relationship } : {}),
    ...(i.exclude_entry_points !== undefined ? { excludeEntryPoints: i.exclude_entry_points } : {}),
    ...(i.limit !== undefined ? { limit: i.limit } : {}),
  });

  return { nodes, count: nodes.length };
}
