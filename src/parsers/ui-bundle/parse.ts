// uiBundle parser entry point. One DiscoveredFile (kind="ui-bundle") represents one bundle
// directory (e.g. force-app/main/default/uiBundles/agentConsole/) and carries every source
// file under its src/ tree plus the tsconfig.json. We parse them all together so the
// emitted edges can carry resolved qualified names from one TS module to another.
//
// Qualified-name scheme:
//   UiBundle       uiBundle:<bundleName>
//   TsModule       uiBundle:<bundleName>:<relPathUnderBundle>   e.g. uiBundle:agentConsole:src/app.tsx
//   TsFunction     <TsModule qname>::<exportName>
//   TsClass        <TsModule qname>::<exportName>
//   ReactComponent <TsModule qname>::<exportName>
//   ExternalNamespace <packageName>
//
// "Same qname under different label" is allowed by the schema; the (label, qname) tuple is
// unique. We never emit both TsFunction and ReactComponent for the same export — the
// parser commits to one based on JSX-in-return.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { DiscoveredFile } from "../../pipeline/discover.ts";
import type { ParseResult, ParsedEdge, ParsedNode } from "../apex/types.ts";

import { loadTsconfigPaths } from "./tsconfig-paths.ts";
import { resolveImport } from "./resolve-import.ts";
import type { ResolvedImport } from "./resolve-import.ts";
import { walkSource } from "./walk-ast.ts";
import type { ExportDecl, WalkResult } from "./walk-ast.ts";
import { parseGraphqlSource } from "./parse-graphql.ts";
import type { GraphqlOperationInfo, GraphqlFragmentInfo } from "./parse-graphql.ts";

export function parseUiBundle(file: DiscoveredFile): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  if (file.kind !== "ui-bundle" || file.bundleFiles === undefined || file.bundleName === undefined) {
    result.warnings.push({
      message: `parseUiBundle: malformed DiscoveredFile (path=${file.relativePath})`,
      line: 0,
    });
    return result;
  }

  const bundleName = file.bundleName;
  const bundleDir = file.absolutePath;
  const bundleQName = `uiBundle:${bundleName}`;

  // Emit the bundle root node.
  result.nodes.push({
    label: NodeLabel.UiBundle,
    name: bundleName,
    qualifiedName: bundleQName,
    startLine: 0,
    endLine: 0,
    properties: { bundleDir },
  });

  // Find the tsconfig (already discovered) and build the path-alias resolver.
  const tsconfigFile = file.bundleFiles.find((f) => f.fileName === "tsconfig.json");
  const tsconfig = tsconfigFile !== undefined
    ? loadTsconfigPaths(tsconfigFile.absolutePath, bundleDir)
    : { baseUrl: bundleDir, aliases: [] };

  // Build the set of absolute file paths in this bundle. The resolver uses this to probe
  // for `./foo` and `@/foo` → real file matches without hitting the filesystem repeatedly.
  const bundleFilePaths = new Set<string>();
  for (const f of file.bundleFiles) {
    if (f.fileName !== "tsconfig.json") bundleFilePaths.add(f.absolutePath);
  }

  // Per-file walk. We track (filePath → walk result) so the second pass can use the export
  // map to resolve imports to specific TsFunction/TsClass nodes.
  type PerFile = { filePath: string; moduleQName: string; walk: WalkResult };
  const perFile: PerFile[] = [];

  for (const f of file.bundleFiles) {
    if (f.fileName === "tsconfig.json") continue;
    let source: string;
    try {
      source = readFileSync(f.absolutePath, "utf8");
    } catch (err) {
      result.warnings.push({
        message: `Cannot read ${f.fileName}: ${(err as Error).message}`,
        line: 0,
      });
      continue;
    }

    const moduleRel = toRelativeBundlePath(bundleDir, f.absolutePath);
    const moduleQName = `${bundleQName}:${moduleRel}`;

    // v0.7: standalone .graphql / .gql files. Emit a TsModule node (for containment) plus
    // GraphqlOperation / GraphqlFragment nodes; skip the babel walk entirely.
    const lowerName = f.fileName.toLowerCase();
    if (lowerName.endsWith(".graphql") || lowerName.endsWith(".gql")) {
      emitGraphqlNodesFromFile(source, moduleRel, moduleQName, bundleName, bundleQName, result);
      continue;
    }

    const walk = walkSource(source, f.absolutePath);

    for (const w of walk.warnings) {
      result.warnings.push({ message: `${moduleRel}: ${w.message}`, line: w.line });
    }

    // TsModule node — line range covers the whole file conservatively.
    const lineCount = source.split("\n").length;
    result.nodes.push({
      label: NodeLabel.TsModule,
      name: moduleRel,
      qualifiedName: moduleQName,
      startLine: 1,
      endLine: lineCount,
      properties: {
        bundle: bundleName,
        filePath: f.absolutePath,
      },
    });

    // CONTAINS edge: UiBundle -> TsModule
    result.edges.push({
      edgeType: EdgeType.Contains,
      fromQName: bundleQName,
      fromLabel: NodeLabel.UiBundle,
      toQName: moduleQName,
      toLabel: NodeLabel.TsModule,
      confidence: Confidence.Resolved,
    });

    // Export nodes (TsFunction | TsClass | ReactComponent). Skip runtime nodes in .d.ts.
    if (!walk.isDts) {
      for (const exp of walk.exports) {
        const expLabel = pickExportLabel(exp);
        const expQName = `${moduleQName}::${exp.name}`;
        result.nodes.push({
          label: expLabel,
          name: exp.name,
          qualifiedName: expQName,
          startLine: exp.startLine,
          endLine: exp.endLine,
          properties: {
            bundle: bundleName,
            module: moduleRel,
            kind: exp.kind,
            isHook: exp.isHook,
          },
        });
        result.edges.push({
          edgeType: EdgeType.DefinesMethod, // semantic close-enough for TsModule -> TsFunction
          fromQName: moduleQName,
          fromLabel: NodeLabel.TsModule,
          toQName: expQName,
          toLabel: expLabel,
          confidence: Confidence.Resolved,
        });
      }
    }

    // v0.7: TS type-level nodes (interfaces, type aliases, ambient function declarations).
    // These are emitted from both runtime .ts/.tsx files and .d.ts ambient declaration files.
    for (const td of walk.typeDecls) {
      if (td.kind === "ambient-module" || td.kind === "ambient-function") continue; // not a graph node — purely a scope
      const label = td.kind === "interface" ? NodeLabel.TsInterface : NodeLabel.TsTypeAlias;
      const tdQName = `${moduleQName}::${td.name}`;
      result.nodes.push({
        label,
        name: td.name,
        qualifiedName: tdQName,
        startLine: td.startLine,
        endLine: td.endLine,
        properties: {
          bundle: bundleName,
          module: moduleRel,
          ambient: walk.isDts,
          kind: td.kind,
        },
      });
      result.edges.push({
        edgeType: EdgeType.Contains,
        fromQName: moduleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: tdQName,
        toLabel: label,
        confidence: Confidence.Resolved,
      });
    }

    // v0.7: gql tagged templates inside this TS/JS file. Each successfully parsed template
    // emits its own GraphqlOperation / GraphqlFragment nodes anchored to this module.
    for (const tpl of walk.gqlTemplates) {
      emitGraphqlNodesFromInlineTemplate(
        tpl.rawText,
        tpl.fromOwner,
        tpl.line,
        moduleQName,
        bundleName,
        moduleRel,
        result,
      );
    }

    perFile.push({ filePath: f.absolutePath, moduleQName, walk });
  }

  // Build the export map: absolutePath -> Map<importedName, { qname, label }>
  // Also collect a default-export pointer per file. v0.7: include TS type declarations
  // (interfaces, type aliases) so `import { type IFoo } from "./types"` resolves into a
  // TsInterface/TsTypeAlias target.
  type ExportTarget = { qname: string; label: (typeof NodeLabel)[keyof typeof NodeLabel] };
  const exportMaps = new Map<string, Map<string, ExportTarget>>();
  for (const pf of perFile) {
    const m = new Map<string, ExportTarget>();
    for (const exp of pf.walk.exports) {
      const label = pickExportLabel(exp);
      const tgt: ExportTarget = { qname: `${pf.moduleQName}::${exp.name}`, label };
      m.set(exp.name, tgt);
      if (exp.kind === "default-function" || exp.kind === "default-class" || exp.kind === "default-anon") {
        m.set("default", tgt);
      }
    }
    for (const td of pf.walk.typeDecls) {
      if (td.kind === "ambient-module" || td.kind === "ambient-function") continue;
      const label = td.kind === "interface" ? NodeLabel.TsInterface : NodeLabel.TsTypeAlias;
      m.set(td.name, { qname: `${pf.moduleQName}::${td.name}`, label });
    }
    exportMaps.set(pf.filePath, m);
  }

  // External namespace nodes are emitted once per distinct package name we encounter.
  const externalSeen = new Set<string>();
  const ensureExternal = (pkg: string): void => {
    if (externalSeen.has(pkg)) return;
    externalSeen.add(pkg);
    result.nodes.push({
      label: NodeLabel.ExternalNamespace,
      name: pkg,
      qualifiedName: pkg,
      startLine: 0,
      endLine: 0,
      properties: { kind: "npm" },
    });
  };

  // Second pass: emit per-file edges (imports → TsModule | external | sf-*; calls; renders).
  for (const pf of perFile) {
    for (const imp of pf.walk.imports) {
      const resolved = resolveImport(imp.source, pf.filePath, tsconfig, bundleFilePaths);
      emitImportEdges(pf.moduleQName, imp.source, imp.line, imp.bindings, resolved, exportMaps, result, ensureExternal);
    }
    // Calls — resolve identifier name against (a) imports' local bindings, (b) other exports
    // in the same module. We emit a TS_CALLS edge when we can; otherwise drop. v0.6 has no
    // global call graph beyond per-bundle name lookup.
    emitCallsAndRenders(pf, exportMaps, tsconfig, bundleFilePaths, result, ensureExternal);
  }

  return result;
}

// --- helpers ---

function pickExportLabel(exp: ExportDecl): (typeof NodeLabel)[keyof typeof NodeLabel] {
  if (exp.isComponent) return NodeLabel.ReactComponent;
  if (exp.kind === "class" || exp.kind === "default-class") return NodeLabel.TsClass;
  return NodeLabel.TsFunction;
}

function toRelativeBundlePath(bundleDir: string, absFile: string): string {
  return relative(bundleDir, absFile).split("\\").join("/");
}

function emitImportEdges(
  fromModuleQName: string,
  rawSpec: string,
  line: number,
  bindings: { localName: string; importedName: string }[],
  resolved: ResolvedImport,
  exportMaps: Map<string, Map<string, { qname: string; label: (typeof NodeLabel)[keyof typeof NodeLabel] }>>,
  out: ParseResult,
  ensureExternal: (pkg: string) => void,
): void {
  switch (resolved.kind) {
    case "local": {
      const targetMap = exportMaps.get(resolved.absolutePath);
      if (targetMap === undefined) return;
      // One TS_IMPORTS edge per binding, pointing at the specific export node.
      for (const b of bindings) {
        const tgt = targetMap.get(b.importedName);
        if (tgt === undefined) continue;
        out.edges.push({
          edgeType: EdgeType.TsImports,
          fromQName: fromModuleQName,
          fromLabel: NodeLabel.TsModule,
          toQName: tgt.qname,
          toLabel: tgt.label,
          confidence: Confidence.Resolved,
          sourceLine: line,
          properties: { spec: rawSpec, localName: b.localName, importedName: b.importedName },
        });
      }
      return;
    }

    case "sf-apex": {
      // The Apex method qname inside Spindle is "ClassName.methodName" (no parens, no params).
      // pass2's short-name fallback ToLabel=ApexMethod handles overloads.
      const ns = resolved.namespace !== undefined ? `${resolved.namespace}__` : "";
      out.edges.push({
        edgeType: EdgeType.UiBundleUsesApex,
        fromQName: fromModuleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: `${ns}${resolved.className}.${resolved.methodName}`,
        toLabel: NodeLabel.ApexMethod,
        confidence: Confidence.Resolved,
        sourceLine: line,
        properties: { spec: rawSpec },
      });
      return;
    }

    case "sf-schema": {
      // Field qname: "Object.Field". Whole-object form has no field portion; we skip edges
      // since Spindle stores per-field nodes and we don't have an SObject usage edge.
      if (resolved.field === undefined) return;
      out.edges.push({
        edgeType: EdgeType.UiBundleUsesField,
        fromQName: fromModuleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: `${resolved.sobject}.${resolved.field}`,
        toLabel: NodeLabel.Field,
        confidence: Confidence.Resolved,
        sourceLine: line,
        properties: { spec: rawSpec },
      });
      return;
    }

    case "sf-label": {
      out.edges.push({
        edgeType: EdgeType.UiBundleUsesLabel,
        fromQName: fromModuleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: resolved.label,
        toLabel: NodeLabel.CustomLabel,
        confidence: Confidence.Resolved,
        sourceLine: line,
        properties: { spec: rawSpec, namespace: resolved.namespace ?? null },
      });
      return;
    }

    case "sf-resource": {
      out.edges.push({
        edgeType: EdgeType.UiBundleUsesResource,
        fromQName: fromModuleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: resolved.name,
        toLabel: NodeLabel.StaticResource,
        confidence: Confidence.Resolved,
        sourceLine: line,
        properties: { spec: rawSpec, namespace: resolved.namespace ?? null },
      });
      return;
    }

    case "external": {
      ensureExternal(resolved.moduleName);
      out.edges.push({
        edgeType: EdgeType.DependsOnExternal,
        fromQName: fromModuleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: resolved.moduleName,
        toLabel: NodeLabel.ExternalNamespace,
        confidence: Confidence.Resolved,
        sourceLine: line,
        properties: { spec: rawSpec },
      });
      return;
    }

    case "unresolved": {
      // Low-confidence edge to a synthetic external namespace so the relationship doesn't
      // disappear. Future passes (e.g. v0.7 tsconfig project-references) can promote these.
      const pkg = `unresolved:${resolved.spec}`;
      ensureExternal(pkg);
      out.edges.push({
        edgeType: EdgeType.DependsOnExternal,
        fromQName: fromModuleQName,
        fromLabel: NodeLabel.TsModule,
        toQName: pkg,
        toLabel: NodeLabel.ExternalNamespace,
        confidence: Confidence.Regex,
        sourceLine: line,
        properties: { spec: rawSpec, unresolved: true },
      });
      return;
    }
  }
}

function emitCallsAndRenders(
  pf: { filePath: string; moduleQName: string; walk: WalkResult },
  exportMaps: Map<string, Map<string, { qname: string; label: (typeof NodeLabel)[keyof typeof NodeLabel] }>>,
  tsconfig: import("./tsconfig-paths.ts").TsconfigPaths,
  bundleFilePaths: Set<string>,
  out: ParseResult,
  _ensureExternal: (pkg: string) => void,
): void {
  // Build local-name → resolved target table for this file by re-resolving its imports.
  type LocalTarget = {
    qname: string;
    label: (typeof NodeLabel)[keyof typeof NodeLabel];
    edgeType: typeof EdgeType.TsCalls | typeof EdgeType.TsRenders;
  };
  const localToTarget = new Map<string, LocalTarget>();
  // v0.7: namespace import bindings. `import * as Foo from "./mod"` → localToNamespace["Foo"]
  // points at the module's export map so `Foo.bar()` can be resolved.
  const localToNamespace = new Map<string, Map<string, { qname: string; label: (typeof NodeLabel)[keyof typeof NodeLabel] }>>();

  for (const imp of pf.walk.imports) {
    const resolved = resolveImport(imp.source, pf.filePath, tsconfig, bundleFilePaths);
    if (resolved.kind === "local") {
      const targetMap = exportMaps.get(resolved.absolutePath);
      if (targetMap === undefined) continue;
      for (const b of imp.bindings) {
        if (b.importedName === "*") {
          localToNamespace.set(b.localName, targetMap);
          continue;
        }
        const tgt = targetMap.get(b.importedName);
        if (tgt === undefined) continue;
        localToTarget.set(b.localName, {
          qname: tgt.qname,
          label: tgt.label,
          edgeType: tgt.label === NodeLabel.ReactComponent ? EdgeType.TsRenders : EdgeType.TsCalls,
        });
      }
    }
  }

  // Same-file exports: a function can call another function in the same module.
  for (const exp of pf.walk.exports) {
    const label = pickExportLabel(exp);
    const qname = `${pf.moduleQName}::${exp.name}`;
    localToTarget.set(exp.name, {
      qname,
      label,
      edgeType: label === NodeLabel.ReactComponent ? EdgeType.TsRenders : EdgeType.TsCalls,
    });
  }
  // v0.7: same-file type declarations — interfaces, type aliases. Needed so `interface Foo
  // extends Bar` and `class Foo implements IBar` resolve to local declarations.
  for (const td of pf.walk.typeDecls) {
    if (td.kind === "ambient-module" || td.kind === "ambient-function") continue;
    const label = td.kind === "interface" ? NodeLabel.TsInterface : NodeLabel.TsTypeAlias;
    localToTarget.set(td.name, {
      qname: `${pf.moduleQName}::${td.name}`,
      label,
      edgeType: EdgeType.TsCalls, // not used for type-only refs
    });
  }

  // Emit call edges.
  for (const call of pf.walk.calls) {
    const ownerQName = `${pf.moduleQName}::${call.fromOwner}`;
    const ownerLabel = ownerLabelForExport(pf.walk.exports, call.fromOwner);
    if (ownerLabel === null) continue;

    if (call.receiverName === null) {
      // Plain `foo()` call.
      const tgt = localToTarget.get(call.calleeName);
      if (tgt === undefined) continue;
      out.edges.push({
        edgeType: EdgeType.TsCalls,
        fromQName: ownerQName,
        fromLabel: ownerLabel,
        toQName: tgt.qname,
        toLabel: tgt.label,
        confidence: Confidence.Heuristic,
        sourceLine: call.line,
      });
      continue;
    }

    // Member-expression call: `Foo.bar()` or `Foo.bar.baz()`. Resolve through the receiver
    // chain. Three patterns we handle in v0.7:
    //  1. Namespace import: `Foo` was `import * as Foo from "./mod"`. Use namespace map.
    //  2. Default-imported namespace-like object: `Foo` is the default export of a module.
    //     The default export is treated as the receiver; `Foo.bar` resolves to the module's
    //     `bar` export if `Foo`'s source module also exports `bar`. This handles re-export
    //     barrels: `import Foo from "./Foo"; Foo.bar()` where Foo.tsx default-exports an
    //     object that bundles utility functions named alongside.
    //  3. Single-resolved-target receiver: `Foo` was bound to a specific export, and the
    //     member ('bar') happens to be a property name we can find in `Foo`'s source module.
    //     Same as 2 essentially.
    //
    // Deeper chains (`Foo.bar.baz()`) only resolve the first two levels; we don't try to
    // re-resolve `Foo.bar` and then look up `.baz` on it. v0.7 leaves that to the TS
    // compiler enrichment pass.
    const nsMap = localToNamespace.get(call.receiverName);
    if (nsMap !== undefined) {
      // chain[0] is the namespace local name; chain[1] is the property name to look up.
      const propName = call.receiverChain[1];
      if (typeof propName !== "string") continue;
      const tgt = nsMap.get(propName);
      if (tgt === undefined) continue;
      out.edges.push({
        edgeType: tgt.label === NodeLabel.ReactComponent ? EdgeType.TsRenders : EdgeType.TsCalls,
        fromQName: ownerQName,
        fromLabel: ownerLabel,
        toQName: tgt.qname,
        toLabel: tgt.label,
        confidence: Confidence.Resolved,
        sourceLine: call.line,
        properties: { via: "namespace-import" },
      });
      continue;
    }
    // Receiver resolved to a single target — try looking up the call's calleeName as
    // a sibling export of the same source module.
    const recv = localToTarget.get(call.receiverName);
    if (recv !== undefined) {
      // Find the source module by parsing the receiver qname back to its TsModule.
      const moduleQNameOfReceiver = stripExportSuffix(recv.qname);
      if (moduleQNameOfReceiver !== null) {
        const moduleExports = findExportMapForModuleQName(exportMaps, moduleQNameOfReceiver);
        if (moduleExports !== undefined) {
          const propName = call.receiverChain[1];
          if (typeof propName === "string") {
            const tgt = moduleExports.get(propName);
            if (tgt !== undefined) {
              out.edges.push({
                edgeType: tgt.label === NodeLabel.ReactComponent ? EdgeType.TsRenders : EdgeType.TsCalls,
                fromQName: ownerQName,
                fromLabel: ownerLabel,
                toQName: tgt.qname,
                toLabel: tgt.label,
                confidence: Confidence.Heuristic,
                sourceLine: call.line,
                properties: { via: "receiver-sibling-export" },
              });
            }
          }
        }
      }
    }
  }

  // Emit JSX render edges. The JSX walker captures PascalCase tags including dotted names
  // (radix-ui's `Tabs.Root`). v0.7 resolves the dotted form against namespace and receiver
  // sibling-export tables.
  for (const ren of pf.walk.renders) {
    const ownerQName = `${pf.moduleQName}::${ren.fromOwner}`;
    const ownerLabel = ownerLabelForExport(pf.walk.exports, ren.fromOwner);
    if (ownerLabel === null) continue;

    if (!ren.componentName.includes(".")) {
      const tgt = localToTarget.get(ren.componentName);
      if (tgt === undefined) continue;
      out.edges.push({
        edgeType: EdgeType.TsRenders,
        fromQName: ownerQName,
        fromLabel: ownerLabel,
        toQName: tgt.qname,
        toLabel: tgt.label,
        confidence: Confidence.Heuristic,
        sourceLine: ren.line,
      });
      continue;
    }

    // Dotted JSX: <Foo.Bar />
    const parts = ren.componentName.split(".");
    if (parts.length < 2) continue;
    const head = parts[0] as string;
    const prop = parts[1] as string;
    const nsMap = localToNamespace.get(head);
    if (nsMap !== undefined) {
      const tgt = nsMap.get(prop);
      if (tgt === undefined) continue;
      out.edges.push({
        edgeType: EdgeType.TsRenders,
        fromQName: ownerQName,
        fromLabel: ownerLabel,
        toQName: tgt.qname,
        toLabel: tgt.label,
        confidence: Confidence.Resolved,
        sourceLine: ren.line,
        properties: { via: "namespace-jsx" },
      });
      continue;
    }
    const recv = localToTarget.get(head);
    if (recv !== undefined) {
      const moduleQNameOfReceiver = stripExportSuffix(recv.qname);
      if (moduleQNameOfReceiver !== null) {
        const moduleExports = findExportMapForModuleQName(exportMaps, moduleQNameOfReceiver);
        if (moduleExports !== undefined) {
          const tgt = moduleExports.get(prop);
          if (tgt !== undefined) {
            out.edges.push({
              edgeType: EdgeType.TsRenders,
              fromQName: ownerQName,
              fromLabel: ownerLabel,
              toQName: tgt.qname,
              toLabel: tgt.label,
              confidence: Confidence.Heuristic,
              sourceLine: ren.line,
              properties: { via: "receiver-sibling-jsx" },
            });
          }
        }
      }
    }
  }

  // TS_EXTENDS — resolve the class superclass identifier through the local-name table.
  for (const exp of pf.walk.exports) {
    if (exp.extendsName !== null && (exp.kind === "class" || exp.kind === "default-class")) {
      const tgt = localToTarget.get(exp.extendsName);
      if (tgt !== undefined) {
        out.edges.push({
          edgeType: EdgeType.TsExtends,
          fromQName: `${pf.moduleQName}::${exp.name}`,
          fromLabel: pickExportLabel(exp),
          toQName: tgt.qname,
          toLabel: tgt.label,
          confidence: Confidence.Resolved,
          sourceLine: exp.startLine,
        });
      }
    }

    // v0.7: TS_IMPLEMENTS — `class Foo implements Interface1, Interface2`.
    if (exp.kind === "class" || exp.kind === "default-class") {
      for (const ifaceName of exp.implementsNames) {
        const tgt = localToTarget.get(ifaceName);
        if (tgt === undefined) continue;
        out.edges.push({
          edgeType: EdgeType.TsImplements,
          fromQName: `${pf.moduleQName}::${exp.name}`,
          fromLabel: pickExportLabel(exp),
          toQName: tgt.qname,
          toLabel: tgt.label,
          confidence: Confidence.Resolved,
          sourceLine: exp.startLine,
        });
      }
    }
  }

  // v0.7: TS_TYPE_EXTENDS — `interface Foo extends Bar` between interfaces.
  for (const td of pf.walk.typeDecls) {
    if (td.kind !== "interface") continue;
    if (td.extendsNames.length === 0) continue;
    const fromQName = `${pf.moduleQName}::${td.name}`;
    for (const parentName of td.extendsNames) {
      const tgt = localToTarget.get(parentName);
      if (tgt === undefined) continue;
      out.edges.push({
        edgeType: EdgeType.TsTypeExtends,
        fromQName,
        fromLabel: NodeLabel.TsInterface,
        toQName: tgt.qname,
        toLabel: tgt.label,
        confidence: Confidence.Resolved,
        sourceLine: td.startLine,
      });
    }
  }
}

function ownerLabelForExport(
  exports: ExportDecl[],
  name: string,
): (typeof NodeLabel)[keyof typeof NodeLabel] | null {
  const found = exports.find((e) => e.name === name);
  if (found === undefined) return null;
  return pickExportLabel(found);
}

// Strip `::<exportName>` off an export-level qname, yielding the owning TsModule qname.
// Returns null if the qname has no `::` separator.
function stripExportSuffix(exportQName: string): string | null {
  const idx = exportQName.lastIndexOf("::");
  if (idx === -1) return null;
  return exportQName.slice(0, idx);
}

// v0.7: emit graph nodes/edges for a standalone .graphql / .gql file. The TsModule node
// is emitted by the caller indirectly via `emitGraphqlNodesFromFile`'s own TsModule emit,
// but operations need their own line-anchored nodes.
function emitGraphqlNodesFromFile(
  source: string,
  moduleRel: string,
  moduleQName: string,
  bundleName: string,
  bundleQName: string,
  out: ParseResult,
): void {
  // Emit the TsModule node itself so the file shows up in the graph. We mark it as a
  // "graphql" module so consumers can filter.
  const lineCount = source.split("\n").length;
  out.nodes.push({
    label: NodeLabel.TsModule,
    name: moduleRel,
    qualifiedName: moduleQName,
    startLine: 1,
    endLine: lineCount,
    properties: { bundle: bundleName, module: moduleRel, isGraphql: true },
  });
  out.edges.push({
    edgeType: EdgeType.Contains,
    fromQName: bundleQName,
    fromLabel: NodeLabel.UiBundle,
    toQName: moduleQName,
    toLabel: NodeLabel.TsModule,
    confidence: Confidence.Resolved,
  });

  const parsed = parseGraphqlSource(source);
  if (parsed.parseError !== null) {
    out.warnings.push({ message: `${moduleRel}: gql parse error: ${parsed.parseError}`, line: 0 });
    return;
  }
  for (const op of parsed.operations) {
    emitOperationNodeAndEdges(op, moduleQName, bundleName, moduleRel, out);
  }
  for (const frag of parsed.fragments) {
    emitFragmentNodeAndEdges(frag, moduleQName, bundleName, moduleRel, out);
  }
}

// Emit graph nodes/edges for one gql tagged template literal inside a TS/JS file. The
// surrounding TsModule + TsFunction nodes are already emitted by the main parser path.
function emitGraphqlNodesFromInlineTemplate(
  rawText: string,
  fromOwner: string,
  line: number,
  moduleQName: string,
  bundleName: string,
  moduleRel: string,
  out: ParseResult,
): void {
  const parsed = parseGraphqlSource(rawText);
  if (parsed.parseError !== null) {
    out.warnings.push({
      message: `${moduleRel}: inline gql template parse error: ${parsed.parseError}`,
      line,
    });
    return;
  }
  for (const op of parsed.operations) {
    // Adjust to the template's line within the source.
    op.startLine = line + op.startLine - 1;
    emitOperationNodeAndEdges(op, moduleQName, bundleName, moduleRel, out, fromOwner);
  }
  for (const frag of parsed.fragments) {
    frag.startLine = line + frag.startLine - 1;
    emitFragmentNodeAndEdges(frag, moduleQName, bundleName, moduleRel, out, fromOwner);
  }
}

function emitOperationNodeAndEdges(
  op: GraphqlOperationInfo,
  moduleQName: string,
  bundleName: string,
  moduleRel: string,
  out: ParseResult,
  enclosingExportName?: string,
): void {
  const opQName = `${moduleQName}::gql:${op.operationType}:${op.name}`;
  out.nodes.push({
    label: NodeLabel.GraphqlOperation,
    name: op.name,
    qualifiedName: opQName,
    startLine: op.startLine,
    endLine: op.startLine,
    properties: {
      bundle: bundleName,
      module: moduleRel,
      operationType: op.operationType,
      rootSelections: op.rootSelections,
      enclosingExport: enclosingExportName ?? null,
    },
  });
  out.edges.push({
    edgeType: EdgeType.GraphqlDefinedIn,
    fromQName: opQName,
    fromLabel: NodeLabel.GraphqlOperation,
    toQName: moduleQName,
    toLabel: NodeLabel.TsModule,
    confidence: Confidence.Resolved,
  });

  // Cross-domain: every top-level root selection is treated as a type reference (SObject)
  // if the name matches an existing SObject. Pass2 prunes if there's no match.
  for (const rootName of op.rootSelections) {
    out.edges.push({
      edgeType: EdgeType.GraphqlUsesType,
      fromQName: opQName,
      fromLabel: NodeLabel.GraphqlOperation,
      toQName: rootName,
      toLabel: NodeLabel.SObject,
      confidence: Confidence.Heuristic,
      sourceLine: op.startLine,
      properties: { rootSelection: rootName },
    });

    // Direct field children of this selection become GRAPHQL_USES_FIELD edges to Field
    // nodes qualified by "Object.Field".
    const children = op.fieldSelections[rootName] ?? [];
    for (const fieldName of children) {
      out.edges.push({
        edgeType: EdgeType.GraphqlUsesField,
        fromQName: opQName,
        fromLabel: NodeLabel.GraphqlOperation,
        toQName: `${rootName}.${fieldName}`,
        toLabel: NodeLabel.Field,
        confidence: Confidence.Heuristic,
        sourceLine: op.startLine,
        properties: { rootSelection: rootName, field: fieldName },
      });
    }
  }
}

function emitFragmentNodeAndEdges(
  frag: GraphqlFragmentInfo,
  moduleQName: string,
  bundleName: string,
  moduleRel: string,
  out: ParseResult,
  enclosingExportName?: string,
): void {
  const fragQName = `${moduleQName}::gqlFragment:${frag.name}`;
  out.nodes.push({
    label: NodeLabel.GraphqlFragment,
    name: frag.name,
    qualifiedName: fragQName,
    startLine: frag.startLine,
    endLine: frag.startLine,
    properties: {
      bundle: bundleName,
      module: moduleRel,
      onType: frag.onType,
      enclosingExport: enclosingExportName ?? null,
    },
  });
  out.edges.push({
    edgeType: EdgeType.GraphqlDefinedIn,
    fromQName: fragQName,
    fromLabel: NodeLabel.GraphqlFragment,
    toQName: moduleQName,
    toLabel: NodeLabel.TsModule,
    confidence: Confidence.Resolved,
  });

  // Cross-domain: fragment's `on Type` is treated as a GraphqlUsesType edge.
  out.edges.push({
    edgeType: EdgeType.GraphqlUsesType,
    fromQName: fragQName,
    fromLabel: NodeLabel.GraphqlFragment,
    toQName: frag.onType,
    toLabel: NodeLabel.SObject,
    confidence: Confidence.Heuristic,
    sourceLine: frag.startLine,
  });
  for (const fieldName of frag.fieldSelections) {
    out.edges.push({
      edgeType: EdgeType.GraphqlUsesField,
      fromQName: fragQName,
      fromLabel: NodeLabel.GraphqlFragment,
      toQName: `${frag.onType}.${fieldName}`,
      toLabel: NodeLabel.Field,
      confidence: Confidence.Heuristic,
      sourceLine: frag.startLine,
    });
  }
}

// exportMaps is keyed by file absolute path; we need to find the map for a module by its
// qualified name (`uiBundle:foo:src/bar.ts`). Build a reverse lookup once per call. v0.8
// could cache this on the bundle.
function findExportMapForModuleQName(
  exportMaps: Map<string, Map<string, { qname: string; label: (typeof NodeLabel)[keyof typeof NodeLabel] }>>,
  moduleQName: string,
): Map<string, { qname: string; label: (typeof NodeLabel)[keyof typeof NodeLabel] }> | undefined {
  for (const map of exportMaps.values()) {
    // Every export in a module shares the module qname prefix.
    for (const target of map.values()) {
      if (target.qname.startsWith(moduleQName + "::")) return map;
      break; // only need to check one entry per map
    }
  }
  return undefined;
}
