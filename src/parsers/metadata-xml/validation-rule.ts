// Parses validation rule XML into a ValidationRule node. Formula field references are
// emitted as unresolved-style edges (VALIDATION_REFERENCES_FIELD) at confidence 0.7 per
// design §6.7. v0.2 uses a simple token walker; full formula AST is a v2+ improvement.

import { basename } from "node:path";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

import { extractFormulaFieldReferences } from "./formula.ts";
import { createXmlParser, xmlBool, xmlText } from "./xml.ts";

type ValidationRuleXml = {
  ValidationRule?: {
    fullName?: string;
    active?: string;
    description?: string;
    errorConditionFormula?: string;
    errorDisplayField?: string;
    errorMessage?: string;
  };
};

const xmlParser = createXmlParser();

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
  const ruleName = xmlText(vr.fullName) ?? basename(filePath, ".validationRule-meta.xml");
  const qualifiedName = `${parentSObject}.${ruleName}`;
  const formula = xmlText(vr.errorConditionFormula);

  result.nodes.push({
    label: NodeLabel.ValidationRule,
    name: ruleName,
    qualifiedName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      parentSObject,
      active: xmlBool(vr.active) ?? true,
      description: xmlText(vr.description) ?? null,
      errorDisplayField: xmlText(vr.errorDisplayField) ?? null,
      errorMessage: xmlText(vr.errorMessage) ?? null,
      formula: formula ?? null,
    },
  });

  if (formula !== undefined) {
    const refs = extractFormulaFieldReferences(formula, parentSObject);
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
