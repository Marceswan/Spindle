// Parses <Name>.object-meta.xml into an SObject node. See design §6.5.
// Standard objects (Account, Contact, ...) typically have a near-empty file; we still emit
// the node so SOQL/DML edges from Apex resolve to a real node rather than the parser-emitted
// placeholder.

import { XMLParser } from "fast-xml-parser";

import { NodeLabel } from "../../model/node-labels.ts";
import type { ParseResult } from "../apex/types.ts";

type CustomObjectXml = {
  CustomObject?: {
    label?: string;
    pluralLabel?: string;
    description?: string;
    sharingModel?: string;
    deploymentStatus?: string;
    nameField?: { type?: string; label?: string };
    enableActivities?: boolean;
    enableHistory?: boolean;
    enableReports?: boolean;
    enableSearch?: boolean;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: () => false,
});

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
      label: co.label ?? objectName,
      pluralLabel: co.pluralLabel ?? null,
      description: co.description ?? null,
      sharingModel: co.sharingModel ?? null,
      deploymentStatus: co.deploymentStatus ?? null,
      nameFieldType: co.nameField?.type ?? null,
      enableActivities: co.enableActivities ?? null,
      enableHistory: co.enableHistory ?? null,
      enableReports: co.enableReports ?? null,
      enableSearch: co.enableSearch ?? null,
      isCustom: objectName.endsWith("__c") || objectName.endsWith("__mdt"),
      isCustomMetadataType: objectName.endsWith("__mdt"),
      isPlaceholder: false,
    },
  });

  return result;
}
