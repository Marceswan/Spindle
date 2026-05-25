// Parses validation rule XML into a ValidationRule node. Formula field references are
// emitted as unresolved-style edges (VALIDATION_REFERENCES_FIELD) at confidence 0.7 per
// design §6.7. v0.2 uses a simple token walker; full formula AST is a v2+ improvement.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

import { extractFormulaFieldReferences } from "./formula.ts";

type ValidationRuleXml = {
  ValidationRule?: {
    fullName?: string;
    active?: boolean;
    description?: string;
    errorConditionFormula?: string;
    errorDisplayField?: string;
    errorMessage?: string;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: () => false,
});

export function parseValidationRuleMeta(
  filePath: string,
  source: string,
  parentSObject: string,
): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: ValidationRuleXml;
  try {
    parsed = xmlParser.parse(source) as ValidationRuleXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const vr = parsed.ValidationRule ?? {};
  const ruleName = vr.fullName ?? basename(filePath, ".validationRule-meta.xml");
  const qualifiedName = `${parentSObject}.${ruleName}`;

  result.nodes.push({
    label: NodeLabel.ValidationRule,
    name: ruleName,
    qualifiedName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      parentSObject,
      active: vr.active ?? true,
      description: vr.description ?? null,
      errorDisplayField: vr.errorDisplayField ?? null,
      errorMessage: vr.errorMessage ?? null,
      formula: vr.errorConditionFormula ?? null,
    },
  });

  if (vr.errorConditionFormula !== undefined && vr.errorConditionFormula !== null) {
    const refs = extractFormulaFieldReferences(vr.errorConditionFormula, parentSObject);
    for (const ref of refs) {
      result.edges.push({
        edgeType: EdgeType.ValidationReferencesField,
        fromQName: qualifiedName,
        fromLabel: NodeLabel.ValidationRule,
        toQName: ref,
        toLabel: NodeLabel.Field,
        confidence: Confidence.Regex,
      });
    }
  }

  return result;
}
