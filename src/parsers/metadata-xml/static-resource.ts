// Parses staticresources/<name>.resource-meta.xml into a StaticResource node. The actual
// resource bytes are ignored — Spindle only models the reference, not the content. Per
// design §6.10.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { NodeLabel } from "../../model/node-labels.ts";
import type { ParseResult } from "../apex/types.ts";

type StaticResourceXml = {
  StaticResource?: {
    contentType?: string;
    cacheControl?: string;
    description?: string;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: () => false,
});

export function parseStaticResource(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: StaticResourceXml;
  try {
    parsed = xmlParser.parse(source) as StaticResourceXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const sr = parsed.StaticResource ?? {};
  const apiName = basename(filePath).replace(/\.resource-meta\.xml$/, "");
  const totalLines = source.split("\n").length;

  result.nodes.push({
    label: NodeLabel.StaticResource,
    name: apiName,
    qualifiedName: apiName,
    startLine: 1,
    endLine: totalLines,
    properties: {
      contentType: sr.contentType ?? null,
      cacheControl: sr.cacheControl ?? null,
      description: sr.description ?? null,
    },
  });

  return result;
}
