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
  interfaceByShortName: Map<string, StoredNode>;
  methodByQName: Map<string, StoredNode>;
  methodsByClassAndName: Map<string, StoredNode[]>;
  nodeByLabelAndQName: Map<string, StoredNode>;
};

function buildSymbolTable(nodes: StoredNode[]): SymbolTable {
  const classByShortName = new Map<string, StoredNode>();
  const interfaceByShortName = new Map<string, StoredNode>();
  const methodByQName = new Map<string, StoredNode>();
  const methodsByClassAndName = new Map<string, StoredNode[]>();
  const nodeByLabelAndQName = new Map<string, StoredNode>();

  for (const node of nodes) {
    const key = `${node.label}::${node.qualifiedName}`;
    nodeByLabelAndQName.set(key, node);

    if (node.label === NodeLabel.ApexClass) {
      classByShortName.set(node.name.toLowerCase(), node);
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

  return { classByShortName, interfaceByShortName, methodByQName, methodsByClassAndName, nodeByLabelAndQName };
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

type EdgeRecord = {
  sourceId: number;
  targetId: number;
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

export function runPass2(
  projectId: number,
  unresolved: UnresolvedRef[],
  inFileEdges: ParsedEdge[],
  store: GraphStore,
): Pass2Diagnostics {
  const allNodes = getAllNodesForProject(store, projectId);
  const sym = buildSymbolTable(allNodes);
  const resolveSoql = soqlResolver(allNodes);

  let resolvedCount = 0;
  let unresolvedCount = 0;
  const edgesToInsert: EdgeRecord[] = [];

  // Write in-file structural edges. For some cross-domain edges (LWC→Apex, etc.) the parser
  // emits a target qname in short form ("AccountService.cleanup") because the source format
  // doesn't carry parameter types. Fall back to a short-name lookup when exact-qname misses.
  for (const e of inFileEdges) {
    const fromKey = `${e.fromLabel}::${e.fromQName}`;
    const toKey = `${e.toLabel}::${e.toQName}`;
    const fromNode = sym.nodeByLabelAndQName.get(fromKey);
    let toNode = e.properties?.["soqlObjectPath"] ? resolveSoql(e) : sym.nodeByLabelAndQName.get(toKey);

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
      const parentClass = sym.classByShortName.get(ref.parentName.toLowerCase());
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
      const targetClass = sym.classByShortName.get(ref.typeName.toLowerCase());
      const fromNode = sym.methodByQName.get(ref.fromMethodQName);
      if (fromNode === undefined || targetClass === undefined) {
        logger.debug({ from: ref.fromMethodQName, typeName: ref.typeName }, "pass2: instantiation unresolved");
        unresolvedCount++;
        continue;
      }
      const rec: EdgeRecord = { sourceId: fromNode.id, targetId: targetClass.id, edgeType: EdgeType.Instantiates, confidence: Confidence.Resolved, sourceLine: ref.sourceLine, sourceFile: ref.sourceFile };
      edgesToInsert.push(rec);
      resolvedCount++;

    } else if (ref.kind === "call") {
      const fromNode = sym.methodByQName.get(ref.fromMethodQName);
      if (fromNode === undefined) { unresolvedCount++; continue; }

      let resolved: { node: StoredNode; confidence: number } | null = null;

      if (ref.receiverText === null) {
        const parenIdx = ref.fromMethodQName.indexOf("(");
        const withoutSig = parenIdx !== -1 ? ref.fromMethodQName.slice(0, parenIdx) : ref.fromMethodQName;
        const dotIdx = withoutSig.lastIndexOf(".");
        const enclosingClass = dotIdx !== -1 ? withoutSig.slice(0, dotIdx) : withoutSig;
        const lookupKey = `${enclosingClass}.${ref.calleeName}`.toLowerCase();
        const overloads = sym.methodsByClassAndName.get(lookupKey);
        if (overloads !== undefined && overloads.length > 0) {
          resolved = pickBestOverload(overloads, ref.argCount);
        }
      } else {
        const receiverLower = ref.receiverText.toLowerCase();
        const staticClass = sym.classByShortName.get(receiverLower);
        if (staticClass !== undefined) {
          const lookupKey = `${staticClass.name}.${ref.calleeName}`.toLowerCase();
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
      for (const e of edgesToInsert) {
        try {
          store.insertEdge({
            projectId,
            sourceId: e.sourceId,
            targetId: e.targetId,
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
