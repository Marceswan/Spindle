// UI bundle parser: the UIBundle metadata type, which holds a React (or other framework) app
// under uiBundles/<name>/. A bundle gets Salesforce data in two ways, and both are read here:
//
//   - GraphQL documents for the UI API (`uiapi { query { Account { ... } } }`), in a `gql`
//     template, in a plain string, or in a `.graphql` file.
//   - Apex REST paths (`/services/apexrest/...`) in a string or a template.
//
// A value that exists only at run time is not read: a `where` filter that comes from a
// variable, the fields of a mutation input that comes from a variable, or a path that is
// built from parts in more than one statement.

import { readFileSync } from "node:fs";
import { parse as parseScript } from "@babel/parser";

import { Confidence } from "../../model/confidence.ts";
import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import type { DiscoveredFile } from "../../pipeline/discover.ts";
import type { ParsedEdge, ParseResult } from "../apex/types.ts";
import { createXmlParser, xmlText } from "../metadata-xml/xml.ts";
import { parseGraphql, type GqlDocument, type GqlField, type GqlFragment, type GqlSelection, type GqlValue } from "./graphql.ts";

export type UiBundleSource = {
  // Path relative to the bundle directory, with forward slashes.
  path: string;
  absolutePath: string;
  source: string;
};

const META_SUFFIX = ".uibundle-meta.xml";
const CONFIG_FILE = "ui-bundle.json";
const APEX_REST_PREFIX = "/services/apexrest/";
// A source file larger than this is build output or a vendored library.
const MAX_SOURCE_BYTES = 1_000_000;

const xmlParser = createXmlParser();

export function parseUiBundle(file: DiscoveredFile): ParseResult {
  if (file.kind !== "ui-bundle" || file.bundleFiles === undefined || file.bundleName === undefined) {
    return {
      nodes: [],
      edges: [],
      unresolved: [],
      warnings: [{ message: `parseUiBundle: malformed DiscoveredFile (path=${file.relativePath})`, line: 0 }],
    };
  }
  const sources: UiBundleSource[] = [];
  const unread: { message: string; line: number }[] = [];
  for (const bf of file.bundleFiles) {
    try {
      const source = readFileSync(bf.absolutePath, "utf8");
      if (source.length > MAX_SOURCE_BYTES) {
        unread.push({ message: `[${bf.fileName}] Not read: the file is larger than ${MAX_SOURCE_BYTES} bytes`, line: 0 });
        continue;
      }
      sources.push({ path: bf.fileName, absolutePath: bf.absolutePath, source });
    } catch (err) {
      unread.push({ message: `Cannot read ${bf.fileName}: ${(err as Error).message}`, line: 0 });
    }
  }
  const result = extractUiBundle(file.bundleName, sources);
  result.warnings.push(...unread);
  return result;
}

// One GraphQL document and where it is.
type FoundDocument = { doc: GqlDocument; file: UiBundleSource; firstLine: number };
type FoundFragment = { fragment: GqlFragment; file: UiBundleSource; firstLine: number };
// Where a selection is: its file, and the line of the first line of its document.
type Place = { file: UiBundleSource; firstLine: number };

export function extractUiBundle(bundleName: string, files: UiBundleSource[]): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  const meta = files.find((f) => f.path.endsWith(META_SUFFIX));
  const config = files.find((f) => f.path === CONFIG_FILE);
  result.nodes.push({
    label: NodeLabel.UiBundle,
    name: bundleName,
    qualifiedName: bundleName,
    startLine: 1,
    endLine: 1,
    properties: { ...readMeta(meta, result), ...readConfig(config, result) },
  });

  const documents: FoundDocument[] = [];
  const apexPaths: { path: string; file: UiBundleSource; line: number }[] = [];
  for (const file of files) {
    if (file === meta || file === config) continue;
    if (/\.(graphql|gql)$/.test(file.path)) {
      const doc = parseGraphql(file.source);
      if (doc === null) result.warnings.push({ message: `[${file.path}] Not a GraphQL document`, line: 0 });
      else documents.push({ doc, file, firstLine: 1 });
    } else {
      scanScript(file, documents, apexPaths, result);
    }
  }

  // A fragment can be in a different template or file from the operation that uses it.
  const fragments = new Map<string, FoundFragment>();
  for (const { doc, file, firstLine } of documents) {
    for (const fragment of doc.fragments) {
      if (!fragments.has(fragment.name)) fragments.set(fragment.name, { fragment, file, firstLine });
    }
  }

  const emitter = createEmitter(bundleName, result);
  for (const { doc, file, firstLine } of documents) {
    for (const operation of doc.operations) {
      for (const root of operation.selections) {
        if (root.kind === "field" && root.name === "uiapi") {
          readUiapi(root, operation.kind, { file, firstLine }, fragments, emitter);
        }
      }
    }
  }
  for (const { path, file, line } of apexPaths) emitter.apexRest(path, file, line);

  return result;
}

// ---------------------------------------------------------------------------
// Meta file and configuration
// ---------------------------------------------------------------------------

function readMeta(meta: UiBundleSource | undefined, result: ParseResult): Record<string, unknown> {
  if (meta === undefined) return {};
  type MetaXml = { UIBundle?: { masterLabel?: unknown; description?: unknown; isActive?: unknown; version?: unknown } };
  try {
    const bundle = (xmlParser.parse(meta.source) as MetaXml).UIBundle ?? {};
    const version = xmlText(bundle.version);
    return {
      masterLabel: xmlText(bundle.masterLabel) ?? null,
      description: xmlText(bundle.description) ?? null,
      isActive: xmlText(bundle.isActive) === "true",
      version: version === undefined ? null : version,
    };
  } catch (err) {
    result.warnings.push({ message: `[${meta.path}] Failed to parse: ${(err as Error).message}`, line: 0 });
    return {};
  }
}

function readConfig(config: UiBundleSource | undefined, result: ParseResult): Record<string, unknown> {
  if (config === undefined) return {};
  try {
    const parsed = JSON.parse(config.source) as { outputDir?: unknown };
    return typeof parsed.outputDir === "string" ? { outputDir: parsed.outputDir } : {};
  } catch (err) {
    result.warnings.push({ message: `[${config.path}] Failed to parse: ${(err as Error).message}`, line: 0 });
    return {};
  }
}

// ---------------------------------------------------------------------------
// Script files
// ---------------------------------------------------------------------------

type AstNode = { type: string; start: number; end: number; loc?: { start: { line: number } } } & Record<string, unknown>;

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function scanScript(
  file: UiBundleSource,
  documents: FoundDocument[],
  apexPaths: { path: string; file: UiBundleSource; line: number }[],
  result: ParseResult,
): void {
  // A file that has no data access needs no syntax tree.
  if (!file.source.includes("uiapi") && !file.source.includes(APEX_REST_PREFIX) && !/\b(gql|graphql)\s*`/.test(file.source)) {
    return;
  }
  let ast: unknown;
  try {
    // `<T>value` in a .ts file is a type assertion, so JSX is on for the other extensions only.
    const jsx = !/\.[cm]?ts$/.test(file.path);
    const parsed = parseScript(file.source, {
      sourceType: "module",
      errorRecovery: true,
      plugins: jsx ? ["typescript", "jsx"] : ["typescript"],
    });
    ast = parsed;
    // With recovery on, the tree is still usable. The first error is sufficient as a report.
    const first = (parsed.errors as { message?: string; loc?: { line?: number } }[] | undefined)?.[0];
    if (first !== undefined) {
      result.warnings.push({ message: `[${file.path}] Syntax error: ${first.message ?? "unknown"}`, line: first.loc?.line ?? 0 });
    }
  } catch (err) {
    result.warnings.push({ message: `[${file.path}] Cannot parse: ${(err as Error).message}`, line: 0 });
    return;
  }

  const readText = (text: string, line: number, tagged: boolean): void => {
    if (text.startsWith(APEX_REST_PREFIX)) {
      apexPaths.push({ path: text, file, line });
      return;
    }
    // A template with no tag is a document only if it names the UI API.
    if (!tagged && !/\buiapi\b/.test(text)) return;
    const doc = parseGraphql(text);
    if (doc !== null) documents.push({ doc, file, firstLine: line });
    else if (tagged) result.warnings.push({ message: `[${file.path}] Not a GraphQL document`, line });
  };

  const visit = (node: AstNode, tagged: boolean): void => {
    const line = node.loc?.start.line ?? 0;
    if (node.type === "StringLiteral" && typeof node["value"] === "string") {
      readText(node["value"], line, false);
      return;
    }
    if (node.type === "TemplateLiteral") {
      readText(templateText(file.source, node, tagged), line, tagged);
      // The expressions of a template are not followed: `${FRAGMENT}` is read at its own
      // declaration.
      return;
    }
    if (node.type === "TaggedTemplateExpression") {
      const tag = node["tag"];
      const isGql = isAstNode(tag) && tag.type === "Identifier" && (tag["name"] === "gql" || tag["name"] === "graphql");
      if (isAstNode(node["quasi"])) visit(node["quasi"], isGql);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isAstNode(item)) visit(item, false);
      } else if (isAstNode(child)) {
        visit(child, false);
      }
    }
  };
  if (isAstNode(ast)) visit(ast, false);
}

// The text of a template. Each `${...}` becomes blank space with its line breaks kept, so a
// line in the text is the same line in the file. In an Apex REST path, each `${...}` is a
// part of the path that is known only at run time, and it becomes `*`.
function templateText(source: string, node: AstNode, tagged: boolean): string {
  const quasis = (node["quasis"] as AstNode[]).slice().sort((a, b) => a.start - b.start);
  const first = quasis[0];
  const isPath = !tagged && first !== undefined && source.slice(first.start, first.end).startsWith(APEX_REST_PREFIX);
  let text = "";
  for (let i = 0; i < quasis.length; i++) {
    const quasi = quasis[i] as AstNode;
    text += source.slice(quasi.start, quasi.end);
    const next = quasis[i + 1];
    if (next !== undefined) {
      text += isPath ? "*" : source.slice(quasi.end, next.start).replace(/[^\n]/g, " ");
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// GraphQL documents for the UI API
// ---------------------------------------------------------------------------

type Emitter = {
  // `runtime` is true when a part of the operation that can name a field is a variable.
  object(object: string, operation: string, runtime: boolean, place: Place, line: number): void;
  field(objectPath: string[], fieldPath: string, context: string, place: Place, line: number): void;
  apexRest(path: string, file: UiBundleSource, line: number): void;
};

function createEmitter(bundleName: string, result: ParseResult): Emitter {
  const seen = new Set<string>();
  const push = (key: string, edge: Omit<ParsedEdge, "fromQName" | "fromLabel">): void => {
    if (seen.has(key)) return;
    seen.add(key);
    result.edges.push({ ...edge, fromQName: bundleName, fromLabel: NodeLabel.UiBundle });
  };
  return {
    object(object, operation, runtime, place, line) {
      push(`object|${object}|${operation}|${runtime}|${place.file.path}`, {
        edgeType: EdgeType.UiBundleUsesObject,
        toQName: object,
        toLabel: NodeLabel.SObject,
        confidence: Confidence.Resolved,
        sourceLine: place.firstLine + line - 1,
        properties: { sourceFile: place.file.absolutePath, operation, runtime },
      });
    },
    field(objectPath, fieldPath, context, place, line) {
      push(`field|${objectPath.join(">")}|${fieldPath}|${place.file.path}`, {
        edgeType: EdgeType.UiBundleUsesField,
        toQName: `${objectPath.join(".")}.${fieldPath}`,
        toLabel: NodeLabel.Field,
        confidence: Confidence.Resolved,
        sourceLine: place.firstLine + line - 1,
        // A GraphQL path has the same form as a SOQL path: the root object, then child
        // relationship names, then parent relationship names before the field. Pass 2
        // resolves both with the same relationship metadata, so the property names are shared.
        properties: { sourceFile: place.file.absolutePath, context, soqlObjectPath: objectPath, soqlFieldPath: fieldPath },
      });
    },
    apexRest(path, file, line) {
      // `/services/apexrest/auth/login?x=1` -> `/auth/login`
      const resource = `/${path.slice(APEX_REST_PREFIX.length).split(/[?#]/)[0] ?? ""}`.replace(/\/+$/, "");
      if (resource === "") return;
      push(`apex|${resource}|${file.path}`, {
        edgeType: EdgeType.UiBundleUsesApex,
        toQName: `apexrest:${resource}`,
        toLabel: NodeLabel.ApexClass,
        // The class is found by its @RestResource urlMapping, not by its name.
        confidence: Confidence.Heuristic,
        sourceLine: line,
        properties: { sourceFile: file.absolutePath, apexRestPath: resource },
      });
    },
  };
}

const MUTATION_NAME = /^(.+)(Create|Update|Delete)$/;

function readUiapi(
  uiapi: GqlField,
  operationKind: string,
  place: Place,
  fragments: Map<string, FoundFragment>,
  emitter: Emitter,
): void {
  const ctx: Walk = { fragments, emitter, active: new Set() };
  for (const child of uiapi.selections) {
    if (child.kind !== "field") continue;
    if (operationKind === "mutation") {
      const match = MUTATION_NAME.exec(child.name);
      if (match === null) continue;
      const object = match[1] as string;
      const operation = (match[2] as string).toLowerCase();
      const input = child.args["input"];
      const record = input?.kind === "object" ? input.fields[object] : undefined;
      // A delete names no field. A create or an update does, and a variable hides them.
      emitter.object(object, operation, operation !== "delete" && record?.kind !== "object", place, child.line);
      if (record?.kind === "object") {
        for (const fieldName of Object.keys(record.fields)) emitter.field([object], fieldName, "input", place, child.line);
      }
      for (const sub of child.selections) {
        if (sub.kind === "field" && sub.name === "Record") readRecord(sub.selections, [object], "", place, ctx);
      }
    } else if (child.name === "query" || child.name === "aggregate") {
      for (const entity of child.selections) {
        if (entity.kind === "field") readEntity(entity, [entity.name], child.name, place, ctx);
      }
    } else if (child.name === "objectInfos") {
      const names = child.args["apiNames"];
      if (names?.kind === "list") {
        for (const item of names.items) {
          if (item.kind === "scalar" && typeof item.value === "string") emitter.object(item.value, "describe", false, place, child.line);
        }
      }
    } else if (child.name === "relatedListByName") {
      const parent = child.args["parentApiName"];
      if (parent?.kind === "scalar" && typeof parent.value === "string") emitter.object(parent.value, "describe", false, place, child.line);
    }
  }
}

const FILTER_ARGUMENTS = [["where", "filter"], ["orderBy", "orderBy"], ["groupBy", "groupBy"]] as const;

type Walk = { fragments: Map<string, FoundFragment>; emitter: Emitter; active: Set<string> };

// `Account(first: 10, where: {...}) { edges { node { ... } } }`, at the root or as a child
// relationship.
function readEntity(entity: GqlField, objectPath: string[], operation: string, place: Place, ctx: Walk): void {
  if (objectPath.length === 1) {
    const runtime = FILTER_ARGUMENTS.some(([arg]) => entity.args[arg]?.kind === "variable");
    ctx.emitter.object(objectPath[0] as string, operation, runtime, place, entity.line);
  }
  for (const [arg, context] of FILTER_ARGUMENTS) {
    const value = entity.args[arg];
    if (value !== undefined) readFilter(value, objectPath, "", context, place, entity.line, ctx);
  }
  for (const edges of entity.selections) {
    if (edges.kind !== "field" || edges.name !== "edges") continue;
    for (const node of edges.selections) {
      if (node.kind === "field" && node.name === "node") readRecord(node.selections, objectPath, "", place, ctx);
    }
  }
}

// The names below a field that is a value, not a relationship: `Name { value displayValue }`,
// or an aggregate such as `Amount { sum { value } }`.
const VALUE_NAMES = new Set([
  "value", "displayValue", "label", "format", "count", "countDistinct", "min", "max", "avg", "sum", "grouping",
]);

function readRecord(selections: GqlSelection[], objectPath: string[], prefix: string, place: Place, ctx: Walk): void {
  for (const sel of selections) {
    if (sel.kind === "spread") {
      const found = ctx.fragments.get(sel.name);
      if (found === undefined || ctx.active.has(sel.name)) continue;
      ctx.active.add(sel.name);
      // The type condition names the object, so no relationship metadata is necessary.
      readRecord(found.fragment.selections, [found.fragment.typeCondition], "", { file: found.file, firstLine: found.firstLine }, ctx);
      ctx.active.delete(sel.name);
    } else if (sel.kind === "inline") {
      if (sel.typeCondition === null) readRecord(sel.selections, objectPath, prefix, place, ctx);
      else readRecord(sel.selections, [sel.typeCondition], "", place, ctx);
    } else if (sel.name === "aggregate" && sel.selections.length > 0) {
      readRecord(sel.selections, objectPath, prefix, place, ctx);
    } else if (sel.selections.length === 0) {
      if (sel.name !== "Id" && sel.name !== "__typename") ctx.emitter.field(objectPath, prefix + sel.name, "select", place, sel.line);
    } else {
      const names = sel.selections.map((s) => (s.kind === "field" ? s.name : null));
      if (names.includes("edges")) {
        // A child relationship. Pass 2 can resolve one only from the root object.
        if (prefix === "") readEntity(sel, [...objectPath, sel.name], "query", place, ctx);
      } else if (names.every((n) => n !== null && VALUE_NAMES.has(n))) {
        ctx.emitter.field(objectPath, prefix + sel.name, "select", place, sel.line);
      } else {
        readParent(sel.name, objectPath, prefix, "select", place, sel.line, ctx);
        readRecord(sel.selections, objectPath, `${prefix}${sel.name}.`, place, ctx);
      }
    }
  }
}

// A custom parent relationship `Parent__r` exists because of the lookup field `Parent__c`.
function readParent(relation: string, objectPath: string[], prefix: string, context: string, place: Place, line: number, ctx: Walk): void {
  if (relation.endsWith("__r")) ctx.emitter.field(objectPath, `${prefix}${relation.slice(0, -3)}__c`, context, place, line);
}

const FILTER_OPERATORS = new Set([
  "eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "nin", "inq", "ninq", "includes", "excludes",
  "order", "nulls", "group", "function",
]);

// `where: { A: { eq: 1 }, OR: [{ B: { like: "x" } }], Parent__r: { C: { ne: 2 } } }`. The same
// form holds for `orderBy` and `groupBy`.
function readFilter(value: GqlValue, objectPath: string[], prefix: string, context: string, place: Place, line: number, ctx: Walk): void {
  if (value.kind === "list") {
    for (const item of value.items) readFilter(item, objectPath, prefix, context, place, line, ctx);
    return;
  }
  if (value.kind !== "object") return;
  for (const [key, child] of Object.entries(value.fields)) {
    if (key === "AND" || key === "OR" || key === "NOT") {
      readFilter(child, objectPath, prefix, context, place, line, ctx);
    } else if (child.kind === "object" && !Object.keys(child.fields).every((k) => FILTER_OPERATORS.has(k))) {
      readParent(key, objectPath, prefix, context, place, line, ctx);
      readFilter(child, objectPath, `${prefix}${key}.`, context, place, line, ctx);
    } else {
      ctx.emitter.field(objectPath, prefix + key, context, place, line);
    }
  }
}
