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
  // v0.8: short-name → Field nodes. A custom field name (`Late__c`) often exists on a
  // single SObject; the DML-write detection in the Apex parser emits a __SHORTNAME__:
  // qname which we resolve here. Returns the array of candidate Field nodes so callers
  // can decide whether to emit (single match: confident; many matches: emit one edge per
  // candidate at lower confidence; zero matches: drop).
  fieldsByShortName: Map<string, StoredNode[]>;
};

function buildSymbolTable(nodes: StoredNode[]): SymbolTable {
  const classByShortName = new Map<string, StoredNode>();
  const interfaceByShortName = new Map<string, StoredNode>();
  const methodByQName = new Map<string, StoredNode>();
  const methodsByClassAndName = new Map<string, StoredNode[]>();
  const nodeByLabelAndQName = new Map<string, StoredNode>();
  const fieldsByShortName = new Map<string, StoredNode[]>();

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
    } else if (node.label === NodeLabel.Field) {
      const key = node.name.toLowerCase();
      const arr = fieldsByShortName.get(key) ?? [];
      arr.push(node);
      fieldsByShortName.set(key, arr);
    }
  }

  return { classByShortName, interfaceByShortName, methodByQName, methodsByClassAndName, nodeByLabelAndQName, fieldsByShortName };
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

export function runPass2(
  projectId: number,
  unresolved: UnresolvedRef[],
  inFileEdges: ParsedEdge[],
  store: GraphStore,
): Pass2Diagnostics {
  const allNodes = getAllNodesForProject(store, projectId);
  const sym = buildSymbolTable(allNodes);

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
    let toNode = sym.nodeByLabelAndQName.get(toKey);

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

    // v0.8: short-name fallback for Field targets emitted by the Apex DML-write detector.
    // The parser emits "__SHORTNAME__:FieldName" qnames because it doesn't know the
    // receiver's SObject type. Strategy:
    //   - If exactly one Field node has that short name → resolve confidently.
    //   - If multiple candidates → disambiguate by which SObject the enclosing method has
    //     SOQL_QUERIES or DML_ON edges to. Only emit an edge if exactly one candidate's
    //     parent SObject matches the method's SOQL/DML context.
    //   - If still ambiguous → drop. Over-claiming on every same-named field across the
    //     org would tank precision (matrix has 4 SObjects with Status__c).
    if (toNode === undefined && e.toLabel === NodeLabel.Field && e.toQName.startsWith("__SHORTNAME__:")) {
      const shortName = e.toQName.slice("__SHORTNAME__:".length).toLowerCase();
      const candidates = sym.fieldsByShortName.get(shortName) ?? [];
      if (candidates.length === 1) {
        toNode = candidates[0];
      } else if (candidates.length > 1 && fromNode !== undefined) {
        // Look up the SObjects the enclosing method touches via SOQL_QUERIES or DML_ON.
        const methodSObjects = getMethodSObjectContext(store, projectId, fromNode.id);
        const matching = candidates.filter((c) => {
          const props = c.properties as Record<string, unknown> | undefined;
          const parent = props?.["parentSObject"];
          return typeof parent === "string" && methodSObjects.has(parent);
        });
        if (matching.length === 1) {
          toNode = matching[0];
        } else {
          // Either no SObject context match or still ambiguous — drop (precision-first).
          logger.debug(
            { fromId: fromNode.id, shortName, candidates: candidates.length, matched: matching.length },
            "pass2: DML-write field shortname unresolvable (precision-first drop)",
          );
          unresolvedCount++;
          continue;
        }
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

// v0.8: return the set of SObject API names that this method has SOQL_QUERIES or DML_ON
// edges to. Used to disambiguate DML-write field shortname resolution: if a method writes
// `Status__c` and the field exists on 4 SObjects, the one matching the method's SOQL/DML
// context is the intended target.
//
// Also includes the method's return type when it's an SObject (a helper like
// `Inbound_Staging__c buildBase(...)` constructs the object but doesn't DML/SOQL it; the
// return type is the strongest disambiguation signal we have without variable-type
// inference).
function getMethodSObjectContext(
  store: GraphStore,
  projectId: number,
  methodId: number,
): Set<string> {
  type Row = { qualified_name: string };
  const rows = store.db
    .query<Row, [number, number]>(
      `SELECT t.qualified_name AS qualified_name
       FROM edges e
       JOIN nodes t ON t.id = e.target_id
       WHERE e.project_id = ? AND e.source_id = ?
         AND t.label = 'SObject'
         AND e.edge_type IN ('SOQL_QUERIES', 'DML_ON')`,
    )
    .all(projectId, methodId);
  const sobjects = new Set(rows.map((r) => r.qualified_name));

  // Pull the method's own properties.returnType — match against SObject node names.
  type MethodRow = { properties: string };
  const methodRow = store.db
    .query<MethodRow, [number]>(
      `SELECT properties FROM nodes WHERE id = ?`,
    )
    .get(methodId);
  if (methodRow !== null) {
    try {
      const props = JSON.parse(methodRow.properties) as Record<string, unknown>;
      const returnType = props["returnType"];
      if (typeof returnType === "string" && returnType.endsWith("__c")) {
        sobjects.add(returnType);
      }
      // Also include parameter types — `void setStatus(Inbound_Staging__c rec)`.
      const params = props["parameters"];
      if (Array.isArray(params)) {
        for (const p of params) {
          if (typeof p === "object" && p !== null && "type" in p) {
            const t = (p as { type: unknown }).type;
            if (typeof t === "string" && t.endsWith("__c")) sobjects.add(t);
          }
        }
      }
    } catch {
      // best-effort
    }
  }

  return sobjects;
}
