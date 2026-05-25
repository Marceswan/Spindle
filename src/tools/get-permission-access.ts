// MCP tool: get_permission_access — design §9.9.
// "Who can access this Apex class / object / field?" Traverses permission sets, permission set
// groups, and profiles. Returns each grant with its access details (CRUD for objects, read/edit
// for fields, enabled flag for classes).

import { GraphStore } from "../graph/store.ts";
import { EdgeType } from "../model/edge-types.ts";
import { NodeLabel } from "../model/node-labels.ts";

export const name = "get_permission_access";

export const description =
  "List every permission set and profile that grants access to a given Apex class, SObject, or Field. " +
  "Also returns the permission set groups that include any of those permission sets — useful for tracing " +
  "indirect grants. The answer to 'who can run this method' or 'who can read this field'.";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: { type: "number" },
    target: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["ApexClass", "SObject", "Field", "VisualforcePage", "RecordType"] },
        qualified_name: { type: "string" },
      },
      required: ["type", "qualified_name"],
    },
  },
  required: ["project_id", "target"],
} as const;

type TargetType = "ApexClass" | "SObject" | "Field" | "VisualforcePage" | "RecordType";

type Input = {
  project_id: number;
  target: { type: TargetType; qualified_name: string };
};

type Grant = {
  source_qualified_name: string;
  source_label: "PermissionSet" | "Profile";
  edge_type: string;
  access: Record<string, unknown>;
};

type AccessReport = {
  target: { type: TargetType; qualified_name: string };
  permission_sets: Grant[];
  profiles: Grant[];
  permission_set_groups: { qualified_name: string; includes: string[] }[];
  total_grants: number;
};

const targetToEdge: Record<TargetType, string> = {
  ApexClass: EdgeType.GrantsApexAccess,
  SObject: EdgeType.GrantsObjectAccess,
  Field: EdgeType.GrantsFieldAccess,
  VisualforcePage: EdgeType.GrantsVisualforceAccess,
  RecordType: EdgeType.GrantsRecordTypeAccess,
};

const targetToLabel: Record<TargetType, string> = {
  ApexClass: NodeLabel.ApexClass,
  SObject: NodeLabel.SObject,
  Field: NodeLabel.Field,
  VisualforcePage: NodeLabel.VisualforcePage,
  RecordType: NodeLabel.RecordType,
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const { project_id, target } = input as Input;

  const edgeType = targetToEdge[target.type];
  const targetLabel = targetToLabel[target.type];
  if (edgeType === undefined || targetLabel === undefined) {
    return { error: `Unknown target type "${target.type}". Use one of: ApexClass, SObject, Field, VisualforcePage, RecordType.` };
  }

  // Pull all grant edges pointing at the target.
  type GrantRow = {
    source_label: string;
    source_qname: string;
    edge_properties: string;
    edge_type: string;
  };
  const grantRows = store.db
    .query<GrantRow, [number, string, string, string]>(
      `SELECT
         s.label AS source_label,
         s.qualified_name AS source_qname,
         e.properties AS edge_properties,
         e.edge_type AS edge_type
       FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ?
         AND e.edge_type = ?
         AND t.label = ?
         AND t.qualified_name = ?`,
    )
    .all(project_id, edgeType, targetLabel, target.qualified_name);

  const permissionSets: Grant[] = [];
  const profiles: Grant[] = [];

  for (const row of grantRows) {
    const access = JSON.parse(row.edge_properties) as Record<string, unknown>;
    const grant: Grant = {
      source_qualified_name: row.source_qname,
      source_label: row.source_label === NodeLabel.Profile ? "Profile" : "PermissionSet",
      edge_type: row.edge_type,
      access,
    };
    if (row.source_label === NodeLabel.Profile) {
      profiles.push(grant);
    } else if (row.source_label === NodeLabel.PermissionSet) {
      permissionSets.push(grant);
    }
  }

  // For each PermissionSet that grants access, find PermissionSetGroups that include it.
  const permsetNames = new Set(permissionSets.map((g) => g.source_qualified_name));
  const groups: { qualified_name: string; includes: string[] }[] = [];
  if (permsetNames.size > 0) {
    const placeholders = [...permsetNames].map(() => "?").join(",");
    type GroupRow = { group_qname: string; member_qname: string };
    const groupRows = store.db
      .query<GroupRow, (number | string)[]>(
        `SELECT
           s.qualified_name AS group_qname,
           t.qualified_name AS member_qname
         FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND e.edge_type = ?
           AND s.label = ?
           AND t.label = ?
           AND t.qualified_name IN (${placeholders})`,
      )
      .all(
        project_id,
        EdgeType.IncludesPermset,
        NodeLabel.PermissionSetGroup,
        NodeLabel.PermissionSet,
        ...permsetNames,
      );

    const byGroup = new Map<string, string[]>();
    for (const row of groupRows) {
      const existing = byGroup.get(row.group_qname) ?? [];
      existing.push(row.member_qname);
      byGroup.set(row.group_qname, existing);
    }
    for (const [groupName, members] of byGroup.entries()) {
      groups.push({ qualified_name: groupName, includes: members });
    }
  }

  const report: AccessReport = {
    target,
    permission_sets: permissionSets,
    profiles,
    permission_set_groups: groups,
    total_grants: permissionSets.length + profiles.length,
  };
  return report;
}
