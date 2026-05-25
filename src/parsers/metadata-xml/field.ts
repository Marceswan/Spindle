// Parses <Field>.field-meta.xml into a Field node and, for formula/rollup-summary fields,
// emits FORMULA_REFERENCES_FIELD unresolved refs that pass 3 will resolve once all fields
// across all objects are present in the graph. See design §6.5.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type CustomFieldXml = {
  CustomField?: {
    fullName?: string;
    label?: string;
    type?: string;
    length?: number;
    precision?: number;
    scale?: number;
    required?: boolean;
    unique?: boolean;
    externalId?: boolean;
    description?: string;
    inlineHelpText?: string;
    formula?: string;
    formulaTreatBlanksAs?: string;
    referenceTo?: string;
    relationshipName?: string;
    deleteConstraint?: string;
    summarizedField?: string;
    summaryForeignKey?: string;
    summaryOperation?: string;
    trackHistory?: boolean;
    defaultValue?: string;
    valueSet?: {
      valueSetDefinition?: {
        value?: { fullName?: string; label?: string }[] | { fullName?: string; label?: string };
        sorted?: boolean;
      };
      restricted?: boolean;
    };
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => name === "value",
});

export function parseFieldMeta(
  filePath: string,
  source: string,
  parentSObject: string,
): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: CustomFieldXml;
  try {
    parsed = xmlParser.parse(source) as CustomFieldXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const cf = parsed.CustomField ?? {};
  const apiName = cf.fullName ?? basename(filePath, ".field-meta.xml");
  const qualifiedName = `${parentSObject}.${apiName}`;

  const picklistValues = collectPicklistValues(cf);

  result.nodes.push({
    label: NodeLabel.Field,
    name: apiName,
    qualifiedName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      parentSObject,
      label: cf.label ?? apiName,
      type: cf.type ?? null,
      length: cf.length ?? null,
      precision: cf.precision ?? null,
      scale: cf.scale ?? null,
      required: cf.required ?? false,
      unique: cf.unique ?? false,
      externalId: cf.externalId ?? false,
      formula: cf.formula ?? null,
      referenceTo: cf.referenceTo ?? null,
      relationshipName: cf.relationshipName ?? null,
      deleteConstraint: cf.deleteConstraint ?? null,
      summarizedField: cf.summarizedField ?? null,
      summaryForeignKey: cf.summaryForeignKey ?? null,
      summaryOperation: cf.summaryOperation ?? null,
      trackHistory: cf.trackHistory ?? false,
      picklistValues,
      isCustom: apiName.endsWith("__c"),
      isFormula: cf.formula !== undefined && cf.formula !== null && cf.formula.length > 0,
      isRollUp: cf.summaryOperation !== undefined && cf.summaryOperation !== null,
    },
  });

  // Roll-up summary: explicit references via <summarizedField> and <summaryForeignKey>.
  // These reference fields on the related object identified by referenceTo of the lookup.
  // We emit a placeholder edge to the bare field name; pass 3 will resolve fully when the
  // graph is complete. For v0.2 we capture the relationship even if the target is unresolved.
  if (cf.summarizedField !== undefined && cf.summarizedField !== null) {
    result.edges.push({
      edgeType: EdgeType.FormulaReferencesField,
      fromQName: qualifiedName,
      fromLabel: NodeLabel.Field,
      toQName: cf.summarizedField,
      toLabel: NodeLabel.Field,
      confidence: Confidence.Heuristic,
      properties: { kind: "rollup-summary" },
    });
  }

  return result;
}

function collectPicklistValues(cf: NonNullable<CustomFieldXml["CustomField"]>): string[] {
  const def = cf.valueSet?.valueSetDefinition;
  if (def === undefined) return [];
  const raw = def.value;
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of arr) {
    if (v.fullName !== undefined) out.push(v.fullName);
  }
  return out;
}
