// Parses permission-set-group XML. Emits a PermissionSetGroup node + INCLUDES_PERMSET edges
// to each member PermissionSet. Per design §6.8.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type PermSetGroupXml = {
  PermissionSetGroup?: {
    description?: string;
    status?: string;
    permissionSets?: string | string[];
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => name === "permissionSets",
});

export function parsePermissionSetGroup(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: PermSetGroupXml;
  try {
    parsed = xmlParser.parse(source) as PermSetGroupXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const group = parsed.PermissionSetGroup;
  if (group === undefined) return result;

  const groupName = basename(filePath).replace(/\.permissionsetgroup-meta\.xml$/, "");

  result.nodes.push({
    label: NodeLabel.PermissionSetGroup,
    name: groupName,
    qualifiedName: groupName,
    startLine: 1,
    endLine: source.split("\n").length,
    properties: {
      description: group.description ?? null,
      status: group.status ?? null,
    },
  });

  const members = group.permissionSets === undefined
    ? []
    : Array.isArray(group.permissionSets)
      ? group.permissionSets
      : [group.permissionSets];

  for (const memberName of members) {
    if (typeof memberName !== "string" || memberName.length === 0) continue;
    result.edges.push({
      edgeType: EdgeType.IncludesPermset,
      fromQName: groupName,
      fromLabel: NodeLabel.PermissionSetGroup,
      toQName: memberName,
      toLabel: NodeLabel.PermissionSet,
      confidence: Confidence.Resolved,
    });
  }

  return result;
}
