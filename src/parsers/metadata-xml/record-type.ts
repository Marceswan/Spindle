// Parses record type XML into a RecordType node. v0.2 records the structural node; field-level
// picklist availability per record type is captured as a property but not yet exposed as edges
// (that lands when we model picklist values as first-class nodes, post-v1).

import { basename } from "node:path";

import { NodeLabel } from "../../model/node-labels.ts";
import type { ParseResult } from "../apex/types.ts";
import { createXmlParser, xmlBool, xmlText } from "./xml.ts";

type RecordTypeXml = {
  RecordType?: {
    fullName?: string;
    label?: string;
    active?: string;
    description?: string;
    businessProcess?: string;
    picklistValues?: unknown;
  };
};

const xmlParser = createXmlParser();

export function parseRecordTypeMeta(
  filePath: string,
  source: string,
  parentSObject: string,
): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: RecordTypeXml;
  try {
    parsed = xmlParser.parse(source) as RecordTypeXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const rt = parsed.RecordType ?? {};
  const rtName = xmlText(rt.fullName) ?? basename(filePath, ".recordType-meta.xml");
  const qualifiedName = `${parentSObject}.${rtName}`;

  result.nodes.push({
    label: NodeLabel.RecordType,
    name: rtName,
    qualifiedName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      parentSObject,
      label: xmlText(rt.label) ?? rtName,
      active: xmlBool(rt.active) ?? true,
      description: xmlText(rt.description) ?? null,
      businessProcess: xmlText(rt.businessProcess) ?? null,
    },
  });

  return result;
}
