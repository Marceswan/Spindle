// Parses <Name>.object-meta.xml into an SObject node. See design §6.5.
// Standard objects (Account, Contact, ...) typically have a near-empty file; we still emit
// the node so SOQL/DML edges from Apex resolve to a real node rather than the parser-emitted
// placeholder.


import { NodeLabel } from "../../model/node-labels.ts";
import type { ParseResult } from "../apex/types.ts";
import { createXmlParser, xmlBool, xmlText } from "./xml.ts";

type CustomObjectXml = {
  CustomObject?: {
    label?: string;
    pluralLabel?: string;
    description?: string;
    sharingModel?: string;
    deploymentStatus?: string;
    nameField?: { type?: string; label?: string };
    enableActivities?: string;
    enableHistory?: string;
    enableReports?: string;
    enableSearch?: string;
  };
};

const xmlParser = createXmlParser();

export function parseObjectMeta(filePath: string, source: string, objectName: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: CustomObjectXml;
  try {
    parsed = xmlParser.parse(source) as CustomObjectXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const co = parsed.CustomObject ?? {};

  result.nodes.push({
    label: NodeLabel.SObject,
    name: objectName,
    qualifiedName: objectName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      label: xmlText(co.label) ?? objectName,
      pluralLabel: xmlText(co.pluralLabel) ?? null,
      description: xmlText(co.description) ?? null,
      sharingModel: xmlText(co.sharingModel) ?? null,
      deploymentStatus: xmlText(co.deploymentStatus) ?? null,
      nameFieldType: xmlText(co.nameField?.type) ?? null,
      enableActivities: xmlBool(co.enableActivities) ?? null,
      enableHistory: xmlBool(co.enableHistory) ?? null,
      enableReports: xmlBool(co.enableReports) ?? null,
      enableSearch: xmlBool(co.enableSearch) ?? null,
      isCustom: objectName.endsWith("__c") || objectName.endsWith("__mdt"),
      isCustomMetadataType: objectName.endsWith("__mdt"),
      isPlaceholder: false,
    },
  });

  return result;
}
