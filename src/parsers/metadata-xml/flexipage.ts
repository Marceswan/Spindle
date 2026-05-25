// Parses flexipages/<name>.flexipage-meta.xml into a FlexiPage node plus
// FLEXIPAGE_INCLUDES_COMPONENT edges (to LwcBundle / AuraBundle) and
// FLEXIPAGE_REFERENCES_FIELD edges from componentInstanceProperties and fieldInstances.
// Per design §6.6.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type ComponentInstanceProperty = { name?: string; value?: string };
type ComponentInstance = {
  componentName?: string;
  componentInstanceProperties?: ComponentInstanceProperty | ComponentInstanceProperty[];
};
type FieldInstance = { fieldItem?: string; uiBehavior?: string };
type ItemInstance = { componentInstance?: ComponentInstance; fieldInstance?: FieldInstance };
type FlexiPageRegion = {
  name?: string;
  type?: string;
  itemInstances?: ItemInstance | ItemInstance[];
};

type FlexiPageXml = {
  FlexiPage?: {
    masterLabel?: string;
    type?: string;
    sobjectType?: string;
    flexiPageRegions?: FlexiPageRegion | FlexiPageRegion[];
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) =>
    name === "flexiPageRegions" ||
    name === "itemInstances" ||
    name === "componentInstanceProperties",
});

export function parseFlexiPage(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: FlexiPageXml;
  try {
    parsed = xmlParser.parse(source) as FlexiPageXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const flexi = parsed.FlexiPage;
  if (flexi === undefined) return result;

  const flexiName = basename(filePath).replace(/\.flexipage-meta\.xml$/, "");
  const sobjectType = flexi.sobjectType ?? null;
  const totalLines = source.split("\n").length;

  result.nodes.push({
    label: NodeLabel.FlexiPage,
    name: flexiName,
    qualifiedName: flexiName,
    startLine: 1,
    endLine: totalLines,
    properties: {
      masterLabel: flexi.masterLabel ?? flexiName,
      type: flexi.type ?? null,
      sobjectType,
    },
  });

  for (const region of asArray(flexi.flexiPageRegions)) {
    for (const item of asArray(region.itemInstances)) {
      handleComponentInstance(result, flexiName, item.componentInstance);
      handleFieldInstance(result, flexiName, item.fieldInstance, sobjectType);
    }
  }

  return result;
}

function handleComponentInstance(
  result: ParseResult,
  flexiName: string,
  ci: ComponentInstance | undefined,
): void {
  if (ci === undefined) return;
  const componentName = ci.componentName;
  if (componentName === undefined) return;
  if (!componentName.startsWith("c:")) return;

  const bareName = componentName.slice(2);
  result.edges.push({
    edgeType: EdgeType.FlexipageIncludesComponent,
    fromQName: flexiName,
    fromLabel: NodeLabel.FlexiPage,
    toQName: `c/${bareName}`,
    toLabel: NodeLabel.LwcBundle,
    confidence: Confidence.Heuristic,
  });
  result.edges.push({
    edgeType: EdgeType.FlexipageIncludesComponent,
    fromQName: flexiName,
    fromLabel: NodeLabel.FlexiPage,
    toQName: bareName,
    toLabel: NodeLabel.AuraBundle,
    confidence: Confidence.Heuristic,
  });

  for (const prop of asArray(ci.componentInstanceProperties)) {
    if (prop.value === undefined) continue;
    extractFieldReferences(prop.value).forEach((fieldQName) => {
      result.edges.push({
        edgeType: EdgeType.FlexipageReferencesField,
        fromQName: flexiName,
        fromLabel: NodeLabel.FlexiPage,
        toQName: fieldQName,
        toLabel: NodeLabel.Field,
        confidence: Confidence.Regex,
        properties: { propertyName: prop.name ?? null, raw: prop.value },
      });
    });
  }
}

function handleFieldInstance(
  result: ParseResult,
  flexiName: string,
  fi: FieldInstance | undefined,
  sobjectType: string | null,
): void {
  if (fi === undefined || fi.fieldItem === undefined) return;
  const raw = fi.fieldItem;
  const fieldQName = raw.startsWith("Record.")
    ? sobjectType !== null
      ? `${sobjectType}.${raw.slice("Record.".length)}`
      : raw.slice("Record.".length)
    : raw;

  result.edges.push({
    edgeType: EdgeType.FlexipageReferencesField,
    fromQName: flexiName,
    fromLabel: NodeLabel.FlexiPage,
    toQName: fieldQName,
    toLabel: NodeLabel.Field,
    confidence: Confidence.Resolved,
    properties: { raw, uiBehavior: fi.uiBehavior ?? null },
  });
}

const FIELD_REF_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]+)(?:\b|\W)/g;

function extractFieldReferences(text: string): string[] {
  const out = new Set<string>();
  FIELD_REF_PATTERN.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = FIELD_REF_PATTERN.exec(text)) !== null) {
    const obj = matched[1];
    const field = matched[2];
    if (obj === undefined || field === undefined) continue;
    if (obj.startsWith("$")) continue;
    if (obj === "Record") continue;
    out.add(`${obj}.${field}`);
  }
  return [...out];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
