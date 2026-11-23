// Parses labels/CustomLabels.labels-meta.xml into CustomLabel nodes. Each `<labels>` entry
// becomes one node with qualified_name = `c.<fullName>` to match the LWC and VF import
// conventions (e.g., `@salesforce/label/c.Greeting`).


import { NodeLabel } from "../../model/node-labels.ts";
import type { ParseResult } from "../apex/types.ts";
import { createXmlParser, xmlBool, xmlText } from "./xml.ts";

type LabelEntry = {
  fullName?: string;
  value?: string;
  language?: string;
  protected?: string;
  shortDescription?: string;
  categories?: string;
};

type CustomLabelsXml = {
  CustomLabels?: {
    labels?: LabelEntry | LabelEntry[];
  };
};

const xmlParser = createXmlParser({
  isArray: (name) => name === "labels",
});

export function parseCustomLabels(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: CustomLabelsXml;
  try {
    parsed = xmlParser.parse(source) as CustomLabelsXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const labelsRaw = parsed.CustomLabels?.labels;
  if (labelsRaw === undefined) return result;
  const labels = Array.isArray(labelsRaw) ? labelsRaw : [labelsRaw];

  const totalLines = source.split("\n").length;

  for (const lbl of labels) {
    const fullName = xmlText(lbl.fullName);
    if (fullName === undefined || fullName.length === 0) continue;
    const qname = `c.${fullName}`;
    result.nodes.push({
      label: NodeLabel.CustomLabel,
      name: fullName,
      qualifiedName: qname,
      startLine: 1,
      endLine: totalLines,
      properties: {
        value: xmlText(lbl.value) ?? null,
        language: xmlText(lbl.language) ?? "en_US",
        protected: xmlBool(lbl.protected) ?? false,
        shortDescription: xmlText(lbl.shortDescription) ?? null,
        categories: xmlText(lbl.categories) ?? null,
      },
    });
  }

  return result;
}
