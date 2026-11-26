// Pass 2: Intra-domain reference resolution.
// Builds the project symbol table from pass 1 nodes, then resolves:
//   - EXTENDS edges (class -> class/interface)
//   - IMPLEMENTS edges (class -> interface)
//   - INSTANTIATES edges (method -> class)
//   - CALLS edges (method -> method) for same-project static + unqualified calls
// Also writes the in-file structural edges (DEFINES_METHOD, DEFINES_PROPERTY,
// TRIGGERS_ON, SOQL_QUERIES, SOSL_QUERIES) from the ParsedEdge list into the DB.

import type { ParsedEdge, UnresolvedRef } from "../parsers/apex/types.ts";
import type { GraphStore, StoredNode } from "../graph/store.ts";
import { getAllNodesForProject, getNodeByQName } from "../graph/queries.ts";
import { NodeLabel } from "../model/node-labels.ts";
import { EdgeType } from "../model/edge-types.ts";
import { Confidence } from "../model/confidence.ts";
import { logger } from "../util/logger.ts";

export type Pass2Diagnostics = {
  resolvedCount: number;
  unresolvedCount: number;
};

type SymbolTable = {
  classByShortName: Map<string, StoredNode>;
  // Short names that more than one class has (inner classes such as Wrapper or Request).
  ambiguousClassNames: Set<string>;
  classByQName: Map<string, StoredNode>;
  interfaceByShortName: Map<string, StoredNode>;
  methodByQName: Map<string, StoredNode>;
  methodsByClassAndName: Map<string, StoredNode[]>;
  nodeByLabelAndQName: Map<string, StoredNode>;
  // SObject and Field nodes by lower-case qualified name: API names ignore case.
  objectOrFieldByLowerQName: Map<string, StoredNode>;
};

const isPlaceholderNode = (node: StoredNode): boolean => node.properties?.["isPlaceholder"] === true;

function buildSymbolTable(nodes: StoredNode[]): SymbolTable {
  const classByShortName = new Map<string, StoredNode>();
  const classByQName = new Map<string, StoredNode>();
  const ambiguousClassNames = new Set<string>();
  const interfaceByShortName = new Map<string, StoredNode>();
  const methodByQName = new Map<string, StoredNode>();
  const methodsByClassAndName = new Map<string, StoredNode[]>();
  const nodeByLabelAndQName = new Map<string, StoredNode>();
  const objectOrFieldByLowerQName = new Map<string, StoredNode>();

  for (const node of nodes) {
    const key = `${node.label}::${node.qualifiedName}`;
    nodeByLabelAndQName.set(key, node);
    if (node.label === NodeLabel.SObject || node.label === NodeLabel.Field) {
      const lowerKey = key.toLowerCase();
      const existing = objectOrFieldByLowerQName.get(lowerKey);
      // A real node wins over a placeholder.
      if (existing === undefined || (isPlaceholderNode(existing) && !isPlaceholderNode(node))) {
        objectOrFieldByLowerQName.set(lowerKey, node);
      }
    }

    if (node.label === NodeLabel.ApexClass) {
      const shortName = node.name.toLowerCase();
      if (classByShortName.has(shortName)) ambiguousClassNames.add(shortName);
      classByShortName.set(shortName, node);
      classByQName.set(node.qualifiedName.toLowerCase(), node);
    } else if (node.label === NodeLabel.ApexInterface) {
      interfaceByShortName.set(node.name.toLowerCase(), node);
    } else if (node.label === NodeLabel.ApexMethod) {
      methodByQName.set(node.qualifiedName, node);
      const parenIdx = node.qualifiedName.indexOf("(");
      if (parenIdx !== -1) {
        const withoutSig = node.qualifiedName.slice(0, parenIdx);
        const mapKey = withoutSig.toLowerCase();
        const existing = methodsByClassAndName.get(mapKey) ?? [];
        existing.push(node);
        methodsByClassAndName.set(mapKey, existing);
      }
    }
  }

  return { classByShortName, ambiguousClassNames, classByQName, interfaceByShortName, methodByQName, methodsByClassAndName, nodeByLabelAndQName, objectOrFieldByLowerQName };
}

function getArgCount(qname: string): number {
  const m = /\(([^)]*)\)/.exec(qname);
  if (m === null) return 0;
  const inner = m[1]?.trim() ?? "";
  if (inner === "") return 0;
  return inner.split(",").length;
}

function pickBestOverload(overloads: StoredNode[], argCount: number): { node: StoredNode; confidence: number } {
  const exact = overloads.filter((o) => getArgCount(o.qualifiedName) === argCount);
  if (exact.length === 1) return { node: exact[0] as StoredNode, confidence: Confidence.Resolved };
  if (exact.length > 1) return { node: exact[0] as StoredNode, confidence: Confidence.Ambiguous };
  const zeroArity = overloads.filter((o) => getArgCount(o.qualifiedName) === 0);
  if (zeroArity.length > 0) return { node: zeroArity[0] as StoredNode, confidence: Confidence.Ambiguous };
  return { node: overloads[0] as StoredNode, confidence: Confidence.Ambiguous };
}

// The class that contains a method or trigger body: the qualified name without the
// signature and without the last part.
function enclosingClassOf(siteQName: string): string {
  const parenIdx = siteQName.indexOf("(");
  const withoutSig = parenIdx !== -1 ? siteQName.slice(0, parenIdx) : siteQName;
  const dotIdx = withoutSig.lastIndexOf(".");
  return dotIdx !== -1 ? withoutSig.slice(0, dotIdx) : withoutSig;
}

// Resolves a class name as Apex does: first as a member of each enclosing class, from the
// innermost outward, then as a qualified name. A bare short name is the last choice, and
// only when exactly one class has it; a guess between two classes gives a wrong edge.
function resolveClass(sym: SymbolTable, name: string, enclosingClass: string): StoredNode | undefined {
  const lower = name.toLowerCase();
  let scope = enclosingClass.toLowerCase();
  while (scope !== "") {
    const member = sym.classByQName.get(`${scope}.${lower}`);
    if (member !== undefined) return member;
    const dotIdx = scope.lastIndexOf(".");
    scope = dotIdx === -1 ? "" : scope.slice(0, dotIdx);
  }
  const qualified = sym.classByQName.get(lower);
  if (qualified !== undefined) return qualified;
  return sym.ambiguousClassNames.has(lower) ? undefined : sym.classByShortName.get(lower);
}

// A call or instantiation site is a method, or the trigger itself for a trigger body.
function callSite(sym: SymbolTable, qname: string): StoredNode | undefined {
  return sym.methodByQName.get(qname) ?? sym.nodeByLabelAndQName.get(`${NodeLabel.ApexTrigger}::${qname}`);
}

type EdgeRecord = {
  sourceId: number;
  targetId: number;
  // Set for a target that a placeholder stands for: its id is known only after the write.
  targetNode?: StoredNode | undefined;
  edgeType: (typeof EdgeType)[keyof typeof EdgeType];
  confidence: number;
  sourceFile?: string | undefined;
  sourceLine?: number | undefined;
  properties?: Record<string, unknown> | undefined;
};

// Relationship names require metadata: never infer a child object from its plural name.
function soqlResolver(nodes: StoredNode[]): (edge: ParsedEdge) => StoredNode | undefined {
  const byName = new Map(nodes.map(n => [`${n.label}::${n.qualifiedName}`.toLowerCase(), n]));
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, target: string): void => {
    const set = map.get(key.toLowerCase()) ?? new Set<string>();
    set.add(target.toLowerCase());
    map.set(key.toLowerCase(), set);
  };
  for (const node of nodes) {
    if (node.label !== NodeLabel.Field) continue;
    const props = node.properties ?? {};
    const target = props["referenceTo"];
    if (typeof target !== "string") continue;
    const object = node.qualifiedName.slice(0, node.qualifiedName.lastIndexOf("."));
    const parentRelation = node.name.endsWith("__c") ? `${node.name.slice(0,-3)}__r` : node.name.endsWith("Id") ? node.name.slice(0,-2) : node.name;
    add(parents, `${object}.${parentRelation}`, target);
    const childRelation = props["relationshipName"];
    if (typeof childRelation === "string") {
      const apiRelation = node.name.endsWith("__c") && !childRelation.endsWith("__r") ? `${childRelation}__r` : childRelation;
      add(children, `${target}.${apiRelation}`, object);
    }
  }
  const unique = (map: Map<string,Set<string>>, key: string): string | undefined => {
    const matches = map.get(key.toLowerCase());
    return matches?.size === 1 ? [...matches][0] : undefined;
  };
  return (edge: ParsedEdge): StoredNode | undefined => {
    const path = edge.properties?.["soqlObjectPath"];
    if (!Array.isArray(path) || !path.every(p => typeof p === "string") || !path[0]) return undefined;
    let object: string = path[0];
    for (const child of path.slice(1)) {
      const target = unique(children, `${object}.${child.split(".").pop()}`);
      if (!target) return undefined;
      object = target;
    }
    if (edge.toLabel === NodeLabel.SObject) return byName.get(`${NodeLabel.SObject}::${object}`.toLowerCase());
    const fieldPath = edge.properties?.["soqlFieldPath"];
    if (typeof fieldPath !== "string") return undefined;
    const parts = fieldPath.split(".");
    for (const relation of parts.slice(0,-1)) {
      const target = unique(parents, `${object}.${relation}`);
      if (!target) return undefined;
      object = target;
    }
    return byName.get(`${NodeLabel.Field}::${object}.${parts.at(-1)}`.toLowerCase());
  };
}

// Finds the Apex class whose `@RestResource(urlMapping=...)` serves an Apex REST path. A
// mapping is an exact path, or a path that ends with `/*`. The longest mapping that matches
// wins. A `*` part in the path is a part that the caller builds at run time.
function apexRestResolver(nodes: StoredNode[]): (path: string) => StoredNode | undefined {
  const resources: { mapping: string; node: StoredNode }[] = [];
  for (const node of nodes) {
    const mapping = node.label === NodeLabel.ApexClass ? node.properties?.["restUrlMapping"] : undefined;
    if (typeof mapping === "string" && mapping !== "") resources.push({ mapping: mapping.replace(/\/+$/, ""), node });
  }
  resources.sort((a, b) => b.mapping.length - a.mapping.length);
  return (path: string): StoredNode | undefined => {
    for (const { mapping, node } of resources) {
      if (mapping.endsWith("/*")) {
        const prefix = mapping.slice(0, -2);
        if (path === prefix || path.startsWith(`${prefix}/`)) return node;
      } else if (path === mapping) {
        return node;
      }
    }
    return undefined;
  };
}

const API_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The qualified name of the placeholder that an unresolved edge target may get, or null.
// Regex-tier edges (Visualforce bindings, validation formulas, FlexiPage component properties,
// email merge fields) never create a placeholder: their token scans also match text that is
// not a field, and a placeholder for it would add a false node. Only edges at Heuristic
// confidence or higher do, and only for an SObject or a Field target.
function placeholderQName(e: ParsedEdge): string | null {
  if (e.toLabel !== NodeLabel.SObject && e.toLabel !== NodeLabel.Field) return null;
  if (e.confidence < Confidence.Heuristic) return null;
  let qname = e.toQName;
  const objectPath = e.properties?.["soqlObjectPath"];
  if (objectPath !== undefined) {
    // A SOQL edge: a relationship or a child path needs relationship metadata that is not here.
    if (!Array.isArray(objectPath) || objectPath.length !== 1 || typeof objectPath[0] !== "string") return null;
    if (e.toLabel === NodeLabel.SObject) {
      qname = objectPath[0];
    } else {
      const fieldPath = e.properties?.["soqlFieldPath"];
      if (typeof fieldPath !== "string" || fieldPath.includes(".")) return null;
      qname = `${objectPath[0]}.${fieldPath}`;
    }
  }
  const parts = qname.split(".");
  if (e.toLabel === NodeLabel.SObject ? parts.length !== 1 : parts.length !== 2) return null;
  return parts.every((part) => API_NAME.test(part)) ? qname : null;
}

export function runPass2(
  projectId: number,
  unresolved: UnresolvedRef[],
  inFileEdges: ParsedEdge[],
  store: GraphStore,
): Pass2Diagnostics {
  // One node per API name, whatever the spelling, before the symbol table is built.
  store.mergeCaseVariantPlaceholders(projectId);
  const allNodes = getAllNodesForProject(store, projectId);
  const sym = buildSymbolTable(allNodes);
  const resolveSoql = soqlResolver(allNodes);
  const resolveApexRest = apexRestResolver(allNodes);

  let resolvedCount = 0;
  let unresolvedCount = 0;
  const edgesToInsert: EdgeRecord[] = [];
  // Placeholders made in this run. Their ids are set in the write transaction below.
  const newPlaceholders: StoredNode[] = [];

  // Write in-file structural edges. For some cross-domain edges (LWC→Apex, etc.) the parser
  // emits a target qname in short form ("AccountService.cleanup") because the source format
  // doesn't carry parameter types. Fall back to a short-name lookup when exact-qname misses.
  for (const e of inFileEdges) {
    const fromKey = `${e.fromLabel}::${e.fromQName}`;
    const toKey = `${e.toLabel}::${e.toQName}`;
    const fromNode = sym.nodeByLabelAndQName.get(fromKey);
    let toNode = e.properties?.["soqlObjectPath"] ? resolveSoql(e) : sym.nodeByLabelAndQName.get(toKey);

    // SObject and Field targets: API names ignore case, and a target that no node stands for
    // may get a placeholder. A SOQL edge that needs relationship metadata is not looked up by
    // its toQName: only the resolver may follow a relationship.
    if (toNode === undefined && (e.toLabel === NodeLabel.SObject || e.toLabel === NodeLabel.Field)) {
      const qname = placeholderQName(e);
      const lookupName = qname ?? (e.properties?.["soqlObjectPath"] === undefined ? e.toQName : null);
      const lowerKey = lookupName === null ? "" : `${e.toLabel}::${lookupName}`.toLowerCase();
      if (lookupName !== null) toNode = sym.objectOrFieldByLowerQName.get(lowerKey);
      if (toNode === undefined && qname !== null && fromNode !== undefined) {
        const parts = qname.split(".");
        toNode = {
          id: -1,
          projectId,
          label: e.toLabel,
          name: parts[parts.length - 1] as string,
          qualifiedName: qname,
          filePath: null,
          startLine: null,
          endLine: null,
          properties: e.toLabel === NodeLabel.Field ? { isPlaceholder: true, parentSObject: parts[0] } : { isPlaceholder: true },
          contentHash: null,
        };
        sym.nodeByLabelAndQName.set(`${e.toLabel}::${qname}`, toNode);
        sym.objectOrFieldByLowerQName.set(lowerKey, toNode);
        newPlaceholders.push(toNode);
      }
    }

    // An Apex REST path names no class: the class is the one whose urlMapping serves the path.
    const apexRestPath = e.properties?.["apexRestPath"];
    if (toNode === undefined && e.toLabel === NodeLabel.ApexClass && typeof apexRestPath === "string") {
      toNode = resolveApexRest(apexRestPath);
    }

    // Short-name fallback for ApexMethod targets (LWC@salesforce/apex imports, etc.).
    if (toNode === undefined && e.toLabel === NodeLabel.ApexMethod) {
      const overloads = sym.methodsByClassAndName.get(e.toQName.toLowerCase());
      if (overloads !== undefined && overloads.length > 0) {
        // Prefer @AuraEnabled overload; otherwise pick first.
        const auraEnabled = overloads.find((o) => {
          const props = o.properties as Record<string, unknown> | undefined;
          return props !== undefined && props["isAuraEnabled"] === true;
        });
        toNode = auraEnabled ?? overloads[0];
      }
    }

    if (fromNode === undefined || toNode === undefined) {
      logger.debug({ from: e.fromQName, to: e.toQName, type: e.edgeType }, "pass2: in-file edge endpoints not found");
      unresolvedCount++;
      continue;
    }

    const rec: EdgeRecord = {
      sourceId: fromNode.id,
      targetId: toNode.id,
      targetNode: toNode,
      edgeType: e.edgeType,
      confidence: e.confidence,
    };
    if (e.sourceLine !== undefined) rec.sourceLine = e.sourceLine;
    if (e.properties !== undefined) rec.properties = e.properties;
    edgesToInsert.push(rec);
    resolvedCount++;
  }

  // Resolve cross-file refs.
  for (const ref of unresolved) {
    if (ref.kind === "extends") {
      const parentClass = resolveClass(sym, ref.parentName, ref.classQName);
      const parentIface = sym.interfaceByShortName.get(ref.parentName.toLowerCase());
      const fromKey = `${NodeLabel.ApexClass}::${ref.classQName}`;
      const fromIfaceKey = `${NodeLabel.ApexInterface}::${ref.classQName}`;
      const fromNode = sym.nodeByLabelAndQName.get(fromKey) ?? sym.nodeByLabelAndQName.get(fromIfaceKey);
      const toNode = parentClass ?? parentIface;
      if (fromNode === undefined || toNode === undefined) {
        logger.debug({ classQName: ref.classQName, parentName: ref.parentName }, "pass2: extends unresolved");
        unresolvedCount++;
        continue;
      }
      edgesToInsert.push({ sourceId: fromNode.id, targetId: toNode.id, edgeType: EdgeType.Extends, confidence: Confidence.Resolved, sourceLine: ref.sourceLine });
      resolvedCount++;

    } else if (ref.kind === "implements") {
      const iface = sym.interfaceByShortName.get(ref.interfaceName.toLowerCase());
      const fromKey = `${NodeLabel.ApexClass}::${ref.classQName}`;
      const fromNode = sym.nodeByLabelAndQName.get(fromKey);
      if (fromNode === undefined || iface === undefined) {
        logger.debug({ classQName: ref.classQName, interfaceName: ref.interfaceName }, "pass2: implements unresolved");
        unresolvedCount++;
        continue;
      }
      edgesToInsert.push({ sourceId: fromNode.id, targetId: iface.id, edgeType: EdgeType.Implements, confidence: Confidence.Resolved, sourceLine: ref.sourceLine });
      resolvedCount++;

    } else if (ref.kind === "new") {
      const targetClass = resolveClass(sym, ref.typeName, enclosingClassOf(ref.fromMethodQName));
      const fromNode = callSite(sym, ref.fromMethodQName);
      if (fromNode === undefined || targetClass === undefined) {
        logger.debug({ from: ref.fromMethodQName, typeName: ref.typeName }, "pass2: instantiation unresolved");
        unresolvedCount++;
        continue;
      }
      const rec: EdgeRecord = { sourceId: fromNode.id, targetId: targetClass.id, edgeType: EdgeType.Instantiates, confidence: Confidence.Resolved, sourceLine: ref.sourceLine, sourceFile: ref.sourceFile };
      edgesToInsert.push(rec);
      resolvedCount++;

    } else if (ref.kind === "call") {
      const fromNode = callSite(sym, ref.fromMethodQName);
      if (fromNode === undefined) { unresolvedCount++; continue; }

      let resolved: { node: StoredNode; confidence: number } | null = null;

      // `this.foo()` calls a method of the enclosing class, the same as `foo()`.
      if (ref.receiverText === null || ref.receiverText.toLowerCase() === "this") {
        const enclosingClass = enclosingClassOf(ref.fromMethodQName);
        const lookupKey = `${enclosingClass}.${ref.calleeName}`.toLowerCase();
        const overloads = sym.methodsByClassAndName.get(lookupKey);
        if (overloads !== undefined && overloads.length > 0) {
          resolved = pickBestOverload(overloads, ref.argCount);
        }
      } else {
        const staticClass = resolveClass(sym, ref.receiverText, enclosingClassOf(ref.fromMethodQName));
        if (staticClass !== undefined) {
          // Methods are keyed by the qualified class name; an inner class has more than one part.
          const lookupKey = `${staticClass.qualifiedName}.${ref.calleeName}`.toLowerCase();
          const overloads = sym.methodsByClassAndName.get(lookupKey);
          if (overloads !== undefined && overloads.length > 0) {
            resolved = pickBestOverload(overloads, ref.argCount);
          }
        }
      }

      if (resolved === null) {
        logger.debug({ from: ref.fromMethodQName, callee: ref.calleeName, receiver: ref.receiverText }, "pass2: call unresolved");
        unresolvedCount++;
        continue;
      }

      const rec: EdgeRecord = { sourceId: fromNode.id, targetId: resolved.node.id, edgeType: EdgeType.Calls, confidence: resolved.confidence, sourceLine: ref.sourceLine, sourceFile: ref.sourceFile };
      edgesToInsert.push(rec);
      resolvedCount++;
    }
    // soql kind: SOQL_QUERIES edges already emitted as in-file edges by the parser.
  }

  if (edgesToInsert.length > 0) {
    store.transaction(() => {
      for (const node of newPlaceholders) {
        node.id = store.ensurePlaceholderNode({
          projectId,
          label: node.label,
          name: node.name,
          qualifiedName: node.qualifiedName,
          properties: node.properties,
        });
      }
      for (const e of edgesToInsert) {
        try {
          store.insertEdge({
            projectId,
            sourceId: e.sourceId,
            targetId: e.targetNode?.id ?? e.targetId,
            edgeType: e.edgeType,
            confidence: e.confidence,
            ...(e.sourceFile !== undefined ? { sourceFile: e.sourceFile } : {}),
            ...(e.sourceLine !== undefined ? { sourceLine: e.sourceLine } : {}),
            ...(e.properties !== undefined ? { properties: e.properties } : {}),
          });
        } catch (err) {
          logger.warn({ err, edgeType: e.edgeType }, "pass2: failed to insert edge");
        }
      }
    });
  }

  logger.info({ projectId, resolvedCount, unresolvedCount }, "pass2: complete");
  return { resolvedCount, unresolvedCount };
}

export function getNodeByLabelAndQName(
  store: GraphStore,
  projectId: number,
  label: (typeof NodeLabel)[keyof typeof NodeLabel],
  qname: string,
): StoredNode | null {
  return getNodeByQName(store, projectId, label, qname);
}
