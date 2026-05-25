// Parses email/<folder>/<name>.email-meta.xml into an EmailTemplate node. Also reads the
// associated .email body file (sibling to the meta XML) and scans for `{!Object.Field}`
// merge fields and `{!$Label.X}` label references. Per design §6.10.

import { basename, dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type EmailTemplateXml = {
  EmailTemplate?: {
    name?: string;
    subject?: string;
    style?: string;
    type?: string;
    encodingKey?: string;
    available?: boolean;
    apiVersion?: number;
    description?: string;
    uiType?: string;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: () => false,
});

const FIELD_MERGE = /\{!\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]+)*)\s*\}/g;
const LABEL_MERGE = /\{!\s*\$Label\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

export function parseEmailTemplate(
  filePath: string,
  source: string,
  folder: string,
): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: EmailTemplateXml;
  try {
    parsed = xmlParser.parse(source) as EmailTemplateXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const et = parsed.EmailTemplate ?? {};
  const templateName = basename(filePath).replace(/\.email-meta\.xml$/, "");
  const qualifiedName = `${folder}/${templateName}`;
  const totalLines = source.split("\n").length;

  result.nodes.push({
    label: NodeLabel.EmailTemplate,
    name: templateName,
    qualifiedName,
    startLine: 1,
    endLine: totalLines,
    properties: {
      folder,
      label: et.name ?? templateName,
      subject: et.subject ?? null,
      style: et.style ?? null,
      type: et.type ?? null,
      uiType: et.uiType ?? null,
      apiVersion: et.apiVersion ?? null,
      available: et.available ?? null,
    },
  });

  const bodyPath = join(dirname(filePath), `${templateName}.email`);
  let body = "";
  if (existsSync(bodyPath)) {
    try {
      body = readFileSync(bodyPath, "utf8");
    } catch {
      // body is optional
    }
  }

  const scanText = `${et.subject ?? ""}\n${body}`;

  const seenFields = new Set<string>();
  FIELD_MERGE.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = FIELD_MERGE.exec(scanText)) !== null) {
    const obj = matched[1];
    const rest = matched[2];
    if (obj === undefined || rest === undefined) continue;
    if (obj.startsWith("$")) continue;
    const fieldQName = `${obj}.${rest}`;
    if (seenFields.has(fieldQName)) continue;
    seenFields.add(fieldQName);
    result.edges.push({
      edgeType: EdgeType.EmailReferencesField,
      fromQName: qualifiedName,
      fromLabel: NodeLabel.EmailTemplate,
      toQName: fieldQName,
      toLabel: NodeLabel.Field,
      confidence: Confidence.Regex,
    });
  }

  const seenLabels = new Set<string>();
  LABEL_MERGE.lastIndex = 0;
  while ((matched = LABEL_MERGE.exec(scanText)) !== null) {
    const labelName = matched[1];
    if (labelName === undefined) continue;
    if (seenLabels.has(labelName)) continue;
    seenLabels.add(labelName);
    result.edges.push({
      edgeType: EdgeType.ReferencesLabel,
      fromQName: qualifiedName,
      fromLabel: NodeLabel.EmailTemplate,
      toQName: `c.${labelName}`,
      toLabel: NodeLabel.CustomLabel,
      confidence: Confidence.Regex,
    });
  }

  return result;
}
