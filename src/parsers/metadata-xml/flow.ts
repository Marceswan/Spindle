// Flow structure plus statically bound field references. This includes record fields on
// screens, the fields of record and picklist choice sets, and `{!resource.Field}` merge fields
// in text. Relationship traversal and dynamic resource evaluation are not resolved.

import { basename } from "node:path";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { extractFormulaFieldReferences } from "./formula.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";
import { createXmlParser, xmlBool, xmlNumber, xmlText } from "./xml.ts";

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
  storeOutputAutomatically?: string;
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
    apiVersion?: string;
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

const xmlParser = createXmlParser({
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
      apiVersion: xmlNumber(flow.apiVersion),
      processType: xmlText(flow.processType) ?? null,
      status: xmlText(flow.status) ?? null,
      label: xmlText(flow.label) ?? flowName,
      triggerType: xmlText(flow.start?.triggerType) ?? null,
      triggerObject: xmlText(flow.start?.object) ?? null,
      recordTriggerType: xmlText(flow.start?.recordTriggerType) ?? null,
    },
  });

  // If the flow is record-triggered, emit a TRIGGERS_ON-style edge so this Flow shows up
  // when asking "what fires when X is updated". We reuse FLOW_DML_ON with operation="trigger"
  // to keep the edge type set small — alternative would be a dedicated FLOW_TRIGGERED_ON.
  const startObject = xmlText(flow.start?.object);
  const startTriggerType = xmlText(flow.start?.triggerType);
  if (startObject !== undefined && startTriggerType !== undefined) {
    result.edges.push({
      edgeType: EdgeType.FlowDmlOn,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: startObject,
      toLabel: NodeLabel.SObject,
      confidence: Confidence.Resolved,
      properties: {
        operation: "trigger",
        triggerType: startTriggerType,
        recordTriggerType: xmlText(flow.start?.recordTriggerType) ?? null,
      },
    });
  }

  // actionCalls -> INVOCABLE_FROM_FLOW
  for (const ac of asArray(flow.actionCalls)) {
    if (xmlText(ac.actionType) !== "apex") continue;
    const actionName = xmlText(ac.actionName);
    if (actionName === undefined) continue;
    // actionName is the Apex class name (the @InvocableMethod-bearing class). We don't know
    // the method's parameter list from the Flow alone; pass2's short-name fallback resolves
    // to the @InvocableMethod-annotated method when one matches.
    result.edges.push({
      edgeType: EdgeType.InvocableFromFlow,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: actionName,
      toLabel: NodeLabel.ApexClass,
      confidence: Confidence.Heuristic,
      properties: { actionName, flowElementName: xmlText(ac.name) ?? null },
    });
  }

  const bindings = new Map<string, string>();
  for (const variable of asArray(flow.variables)) {
    const varName = xmlText(variable.name);
    const varType = xmlText(variable.objectType);
    if (varName && varType) bindings.set(varName, varType);
  }
  if (startObject) {
    bindings.set("$Record", startObject);
    bindings.set("$Record__Prior", startObject);
  }
  for (const lookup of asArray(flow.recordLookups)) {
    const lookupObject = xmlText(lookup.object);
    if (!lookupObject) continue;
    const lookupName = xmlText(lookup.name);
    const outputReference = xmlText(lookup.outputReference);
    if (lookupName && xmlBool(lookup.storeOutputAutomatically) === true) bindings.set(lookupName, lookupObject);
    if (outputReference) bindings.set(outputReference, lookupObject);
  }
  extractFields(result, flowName, flow, bindings);

  // recordCreates / recordUpdates / recordDeletes / recordLookups -> FLOW_DML_ON
  for (const op of asArray(flow.recordCreates)) emitFlowDml(result, flowName, op, "insert", bindings);
  for (const op of asArray(flow.recordUpdates)) emitFlowDml(result, flowName, op, "update", bindings);
  for (const op of asArray(flow.recordDeletes)) emitFlowDml(result, flowName, op, "delete", bindings);
  for (const op of asArray(flow.recordLookups)) emitFlowDml(result, flowName, op, "select", bindings);

  // subflows -> FLOW_INVOKES_FLOW
  for (const sf of asArray(flow.subflows)) {
    const subflowName = xmlText(sf.flowName);
    if (subflowName === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.FlowInvokesFlow,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: subflowName,
      toLabel: NodeLabel.Flow,
      confidence: Confidence.Resolved,
      properties: { subflowElementName: xmlText(sf.name) ?? null },
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
  const object = xmlText(op.object) ?? bindings.get(xmlText(op.inputReference) ?? "");
  if (object === undefined) return;
  result.edges.push({
    edgeType: EdgeType.FlowDmlOn,
    fromQName: flowName,
    fromLabel: NodeLabel.Flow,
    toQName: object,
    toLabel: NodeLabel.SObject,
    confidence: Confidence.Resolved,
    properties: { operation, flowElementName: xmlText(op.name) ?? null },
  });
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Text values are never converted, so a literal such as `001`, `1.5`, `1e3`, `0x1F` or `true`
// reaches the walk as a string. No flow resource or field API name starts with a digit or sign,
// and `true`/`false` are not references, so literals are never taken for field references.
const LITERAL_VALUE = /^(?:[+-]?(?:\d|\.\d)|true$|false$)/;

// A merge field in display text: `{!resource}` or `{!resource.Field}`.
const MERGE_FIELD = /\{!\s*(\$?[A-Za-z_][A-Za-z0-9_.]*)\s*\}/g;

function isLiteral(value: string): boolean {
  return LITERAL_VALUE.test(value.trim());
}

function extractFields(
  result: ParseResult,
  flowName: string,
  flow: NonNullable<FlowXml["Flow"]>,
  bindings: Map<string, string>,
): void {
  const seen = new Set<string>();
  const warned = new Set<string>();
  const referenceKeys = new Set(["elementReference", "assignToReference", "leftValueReference", "rightValueReference", "inputReference", "objectFieldReference"]);
  // Keys that name a field of the object that the same element declares.
  const fieldKeys = new Set(["field", "queriedFields", "sortField", "displayField", "valueField", "picklistField"]);
  // Keys that hold text for a person to read. A `{!resource.Field}` merge field can occur in it.
  const mergeTextKeys = new Set(["fieldText", "helpText", "pausedText", "choiceText", "errorMessage", "text", "stringValue"]);
  const recordSections = new Set(["start", "recordCreates", "recordUpdates", "recordDeletes", "recordLookups", "dynamicChoiceSets"]);
  const warn = (ref: string): void => {
    if (warned.has(ref)) return;
    warned.add(ref);
    result.warnings.push({ message: `Flow ${flowName}: unresolved field reference ${ref} (unknown record binding or relationship traversal)`, line: 0 });
  };
  const emit = (qname: string, element: string, context: string, textScan: boolean): void => {
    const key = `${qname}:${element}:${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.edges.push({
      edgeType: EdgeType.FlowUsesField, fromQName: flowName, fromLabel: NodeLabel.Flow,
      toQName: qname, toLabel: NodeLabel.Field,
      confidence: textScan ? Confidence.Regex : Confidence.Resolved,
      properties: { flowElementName: element, context },
    });
  };
  const resolve = (value: string, element: string, context: string, textScan = false): void => {
    const ref = value.trim().replace(/^\{!\s*|\s*\}$/g, "");
    if (isLiteral(ref)) return;
    if (!ref.includes(".")) return; // Scalar resources and record variables aren't fields.
    const parts = ref.split(".");
    const object = bindings.get(parts[0] ?? "");
    if (!object || parts.length !== 2 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[1] ?? "")) {
      if (!ref.startsWith("$") || ref.startsWith("$Record")) warn(ref);
      return;
    }
    emit(`${object}.${parts[1]}`, element, context, textScan);
  };
  const walk = (value: unknown, element: string, context: string, object?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, element, context, object);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && referenceKeys.has(key)) resolve(child, element, context);
      else if (typeof child === "string" && mergeTextKeys.has(key)) {
        // Only the explicit `{!...}` form qualifies. Plain text that looks like a reference does not.
        for (const merge of child.matchAll(MERGE_FIELD)) resolve(merge[1] ?? "", element, context, true);
      } else if (key === "expression" && typeof child === "string") {
        if (isLiteral(child)) continue;
        // The shared formula walker is intentionally conservative. Remove literal strings
        // and comments first; only dotted resources with explicit record bindings qualify.
        const expression = child.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g, " ");
        for (const ref of extractFormulaFieldReferences(expression, "")) {
          if (!ref.startsWith(".")) resolve(ref, element, "formula", true);
        }
      } else if (object && fieldKeys.has(key)) {
        for (const field of asArray(child)) {
          if (typeof field !== "string" || isLiteral(field)) continue;
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
        ? typeof record.object === "string" ? record.object
          : typeof record.picklistObject === "string" ? record.picklistObject
          : bindings.get(String(record.inputReference ?? ""))
        : undefined;
      walk(item, element, section, object);
    }
  }
}
