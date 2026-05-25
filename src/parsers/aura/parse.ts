// Aura bundle parser. Built from scratch per the LSP spike recommendation.
// fast-xml-parser handles .cmp/.app/.evt markup; a regex pass handles
// `component.get("c.X")` in controller JS. See design §6.3.

import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { DiscoveredFile } from "../../pipeline/discover.ts";
import type { ParseResult } from "../apex/types.ts";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true,
  isArray: () => false,
  preserveOrder: true,
});

type XmlNode = {
  [tag: string]: unknown;
  ":@"?: Record<string, string>;
};

const COMPONENT_GET_CONTROLLER = /\.get\s*\(\s*["']c\.([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g;

export function parseAuraBundle(file: DiscoveredFile): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  if (file.kind !== "aura-bundle" || file.bundleFiles === undefined || file.bundleName === undefined) {
    result.warnings.push({
      message: `parseAuraBundle: malformed DiscoveredFile (path=${file.relativePath})`,
      line: 0,
    });
    return result;
  }

  const bundleName = file.bundleName;
  const bundleQName = bundleName;
  let cmpFilePath: string | null = null;

  result.nodes.push({
    label: NodeLabel.AuraBundle,
    name: bundleName,
    qualifiedName: bundleQName,
    startLine: 1,
    endLine: 1,
    properties: {
      fileNames: file.bundleFiles.map((f) => f.fileName),
    },
  });

  let boundController: string | null = null;
  let controllerQName: string | null = null;
  let helperQName: string | null = null;

  // Track edges already emitted so we don't double-count `<aura:dependency>` + `<c:foo>` tag.
  const emittedIncludeKeys = new Set<string>();

  // Process markup files first so `boundController` is set before any controller.js regex pass.
  const order = ["cmp", "app", "evt", "intf", "design", "controller", "helper"];
  const sortedFiles = [...file.bundleFiles].sort((a, b) => {
    const ai = order.findIndex((suffix) => a.fileName.toLowerCase().endsWith(`.${suffix}`) || a.fileName.toLowerCase().endsWith(`${suffix}.js`));
    const bi = order.findIndex((suffix) => b.fileName.toLowerCase().endsWith(`.${suffix}`) || b.fileName.toLowerCase().endsWith(`${suffix}.js`));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const bf of sortedFiles) {
    const lowerName = bf.fileName.toLowerCase();

    let source: string;
    try {
      source = readFileSync(bf.absolutePath, "utf8");
    } catch (err) {
      result.warnings.push({
        message: `Cannot read ${bf.fileName}: ${(err as Error).message}`,
        line: 0,
      });
      continue;
    }

    if (lowerName.endsWith(".cmp") || lowerName.endsWith(".app") || lowerName.endsWith(".evt") || lowerName.endsWith(".design") || lowerName.endsWith(".intf")) {
      cmpFilePath = bf.absolutePath;
      const compRoot = lowerName.endsWith(".cmp")
        ? `${bundleQName}`
        : `${bundleQName}.${bf.fileName}`;

      result.nodes.push({
        label: NodeLabel.AuraComponent,
        name: bf.fileName,
        qualifiedName: compRoot,
        startLine: 1,
        endLine: 1,
        properties: { bundle: bundleQName, fileName: bf.fileName },
      });

      let parsed: XmlNode[];
      try {
        parsed = xmlParser.parse(source) as XmlNode[];
      } catch (err) {
        result.warnings.push({
          message: `Failed to parse ${bf.fileName}: ${(err as Error).message}`,
          line: 0,
        });
        continue;
      }
      walkAuraXml(parsed, bundleQName, result, emittedIncludeKeys);

      const root = findFirstNamedTag(parsed, ["aura:component", "aura:application", "aura:event", "aura:interface"]);
      if (root !== null) {
        const attrs = root[":@"] ?? {};
        const controller = attrs["@_controller"];
        if (controller !== undefined && controller.length > 0) {
          boundController = controller.replace(/^apex:\/\/?/, "");
        }
      }
    } else if (lowerName.endsWith("controller.js")) {
      controllerQName = `${bundleQName}.${bf.fileName}`;
      result.nodes.push({
        label: NodeLabel.AuraController,
        name: bf.fileName,
        qualifiedName: controllerQName,
        startLine: 1,
        endLine: 1,
        properties: { bundle: bundleQName, fileName: bf.fileName },
      });

      COMPONENT_GET_CONTROLLER.lastIndex = 0;
      let matched: RegExpExecArray | null;
      while ((matched = COMPONENT_GET_CONTROLLER.exec(source)) !== null) {
        const methodName = matched[1];
        if (methodName === undefined) continue;
        const targetQName = boundController !== null ? `${boundController}.${methodName}` : methodName;
        result.edges.push({
          edgeType: EdgeType.AuraUsesApex,
          fromQName: bundleQName,
          fromLabel: NodeLabel.AuraBundle,
          toQName: targetQName,
          toLabel: NodeLabel.ApexMethod,
          confidence: boundController !== null ? Confidence.Heuristic : Confidence.Ambiguous,
          properties: { controllerJs: bf.fileName, methodName },
        });
      }
    } else if (lowerName.endsWith("helper.js")) {
      helperQName = `${bundleQName}.${bf.fileName}`;
      result.nodes.push({
        label: NodeLabel.AuraHelper,
        name: bf.fileName,
        qualifiedName: helperQName,
        startLine: 1,
        endLine: 1,
        properties: { bundle: bundleQName, fileName: bf.fileName },
      });
    }
  }

  if (boundController !== null && controllerQName === null) {
    result.edges.push({
      edgeType: EdgeType.AuraUsesApex,
      fromQName: bundleQName,
      fromLabel: NodeLabel.AuraBundle,
      toQName: boundController,
      toLabel: NodeLabel.ApexClass,
      confidence: Confidence.Resolved,
      properties: { source: cmpFilePath ?? "", scopedKind: "cmp-controller-attribute" },
    });
  }

  return result;
}

function walkAuraXml(
  node: XmlNode[] | XmlNode,
  fromQName: string,
  result: ParseResult,
  emittedKeys: Set<string>,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walkAuraXml(child, fromQName, result, emittedKeys);
    return;
  }

  // fast-xml-parser preserve-order shape: each object has exactly one tag key plus an
  // optional `:@` sibling holding attributes.
  let tagKey: string | null = null;
  let tagChildren: unknown = null;
  for (const [k, v] of Object.entries(node)) {
    if (k === ":@") continue;
    if (k === "#text") continue;
    tagKey = k;
    tagChildren = v;
    break;
  }
  if (tagKey === null) return;
  const attrs = node[":@"] ?? {};

  // Custom child component: <c:Foo .../>. A c:foo tag in Aura can refer to either an
  // AuraBundle or an LwcBundle. We emit a candidate edge to each so pass2 keeps whichever
  // target actually exists. Dedupe by component name so <aura:dependency> + <c:foo> don't
  // double-count.
  if (tagKey.startsWith("c:")) {
    const componentName = tagKey.slice(2);
    emitIncludeBoth(result, fromQName, componentName, emittedKeys, Confidence.Resolved);
  }

  // <aura:dependency resource="markup://c:Foo"/>
  if (tagKey === "aura:dependency") {
    const resource = attrs["@_resource"];
    if (resource !== undefined) {
      const componentName = resource.replace(/^markup:\/\//, "").replace(/^c:/, "");
      emitIncludeBoth(result, fromQName, componentName, emittedKeys, Confidence.Heuristic);
    }
  }

  if (Array.isArray(tagChildren)) {
    walkAuraXml(tagChildren as XmlNode[], fromQName, result, emittedKeys);
  }
}

function emitIncludeBoth(
  result: ParseResult,
  fromQName: string,
  componentName: string,
  emittedKeys: Set<string>,
  confidence: number,
): void {
  // AuraBundle candidate.
  const auraKey = `aura:${componentName}`;
  if (!emittedKeys.has(auraKey)) {
    emittedKeys.add(auraKey);
    result.edges.push({
      edgeType: EdgeType.AuraIncludesComponent,
      fromQName,
      fromLabel: NodeLabel.AuraBundle,
      toQName: componentName,
      toLabel: NodeLabel.AuraBundle,
      confidence,
    });
  }
  // LwcBundle candidate (LWCs live under the c/ namespace).
  const lwcKey = `lwc:${componentName}`;
  if (!emittedKeys.has(lwcKey)) {
    emittedKeys.add(lwcKey);
    result.edges.push({
      edgeType: EdgeType.AuraIncludesComponent,
      fromQName,
      fromLabel: NodeLabel.AuraBundle,
      toQName: `c/${componentName}`,
      toLabel: NodeLabel.LwcBundle,
      confidence,
    });
  }
}

function findFirstNamedTag(tree: XmlNode[], tags: string[]): XmlNode | null {
  for (const n of tree) {
    for (const [key] of Object.entries(n)) {
      if (key === ":@") continue;
      if (tags.includes(key)) return n;
    }
  }
  return null;
}
