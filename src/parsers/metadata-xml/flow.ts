// Parses flows/<name>.flow-meta.xml.
//
// v0.3 (shipped): Flow node + INVOCABLE_FROM_FLOW (apex actionCalls) + FLOW_DML_ON
// (recordCreates/Updates/Deletes/Lookups, SObject-level) + FLOW_INVOKES_FLOW (subflows).
//
// Advanced Flow extraction (this phase): per-field FLOW_REFERENCES_FIELD edges so the Flow
// becomes an authoritative field-impact surface, analogous to VALIDATION_REFERENCES_FIELD.
// Field references are pulled from record-element field lists/filters/assignments, decisions,
// assignments, and formula resources. A variable->SObject binding table (built locally, in
// this pure parser) resolves `myVar.Field__c` references to `Object__c.Field__c` (tier 1).
// References whose root variable isn't bound fall back to a `__SHORTNAME__:Field` qname
// (tier 2) that pass2's fieldsByShortName resolver places (single candidate) or drops
// (ambiguous, precision-first) — the same path the Apex DML-write detector uses.
//
// The coarse FLOW_DML_ON edges are retained as the include_indirect fallback in
// get_field_usage; the new per-field edges are the authoritative path.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult, ParsedEdge } from "../apex/types.ts";
import { extractFormulaFieldReferences } from "./formula.ts";

type ActionCall = { name?: string; actionName?: string; actionType?: string };
type Subflow = { name?: string; flowName?: string };

type Value = { elementReference?: string };
type Filter = { field?: string; value?: Value };
type InputAssignment = { field?: string; value?: Value };
type RecordOp = {
  name?: string;
  object?: string;
  queriedFields?: string | string[];
  sortField?: string;
  filters?: Filter | Filter[];
  inputAssignments?: InputAssignment | InputAssignment[];
  outputReference?: string;
  outputAssignments?: { field?: string } | { field?: string }[];
};

type AssignmentItem = { assignToReference?: string; value?: Value };
type Assignment = { name?: string; assignmentItems?: AssignmentItem | AssignmentItem[] };

type Condition = { leftValueReference?: string; rightValue?: Value };
type DecisionRule = { name?: string; conditions?: Condition | Condition[] };
type Decision = { name?: string; rules?: DecisionRule | DecisionRule[] };

type FormulaResource = { name?: string; expression?: string };

type FlowVariable = { name?: string; objectType?: string; dataType?: string };

type FlowStart = {
  object?: string;
  triggerType?: string;
  recordTriggerType?: string;
  filters?: Filter | Filter[];
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
    assignments?: Assignment | Assignment[];
    decisions?: Decision | Decision[];
    formulas?: FormulaResource | FormulaResource[];
    variables?: FlowVariable | FlowVariable[];
  };
};

const ARRAY_ELEMENTS = new Set([
  "actionCalls",
  "recordCreates",
  "recordUpdates",
  "recordDeletes",
  "recordLookups",
  "subflows",
  "assignments",
  "decisions",
  "formulas",
  "variables",
  "queriedFields",
  "filters",
  "inputAssignments",
  "outputAssignments",
  "assignmentItems",
  "rules",
  "conditions",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => ARRAY_ELEMENTS.has(name),
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
  const triggerObject = flow.start?.object;

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

  // Record-triggered: emit FLOW_DML_ON operation="trigger" (unchanged).
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

  // actionCalls -> INVOCABLE_FROM_FLOW (unchanged).
  for (const ac of asArray(flow.actionCalls)) {
    if (ac.actionType !== "apex") continue;
    if (ac.actionName === undefined) continue;
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

  // recordCreates/Updates/Deletes/Lookups -> coarse FLOW_DML_ON (unchanged).
  for (const op of asArray(flow.recordCreates)) emitFlowDml(result, flowName, op, "insert");
  for (const op of asArray(flow.recordUpdates)) emitFlowDml(result, flowName, op, "update");
  for (const op of asArray(flow.recordDeletes)) emitFlowDml(result, flowName, op, "delete");
  for (const op of asArray(flow.recordLookups)) emitFlowDml(result, flowName, op, "select");

  // subflows -> FLOW_INVOKES_FLOW (unchanged).
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

  // --- Per-field extraction (FLOW_REFERENCES_FIELD) -----------------------

  const bindings = buildVariableBindings(flow);
  const seen = new Set<string>(); // dedupe by `${qname}|${clause}`

  const emitField = (
    rawRef: string,
    contextObject: string | undefined,
    operation: string,
    clause: string,
    elementName: string | null,
  ): void => {
    if (!contextObject && !rawRef.includes(".")) return; // scalar resources are not fields
    const qname = resolveFieldRef(rawRef, contextObject, bindings, triggerObject);
    if (qname === null) return;
    const key = `${qname}|${clause}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.edges.push({
      edgeType: EdgeType.FlowReferencesField,
      fromQName: flowName,
      fromLabel: NodeLabel.Flow,
      toQName: qname,
      toLabel: NodeLabel.Field,
      // tier-1 (Object.Field) is statically known -> Resolved; tier-2 short-name is Heuristic.
      confidence: qname.startsWith("__SHORTNAME__:") ? Confidence.Heuristic : Confidence.Resolved,
      properties: { operation, clause, flowElementName: elementName },
    });
  };

  // Record elements: queriedFields / sortField / filters / inputAssignments use the
  // element's own <object> as context (tier 1).
  const recordElems: { ops: RecordOp[]; operation: string }[] = [
    { ops: asArray(flow.recordLookups), operation: "select" },
    { ops: asArray(flow.recordCreates), operation: "insert" },
    { ops: asArray(flow.recordUpdates), operation: "update" },
    { ops: asArray(flow.recordDeletes), operation: "delete" },
  ];
  for (const { ops, operation } of recordElems) {
    for (const op of ops) {
      const ctx = op.object;
      for (const f of asArray(op.queriedFields)) {
        if (typeof f === "string") emitField(f, ctx, operation, "queriedField", op.name ?? null);
      }
      if (typeof op.sortField === "string" && op.sortField.length > 0) {
        emitField(op.sortField, ctx, operation, "sortField", op.name ?? null);
      }
      for (const flt of asArray(op.filters)) {
        if (flt.field) emitField(flt.field, ctx, operation, "filter", op.name ?? null);
        if (flt.value?.elementReference) emitField(flt.value.elementReference, undefined, operation, "filterValue", op.name ?? null);
      }
      for (const output of asArray(op.outputAssignments)) {
        if (output.field) emitField(output.field, ctx, operation, "outputAssignment", op.name ?? null);
      }
      for (const ia of asArray(op.inputAssignments)) {
        if (ia.field) emitField(ia.field, ctx, operation, "inputAssignment", op.name ?? null);
        if (ia.value?.elementReference) emitField(ia.value.elementReference, undefined, operation, "inputValue", op.name ?? null);
      }
    }
  }

  // start (record-triggered) entry-criteria filters + $Record refs -> trigger object.
  for (const flt of asArray(flow.start?.filters)) {
    if (flt.field) emitField(flt.field, triggerObject, "entryCriteria", "entryCriteria", null);
    if (flt.value?.elementReference) emitField(flt.value.elementReference, undefined, "entryCriteria", "entryValue", null);
  }

  // assignments: assignmentItems[].assignToReference (var.Field).
  for (const asg of asArray(flow.assignments)) {
    for (const item of asArray(asg.assignmentItems)) {
      if (item.value?.elementReference) emitField(item.value.elementReference, undefined, "assign", "assignmentValue", asg.name ?? null);
      if (item.assignToReference) {
        emitField(item.assignToReference, undefined, "assign", "assignment", asg.name ?? null);
      }
    }
  }

  // decisions: rules[].conditions[].leftValueReference (var.Field).
  for (const dec of asArray(flow.decisions)) {
    for (const rule of asArray(dec.rules)) {
      for (const cond of asArray(rule.conditions)) {
        if (cond.rightValue?.elementReference) emitField(cond.rightValue.elementReference, undefined, "decision", "decisionValue", dec.name ?? null);
        if (cond.leftValueReference) {
          emitField(cond.leftValueReference, undefined, "decision", "decision", dec.name ?? null);
        }
      }
    }
  }

  // formulas: walk the expression with the shared token walker, then re-root var/$Record
  // prefixes through the binding table.
  for (const fm of asArray(flow.formulas)) {
    if (!fm.expression) continue;
    const refs = extractFormulaFieldReferences(fm.expression, triggerObject ?? "");
    for (const ref of refs) {
      if (ref.startsWith("$")) {
        if (ref.startsWith("$Record.") && triggerObject) {
          emitField(ref.slice("$Record.".length), triggerObject, "formula", "formula", fm.name ?? null);
        }
        continue; // other $-globals out of scope this phase
      }
      emitField(ref, undefined, "formula", "formula", fm.name ?? null);
    }
  }

  return result;
}

// Build variableName -> SObject API name from <variables objectType=...> and record
// elements that store into a named output. Pure: everything is in the one Flow XML.
export function buildVariableBindings(flow: NonNullable<FlowXml["Flow"]>): Map<string, string> {
  const bindings = new Map<string, string>();

  for (const v of asArray(flow.variables)) {
    if (v.name && v.objectType && v.objectType.length > 0) {
      bindings.set(v.name, v.objectType);
    }
  }

  // recordLookups/Creates/Updates: the element's auto-stored output is referenced by the
  // element name; an explicit <outputReference> overrides. Bind both to the element object.
  const recordOps = [
    ...asArray(flow.recordLookups),
    ...asArray(flow.recordCreates),
    ...asArray(flow.recordUpdates),
  ];
  for (const op of recordOps) {
    if (!op.object) continue;
    if (op.name) bindings.set(op.name, op.object);
    if (typeof op.outputReference === "string" && op.outputReference.length > 0) {
      bindings.set(op.outputReference, op.object);
    }
  }

  return bindings;
}

// Resolve a Flow field reference to a Field qname.
//   - "Email__c" with contextObject "Customer__c"  -> "Customer__c.Email__c" (tier 1)
//   - "$Record.Status__c" (handled by caller via contextObject = trigger object)
//   - "myVar.Email__c" where myVar -> Customer__c     -> "Customer__c.Email__c" (tier 1)
//   - "Object__c.Field__c" (already qualified)        -> as-is (tier 1)
//   - "Field__c" with no context                      -> "__SHORTNAME__:Field__c" (tier 2)
// Returns null when the reference clearly isn't a field (no usable field segment).
function resolveFieldRef(
  rawRef: string,
  contextObject: string | undefined,
  bindings: Map<string, string>,
  triggerObject: string | undefined,
): string | null {
  const ref = rawRef.replace(/^\{!/, "").replace(/\}$/, "").trim();
  if (ref.length === 0) return null;

  const parts = ref.split(".");

  if (parts.length === 1) {
    const field = parts[0]!;
    if (contextObject && contextObject.length > 0) return `${contextObject}.${field}`;
    return `__SHORTNAME__:${field}`;
  }

  const root = parts[0]!;
  const field = parts[parts.length - 1]!;

  if (root === "$Record") {
    return triggerObject ? `${triggerObject}.${field}` : `__SHORTNAME__:${field}`;
  }
  if (root.startsWith("$")) return null; // other globals out of scope

  const bound = bindings.get(root);
  if (bound) return `${bound}.${field}`;

  // Already-qualified Object.Field (root names an SObject-shaped token).
  if (parts.length === 2 && (root.endsWith("__c") || /^[A-Z]/.test(root))) {
    return `${root}.${field}`;
  }

  return `__SHORTNAME__:${field}`;
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
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Re-export the edge shape for tests that build expected edges.
export type { ParsedEdge };
