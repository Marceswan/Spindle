// AST walker for a single TS/TSX/JS/JSX file. Pure function: takes source + qualified-name
// scheme info, returns the per-file extracted nodes/edges/imports/exports/calls/renders.
// The walker does NOT do type inference or scope resolution — pass2 + the parse driver
// resolve cross-file references by qname lookup.
//
// Babel AST is dynamically typed; we annotate the few shapes we touch with local interfaces
// and otherwise treat nodes as `any`. The minor type loosening is bounded to this file.

import { parse } from "@babel/parser";
import type { File } from "@babel/types";

export type ImportRecord = {
  source: string;
  // Each binding the file pulls in. `localName` is what's in scope after the import;
  // `importedName` is what the source exports (matches source's exported identifier, or
  // "default" / "*" for default / namespace forms).
  bindings: { localName: string; importedName: string }[];
  line: number;
};

export type ExportDecl = {
  name: string;       // identifier as written in source ("App", "default", etc.)
  kind: "function" | "class" | "default-function" | "default-class" | "variable" | "default-anon";
  isComponent: boolean; // function/class returns JSX or extends React.Component
  isHook: boolean;      // name matches /^use[A-Z]/
  extendsName: string | null; // for class declarations, the parent class identifier text
  implementsNames: string[]; // v0.7: TS `class Foo implements Bar, Baz` identifier list
  startLine: number;
  endLine: number;
};

export type CallSite = {
  fromOwner: string;   // owning export name (or "<module>") for top-level calls
  calleeName: string;  // simple identifier; for `Foo.bar()` only `bar` is captured
  receiverName: string | null;
  // Full receiver identifier chain for `Foo.bar.baz()` style calls. The last entry is the
  // method name (== calleeName); the head is the root identifier through which we resolve.
  // For a simple `bar()` call this is []. For `Foo.bar()` it is ["Foo", "bar"].
  // For `Foo.bar.baz()` it is ["Foo", "bar", "baz"].
  receiverChain: string[];
  line: number;
};

// v0.7: ambient TypeScript declarations from .d.ts and inline type-only constructs.
// These are surfaced separately so callers can decide whether to emit nodes (we do for
// .d.ts files; inline `interface Foo {}` and `type Bar = ...` also create nodes).
export type TypeDecl = {
  name: string;
  kind: "interface" | "type-alias" | "ambient-function" | "ambient-module";
  // For interfaces: any names referenced as `extends X, Y, Z`. v0.7 stores the identifier
  // text only and resolves them through the local-name table later.
  extendsNames: string[];
  startLine: number;
  endLine: number;
};

// v0.7: gql tagged template literal capture. `gql\`query { x }\`` calls in the file body.
// The raw operation text is preserved for the GraphQL parser to consume.
export type GqlTemplate = {
  fromOwner: string;
  rawText: string;
  line: number;
};

export type JsxUsage = {
  fromOwner: string;
  componentName: string; // PascalCase JSX element name; lowercase (intrinsic) elements skipped
  line: number;
};

export type WalkResult = {
  imports: ImportRecord[];
  exports: ExportDecl[];
  calls: CallSite[];
  renders: JsxUsage[];
  typeDecls: TypeDecl[];
  gqlTemplates: GqlTemplate[];
  // True if this is a .d.ts file. The TsModule emitted for it should be marked ambient and
  // we skip emitting TsFunction/TsClass nodes for declarations that have no runtime presence.
  isDts: boolean;
  warnings: { message: string; line: number }[];
};

export function walkSource(source: string, filePath: string): WalkResult {
  const isDts = filePath.toLowerCase().endsWith(".d.ts");
  const result: WalkResult = {
    imports: [],
    exports: [],
    calls: [],
    renders: [],
    typeDecls: [],
    gqlTemplates: [],
    isDts,
    warnings: [],
  };

  let ast: File;
  try {
    ast = parse(source, {
      sourceType: "module",
      sourceFilename: filePath,
      allowReturnOutsideFunction: false,
      allowImportExportEverywhere: false,
      errorRecovery: true,
      plugins: pluginsForFile(filePath),
    });
  } catch (err) {
    result.warnings.push({ message: `parse failed: ${(err as Error).message}`, line: 0 });
    return result;
  }

  // Top-level walk. We intentionally do NOT recurse into nested functions for export
  // detection — uiBundles do not nest exports inside other functions in practice.
  for (const node of ast.program.body) {
    extractTopLevel(node, result);
  }

  // For each top-level function/class declaration, walk its body to find call/render sites.
  for (const node of ast.program.body) {
    walkExportBody(node, result);
  }

  // v0.7: also scan top-level VariableDeclaration initializers for gql tagged templates.
  // The export-body walker above only enters function/class scopes; `export const Q = gql\`...\``
  // lives directly in module scope and would be missed.
  for (const node of ast.program.body) {
    scanTopLevelForGql(node, "<module>", result);
  }

  return result;
}

function scanTopLevelForGql(node: any, owner: string, out: WalkResult): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  // Unwrap exports.
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    if (node.declaration !== null && node.declaration !== undefined) {
      scanTopLevelForGql(node.declaration, owner, out);
    }
    return;
  }
  // Walk variable declarators for tagged template initializers.
  if (node.type === "VariableDeclaration") {
    for (const d of node.declarations ?? []) {
      const declOwner = typeof d.id?.name === "string" ? d.id.name : owner;
      walkNodeForGqlTemplates(d.init, declOwner, out);
    }
    return;
  }
  // Ignore function/class declarations here — walkExportBody already handles their bodies.
}

function walkNodeForGqlTemplates(node: any, owner: string, out: WalkResult): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkNodeForGqlTemplates(child, owner, out);
    return;
  }
  if (node.type === "TaggedTemplateExpression" && isGqlTag(node.tag)) {
    const raw = extractTemplateRawText(node.quasi);
    if (raw !== null) {
      out.gqlTemplates.push({
        fromOwner: owner,
        rawText: raw,
        line: node.loc?.start.line ?? 0,
      });
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const v = node[key];
    if (v !== null && typeof v === "object") walkNodeForGqlTemplates(v, owner, out);
  }
}

function pluginsForFile(filePath: string): ("typescript" | "jsx")[] {
  const lower = filePath.toLowerCase();
  const tsxOrJsx = lower.endsWith(".tsx") || lower.endsWith(".jsx");
  const ts = lower.endsWith(".ts") || lower.endsWith(".tsx");
  const plugins: ("typescript" | "jsx")[] = [];
  if (ts) plugins.push("typescript");
  if (tsxOrJsx) plugins.push("jsx");
  // For plain .js / .mjs we still allow jsx so JSX-in-JS works (rare but cheap).
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    plugins.push("jsx");
  }
  return plugins;
}

// --- top-level extraction ---

function extractTopLevel(node: any, out: WalkResult): void {
  switch (node.type) {
    case "ImportDeclaration":
      out.imports.push(extractImport(node));
      return;

    case "ExportNamedDeclaration":
      if (node.declaration === null || node.declaration === undefined) {
        // re-export form: `export { foo } from "./bar"` — record as an import for the
        // graph's purposes (we want the TS_IMPORTS edge even for re-exports).
        if (node.source !== null && node.source !== undefined) {
          const bindings: { localName: string; importedName: string }[] = [];
          for (const spec of node.specifiers ?? []) {
            const imported = spec.exported?.name ?? spec.local?.name ?? "default";
            bindings.push({
              localName: spec.exported?.name ?? imported,
              importedName: spec.local?.name ?? imported,
            });
          }
          out.imports.push({
            source: node.source.value as string,
            bindings,
            line: node.loc?.start.line ?? 0,
          });
        }
        return;
      }
      extractDeclaration(node.declaration, out, { exported: true });
      return;

    case "ExportDefaultDeclaration": {
      const decl = node.declaration;
      const line = node.loc?.start.line ?? 0;
      const endLine = node.loc?.end.line ?? line;
      if (decl.type === "FunctionDeclaration") {
        const name = decl.id?.name ?? "default";
        out.exports.push({
          name,
          kind: name === "default" ? "default-anon" : "default-function",
          isComponent: functionReturnsJsx(decl),
          isHook: isHookName(name),
          extendsName: null,
          implementsNames: [],
          startLine: decl.loc?.start.line ?? line,
          endLine: decl.loc?.end.line ?? endLine,
        });
      } else if (decl.type === "ClassDeclaration") {
        const name = decl.id?.name ?? "default";
        out.exports.push({
          name,
          kind: "default-class",
          isComponent: classExtendsReactComponent(decl),
          isHook: false,
          extendsName: extractSuperName(decl.superClass),
          implementsNames: extractImplementsNames(decl),
          startLine: decl.loc?.start.line ?? line,
          endLine: decl.loc?.end.line ?? endLine,
        });
      } else if (decl.type === "ArrowFunctionExpression" || decl.type === "FunctionExpression") {
        out.exports.push({
          name: "default",
          kind: "default-anon",
          isComponent: arrowReturnsJsx(decl),
          isHook: false,
          extendsName: null,
          implementsNames: [],
          startLine: decl.loc?.start.line ?? line,
          endLine: decl.loc?.end.line ?? endLine,
        });
      } else if (decl.type === "Identifier") {
        // `export default Foo` — the identifier was declared elsewhere; we already
        // captured it via its own declaration. Nothing else to do.
        return;
      }
      return;
    }

    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "VariableDeclaration":
      extractDeclaration(node, out, { exported: false });
      return;

    case "TSInterfaceDeclaration":
      extractInterface(node, out);
      return;

    case "TSTypeAliasDeclaration":
      out.typeDecls.push({
        name: node.id?.name ?? "<anon>",
        kind: "type-alias",
        extendsNames: [],
        startLine: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
      return;

    case "TSDeclareFunction":
      // Ambient function declarations (typical in .d.ts). Use TypeDecl with ambient-function
      // kind so the parse driver knows not to emit a runtime TsFunction node for it.
      out.typeDecls.push({
        name: node.id?.name ?? "<anon>",
        kind: "ambient-function",
        extendsNames: [],
        startLine: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
      return;

    case "TSModuleDeclaration":
      // `declare module "foo" { ... }` — ambient module declaration; recurse into body for
      // any interfaces/types it declares.
      out.typeDecls.push({
        name: typeof node.id?.name === "string" ? node.id.name : node.id?.value ?? "<anon>",
        kind: "ambient-module",
        extendsNames: [],
        startLine: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
      });
      if (node.body?.body !== undefined && Array.isArray(node.body.body)) {
        for (const child of node.body.body) extractTopLevel(child, out);
      }
      return;
  }
}

function extractInterface(node: any, out: WalkResult): void {
  const extendsNames: string[] = [];
  for (const ext of node.extends ?? []) {
    const exprName = ext.expression?.name;
    if (typeof exprName === "string") extendsNames.push(exprName);
  }
  out.typeDecls.push({
    name: node.id?.name ?? "<anon>",
    kind: "interface",
    extendsNames,
    startLine: node.loc?.start.line ?? 0,
    endLine: node.loc?.end.line ?? 0,
  });
}

function extractDeclaration(decl: any, out: WalkResult, ctx: { exported: boolean }): void {
  // v0.7: `export interface Foo` and `export type Bar = ...` reach here. Forward them to
  // the top-level handlers that know how to produce TypeDecl entries.
  if (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration" || decl.type === "TSDeclareFunction" || decl.type === "TSModuleDeclaration") {
    extractTopLevel(decl, out);
    return;
  }
  if (decl.type === "FunctionDeclaration") {
    const name = decl.id?.name ?? "<anon>";
    out.exports.push({
      name,
      kind: "function",
      isComponent: functionReturnsJsx(decl),
      isHook: isHookName(name),
      extendsName: null,
      implementsNames: [],
      startLine: decl.loc?.start.line ?? 0,
      endLine: decl.loc?.end.line ?? 0,
    });
  } else if (decl.type === "ClassDeclaration") {
    const name = decl.id?.name ?? "<anon>";
    out.exports.push({
      name,
      kind: "class",
      isComponent: classExtendsReactComponent(decl),
      isHook: false,
      extendsName: extractSuperName(decl.superClass),
      implementsNames: extractImplementsNames(decl),
      startLine: decl.loc?.start.line ?? 0,
      endLine: decl.loc?.end.line ?? 0,
    });
  } else if (decl.type === "VariableDeclaration") {
    // `const Foo = () => <div/>` — capture as a function-shaped export if the initializer
    // is an arrow/function returning JSX, otherwise as a "variable" (we still want a node
    // so cross-file references resolve).
    for (const d of decl.declarations ?? []) {
      const name = d.id?.name;
      if (typeof name !== "string") continue;
      const init = d.init;
      if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
        out.exports.push({
          name,
          kind: "function",
          isComponent: arrowReturnsJsx(init),
          isHook: isHookName(name),
          extendsName: null,
          implementsNames: [],
          startLine: d.loc?.start.line ?? 0,
          endLine: d.loc?.end.line ?? 0,
        });
      } else if (ctx.exported) {
        out.exports.push({
          name,
          kind: "variable",
          isComponent: false,
          isHook: false,
          extendsName: null,
          implementsNames: [],
          startLine: d.loc?.start.line ?? 0,
          endLine: d.loc?.end.line ?? 0,
        });
      }
    }
  }
}

function extractImport(node: any): ImportRecord {
  const bindings: { localName: string; importedName: string }[] = [];
  for (const spec of node.specifiers ?? []) {
    if (spec.type === "ImportDefaultSpecifier") {
      bindings.push({ localName: spec.local.name, importedName: "default" });
    } else if (spec.type === "ImportNamespaceSpecifier") {
      bindings.push({ localName: spec.local.name, importedName: "*" });
    } else if (spec.type === "ImportSpecifier") {
      const imported = spec.imported?.name ?? spec.imported?.value ?? spec.local.name;
      bindings.push({ localName: spec.local.name, importedName: imported });
    }
  }
  return {
    source: node.source.value as string,
    bindings,
    line: node.loc?.start.line ?? 0,
  };
}

// --- body walk for call/render extraction ---

function walkExportBody(node: any, out: WalkResult): void {
  const exportName = topLevelExportName(node);
  if (exportName === null) return;
  walkNodeForCallsAndRenders(node, exportName, out);
}

function topLevelExportName(node: any): string | null {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? null;
  if (node.type === "ClassDeclaration") return node.id?.name ?? null;
  if (node.type === "VariableDeclaration") {
    for (const d of node.declarations ?? []) {
      if (d.init && (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression")) {
        return d.id?.name ?? null;
      }
    }
    return null;
  }
  if (node.type === "ExportNamedDeclaration" && node.declaration) {
    return topLevelExportName(node.declaration);
  }
  if (node.type === "ExportDefaultDeclaration") {
    const decl = node.declaration;
    if (decl.type === "FunctionDeclaration") return decl.id?.name ?? "default";
    if (decl.type === "ClassDeclaration") return decl.id?.name ?? "default";
    if (decl.type === "ArrowFunctionExpression" || decl.type === "FunctionExpression") return "default";
  }
  return null;
}

function walkNodeForCallsAndRenders(node: any, owner: string, out: WalkResult): void {
  if (node === null || node === undefined || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) walkNodeForCallsAndRenders(child, owner, out);
    return;
  }

  if (typeof node.type === "string") {
    switch (node.type) {
      case "CallExpression":
      case "NewExpression": {
        const callee = node.callee;
        const line = node.loc?.start.line ?? 0;
        if (callee?.type === "Identifier") {
          out.calls.push({
            fromOwner: owner,
            calleeName: callee.name,
            receiverName: null,
            receiverChain: [],
            line,
          });
        } else if (callee?.type === "MemberExpression") {
          const chain = collectMemberChain(callee);
          if (chain !== null && chain.length >= 2) {
            const calleeName = chain[chain.length - 1] as string;
            const receiverName = chain[0] as string;
            out.calls.push({
              fromOwner: owner,
              calleeName,
              receiverName,
              receiverChain: chain,
              line,
            });
          }
        }
        break;
      }
      case "TaggedTemplateExpression": {
        // gql`query { ... }` — capture the raw text for the GraphQL parser to consume.
        if (isGqlTag(node.tag)) {
          const raw = extractTemplateRawText(node.quasi);
          if (raw !== null) {
            out.gqlTemplates.push({
              fromOwner: owner,
              rawText: raw,
              line: node.loc?.start.line ?? 0,
            });
          }
        }
        break;
      }
      case "JSXOpeningElement": {
        const tag = jsxElementName(node.name);
        if (tag !== null && tag.length > 0 && /^[A-Z]/.test(tag)) {
          out.renders.push({
            fromOwner: owner,
            componentName: tag,
            line: node.loc?.start.line ?? 0,
          });
        }
        break;
      }
    }
  }

  // Recurse into all object-valued properties — generic walker. Skip parent/loc/range/comments.
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const value = node[key];
    if (value !== null && typeof value === "object") {
      walkNodeForCallsAndRenders(value, owner, out);
    }
  }
}

// Walk a MemberExpression node and collect the dotted identifier chain. Returns null if
// any link in the chain isn't a plain Identifier (e.g. `arr[0].method()` includes a
// computed access — we can't statically resolve that).
function collectMemberChain(member: any): string[] | null {
  const out: string[] = [];
  let cur: any = member;
  while (cur !== null && cur !== undefined) {
    if (cur.type === "MemberExpression") {
      if (cur.computed === true) return null;
      const propName = cur.property?.name;
      if (typeof propName !== "string") return null;
      out.unshift(propName);
      cur = cur.object;
    } else if (cur.type === "Identifier") {
      out.unshift(cur.name as string);
      return out;
    } else if (cur.type === "ThisExpression") {
      // `this.foo()` — we don't resolve `this` in v0.7.
      return null;
    } else {
      return null;
    }
  }
  return null;
}

function isGqlTag(tag: any): boolean {
  if (tag === null || tag === undefined) return false;
  if (tag.type === "Identifier") return tag.name === "gql";
  // `Apollo.gql\`...\`` — match the trailing property.
  if (tag.type === "MemberExpression") {
    return tag.property?.name === "gql";
  }
  return false;
}

// Extract raw text from a template literal. Returns null if the template contains
// interpolations we can't statically capture (gql templates with ${...} expressions are
// dynamic compositions; we still want to record the surrounding static text).
function extractTemplateRawText(quasi: any): string | null {
  if (quasi === null || quasi === undefined) return null;
  if (quasi.type !== "TemplateLiteral") return null;
  const quasis = quasi.quasis;
  const expressions = quasi.expressions ?? [];
  if (!Array.isArray(quasis) || quasis.length === 0) return null;
  // Concatenate static portions with $N placeholders for expressions. Good enough for the
  // GraphQL parser to recognize most operation shapes; non-static templates still let us
  // capture operation names that appear in the first static chunk.
  let out = "";
  for (let i = 0; i < quasis.length; i++) {
    const q = quasis[i];
    const raw = q?.value?.cooked ?? q?.value?.raw ?? "";
    out += raw;
    if (i < expressions.length) out += `\$VAR${i}`;
  }
  return out;
}

function jsxElementName(node: any): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === "JSXIdentifier") return node.name as string;
  if (node.type === "JSXMemberExpression") {
    const obj = jsxElementName(node.object);
    const prop = node.property?.name;
    if (obj !== null && typeof prop === "string") return obj + "." + prop;
  }
  return null;
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function functionReturnsJsx(node: any): boolean {
  return containsJsx(node.body);
}

function arrowReturnsJsx(node: any): boolean {
  if (!node.body) return false;
  if (node.body.type === "JSXElement" || node.body.type === "JSXFragment") return true;
  return containsJsx(node.body);
}

function containsJsx(node: any): boolean {
  if (node === null || node === undefined || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((c) => containsJsx(c));
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "leadingComments" || key === "trailingComments") continue;
    const value = node[key];
    if (value !== null && typeof value === "object" && containsJsx(value)) return true;
  }
  return false;
}

function classExtendsReactComponent(decl: any): boolean {
  const sup = decl.superClass;
  if (sup === null || sup === undefined) return false;
  if (sup.type === "Identifier") {
    return sup.name === "Component" || sup.name === "PureComponent";
  }
  if (sup.type === "MemberExpression") {
    const prop = sup.property?.name;
    return prop === "Component" || prop === "PureComponent";
  }
  return false;
}

// v0.7: extract TS `class Foo implements Bar, Baz` identifier list.
function extractImplementsNames(classDecl: any): string[] {
  const out: string[] = [];
  const impls = classDecl.implements;
  if (!Array.isArray(impls)) return out;
  for (const i of impls) {
    // TSExpressionWithTypeArguments or ClassImplements
    const expr = i.expression ?? i.id;
    if (expr === null || expr === undefined) continue;
    if (expr.type === "Identifier") {
      out.push(expr.name as string);
    } else if (expr.type === "TSQualifiedName" || expr.type === "MemberExpression") {
      // Foo.Bar — keep just the trailing identifier for v0.7.
      const right = expr.right?.name ?? expr.property?.name;
      if (typeof right === "string") out.push(right);
    }
  }
  return out;
}

function extractSuperName(sup: any): string | null {
  if (sup === null || sup === undefined) return null;
  if (sup.type === "Identifier") return sup.name as string;
  if (sup.type === "MemberExpression") {
    const obj = sup.object?.name ?? "";
    const prop = sup.property?.name ?? "";
    if (obj !== "" && prop !== "") return obj + "." + prop;
    if (prop !== "") return prop;
  }
  return null;
}
