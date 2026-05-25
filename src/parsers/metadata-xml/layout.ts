// Parses layouts/<name>.layout-meta.xml into a Layout node plus LAYOUT_INCLUDES_FIELD edges
// from layoutSections -> layoutColumns -> layoutItems with <field>. Per design §6.6.
//
// The layout file's basename encodes the parent SObject via the convention
// "<SObject>-<Label>" (e.g. "Customer__c-Customer Layout"). We split on the first "-" to
// derive the parent so we can emit fully-qualified field qnames.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type LayoutItem = {
  field?: string;
  behavior?: string;
  emptySpace?: boolean;
  customLink?: string;
};

type LayoutColumn = {
  layoutItems?: LayoutItem | LayoutItem[];
};

type LayoutSection = {
  label?: string;
  style?: string;
  layoutColumns?: LayoutColumn | LayoutColumn[];
};

type LayoutXml = {
  Layout?: {
    layoutSections?: LayoutSection | LayoutSection[];
    relatedLists?: unknown;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) =>
    name === "layoutSections" ||
    name === "layoutColumns" ||
    name === "layoutItems",
});

export function parseLayout(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: LayoutXml;
  try {
    parsed = xmlParser.parse(source) as LayoutXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const layout = parsed.Layout;
  if (layout === undefined) return result;

  const layoutFileName = basename(filePath).replace(/\.layout-meta\.xml$/, "");
  const parentSObject = layoutFileName.includes("-")
    ? layoutFileName.slice(0, layoutFileName.indexOf("-"))
    : null;

  const totalLines = source.split("\n").length;

  result.nodes.push({
    label: NodeLabel.Layout,
    name: layoutFileName,
    qualifiedName: layoutFileName,
    startLine: 1,
    endLine: totalLines,
    properties: {
      parentSObject,
    },
  });

  for (const section of asArray(layout.layoutSections)) {
    for (const column of asArray(section.layoutColumns)) {
      for (const item of asArray(column.layoutItems)) {
        if (item.field === undefined) continue;
        if (item.emptySpace === true) continue;
        const fieldName = item.field;
        const fieldQName = parentSObject !== null
          ? `${parentSObject}.${fieldName}`
          : fieldName;
        result.edges.push({
          edgeType: EdgeType.LayoutIncludesField,
          fromQName: layoutFileName,
          fromLabel: NodeLabel.Layout,
          toQName: fieldQName,
          toLabel: NodeLabel.Field,
          confidence: Confidence.Resolved,
          properties: { behavior: item.behavior ?? null },
        });
      }
    }
  }

  return result;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
