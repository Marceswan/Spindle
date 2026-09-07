// Flow structure plus statically bound field references. Relationship traversal,
// screen/choice-specific field declarations and dynamic resource evaluation are not resolved.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { extractFormulaFieldReferences } from "./formula.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type ActionCall = {
  name?: string;
  actionName?: string;
  actionType?: string;
};

type RecordOp = {
  name?: string;
  object?: string;
  inputReference?: string;
  outputReference?: string;
  storeOutputAutomatically?: boolean;
};

type Subflow = {
  name?: string;
  flowName?: string;
};

type FlowStart = {
  object?: string;
  triggerType?: string;
  recordTriggerType?: string;
};

type FlowXml = {
  Flow?: {
    apiVersion?: number;
    processType?: string;
    status?: string;
    label?: string;
    interviewLabel?: string;
    start?: FlowStart;
    actionCalls?: ActionCall | ActionCall[];
    recordCreates?: RecordOp | RecordOp[];
    recordUpdates?: RecordOp | RecordOp[];
    recordDeletes?: RecordOp | RecordOp[];
    recordLookups?: RecordOp | RecordOp[];
    subflows?: Subflow | Subflow[];
    variables?: { name?: string; objectType?: string } | { name?: string; objectType?: string }[];
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) =>
    name === "actionCalls" ||
    name === "recordCreates" ||
    name === "recordUpdates" ||
    name === "recordDeletes" ||
    name === "recordLookups" ||
    name === "subflows",
});

export function parseFlow(filePath: string, source: string): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: FlowXml;
  try {
    parsed = xmlParser.parse(source) as FlowXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const flow = parsed.Flow;
  if (flow === undefined) return result;

  const flowName = basename(filePath).replace(/\.flow-meta\.xml$/, "");
  const totalLines = source.split("\n").length;

  result.nodes.push({
    label: NodeLabel.Flow,
    name: flowName,
    qualifiedName: flowName,
    startLine: 1,
    endLine: totalLines,
    properties: {
      apiVersion: flow.apiVersion ?? null,
      processType: flow.processType ?? null,
      status: flow.status ?? null,
      label: flow.label ?? flowName,
      triggerType: flow.start?.triggerType ?? null,
      triggerObject: flow.start?.object ?? null,
      recordTriggerType: flow.start?.recordTriggerType ?? null,
    },
  });

  // If the flow is record-triggered, emit a TRIGGERS_ON-style edge so this Flow shows up
  // when asking "what fires when X is updated". We reuse FLOW_DML_ON with operation="trigger"
  // to keep the edge type set small — alternative would be a dedicated FLOW_TRIGGERED_ON.
  if (flow.start?.object !== undefined && flow.start?.triggerType !== undefined) {
    result.edges.push({
      edgeType: EdgeType.FlowDmlOn,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: flow.start.object,
      toLabel: NodeLabel.SObject,
      confidence: Confidence.Resolved,
      properties: {
        operation: "trigger",
        triggerType: flow.start.triggerType,
        recordTriggerType: flow.start.recordTriggerType ?? null,
      },
    });
  }

  // actionCalls -> INVOCABLE_FROM_FLOW
  for (const ac of asArray(flow.actionCalls)) {
    if (ac.actionType !== "apex") continue;
    if (ac.actionName === undefined) continue;
    // actionName is the Apex class name (the @InvocableMethod-bearing class). We don't know
    // the method's parameter list from the Flow alone; pass2's short-name fallback resolves
    // to the @InvocableMethod-annotated method when one matches.
    result.edges.push({
      edgeType: EdgeType.InvocableFromFlow,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: ac.actionName,
      toLabel: NodeLabel.ApexClass,
      confidence: Confidence.Heuristic,
      properties: { actionName: ac.actionName, flowElementName: ac.name ?? null },
    });
  }

  const bindings = new Map<string, string>();
  for (const variable of asArray(flow.variables)) {
    if (variable.name && variable.objectType) bindings.set(variable.name, variable.objectType);
  }
  if (flow.start?.object) {
    bindings.set("$Record", flow.start.object);
    bindings.set("$Record__Prior", flow.start.object);
  }
  for (const lookup of asArray(flow.recordLookups)) {
    if (!lookup.object) continue;
    if (lookup.name && lookup.storeOutputAutomatically === true) bindings.set(lookup.name, lookup.object);
    if (lookup.outputReference) bindings.set(lookup.outputReference, lookup.object);
  }
  extractFields(result, flowName, flow, bindings);

  // recordCreates / recordUpdates / recordDeletes / recordLookups -> FLOW_DML_ON
  for (const op of asArray(flow.recordCreates)) emitFlowDml(result, flowName, op, "insert", bindings);
  for (const op of asArray(flow.recordUpdates)) emitFlowDml(result, flowName, op, "update", bindings);
  for (const op of asArray(flow.recordDeletes)) emitFlowDml(result, flowName, op, "delete", bindings);
  for (const op of asArray(flow.recordLookups)) emitFlowDml(result, flowName, op, "select", bindings);

  // subflows -> FLOW_INVOKES_FLOW
  for (const sf of asArray(flow.subflows)) {
    if (sf.flowName === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.FlowInvokesFlow,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: sf.flowName,
      toLabel: NodeLabel.Flow,
      confidence: Confidence.Resolved,
      properties: { subflowElementName: sf.name ?? null },
    });
  }

  return result;
}

function emitFlowDml(
  result: ParseResult,
  flowName: string,
  op: RecordOp,
  operation: "insert" | "update" | "delete" | "select",
  bindings: Map<string, string>,
): void {
  const object = op.object ?? bindings.get(op.inputReference ?? "");
  if (object === undefined) return;
  result.edges.push({
    edgeType: EdgeType.FlowDmlOn,
    fromQName: flowName,
    fromLabel: NodeLabel.Flow,
    toQName: object,
    toLabel: NodeLabel.SObject,
    confidence: Confidence.Resolved,
    properties: { operation, flowElementName: op.name ?? null },
  });
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function extractFields(
  result: ParseResult,
  flowName: string,
  flow: NonNullable<FlowXml["Flow"]>,
  bindings: Map<string, string>,
): void {
  const seen = new Set<string>();
  const warned = new Set<string>();
  const referenceKeys = new Set(["elementReference", "assignToReference", "leftValueReference", "rightValueReference", "inputReference"]);
  const recordSections = new Set(["start", "recordCreates", "recordUpdates", "recordDeletes", "recordLookups"]);
  const warn = (ref: string): void => {
    if (warned.has(ref)) return;
    warned.add(ref);
    result.warnings.push({ message: `Flow ${flowName}: unresolved field reference ${ref} (unknown record binding or relationship traversal)`, line: 0 });
  };
  const emit = (qname: string, element: string, context: string, formula: boolean): void => {
    const key = `${qname}:${element}:${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.edges.push({
      edgeType: EdgeType.FlowUsesField, fromQName: flowName, fromLabel: NodeLabel.Flow,
      toQName: qname, toLabel: NodeLabel.Field,
      confidence: formula ? Confidence.Regex : Confidence.Resolved,
      properties: { flowElementName: element, context },
    });
  };
  const resolve = (value: string, element: string, context: string, formula = false): void => {
    const ref = value.trim().replace(/^\{!\s*|\s*\}$/g, "");
    if (!ref.includes(".")) return; // Scalar resources and record variables aren't fields.
    const parts = ref.split(".");
    const object = bindings.get(parts[0] ?? "");
    if (!object || parts.length !== 2 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[1] ?? "")) {
      if (!ref.startsWith("$") || ref.startsWith("$Record")) warn(ref);
      return;
    }
    emit(`${object}.${parts[1]}`, element, context, formula);
  };
  const walk = (value: unknown, element: string, context: string, object?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, element, context, object);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && referenceKeys.has(key)) resolve(child, element, context);
      else if (key === "expression" && typeof child === "string") {
        // The shared formula walker is intentionally conservative. Remove literal strings
        // and comments first; only dotted resources with explicit record bindings qualify.
        const expression = child.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g, " ");
        for (const ref of extractFormulaFieldReferences(expression, "")) {
          if (!ref.startsWith(".")) resolve(ref, element, "formula", true);
        }
      } else if (object && (key === "field" || key === "queriedFields" || key === "sortField")) {
        for (const field of asArray(child)) {
          if (typeof field !== "string") continue;
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) emit(`${object}.${field}`, element, context, false);
          else warn(`${object}.${field}`);
        }
      } else walk(child, element, context, object);
    }
  };
  for (const [section, value] of Object.entries(flow)) {
    for (const item of asArray(value)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const element = typeof record.name === "string" ? record.name : section;
      const object = recordSections.has(section)
        ? typeof record.object === "string" ? record.object : bindings.get(String(record.inputReference ?? ""))
        : undefined;
      walk(item, element, section, object);
    }
  }
}
