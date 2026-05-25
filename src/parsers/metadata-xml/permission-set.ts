// Parses permission-set / profile XML into a PermissionSet (or Profile) node plus a fan-out
// of GRANTS_APEX_ACCESS / GRANTS_OBJECT_ACCESS / GRANTS_FIELD_ACCESS / GRANTS_VISUALFORCE_ACCESS
// / GRANTS_RECORDTYPE_ACCESS edges to the access targets. Per design §6.8.
//
// PermissionSet and Profile share the same element shape (classAccesses, objectPermissions,
// fieldPermissions, pageAccesses, recordTypeVisibilities, userPermissions); we accept a
// `mode` parameter to pick the right node label and root element name.

import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { ParseResult } from "../apex/types.ts";

type ClassAccess = { apexClass?: string; enabled?: boolean };
type ObjectPerm = {
  object?: string;
  allowCreate?: boolean;
  allowRead?: boolean;
  allowEdit?: boolean;
  allowDelete?: boolean;
  viewAllRecords?: boolean;
  modifyAllRecords?: boolean;
};
type FieldPerm = { field?: string; readable?: boolean; editable?: boolean };
type PageAccess = { apexPage?: string; enabled?: boolean };
type RecordTypeVis = { recordType?: string; visible?: boolean; default?: boolean };
type UserPerm = { name?: string; enabled?: boolean };

type PermSetShape = {
  label?: string;
  description?: string;
  license?: string;
  hasActivationRequired?: boolean;
  classAccesses?: ClassAccess | ClassAccess[];
  objectPermissions?: ObjectPerm | ObjectPerm[];
  fieldPermissions?: FieldPerm | FieldPerm[];
  pageAccesses?: PageAccess | PageAccess[];
  recordTypeVisibilities?: RecordTypeVis | RecordTypeVis[];
  userPermissions?: UserPerm | UserPerm[];
};

type ProfileShape = PermSetShape & {
  userLicense?: string;
  custom?: boolean;
};

type RootXml = {
  PermissionSet?: PermSetShape;
  Profile?: ProfileShape;
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) =>
    name === "classAccesses" ||
    name === "objectPermissions" ||
    name === "fieldPermissions" ||
    name === "pageAccesses" ||
    name === "recordTypeVisibilities" ||
    name === "userPermissions",
});

export type PermissionMode = "permission-set" | "profile";

export function parsePermissionSetOrProfile(
  filePath: string,
  source: string,
  mode: PermissionMode,
): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  let parsed: RootXml;
  try {
    parsed = xmlParser.parse(source) as RootXml;
  } catch (err) {
    result.warnings.push({
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  const shape = mode === "permission-set" ? parsed.PermissionSet : parsed.Profile;
  if (shape === undefined) return result;

  const fileBase = basename(filePath).replace(/\.(permissionset-meta|profile-meta)\.xml$/, "");
  const nodeLabel = mode === "permission-set" ? NodeLabel.PermissionSet : NodeLabel.Profile;
  const totalLines = source.split("\n").length;

  const userPermissions = collectUserPermissions(shape);

  result.nodes.push({
    label: nodeLabel,
    name: fileBase,
    qualifiedName: fileBase,
    startLine: 1,
    endLine: totalLines,
    properties: {
      label: shape.label ?? fileBase,
      description: shape.description ?? null,
      license: shape.license ?? null,
      hasActivationRequired: shape.hasActivationRequired ?? null,
      userLicense: mode === "profile" ? (parsed.Profile?.userLicense ?? null) : null,
      isCustom: mode === "profile" ? (parsed.Profile?.custom ?? null) : true,
      userPermissions,
    },
  });

  emitClassGrants(result, fileBase, nodeLabel, shape.classAccesses);
  emitObjectGrants(result, fileBase, nodeLabel, shape.objectPermissions);
  emitFieldGrants(result, fileBase, nodeLabel, shape.fieldPermissions);
  emitPageGrants(result, fileBase, nodeLabel, shape.pageAccesses);
  emitRecordTypeGrants(result, fileBase, nodeLabel, shape.recordTypeVisibilities);

  return result;
}

// ---------------------------------------------------------------------------
// Emitters per access kind
// ---------------------------------------------------------------------------

function emitClassGrants(
  result: ParseResult,
  fromQName: string,
  fromLabel: typeof NodeLabel.PermissionSet | typeof NodeLabel.Profile,
  raw: ClassAccess | ClassAccess[] | undefined,
): void {
  for (const entry of asArray(raw)) {
    if (entry.apexClass === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.GrantsApexAccess,
      fromQName,
      fromLabel,
      toQName: entry.apexClass,
      toLabel: NodeLabel.ApexClass,
      confidence: Confidence.Resolved,
      properties: { enabled: entry.enabled ?? false },
    });
  }
}

function emitObjectGrants(
  result: ParseResult,
  fromQName: string,
  fromLabel: typeof NodeLabel.PermissionSet | typeof NodeLabel.Profile,
  raw: ObjectPerm | ObjectPerm[] | undefined,
): void {
  for (const entry of asArray(raw)) {
    if (entry.object === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.GrantsObjectAccess,
      fromQName,
      fromLabel,
      toQName: entry.object,
      toLabel: NodeLabel.SObject,
      confidence: Confidence.Resolved,
      properties: {
        create: entry.allowCreate ?? false,
        read: entry.allowRead ?? false,
        edit: entry.allowEdit ?? false,
        delete: entry.allowDelete ?? false,
        viewAll: entry.viewAllRecords ?? false,
        modifyAll: entry.modifyAllRecords ?? false,
      },
    });
  }
}

function emitFieldGrants(
  result: ParseResult,
  fromQName: string,
  fromLabel: typeof NodeLabel.PermissionSet | typeof NodeLabel.Profile,
  raw: FieldPerm | FieldPerm[] | undefined,
): void {
  for (const entry of asArray(raw)) {
    if (entry.field === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.GrantsFieldAccess,
      fromQName,
      fromLabel,
      toQName: entry.field,
      toLabel: NodeLabel.Field,
      confidence: Confidence.Resolved,
      properties: { read: entry.readable ?? false, edit: entry.editable ?? false },
    });
  }
}

function emitPageGrants(
  result: ParseResult,
  fromQName: string,
  fromLabel: typeof NodeLabel.PermissionSet | typeof NodeLabel.Profile,
  raw: PageAccess | PageAccess[] | undefined,
): void {
  for (const entry of asArray(raw)) {
    if (entry.apexPage === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.GrantsVisualforceAccess,
      fromQName,
      fromLabel,
      toQName: entry.apexPage,
      toLabel: NodeLabel.VisualforcePage,
      confidence: Confidence.Resolved,
      properties: { enabled: entry.enabled ?? false },
    });
  }
}

function emitRecordTypeGrants(
  result: ParseResult,
  fromQName: string,
  fromLabel: typeof NodeLabel.PermissionSet | typeof NodeLabel.Profile,
  raw: RecordTypeVis | RecordTypeVis[] | undefined,
): void {
  for (const entry of asArray(raw)) {
    if (entry.recordType === undefined) continue;
    result.edges.push({
      edgeType: EdgeType.GrantsRecordTypeAccess,
      fromQName,
      fromLabel,
      toQName: entry.recordType,
      toLabel: NodeLabel.RecordType,
      confidence: Confidence.Resolved,
      properties: { visible: entry.visible ?? false, default: entry.default ?? false },
    });
  }
}

function collectUserPermissions(shape: PermSetShape): { name: string; enabled: boolean }[] {
  const arr = asArray(shape.userPermissions);
  const out: { name: string; enabled: boolean }[] = [];
  for (const entry of arr) {
    if (entry.name === undefined) continue;
    out.push({ name: entry.name, enabled: entry.enabled ?? false });
  }
  return out;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
