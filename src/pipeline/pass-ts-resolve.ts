// v0.7: TypeScript Compiler API enrichment pass. Runs between pass1 and pass2.
//
// Why this pass exists. The babel-walker in src/parsers/ui-bundle/walk-ast.ts captures
// most call sites and JSX renders but can't resolve symbols across re-exports, namespace
// imports through index barrels, or type-only references that flow through `import type`.
// This pass loads the TypeScript Compiler API, builds a Program per uiBundle, walks each
// .ts/.tsx/.d.ts file with the type checker, and emits additional edges that pass2 then
// resolves against the existing node table (TsModule, TsFunction, TsClass, TsInterface,
// TsTypeAlias, ReactComponent).
//
// Edges this pass can add:
//   - TS_CALLS with confidence=Resolved when babel emitted nothing (e.g. method call
//     through a re-export barrel: import { X } from '@/lib'; X.foo()).
//   - TS_TYPE_REFERENCES from a function/class to the interface/type it accepts as a
//     parameter or return — useful for impact analysis on type declarations.
//   - Reconnections for re-exported defaults: `export { default as X } from './foo'`
//
// What this pass deliberately doesn't do:
//   - Re-walk JSX. The babel pass already covers JSX render edges adequately.
//   - Build full type information for runtime values. The compiler is loaded with
//     `noEmit + skipLibCheck + isolatedModules=false`, in declaration-friendly mode.
//   - Emit cross-domain edges. Those flow through the babel-derived UiBundleUses* edges.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ts from "typescript";

import { EdgeType } from "../model/edge-types.ts";
import { NodeLabel } from "../model/node-labels.ts";
import { Confidence } from "../model/confidence.ts";
import type { GraphStore, StoredNode, EdgeInput } from "../graph/store.ts";
import { logger } from "../util/logger.ts";

export type PassTsResolveDiagnostics = {
  bundlesProcessed: number;
  filesAnalyzed: number;
  edgesAdded: number;
  durationMs: number;
};

export function runPassTsResolve(
  projectId: number,
  store: GraphStore,
  bundleNodes: StoredNode[],
): PassTsResolveDiagnostics {
  const start = Date.now();
  let bundlesProcessed = 0;
  let filesAnalyzed = 0;
  let edgesAdded = 0;

  // TypeScript compiler is statically imported above. The Bun-compiled binary bundles it.
  const tsLib = ts;

  for (const bundleNode of bundleNodes) {
    const bundleDir = (bundleNode.properties as Record<string, unknown>)?.bundleDir;
    if (typeof bundleDir !== "string") continue;

    // Find every TsModule belonging to this bundle.
    const moduleRows = store.db
      .query<{ id: number; qualified_name: string; properties: string }, [number, string, string]>(
        `SELECT id, qualified_name, properties FROM nodes
         WHERE project_id = ? AND label = ? AND qualified_name LIKE ?`,
      )
      .all(projectId, NodeLabel.TsModule, `${bundleNode.qualifiedName}:%`);

    const fileToModuleQName = new Map<string, string>();
    const tsFilePaths: string[] = [];
    for (const row of moduleRows) {
      const props = JSON.parse(row.properties) as Record<string, unknown>;
      const filePath = props["filePath"];
      if (typeof filePath !== "string") continue;
      if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx") && !filePath.endsWith(".d.ts")) continue;
      fileToModuleQName.set(filePath, row.qualified_name);
      tsFilePaths.push(filePath);
    }
    if (tsFilePaths.length === 0) {
      logger.debug({ bundle: bundleNode.qualifiedName }, "pass-ts-resolve: no TS files in bundle");
      continue;
    }

    bundlesProcessed++;

    // Build a TypeScript Program scoped to this bundle's files. We use the bundle's
    // tsconfig.json for compiler options when present; otherwise fall back to permissive
    // defaults sufficient for symbol resolution.
    const tsconfigPath = join(bundleDir, "tsconfig.json");
    const compilerOptions = loadCompilerOptions(tsLib, tsconfigPath, bundleDir);

    const host = tsLib.createCompilerHost(compilerOptions, /* setParentNodes */ true);
    let program: ts.Program;
    try {
      program = tsLib.createProgram({
        rootNames: tsFilePaths,
        options: compilerOptions,
        host,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, bundle: bundleNode.qualifiedName },
        "pass-ts-resolve: createProgram failed, skipping bundle",
      );
      continue;
    }

    const checker = program.getTypeChecker();

    // Collect new edges, then bulk-insert. Pass2 will resolve qname endpoints. We bypass
    // pass2 here by writing edges via direct node-id lookups since we already have access
    // to the live graph and the symbol-name -> file mapping.
    const newEdges: EdgeInput[] = [];

    for (const filePath of tsFilePaths) {
      const sourceFile = program.getSourceFile(filePath);
      if (sourceFile === undefined) continue;
      filesAnalyzed++;

      const moduleQName = fileToModuleQName.get(filePath);
      if (moduleQName === undefined) continue;

      visit(sourceFile, sourceFile, checker, tsLib, moduleQName, fileToModuleQName, store, projectId, newEdges);
    }

    if (newEdges.length > 0) {
      store.transaction(() => {
        for (const e of newEdges) {
          try {
            store.insertEdge(e);
          } catch (err) {
            logger.warn({ err: (err as Error).message, edgeType: e.edgeType }, "pass-ts-resolve: edge insert failed");
          }
        }
      });
      edgesAdded += newEdges.length;
    }
  }

  const durationMs = Date.now() - start;
  logger.info({ projectId, bundlesProcessed, filesAnalyzed, edgesAdded, durationMs }, "pass-ts-resolve: complete");
  return { bundlesProcessed, filesAnalyzed, edgesAdded, durationMs };
}

function loadCompilerOptions(
  tsLib: typeof ts,
  tsconfigPath: string,
  bundleDir: string,
): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    target: tsLib.ScriptTarget.ES2020,
    module: tsLib.ModuleKind.ESNext,
    moduleResolution: tsLib.ModuleResolutionKind.Bundler,
    jsx: tsLib.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
    isolatedModules: false,
    strict: false,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    resolveJsonModule: true,
  };
  try {
    const raw = readFileSync(tsconfigPath, "utf8");
    // tsLib.parseJsonText/parseJsonConfigFileContent handle JSONC and `extends`.
    const parsed = tsLib.parseConfigFileTextToJson(tsconfigPath, raw);
    if (parsed.error !== undefined || parsed.config === undefined) return fallback;
    const result = tsLib.parseJsonConfigFileContent(
      parsed.config,
      tsLib.sys,
      bundleDir,
      /* existingOptions */ undefined,
      tsconfigPath,
    );
    return { ...result.options, noEmit: true, skipLibCheck: true };
  } catch {
    return fallback;
  }
}

function visit(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  tsLib: typeof ts,
  fromModuleQName: string,
  fileToModuleQName: Map<string, string>,
  store: GraphStore,
  projectId: number,
  outEdges: EdgeInput[],
): void {
  // CallExpression — resolve callee symbol via the type checker. If the symbol declares
  // its origin in another TsModule we know about, emit a TS_CALLS edge from the enclosing
  // export (if any) to the declared TsFunction / ReactComponent node.
  if (tsLib.isCallExpression(node) || tsLib.isNewExpression(node)) {
    handleCall(node, sourceFile, checker, tsLib, fromModuleQName, fileToModuleQName, store, projectId, outEdges);
  }

  // FunctionDeclaration / ClassDeclaration parameter type references → TS_TYPE_REFERENCES
  // to the imported interface or type alias node.
  if (tsLib.isFunctionDeclaration(node) || tsLib.isClassDeclaration(node)) {
    handleSignatureTypeRefs(node, sourceFile, checker, tsLib, fromModuleQName, fileToModuleQName, store, projectId, outEdges);
  }

  node.forEachChild((child) => {
    visit(child, sourceFile, checker, tsLib, fromModuleQName, fileToModuleQName, store, projectId, outEdges);
  });
}

function handleCall(
  call: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  tsLib: typeof ts,
  fromModuleQName: string,
  fileToModuleQName: Map<string, string>,
  store: GraphStore,
  projectId: number,
  outEdges: EdgeInput[],
): void {
  const expr = call.expression;
  // Resolve the symbol the callee binds to.
  let symbol = checker.getSymbolAtLocation(expr) ?? resolveTailSymbol(expr, checker, tsLib);
  if (symbol === undefined) return;
  if ((symbol.flags & tsLib.SymbolFlags.Alias) !== 0) {
    try {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== undefined) symbol = aliased;
    } catch {
      // best-effort
    }
  }
  // Get the symbol's declaration. For an imported function, getDeclarations may include
  // both the import alias and the original; we prefer the declaration in a TsModule file
  // we know about.
  const decls = symbol.getDeclarations();
  if (decls === undefined) return;
  for (const decl of decls) {
    const declFile = decl.getSourceFile();
    if (declFile === undefined) continue;
    if (declFile === sourceFile) continue; // intra-file calls handled by babel walker
    const declModuleQName = fileToModuleQName.get(declFile.fileName);
    if (declModuleQName === undefined) continue;
    // Look up the declaration's symbol name to build the export-level qname.
    const declName = getDeclarationName(decl, tsLib);
    if (declName === null) continue;
    const targetQName = `${declModuleQName}::${declName}`;

    const fromOwner = enclosingExportName(call, tsLib);
    const fromQName = fromOwner === null ? fromModuleQName : `${fromModuleQName}::${fromOwner}`;
    const fromLabel = fromOwner === null ? NodeLabel.TsModule : NodeLabel.TsFunction;

    const fromNode = findNode(store, projectId, fromLabel, fromQName)
      ?? findNode(store, projectId, NodeLabel.ReactComponent, fromQName)
      ?? findNode(store, projectId, NodeLabel.TsClass, fromQName)
      ?? findNode(store, projectId, NodeLabel.TsModule, fromModuleQName);
    if (fromNode === null) continue;

    // Target node: try each label until we find the right one.
    const targetNode =
      findNode(store, projectId, NodeLabel.TsFunction, targetQName)
      ?? findNode(store, projectId, NodeLabel.ReactComponent, targetQName)
      ?? findNode(store, projectId, NodeLabel.TsClass, targetQName);
    if (targetNode === null) continue;

    // Don't duplicate an edge babel already emitted.
    if (edgeAlreadyExists(store, projectId, fromNode.id, targetNode.id, EdgeType.TsCalls)) continue;
    if (edgeAlreadyExists(store, projectId, fromNode.id, targetNode.id, EdgeType.TsRenders)) continue;

    const line = sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1;
    outEdges.push({
      projectId,
      sourceId: fromNode.id,
      targetId: targetNode.id,
      edgeType: targetNode.label === NodeLabel.ReactComponent ? EdgeType.TsRenders : EdgeType.TsCalls,
      confidence: Confidence.Resolved,
      sourceLine: line,
      properties: { via: "ts-compiler" },
    });
  }
}

function handleSignatureTypeRefs(
  decl: ts.FunctionDeclaration | ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  tsLib: typeof ts,
  fromModuleQName: string,
  fileToModuleQName: Map<string, string>,
  store: GraphStore,
  projectId: number,
  outEdges: EdgeInput[],
): void {
  const name = decl.name?.text;
  if (name === undefined) return;
  const fromQName = `${fromModuleQName}::${name}`;

  // Parameter types only (return type omitted to keep this pass cheap).
  const params = tsLib.isFunctionDeclaration(decl) ? decl.parameters : [];
  for (const param of params) {
    const typeNode = param.type;
    if (typeNode === undefined) continue;
    if (!tsLib.isTypeReferenceNode(typeNode)) continue;
    const tn = typeNode.typeName;
    let symbol = checker.getSymbolAtLocation(tn);
    if (symbol === undefined) continue;
    // Follow `import type { Foo } from "./types"` aliases through to the underlying declaration.
    // Without this we'd point at the ImportSpecifier node, not the real interface.
    if ((symbol.flags & tsLib.SymbolFlags.Alias) !== 0) {
      try {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== undefined) symbol = aliased;
      } catch {
        // best-effort
      }
    }
    const decls = symbol.getDeclarations();
    if (decls === undefined) continue;
    for (const d of decls) {
      const f = d.getSourceFile();
      if (f === undefined) continue;
      const declModuleQName = fileToModuleQName.get(f.fileName);
      if (declModuleQName === undefined) continue;
      const declName = getDeclarationName(d, tsLib);
      if (declName === null) continue;
      const toQName = `${declModuleQName}::${declName}`;

      const fromLabel = tsLib.isFunctionDeclaration(decl) ? NodeLabel.TsFunction : NodeLabel.TsClass;
      const fromNode =
        findNode(store, projectId, fromLabel, fromQName)
        ?? findNode(store, projectId, NodeLabel.ReactComponent, fromQName);
      if (fromNode === null) continue;
      const targetNode =
        findNode(store, projectId, NodeLabel.TsInterface, toQName)
        ?? findNode(store, projectId, NodeLabel.TsTypeAlias, toQName);
      if (targetNode === null) continue;
      if (edgeAlreadyExists(store, projectId, fromNode.id, targetNode.id, EdgeType.TsTypeReferences)) continue;
      outEdges.push({
        projectId,
        sourceId: fromNode.id,
        targetId: targetNode.id,
        edgeType: EdgeType.TsTypeReferences,
        confidence: Confidence.Resolved,
        sourceLine: param.getStart() !== undefined ? sourceFile.getLineAndCharacterOfPosition(param.getStart()).line + 1 : 0,
        properties: { via: "ts-compiler" },
      });
    }
  }
}

// For property-access expressions (`Foo.bar`), checker.getSymbolAtLocation on the whole
// expression returns the property symbol's binding only sometimes. We resolve the tail
// identifier directly when the symbol on the full expression is missing.
function resolveTailSymbol(expr: ts.Expression, checker: ts.TypeChecker, tsLib: typeof ts): ts.Symbol | undefined {
  if (tsLib.isPropertyAccessExpression(expr)) {
    return checker.getSymbolAtLocation(expr.name);
  }
  return undefined;
}

function getDeclarationName(decl: ts.Declaration, tsLib: typeof ts): string | null {
  if (tsLib.isFunctionDeclaration(decl) && decl.name !== undefined) return decl.name.text;
  if (tsLib.isClassDeclaration(decl) && decl.name !== undefined) return decl.name.text;
  if (tsLib.isInterfaceDeclaration(decl)) return decl.name.text;
  if (tsLib.isTypeAliasDeclaration(decl)) return decl.name.text;
  if (tsLib.isVariableDeclaration(decl) && tsLib.isIdentifier(decl.name)) return decl.name.text;
  if (tsLib.isImportSpecifier(decl)) return decl.name.text;
  if (tsLib.isImportClause(decl) && decl.name !== undefined) {
    // default import alias
    return decl.name.text;
  }
  // ExportAssignment etc. -> default
  return null;
}

// Walk up the AST to find the enclosing top-level function/class declaration's name. This
// matches babel's `fromOwner` convention so the same edge endpoints can be used.
function enclosingExportName(node: ts.Node, tsLib: typeof ts): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur !== undefined) {
    if (tsLib.isFunctionDeclaration(cur) && cur.name !== undefined) {
      return cur.name.text;
    }
    if (tsLib.isClassDeclaration(cur) && cur.name !== undefined) {
      return cur.name.text;
    }
    if (tsLib.isVariableDeclaration(cur) && tsLib.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return null;
}

function findNode(
  store: GraphStore,
  projectId: number,
  label: string,
  qname: string,
): { id: number; label: string } | null {
  return store.db
    .query<{ id: number; label: string }, [number, string, string]>(
      "SELECT id, label FROM nodes WHERE project_id = ? AND label = ? AND qualified_name = ?",
    )
    .get(projectId, label, qname);
}

function edgeAlreadyExists(
  store: GraphStore,
  projectId: number,
  fromId: number,
  toId: number,
  edgeType: string,
): boolean {
  type Row = { n: number };
  const row = store.db
    .query<Row, [number, number, number, string]>(
      "SELECT COUNT(*) AS n FROM edges WHERE project_id = ? AND source_id = ? AND target_id = ? AND edge_type = ?",
    )
    .get(projectId, fromId, toId, edgeType);
  return (row?.n ?? 0) > 0;
}
