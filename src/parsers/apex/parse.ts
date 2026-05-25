// Apex parser. Pure function: takes (filePath, source) and returns nodes/edges/unresolvedRefs.
// Uses @apexdevtools/apex-parser (ANTLR) for the parse tree, then walks it to extract structural
// nodes, intra-file edges, and cross-file unresolved references for later passes to resolve.
//
// See sections 5.x and 6.1 of the design doc.

import {
  ApexLexer,
  ApexParser,
  AnnotationContext,
  CaseInsensitiveInputStream,
  ClassDeclarationContext,
  ClassBodyDeclarationContext,
  CompilationUnitContext,
  CreatorContext,
  DotExpressionContext,
  DotMethodCallContext,
  EnumDeclarationContext,
  FieldDeclarationContext,
  InterfaceDeclarationContext,
  MethodCallContext,
  MethodDeclarationContext,
  ModifierContext,
  PropertyDeclarationContext,
  SoqlLiteralContext,
  SoslLiteralContext,
  TriggerUnitContext,
  TypeDeclarationContext,
  TypeRefContext,
} from "@apexdevtools/apex-parser";
import { CharStreams, CommonTokenStream, ParserRuleContext } from "antlr4ts";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";

import { extractSoqlFromObject, extractSoqlSelectFields, extractSoslReturningObjects } from "./soql-extract.ts";
import type { ParseResult } from "./types.ts";

export function parseApex(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let tree: ParserRuleContext;
  let isTrigger = false;
  try {
    const { parser, kind } = buildParser(source, filePath);
    if (kind === "trigger") {
      tree = parser.triggerUnit();
      isTrigger = true;
    } else {
      tree = parser.compilationUnit();
    }
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  if (isTrigger) {
    walkTriggerUnit(tree as TriggerUnitContext, filePath, result);
  } else {
    walkCompilationUnit(tree as CompilationUnitContext, filePath, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parser construction
// ---------------------------------------------------------------------------

type ParserKind = "compilation" | "trigger";

type BuildParserResult = {
  parser: ApexParser;
  kind: ParserKind;
};

function buildParser(source: string, filePath: string): BuildParserResult {
  const inputStream = CharStreams.fromString(source);
  const lexer = new ApexLexer(new CaseInsensitiveInputStream(inputStream));
  lexer.removeErrorListeners();
  const tokens = new CommonTokenStream(lexer);
  const parser = new ApexParser(tokens);
  parser.removeErrorListeners();
  const kind: ParserKind = filePath.endsWith(".trigger") ? "trigger" : "compilation";
  return { parser, kind };
}

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

function walkCompilationUnit(
  unit: CompilationUnitContext,
  filePath: string,
  result: ParseResult,
): void {
  const decl = unit.typeDeclaration();
  walkTopLevelType(decl, filePath, result);
}

function walkTopLevelType(
  decl: TypeDeclarationContext,
  filePath: string,
  result: ParseResult,
): void {
  const cls = decl.classDeclaration();
  if (cls !== undefined) {
    walkClass(cls, decl.modifier(), null, filePath, result);
    return;
  }
  const iface = decl.interfaceDeclaration();
  if (iface !== undefined) {
    walkInterface(iface, decl.modifier(), null, filePath, result);
    return;
  }
  const enm = decl.enumDeclaration();
  if (enm !== undefined) {
    walkEnum(enm, decl.modifier(), null, filePath, result);
  }
}

function walkClass(
  cls: ClassDeclarationContext,
  modifiers: ModifierContext[],
  parentQName: string | null,
  filePath: string,
  result: ParseResult,
): void {
  const name = cls.id().text;
  const qualifiedName = parentQName === null ? name : `${parentQName}.${name}`;
  const startLine = cls.start.line;
  const endLine = cls.stop?.line ?? startLine;

  const sharing = readSharingFromModifiers(modifiers);
  const isAbstract = modifiers.some((m) => m.ABSTRACT() !== undefined);
  const isVirtual = modifiers.some((m) => m.VIRTUAL() !== undefined);
  const annotations = collectAnnotations(modifiers);
  const isTest = annotations.some((a) => a.toLowerCase() === "istest");

  const extendsRef = cls.typeRef();
  const extendsName = extendsRef !== undefined ? typeRefSimpleName(extendsRef) : null;

  const implementsList = cls.typeList();
  const implementsNames = implementsList
    ? implementsList.typeRef().map((r) => typeRefSimpleName(r))
    : [];

  result.nodes.push({
    label: NodeLabel.ApexClass,
    name,
    qualifiedName,
    startLine,
    endLine,
    properties: {
      sharing,
      isAbstract,
      isVirtual,
      extendsClass: extendsName,
      implementsInterfaces: implementsNames,
      isTest,
      annotations,
      isInner: parentQName !== null,
      parentQName,
    },
  });

  if (extendsName !== null) {
    result.unresolved.push({
      kind: "extends",
      classQName: qualifiedName,
      parentName: extendsName,
      sourceFile: filePath,
      sourceLine: startLine,
    });
  }
  for (const ifaceName of implementsNames) {
    result.unresolved.push({
      kind: "implements",
      classQName: qualifiedName,
      interfaceName: ifaceName,
      sourceFile: filePath,
      sourceLine: startLine,
    });
  }

  const body = cls.classBody();
  for (const bodyDecl of body.classBodyDeclaration()) {
    walkClassBodyDeclaration(bodyDecl, qualifiedName, filePath, result);
  }
}

function walkInterface(
  iface: InterfaceDeclarationContext,
  _modifiers: ModifierContext[],
  parentQName: string | null,
  filePath: string,
  result: ParseResult,
): void {
  const name = iface.id().text;
  const qualifiedName = parentQName === null ? name : `${parentQName}.${name}`;
  const startLine = iface.start.line;
  const endLine = iface.stop?.line ?? startLine;

  const extendsList = iface.typeList();
  const extendsNames = extendsList
    ? extendsList.typeRef().map((r) => typeRefSimpleName(r))
    : [];

  result.nodes.push({
    label: NodeLabel.ApexInterface,
    name,
    qualifiedName,
    startLine,
    endLine,
    properties: { extendsInterfaces: extendsNames, isInner: parentQName !== null },
  });

  for (const parentName of extendsNames) {
    result.unresolved.push({
      kind: "extends",
      classQName: qualifiedName,
      parentName,
      sourceFile: filePath,
      sourceLine: startLine,
    });
  }
}

function walkEnum(
  enm: EnumDeclarationContext,
  _modifiers: ModifierContext[],
  parentQName: string | null,
  _filePath: string,
  result: ParseResult,
): void {
  const name = enm.id().text;
  const qualifiedName = parentQName === null ? name : `${parentQName}.${name}`;
  result.nodes.push({
    label: NodeLabel.ApexEnum,
    name,
    qualifiedName,
    startLine: enm.start.line,
    endLine: enm.stop?.line ?? enm.start.line,
    properties: { isInner: parentQName !== null },
  });
}

function walkTriggerUnit(
  unit: TriggerUnitContext,
  filePath: string,
  result: ParseResult,
): void {
  const ids = unit.id();
  // Trigger MyTrigger on SObjectName ( ... )
  const triggerName = ids[0]?.text ?? "UnnamedTrigger";
  const sobjectName = ids[1]?.text ?? "Unknown";
  const events = unit
    .triggerCase()
    .map(triggerCaseToString)
    .filter((e): e is string => e !== null);

  const startLine = unit.start.line;
  const endLine = unit.stop?.line ?? startLine;

  result.nodes.push({
    label: NodeLabel.ApexTrigger,
    name: triggerName,
    qualifiedName: triggerName,
    startLine,
    endLine,
    properties: { sobject: sobjectName, events },
  });

  // SObject placeholder + TRIGGERS_ON edge.
  ensureSObjectPlaceholder(result, sobjectName, filePath, startLine);
  result.edges.push({
    edgeType: EdgeType.TriggersOn,
    fromQName: triggerName,
    fromLabel: NodeLabel.ApexTrigger,
    toQName: sobjectName,
    toLabel: NodeLabel.SObject,
    confidence: Confidence.Resolved,
    sourceLine: startLine,
    properties: { events },
  });

  // Walk the trigger body for SOQL/DML and method calls. We don't synthesize a "main" method
  // for the trigger body in v0.1; calls and SOQL inside a trigger are attributed to the trigger
  // qname itself.
  const block = unit.triggerBlock();
  walkExpressionsAndStatements(block, triggerName, filePath, result);
}

function triggerCaseToString(ctx: ParserRuleContext): string | null {
  // TriggerCase enumerates BEFORE/AFTER and INSERT/UPDATE/UPSERT/DELETE/UNDELETE/MERGE.
  // The simplest correct mapping is to concatenate the literal terminal tokens; ANTLR keeps the
  // source casing of identifiers via .text on tokens.
  const txt = ctx.text;
  // Convert e.g. "beforeinsert" -> "before insert" by inserting a space between known prefixes.
  const lower = txt.toLowerCase();
  const prefixes = ["before", "after"];
  for (const p of prefixes) {
    if (lower.startsWith(p)) {
      return `${p} ${lower.slice(p.length)}`;
    }
  }
  return lower;
}

function walkClassBodyDeclaration(
  decl: ClassBodyDeclarationContext,
  classQName: string,
  filePath: string,
  result: ParseResult,
): void {
  const modifiers = decl.modifier();
  const member = decl.memberDeclaration();
  if (member === undefined) return;

  const method = member.methodDeclaration();
  if (method !== undefined) {
    walkMethod(method, modifiers, classQName, filePath, result);
    return;
  }

  const ctor = member.constructorDeclaration();
  if (ctor !== undefined) {
    // Constructors aren't called out separately in the design doc; record as ApexMethod with
    // name == class short name.
    const className = classQName.split(".").pop() ?? classQName;
    const params = ctor.formalParameters();
    const paramTypes: string[] = [];
    const list = params.formalParameterList();
    if (list !== undefined) {
      for (const fp of list.formalParameter()) {
        paramTypes.push(typeRefSimpleName(fp.typeRef()));
      }
    }
    const qname = `${classQName}.${className}(${paramTypes.join(", ")})`;
    const startLine = ctor.start.line;
    const endLine = ctor.stop?.line ?? startLine;

    result.nodes.push({
      label: NodeLabel.ApexMethod,
      name: className,
      qualifiedName: qname,
      startLine,
      endLine,
      properties: {
        returnType: null,
        parameters: paramTypes.map((t) => ({ type: t })),
        modifiers: collectModifierKeywords(modifiers),
        annotations: collectAnnotations(modifiers),
        isStatic: false,
        isConstructor: true,
        isTestMethod: false,
        isAuraEnabled: false,
        isInvocableMethod: false,
        isFuture: false,
        isRemoteAction: false,
      },
    });

    result.edges.push({
      edgeType: EdgeType.DefinesMethod,
      fromQName: classQName,
      fromLabel: NodeLabel.ApexClass,
      toQName: qname,
      toLabel: NodeLabel.ApexMethod,
      confidence: Confidence.Resolved,
      sourceLine: startLine,
    });

    const body = ctor.block();
    if (body !== undefined) {
      walkExpressionsAndStatements(body, qname, filePath, result);
    }
    return;
  }

  const prop = member.propertyDeclaration();
  if (prop !== undefined) {
    walkProperty(prop, modifiers, classQName, result);
    return;
  }

  const field = member.fieldDeclaration();
  if (field !== undefined) {
    walkField(field, modifiers, classQName, result);
    return;
  }

  // Nested type declarations.
  const innerClass = member.classDeclaration();
  if (innerClass !== undefined) {
    walkClass(innerClass, modifiers, classQName, filePath, result);
    return;
  }
  const innerIface = member.interfaceDeclaration();
  if (innerIface !== undefined) {
    walkInterface(innerIface, modifiers, classQName, filePath, result);
    return;
  }
  const innerEnum = member.enumDeclaration();
  if (innerEnum !== undefined) {
    walkEnum(innerEnum, modifiers, classQName, filePath, result);
  }
}

function walkMethod(
  method: MethodDeclarationContext,
  modifiers: ModifierContext[],
  classQName: string,
  filePath: string,
  result: ParseResult,
): void {
  const methodName = method.id().text;
  const returnType = method.VOID() !== undefined ? "void" : typeRefOptionalName(method.typeRef());

  const paramTypes: string[] = [];
  const params = method.formalParameters().formalParameterList();
  if (params !== undefined) {
    for (const fp of params.formalParameter()) {
      paramTypes.push(typeRefSimpleName(fp.typeRef()));
    }
  }

  const qname = `${classQName}.${methodName}(${paramTypes.join(", ")})`;
  const startLine = method.start.line;
  const endLine = method.stop?.line ?? startLine;

  const annotations = collectAnnotations(modifiers);
  const annotationsLower = annotations.map((a) => a.toLowerCase());
  const modifierKeywords = collectModifierKeywords(modifiers);

  result.nodes.push({
    label: NodeLabel.ApexMethod,
    name: methodName,
    qualifiedName: qname,
    startLine,
    endLine,
    properties: {
      returnType,
      parameters: paramTypes.map((t) => ({ type: t })),
      modifiers: modifierKeywords,
      annotations,
      isStatic: modifiers.some((m) => m.STATIC() !== undefined),
      isConstructor: false,
      isTestMethod: annotationsLower.includes("istest"),
      isAuraEnabled: annotationsLower.includes("auraenabled"),
      isInvocableMethod: annotationsLower.includes("invocablemethod"),
      isFuture: annotationsLower.includes("future"),
      isRemoteAction: annotationsLower.includes("remoteaction"),
      isHttpEndpoint: annotationsLower.some((a) =>
        ["httpget", "httppost", "httpput", "httppatch", "httpdelete"].includes(a),
      ),
    },
  });

  result.edges.push({
    edgeType: EdgeType.DefinesMethod,
    fromQName: classQName,
    fromLabel: NodeLabel.ApexClass,
    toQName: qname,
    toLabel: NodeLabel.ApexMethod,
    confidence: Confidence.Resolved,
    sourceLine: startLine,
  });

  const body = method.block();
  if (body !== undefined) {
    walkExpressionsAndStatements(body, qname, filePath, result);
  }
}

function walkProperty(
  prop: PropertyDeclarationContext,
  modifiers: ModifierContext[],
  classQName: string,
  result: ParseResult,
): void {
  const name = prop.id().text;
  const qname = `${classQName}.${name}`;
  result.nodes.push({
    label: NodeLabel.ApexProperty,
    name,
    qualifiedName: qname,
    startLine: prop.start.line,
    endLine: prop.stop?.line ?? prop.start.line,
    properties: {
      type: typeRefSimpleName(prop.typeRef()),
      modifiers: collectModifierKeywords(modifiers),
      annotations: collectAnnotations(modifiers),
      isStatic: modifiers.some((m) => m.STATIC() !== undefined),
    },
  });
  result.edges.push({
    edgeType: EdgeType.DefinesProperty,
    fromQName: classQName,
    fromLabel: NodeLabel.ApexClass,
    toQName: qname,
    toLabel: NodeLabel.ApexProperty,
    confidence: Confidence.Resolved,
    sourceLine: prop.start.line,
  });
}

function walkField(
  field: FieldDeclarationContext,
  modifiers: ModifierContext[],
  classQName: string,
  result: ParseResult,
): void {
  // Apex "fields" (member variables) — we model them as properties for v0.1 so they show up in
  // `search_graph` and can carry references in later passes. The design doc distinguishes
  // ApexField from ApexProperty in spirit but only ApexProperty exists as a label; we encode the
  // distinction via properties.isMemberVariable.
  const typeName = typeRefSimpleName(field.typeRef());
  const declarators = field.variableDeclarators().variableDeclarator();
  for (const v of declarators) {
    const name = v.id().text;
    const qname = `${classQName}.${name}`;
    result.nodes.push({
      label: NodeLabel.ApexProperty,
      name,
      qualifiedName: qname,
      startLine: v.start.line,
      endLine: v.stop?.line ?? v.start.line,
      properties: {
        type: typeName,
        modifiers: collectModifierKeywords(modifiers),
        annotations: collectAnnotations(modifiers),
        isStatic: modifiers.some((m) => m.STATIC() !== undefined),
        isMemberVariable: true,
      },
    });
    result.edges.push({
      edgeType: EdgeType.DefinesProperty,
      fromQName: classQName,
      fromLabel: NodeLabel.ApexClass,
      toQName: qname,
      toLabel: NodeLabel.ApexProperty,
      confidence: Confidence.Resolved,
      sourceLine: v.start.line,
    });
  }
}

// ---------------------------------------------------------------------------
// Expression / statement walking for calls, instantiations, SOQL.
// ---------------------------------------------------------------------------

function walkExpressionsAndStatements(
  ctx: ParserRuleContext,
  enclosingQName: string,
  filePath: string,
  result: ParseResult,
): void {
  recurse(ctx);

  function recurse(node: ParserRuleContext): void {
    // We use instanceof to identify contexts we care about. ANTLR uses class identity so this
    // works reliably as long as we import from the same package.

    if (node instanceof MethodCallContext) {
      // Unqualified calls: `purge()`, `doSomething(x)`.
      const id = node.id();
      if (id !== undefined) {
        const calleeName = id.text;
        const argCount = node.expressionList()?.expression().length ?? 0;
        // receiverFromDotExpression returns null for unqualified calls.
        const receiverText = receiverFromDotExpression(node);
        result.unresolved.push({
          kind: "call",
          fromMethodQName: enclosingQName,
          receiverText,
          calleeName,
          argCount,
          sourceFile: filePath,
          sourceLine: node.start.line,
        });
      }
    } else if (node instanceof DotMethodCallContext) {
      // Qualified calls: `AccountService.cleanup()`, `svc.doThing()`.
      // The DotMethodCallContext lives inside a DotExpressionContext; the left side of the dot
      // is the receiver. Walk up to the parent DotExpressionContext to extract it.
      const anyId = node.anyId();
      if (anyId !== undefined) {
        const calleeName = anyId.text;
        const argCount = node.expressionList()?.expression().length ?? 0;
        // Receiver is the expression on the left of the dot in the parent DotExpression.
        let receiverText: string | null = null;
        let parent: ParserRuleContext | undefined = node.parent;
        while (parent !== undefined) {
          if (parent instanceof DotExpressionContext) {
            receiverText = parent.expression().text;
            break;
          }
          parent = parent.parent;
        }
        result.unresolved.push({
          kind: "call",
          fromMethodQName: enclosingQName,
          receiverText,
          calleeName,
          argCount,
          sourceFile: filePath,
          sourceLine: node.start.line,
        });
      }
    } else if (node instanceof CreatorContext) {
      const created = node.createdName();
      const typeName = createdNameSimple(created);
      if (typeName !== null) {
        result.unresolved.push({
          kind: "new",
          fromMethodQName: enclosingQName,
          typeName,
          sourceFile: filePath,
          sourceLine: node.start.line,
        });
      }
    } else if (node instanceof SoqlLiteralContext) {
      const info = extractSoqlFromObject(node.text);
      if (info !== null) {
        ensureSObjectPlaceholder(result, info.fromObject, filePath, node.start.line);
        result.unresolved.push({
          kind: "soql",
          fromMethodQName: enclosingQName,
          fromObject: info.fromObject,
          rawText: node.text,
          sourceFile: filePath,
          sourceLine: node.start.line,
        });
        result.edges.push({
          edgeType: EdgeType.SoqlQueries,
          fromQName: enclosingQName,
          fromLabel: NodeLabel.ApexMethod,
          toQName: info.fromObject,
          toLabel: NodeLabel.SObject,
          confidence: Confidence.Regex,
          sourceLine: node.start.line,
          properties: { raw: truncate(node.text, 200) },
        });

        // v0.2 task #15: emit one REFERENCES_FIELD edge per simple identifier in the SELECT
        // clause. Pass 2 drops edges whose Field node isn't in the graph (standard objects,
        // unmodelled custom fields) — leaving the coarse SOQL_QUERIES edge as the fallback.
        const selectFields = extractSoqlSelectFields(node.text);
        for (const fieldName of selectFields) {
          const fieldQName = `${info.fromObject}.${fieldName}`;
          result.edges.push({
            edgeType: EdgeType.ReferencesField,
            fromQName: enclosingQName,
            fromLabel: NodeLabel.ApexMethod,
            toQName: fieldQName,
            toLabel: NodeLabel.Field,
            confidence: Confidence.Regex,
            sourceLine: node.start.line,
            properties: { context: "SOQL_SELECT", parentSObject: info.fromObject },
          });
        }
      }
    } else if (node instanceof SoslLiteralContext) {
      const objects = extractSoslReturningObjects(node.text);
      for (const objName of objects) {
        ensureSObjectPlaceholder(result, objName, filePath, node.start.line);
        result.edges.push({
          edgeType: EdgeType.SoslQueries,
          fromQName: enclosingQName,
          fromLabel: NodeLabel.ApexMethod,
          toQName: objName,
          toLabel: NodeLabel.SObject,
          confidence: Confidence.Regex,
          sourceLine: node.start.line,
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.getChild(i);
      if (child instanceof ParserRuleContext) {
        recurse(child);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Receiver detection: walk up from a MethodCall to its containing DotExpression
// to capture the receiver text (the part before the `.`).
// ---------------------------------------------------------------------------

function receiverFromDotExpression(call: MethodCallContext): string | null {
  // Apex grammar: `obj.method(args)` parses as DotExpression( expression() , dotMethodCall(...) ).
  // The MethodCall lives inside a DotMethodCall, whose parent is a DotExpression.
  let parent: ParserRuleContext | undefined = call.parent;
  while (parent !== undefined) {
    if (parent instanceof DotExpressionContext) {
      const left = parent.expression();
      return left.text;
    }
    parent = parent.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readSharingFromModifiers(modifiers: ModifierContext[]): "with" | "without" | "inherited" {
  // Apex 'with sharing' / 'without sharing' / 'inherited sharing' are encoded via WITH/WITHOUT/
  // INHERITED + SHARING terminals on ModifierContext. The apex-parser exposes each as its own
  // accessor. Order matters: 'inherited sharing' beats 'with sharing' beats 'without sharing'.
  if (modifiers.some((m) => m.INHERITED() !== undefined && m.SHARING() !== undefined)) {
    return "inherited";
  }
  if (modifiers.some((m) => m.WITH() !== undefined && m.SHARING() !== undefined)) {
    return "with";
  }
  if (modifiers.some((m) => m.WITHOUT() !== undefined && m.SHARING() !== undefined)) {
    return "without";
  }
  return "inherited";
}

function collectModifierKeywords(modifiers: ModifierContext[]): string[] {
  const out: string[] = [];
  for (const m of modifiers) {
    if (m.PUBLIC() !== undefined) out.push("public");
    if (m.PRIVATE() !== undefined) out.push("private");
    if (m.PROTECTED() !== undefined) out.push("protected");
    if (m.GLOBAL() !== undefined) out.push("global");
    if (m.STATIC() !== undefined) out.push("static");
    if (m.ABSTRACT() !== undefined) out.push("abstract");
    if (m.FINAL() !== undefined) out.push("final");
    if (m.VIRTUAL() !== undefined) out.push("virtual");
    if (m.OVERRIDE() !== undefined) out.push("override");
    if (m.WEBSERVICE() !== undefined) out.push("webservice");
    if (m.TRANSIENT() !== undefined) out.push("transient");
  }
  return out;
}

function collectAnnotations(modifiers: ModifierContext[]): string[] {
  const out: string[] = [];
  for (const m of modifiers) {
    const a = m.annotation();
    if (a !== undefined) out.push(annotationName(a));
  }
  return out;
}

function annotationName(a: AnnotationContext): string {
  // qualifiedName -> id ('.' id)*
  return a.qualifiedName().id().map((i) => i.text).join(".");
}

function typeRefSimpleName(ref: TypeRefContext): string {
  // typeRef = typeName ('.' typeName)* arraySubscripts. For our purposes we want the leaf
  // identifier of the last typeName, optionally with generic params elided.
  const parts = ref.typeName().map((tn) => {
    const id = tn.id();
    if (id !== undefined) return id.text;
    if (tn.LIST() !== undefined) return "List";
    if (tn.SET() !== undefined) return "Set";
    if (tn.MAP() !== undefined) return "Map";
    return "Object";
  });
  return parts.join(".");
}

function typeRefOptionalName(ref: TypeRefContext | undefined): string | null {
  return ref === undefined ? null : typeRefSimpleName(ref);
}

function createdNameSimple(created: ReturnType<CreatorContext["createdName"]>): string | null {
  const pairs = created.idCreatedNamePair();
  if (pairs.length === 0) return null;
  return pairs.map((p) => p.anyId().text).join(".");
}

function ensureSObjectPlaceholder(
  result: ParseResult,
  name: string,
  filePath: string,
  line: number,
): void {
  // Placeholder SObject node. Real SObject nodes from metadata XML (v0.2) will be upserted on
  // the same qualified_name and replace this placeholder's properties.
  if (result.nodes.some((n) => n.label === NodeLabel.SObject && n.qualifiedName === name)) {
    return;
  }
  result.nodes.push({
    label: NodeLabel.SObject,
    name,
    qualifiedName: name,
    startLine: line,
    endLine: line,
    properties: { isPlaceholder: true, firstSeenIn: filePath },
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

