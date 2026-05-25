// Visualforce parser. Walks the ANTLR parse tree from @apexdevtools/vf-parser to extract
// element references and `{!...}` expression bindings. Promoted from v1.1 to v0.2 per the
// scope decision; this is a minimal-but-useful extractor — full VF semantic analysis is a
// future polish item.

import { basename } from "node:path";
import {
  CommonTokenStream,
  ElementContext,
  VFLexer,
  VFParser,
} from "@apexdevtools/vf-parser";
import { CaseInsensitiveInputStream } from "@apexdevtools/apex-parser";
import { CharStreams, ParserRuleContext } from "antlr4ts";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type Kind = "vf-page" | "vf-component";

export function parseVisualforce(filePath: string, source: string, kind: Kind): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  const fileName = basename(filePath);
  const apiName = fileName.replace(/\.(page|component)$/, "");
  const label = kind === "vf-page" ? NodeLabel.VisualforcePage : NodeLabel.VisualforceComponent;

  let unit;
  try {
    const lexer = new VFLexer(new CaseInsensitiveInputStream(CharStreams.fromString(source)));
    lexer.removeErrorListeners();
    const tokens = new CommonTokenStream(lexer);
    const parser = new VFParser(tokens);
    parser.removeErrorListeners();
    unit = parser.vfUnit();
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const rootElement = unit.element();
  const rootTagName = elementTagName(rootElement);
  const rootAttributes = collectAttributes(rootElement);

  result.nodes.push({
    label,
    name: apiName,
    qualifiedName: apiName,
    startLine: rootElement.start.line,
    endLine: rootElement.stop?.line ?? rootElement.start.line,
    properties: {
      rootTag: rootTagName,
      controller: rootAttributes["controller"] ?? null,
      extensions: rootAttributes["extensions"] ?? null,
      standardController: rootAttributes["standardController"] ?? null,
      sidebar: rootAttributes["sidebar"] ?? null,
      showHeader: rootAttributes["showHeader"] ?? null,
    },
  });

  if (rootAttributes["controller"] !== undefined) {
    pushVfUsesApex(result, apiName, label, rootAttributes["controller"], rootElement.start.line);
  }
  if (rootAttributes["extensions"] !== undefined) {
    for (const ext of rootAttributes["extensions"].split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
      pushVfUsesApex(result, apiName, label, ext, rootElement.start.line);
    }
  }

  walkElement(rootElement, result, apiName, label);

  return result;
}

function walkElement(
  element: ElementContext,
  result: ParseResult,
  pageQName: string,
  pageLabel: typeof NodeLabel.VisualforcePage | typeof NodeLabel.VisualforceComponent,
): void {
  const tag = elementTagName(element);
  const attrs = collectAttributes(element);
  const line = element.start.line;

  if (tag.startsWith("c:")) {
    const componentName = tag.slice(2);
    result.edges.push({
      edgeType: EdgeType.VfIncludesComponent,
      fromQName: pageQName,
      fromLabel: pageLabel,
      toQName: componentName,
      toLabel: NodeLabel.VisualforceComponent,
      confidence: Confidence.Resolved,
      sourceLine: line,
    });
  }

  if (tag.toLowerCase() === "apex:include" && attrs["pageName"] !== undefined) {
    result.edges.push({
      edgeType: EdgeType.VfIncludesComponent,
      fromQName: pageQName,
      fromLabel: pageLabel,
      toQName: attrs["pageName"],
      toLabel: NodeLabel.VisualforcePage,
      confidence: Confidence.Resolved,
      sourceLine: line,
    });
  }

  for (const val of Object.values(attrs)) {
    if (typeof val !== "string") continue;
    for (const fieldQName of extractFieldReferences(val)) {
      result.edges.push({
        edgeType: EdgeType.VfUsesField,
        fromQName: pageQName,
        fromLabel: pageLabel,
        toQName: fieldQName,
        toLabel: NodeLabel.Field,
        confidence: Confidence.Regex,
        sourceLine: line,
      });
    }
  }

  const content = element.content();
  if (content !== undefined) {
    for (const child of content.element()) {
      walkElement(child, result, pageQName, pageLabel);
    }
  }
}

function elementTagName(element: ElementContext): string {
  const names = element.Name();
  const first = names[0];
  return first?.text ?? "";
}

function collectAttributes(element: ElementContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of element.attribute()) {
    const nameNode = attr.attributeName();
    const name = nameNode.text;
    if (name.length === 0) continue;
    const valueNodes = attr.attributeValues();
    const value = valueNodes.map((v: ParserRuleContext) => v.text).join("");
    const cleaned = value.replace(/^["']|["']$/g, "");
    out[name] = cleaned;
  }
  return out;
}

function pushVfUsesApex(
  result: ParseResult,
  fromQName: string,
  fromLabel: typeof NodeLabel.VisualforcePage | typeof NodeLabel.VisualforceComponent,
  apexClassName: string,
  line: number,
): void {
  result.edges.push({
    edgeType: EdgeType.VfUsesApex,
    fromQName,
    fromLabel,
    toQName: apexClassName,
    toLabel: NodeLabel.ApexClass,
    confidence: Confidence.Resolved,
    sourceLine: line,
  });
}

const FIELD_EXPR = /\{!\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}/g;

function extractFieldReferences(text: string): string[] {
  const out: string[] = [];
  let matched: RegExpExecArray | null;
  FIELD_EXPR.lastIndex = 0;
  while ((matched = FIELD_EXPR.exec(text)) !== null) {
    const ident = matched[1];
    if (ident === undefined) continue;
    if (ident.startsWith("$")) continue;
    out.push(ident);
  }
  return out;
}
