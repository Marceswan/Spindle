// Parses <Field>.field-meta.xml into a Field node and, for formula/rollup-summary fields,
// emits FORMULA_REFERENCES_FIELD unresolved refs that pass 3 will resolve once all fields
// across all objects are present in the graph. See design §6.5.

import { basename } from "node:path";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";
import { createXmlParser, xmlBool, xmlNumber, xmlText } from "./xml.ts";

type CustomFieldXml = {
  CustomField?: {
    fullName?: string;
    label?: string;
    type?: string;
    length?: string;
    precision?: string;
    scale?: string;
    required?: string;
    unique?: string;
    externalId?: string;
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
    trackHistory?: string;
    defaultValue?: string;
    valueSet?: {
      valueSetDefinition?: {
        value?: { fullName?: string; label?: string }[] | { fullName?: string; label?: string };
        sorted?: string;
      };
      restricted?: string;
    };
  };
};

const xmlParser = createXmlParser({
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
  const apiName = xmlText(cf.fullName) ?? basename(filePath, ".field-meta.xml");
  const qualifiedName = `${parentSObject}.${apiName}`;

  const picklistValues = collectPicklistValues(cf);
  const formula = xmlText(cf.formula);
  const summaryOperation = xmlText(cf.summaryOperation);
  const summarizedField = xmlText(cf.summarizedField);

  result.nodes.push({
    label: NodeLabel.Field,
    name: apiName,
    qualifiedName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      parentSObject,
      label: xmlText(cf.label) ?? apiName,
      type: xmlText(cf.type) ?? null,
      length: xmlNumber(cf.length),
      precision: xmlNumber(cf.precision),
      scale: xmlNumber(cf.scale),
      required: xmlBool(cf.required) ?? false,
      unique: xmlBool(cf.unique) ?? false,
      externalId: xmlBool(cf.externalId) ?? false,
      formula: formula ?? null,
      referenceTo: xmlText(cf.referenceTo) ?? null,
      relationshipName: xmlText(cf.relationshipName) ?? null,
      deleteConstraint: xmlText(cf.deleteConstraint) ?? null,
      summarizedField: summarizedField ?? null,
      summaryForeignKey: xmlText(cf.summaryForeignKey) ?? null,
      summaryOperation: summaryOperation ?? null,
      trackHistory: xmlBool(cf.trackHistory) ?? false,
      picklistValues,
      isCustom: apiName.endsWith("__c"),
      isFormula: formula !== undefined && formula.length > 0,
      isRollUp: summaryOperation !== undefined,
    },
  });

  // Roll-up summary: explicit references via <summarizedField> and <summaryForeignKey>.
  // These reference fields on the related object identified by referenceTo of the lookup.
  // We emit a placeholder edge to the bare field name; pass 3 will resolve fully when the
  // graph is complete. For v0.2 we capture the relationship even if the target is unresolved.
  if (summarizedField !== undefined) {
    result.edges.push({
      edgeType: EdgeType.FormulaReferencesField,
      fromQName: qualifiedName,
      fromLabel: NodeLabel.Field,
      toQName: summarizedField,
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
    const name = xmlText(v.fullName);
    if (name !== undefined) out.push(name);
  }
  return out;
}
