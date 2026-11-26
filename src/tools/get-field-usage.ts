// MCP tool: get_field_usage — the headline tool from design §9.7.
// Given a fully-qualified field (e.g. "Customer__c.Email__c"), returns every node in the
// graph that references that field, grouped by usage type. v0.2 buckets that work today:
//   - apex_methods: methods that SOQL_QUERIES or DML_ON the field's parent SObject
//     (coarse — v0.3 will narrow to per-field via REFERENCES_FIELD edges)
//   - lwc_bundles:  bundles that import the field via @salesforce/schema
//   - vf_pages, vf_components: VF files with {!Object.Field} bindings
//   - validation_rules: VRs whose formula references the field
//   - aura_components: pending Aura parser
//   - flows: pending Flow parser
//   - ui_bundles: React UI bundles whose UI API GraphQL documents name the field
//   - layouts: Layout and FlexiPage field placements
//   - email_templates: merge fields in the subject and body
//   - permission_sets, profiles: use get_permission_access
//
// The tool always returns all buckets; empty arrays mean "indexed, no usage" or "not yet
// modeled by Spindle." The response includes a `coverage` summary so the caller knows what
// is and isn't authoritative.

import { GraphStore } from "../graph/store.ts";
import { EdgeType } from "../model/edge-types.ts";
import { NodeLabel } from "../model/node-labels.ts";
import { projectNotIndexedMessage } from "../graph/queries.ts";

export const name = "get_field_usage";

export const description =
  "Find every reference to a Salesforce field across all metadata types. The killer query for impact analysis. " +
  "Returns Apex methods that SOQL or DML the parent SObject, LWC bundles importing via @salesforce/schema, " +
  "Visualforce bindings, validation formulas, layouts, email template merge fields, the UI API GraphQL documents of React UI bundles, " +
  "and Flow fields resolved from record variables, decisions, assignments, formulas, screens and choice sets. " +
  "Flow relationship traversal is not resolved. A UI bundle query or mutation input that is built at run time is not read. " +
  "Names match without regard to case. A standard field with no metadata file in the project is reported from its references (a placeholder node).";

export const inputSchema = {
  type: "object",
  properties: {
    project_id: { type: "number" },
    field: {
      type: "string",
      description: "Fully-qualified field, e.g. 'Customer__c.Email__c'.",
    },
    include_indirect: {
      type: "boolean",
      description:
        "Include indirect references via the parent SObject (Apex SOQL/DML). Default true; " +
        "set false to limit to direct field-level references (LWC schema imports, VF bindings, " +
        "validation-rule formulas, formula fields, statically bound Flow fields).",
    },
  },
  required: ["project_id", "field"],
} as const;

type Input = {
  project_id: number;
  field: string;
  include_indirect?: boolean | undefined;
};

type Usage = {
  qualified_name: string;
  name: string;
  file_path: string | null;
  line: number | null;
  context: string;
  // "field": the source refers to this field. "object": the source reads or writes the
  // parent object, and no field-level reference is known. An object-level entry is a
  // possible usage, not a confirmed one.
  scope: "field" | "object";
};

type UsageReport = {
  field: string;
  parent_sobject: string | null;
  apex_methods: Usage[];
  lwc_bundles: Usage[];
  vf_pages: Usage[];
  vf_components: Usage[];
  validation_rules: Usage[];
  formula_fields: Usage[];
  aura_components: Usage[];
  flows: Usage[];
  ui_bundles: Usage[];
  layouts: Usage[];
  permission_sets: Usage[];
  email_templates: Usage[];
  coverage: { authoritative: string[]; indirect: string[]; pending: string[] };
};

export async function handler(input: unknown, store: GraphStore): Promise<unknown> {
  const { project_id, field, include_indirect } = input as Input;
  const includeIndirect = include_indirect ?? true;

  if (typeof field !== "string" || !field.includes(".")) {
    return { error: `field must be in "Object.Field" form (got "${field}")` };
  }
  const notIndexed = projectNotIndexedMessage(store, project_id);
  if (notIndexed !== null) return { error: notIndexed };
  const parentSObject = field.slice(0, field.indexOf("."));

  const report: UsageReport = {
    field,
    parent_sobject: parentSObject,
    apex_methods: [],
    lwc_bundles: [],
    vf_pages: [],
    vf_components: [],
    validation_rules: [],
    formula_fields: [],
    aura_components: [],
    flows: [],
    ui_bundles: [],
    layouts: [],
    permission_sets: [],
    email_templates: [],
    coverage: {
      authoritative: ["lwc_bundles", "vf_pages", "vf_components", "validation_rules", "layouts", "email_templates", "ui_bundles"],
      indirect: ["apex_methods", "flows"],
      pending: ["aura_components", "permission_sets", "formula_fields", "flow_relationship_traversal", "ui_bundle_runtime_queries"],
    },
  };

  // Field-level direct edges: LWC_USES_FIELD, VF_USES_FIELD, VALIDATION_REFERENCES_FIELD,
  // FORMULA_REFERENCES_FIELD. All target a Field node by qualified name.
  type Row = {
    source_label: string;
    source_name: string;
    source_qname: string;
    source_file: string | null;
    source_line: number | null;
    edge_type: string;
    usage_context: string | null;
    edge_file: string | null;
  };
  const directRows = store.db
    .query<Row, [number, string, string, string, string, string, string, string, string, string, string, string, string]>(
      `SELECT DISTINCT
         s.label AS source_label,
         s.name AS source_name,
         s.qualified_name AS source_qname,
         s.file_path AS source_file,
         e.source_line AS source_line,
         e.edge_type AS edge_type,
         CASE WHEN s.label IN ('ApexMethod', 'ApexTrigger') THEN json_extract(e.properties, '$.context') END AS usage_context,
         json_extract(e.properties, '$.sourceFile') AS edge_file
       FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ?
         AND t.label = ?
         AND t.qualified_name = ? COLLATE NOCASE
         AND e.edge_type IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .all(
      project_id,
      NodeLabel.Field,
      field,
      EdgeType.LwcUsesField,
      EdgeType.VfUsesField,
      EdgeType.ValidationReferencesField,
      EdgeType.FormulaReferencesField,
      EdgeType.ReferencesField,
      EdgeType.LayoutIncludesField,
      EdgeType.FlexipageReferencesField,
      EdgeType.FlowUsesField,
      EdgeType.EmailReferencesField,
      EdgeType.UiBundleUsesField,
    );

  for (const row of directRows) {
    const usage: Usage = {
      qualified_name: row.source_qname,
      name: row.source_name,
      file_path: row.source_file,
      line: row.source_line,
      context: row.edge_type,
      scope: "field",
    };
    if (row.source_label === NodeLabel.LwcBundle) {
      report.lwc_bundles.push(usage);
    } else if (row.source_label === NodeLabel.VisualforcePage) {
      report.vf_pages.push(usage);
    } else if (row.source_label === NodeLabel.VisualforceComponent) {
      report.vf_components.push(usage);
    } else if (row.source_label === NodeLabel.ValidationRule) {
      report.validation_rules.push(usage);
    } else if (row.source_label === NodeLabel.Field) {
      report.formula_fields.push(usage);
    } else if (row.source_label === NodeLabel.AuraBundle || row.source_label === NodeLabel.AuraComponent) {
      report.aura_components.push(usage);
    } else if (row.source_label === NodeLabel.Flow) {
      report.flows.push(usage);
    } else if (row.source_label === NodeLabel.UiBundle) {
      // The node of a bundle is its directory. The edge names the source file of the reference.
      report.ui_bundles.push({ ...usage, file_path: row.edge_file ?? row.source_file });
    } else if (row.source_label === NodeLabel.ApexMethod || row.source_label === NodeLabel.ApexTrigger) {
      // A query in a trigger body belongs to the trigger node; it has no method.
      // Direct REFERENCES_FIELD edge from a parsed SOQL clause. This is the
      // most precise Apex bucket; takes priority over the indirect SObject-level approximation
      // below, which is now redundant for fields whose object has metadata in the graph.
      report.apex_methods.push({ ...usage, context: row.usage_context ?? "SOQL_SELECT" });
    } else if (row.source_label === NodeLabel.EmailTemplate) {
      report.email_templates.push(usage);
    } else if (row.source_label === NodeLabel.Layout) {
      report.layouts.push(usage);
    } else if (row.source_label === NodeLabel.FlexiPage) {
      // FlexiPages don't have their own bucket; group them under layouts since they play
      // the same role (UI placement of fields). The `context` field carries the edge type
      // so consumers can distinguish.
      report.layouts.push(usage);
    }
  }

  // Indirect: Apex methods that query or DML the parent SObject. Approximate; v0.3 will
  // narrow this once SOQL field-list resolution lands (task #15).
  if (includeIndirect) {
    type ApexRow = {
      qualified_name: string;
      name: string;
      file_path: string | null;
      source_line: number | null;
      edge_type: string;
    };
    const apexRows = store.db
      .query<ApexRow, [number, string, string, string, string, string, string]>(
        `SELECT
           s.qualified_name AS qualified_name,
           s.name AS name,
           s.file_path AS file_path,
           e.source_line AS source_line,
           e.edge_type AS edge_type
         FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND s.label IN (?, ?)
           AND t.label = ?
           AND t.qualified_name = ? COLLATE NOCASE
           AND e.edge_type IN (?, ?)`,
      )
      .all(
        project_id,
        NodeLabel.ApexMethod,
        NodeLabel.ApexTrigger,
        NodeLabel.SObject,
        parentSObject,
        EdgeType.SoqlQueries,
        EdgeType.DmlOn,
      );

    // A source that has a field-level entry is not listed a second time at object level.
    const fieldLevelApex = new Set(report.apex_methods.map((usage) => usage.qualified_name));
    for (const row of apexRows) {
      if (fieldLevelApex.has(row.qualified_name)) continue;
      report.apex_methods.push({
        qualified_name: row.qualified_name,
        name: row.name,
        file_path: row.file_path,
        line: row.source_line,
        context: row.edge_type === EdgeType.SoqlQueries ? "SOQL" : "DML",
        scope: "object",
      });
    }

    // Indirect Flow references: any Flow whose FLOW_DML_ON edge targets the parent SObject
    // is recorded as a touch-point for this field. Coarse, but useful for impact analysis
    // until per-field Flow refs land in v0.4.
    type FlowRow = {
      qualified_name: string;
      name: string;
      file_path: string | null;
      source_line: number | null;
      operation: string;
    };
    const flowRows = store.db
      .query<FlowRow, [number, string, string, string, string]>(
        `SELECT
           s.qualified_name AS qualified_name,
           s.name AS name,
           s.file_path AS file_path,
           e.source_line AS source_line,
           json_extract(e.properties, '$.operation') AS operation
         FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND s.label = ?
           AND t.label = ?
           AND t.qualified_name = ? COLLATE NOCASE
           AND e.edge_type = ?`,
      )
      .all(project_id, NodeLabel.Flow, NodeLabel.SObject, parentSObject, EdgeType.FlowDmlOn);
    const fieldLevelFlows = new Set(report.flows.map((usage) => usage.qualified_name));
    for (const row of flowRows) {
      if (fieldLevelFlows.has(row.qualified_name)) continue;
      report.flows.push({
        qualified_name: row.qualified_name,
        name: row.name,
        file_path: row.file_path,
        line: row.source_line,
        context: row.operation ?? "FLOW_DML",
        scope: "object",
      });
    }

    // A UI bundle operation on the parent object where a variable holds the part that can
    // name a field: a mutation input, or a filter. The field can be in that variable.
    const bundleRows = store.db
      .query<FlowRow & { edge_file: string | null }, [number, string, string, string, string]>(
        `SELECT
           s.qualified_name AS qualified_name,
           s.name AS name,
           s.file_path AS file_path,
           e.source_line AS source_line,
           json_extract(e.properties, '$.operation') AS operation,
           json_extract(e.properties, '$.sourceFile') AS edge_file
         FROM edges e
         JOIN nodes s ON s.id = e.source_id
         JOIN nodes t ON t.id = e.target_id
         WHERE e.project_id = ?
           AND s.label = ?
           AND t.label = ?
           AND t.qualified_name = ? COLLATE NOCASE
           AND e.edge_type = ?
           AND json_extract(e.properties, '$.runtime') = 1`,
      )
      .all(project_id, NodeLabel.UiBundle, NodeLabel.SObject, parentSObject, EdgeType.UiBundleUsesObject);
    const fieldLevelBundles = new Set(report.ui_bundles.map((usage) => `${usage.qualified_name}|${usage.file_path}`));
    for (const row of bundleRows) {
      const filePath = row.edge_file ?? row.file_path;
      if (fieldLevelBundles.has(`${row.qualified_name}|${filePath}`)) continue;
      report.ui_bundles.push({
        qualified_name: row.qualified_name,
        name: row.name,
        file_path: filePath,
        line: row.source_line,
        context: `UI_API_${(row.operation ?? "operation").toUpperCase()}`,
        scope: "object",
      });
    }
  }

  return report;
}
