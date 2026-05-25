// Parses flows/<name>.flow-meta.xml. v0.3 scope (design §6.9 minimum viable):
//   - Flow node with processType, triggerType/Object, status, apiVersion
//   - INVOCABLE_FROM_FLOW edges for actionCalls with actionType=apex
//   - FLOW_DML_ON edges for recordCreates / recordUpdates / recordDeletes / recordLookups
//   - FLOW_INVOKES_FLOW edges for subflows
//
// Deferred to v0.4+:
//   - Variable-to-SObject binding for resolving variableName.field references
//   - Assignments, decisions, formulas (formula walker integration)
//   - FlowChoice and screen field references

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
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

  // recordCreates / recordUpdates / recordDeletes / recordLookups -> FLOW_DML_ON
  for (const op of asArray(flow.recordCreates)) emitFlowDml(result, flowName, op, "insert");
  for (const op of asArray(flow.recordUpdates)) emitFlowDml(result, flowName, op, "update");
  for (const op of asArray(flow.recordDeletes)) emitFlowDml(result, flowName, op, "delete");
  for (const op of asArray(flow.recordLookups)) emitFlowDml(result, flowName, op, "select");

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
): void {
  if (op.object === undefined) return;
  result.edges.push({
    edgeType: EdgeType.FlowDmlOn,
    fromQName: flowName,
    fromLabel: NodeLabel.Flow,
    toQName: op.object,
    toLabel: NodeLabel.SObject,
    confidence: Confidence.Resolved,
    properties: { operation, flowElementName: op.name ?? null },
  });
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
