// Shared types for the Apex parser output. Pure data; no SQLite, no I/O.
// See section 6.1 of the design doc.

import type { EdgeType } from "../../model/edge-types.ts";
import type { NodeLabel } from "../../model/node-labels.ts";

export type ParsedNode = {
  label: NodeLabel;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  properties?: Record<string, unknown>;
};

export type ParsedEdge = {
  edgeType: EdgeType;
  // Both endpoints are identified by qualified name + label; the writer resolves
  // them to node ids at write time.
  fromQName: string;
  fromLabel: NodeLabel;
  toQName: string;
  toLabel: NodeLabel;
  confidence: number;
  sourceLine?: number;
  properties?: Record<string, unknown>;
};

// Cross-file unresolved references. Pass 2/3 resolves these against the global
// symbol table once all files have been walked.
export type UnresolvedRef =
  | UnresolvedCall
  | UnresolvedInstantiation
  | UnresolvedExtends
  | UnresolvedImplements
  | UnresolvedSoql;

export type UnresolvedCall = {
  kind: "call";
  // Method that contains the call site. Null for trigger top-level calls (v0.1 ignores those).
  fromMethodQName: string;
  // Receiver text up to but not including the called method, or null for un-qualified calls.
  receiverText: string | null;
  calleeName: string;
  argCount: number;
  sourceFile: string;
  sourceLine: number;
};

export type UnresolvedInstantiation = {
  kind: "new";
  fromMethodQName: string;
  typeName: string;
  sourceFile: string;
  sourceLine: number;
};

export type UnresolvedExtends = {
  kind: "extends";
  classQName: string;
  parentName: string;
  sourceFile: string;
  sourceLine: number;
};

export type UnresolvedImplements = {
  kind: "implements";
  classQName: string;
  interfaceName: string;
  sourceFile: string;
  sourceLine: number;
};

export type UnresolvedSoql = {
  kind: "soql";
  fromMethodQName: string;
  fromObject: string;
  rawText: string;
  sourceFile: string;
  sourceLine: number;
};

export type ParseResult = {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  unresolved: UnresolvedRef[];
  // Soft parse errors. v0.1 surfaces them via the diagnostics log rather than failing the run.
  warnings: { message: string; line: number }[];
};
