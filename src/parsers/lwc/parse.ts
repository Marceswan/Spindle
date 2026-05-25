// LWC bundle parser. Uses @lwc/metadata's collectBundleMetadata to extract the import graph
// and template references without writing a hand-rolled JS/HTML walker. See design §6.2 and
// the LSP spike report's recommendation. Per the spike, @lwc/metadata is published "as-is
// with no support" — we pin an exact version in package.json and treat upstream majors as
// breaking changes.

import { readFileSync } from "node:fs";
import { collectBundleMetadata } from "@lwc/metadata";
import type {
  BundleMetadata,
  ModuleReference,
  ScriptFile,
  HTMLTemplateFile,
  SfdcResourceType,
} from "@lwc/metadata";

import { EdgeType } from "../../model/edge-types.ts";
import { NodeLabel } from "../../model/node-labels.ts";
import { Confidence } from "../../model/confidence.ts";
import type { DiscoveredFile } from "../../pipeline/discover.ts";
import type { ParseResult } from "../apex/types.ts";

export function parseLwcBundle(file: DiscoveredFile): ParseResult {
  const result: ParseResult = { nodes: [], edges: [], unresolved: [], warnings: [] };

  if (file.kind !== "lwc-bundle" || file.bundleFiles === undefined || file.bundleName === undefined) {
    result.warnings.push({
      message: `parseLwcBundle: malformed DiscoveredFile (path=${file.relativePath})`,
      line: 0,
    });
    return result;
  }

  const bundleName = file.bundleName;
  const bundleQName = `c/${bundleName}`;

  // Load all bundle files into memory. @lwc/metadata accepts an array of { fileName, source }.
  const sourceFiles: { fileName: string; source: string }[] = [];
  for (const bf of file.bundleFiles) {
    let src: string;
    try {
      src = readFileSync(bf.absolutePath, "utf8");
    } catch (err) {
      result.warnings.push({
        message: `Cannot read ${bf.fileName}: ${(err as Error).message}`,
        line: 0,
      });
      continue;
    }
    sourceFiles.push({ fileName: bf.fileName, source: src });
  }

  let meta: BundleMetadata;
  try {
    meta = collectBundleMetadata({
      type: "platform",
      name: bundleName,
      namespace: "c",
      namespaceMapping: {},
      npmModuleMapping: {},
      files: sourceFiles,
    });
  } catch (err) {
    result.warnings.push({
      message: `collectBundleMetadata failed for ${bundleQName}: ${(err as Error).message}`,
      line: 0,
    });
    return result;
  }

  // Surface diagnostics as warnings — non-fatal so we still write the bundle node.
  for (const diag of meta.diagnostics ?? []) {
    pushDiagnosticWarning(result, file.relativePath, diag);
  }

  // ------------------------------------------------------------------------
  // Structural nodes.
  // ------------------------------------------------------------------------

  result.nodes.push({
    label: NodeLabel.LwcBundle,
    name: bundleName,
    qualifiedName: bundleQName,
    startLine: 1,
    endLine: 1,
    properties: {
      namespace: meta.namespace,
      moduleSpecifier: meta.moduleSpecifier,
      entryFileName: meta.entryFileName ?? null,
      fileNames: file.bundleFiles.map((bf) => bf.fileName),
    },
  });

  for (const bundleFile of meta.files ?? []) {
    if (isScriptFileLike(bundleFile)) {
      const moduleQName = `${bundleQName}/${bundleFile.fileName}`;
      result.nodes.push({
        label: NodeLabel.LwcModule,
        name: bundleFile.fileName,
        qualifiedName: moduleQName,
        startLine: 1,
        endLine: 1,
        properties: { bundle: bundleQName, fileName: bundleFile.fileName, fileType: bundleFile.fileType },
      });

      // moduleReferences → typed edges based on the scoped resource kind.
      const moduleRefs = bundleFile.moduleReferences ?? [];
      for (const ref of moduleRefs) {
        emitModuleReferenceEdge(result, bundleQName, ref, file.relativePath);
      }
    } else if (isTemplateFileLike(bundleFile)) {
      const templateQName = `${bundleQName}/${bundleFile.fileName}`;
      result.nodes.push({
        label: NodeLabel.LwcTemplate,
        name: bundleFile.fileName,
        qualifiedName: templateQName,
        startLine: 1,
        endLine: 1,
        properties: { bundle: bundleQName, fileName: bundleFile.fileName, fileType: bundleFile.fileType },
      });

      // componentReferences → LWC_INCLUDES_COMPONENT edges (bundle → bundle).
      for (const cmp of bundleFile.componentReferences ?? []) {
        const targetQName = `c/${cmp.name}`;
        const sourceLine = firstLineOfLocations(cmp.locations);
        result.edges.push({
          edgeType: EdgeType.LwcIncludesComponent,
          fromQName: bundleQName,
          fromLabel: NodeLabel.LwcBundle,
          toQName: targetQName,
          toLabel: NodeLabel.LwcBundle,
          confidence: Confidence.Resolved,
          ...(sourceLine !== undefined ? { sourceLine } : {}),
          properties: { tagName: cmp.tagName, namespacedName: cmp.namespacedName ?? null },
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitModuleReferenceEdge(
  result: ParseResult,
  bundleQName: string,
  ref: ModuleReference,
  sourceFile: string,
): void {
  if (ref.sfdcResource === undefined) {
    // Plain lwc/local/external import (e.g. "lwc", or a user-defined sibling module). Skipped
    // for v0.2; @lwc/metadata exposes type='lwc'|'local'|'external' here. Local imports between
    // bundles also surface via componentReferences in the template, so we don't lose them.
    return;
  }

  const scoped: SfdcResourceType = ref.sfdcResource.scoped;
  const targetId = ref.sfdcResource.id ?? ref.name;

  switch (scoped) {
    case "apexMethod": {
      // targetId looks like "ClassName.methodName" — map to ApexMethod by short qname match.
      // We can't fully resolve to the parameterized qname yet (the LWC import doesn't carry
      // arg types); pass 3 / cross-domain resolution will own that. For v0.2 we emit an edge
      // to the un-parameterized name; pass 3 picks the @AuraEnabled method with matching short
      // name. Confidence Heuristic (0.8): bundle-name + method-name match.
      const sourceLine = firstLineOfLocations(ref.locations);
      result.edges.push({
        edgeType: EdgeType.LwcUsesApex,
        fromQName: bundleQName,
        fromLabel: NodeLabel.LwcBundle,
        toQName: targetId,
        toLabel: NodeLabel.ApexMethod,
        confidence: Confidence.Heuristic,
        ...(sourceLine !== undefined ? { sourceLine } : {}),
        properties: { sourceFile, scopedKind: "apexMethod", rawTarget: targetId },
      });
      break;
    }
    case "schema": {
      // targetId looks like "Object.Field" or "Object" (object-only import).
      const isField = targetId.includes(".");
      const sourceLine = firstLineOfLocations(ref.locations);
      result.edges.push({
        edgeType: isField ? EdgeType.LwcUsesField : EdgeType.ReferencesField,
        fromQName: bundleQName,
        fromLabel: NodeLabel.LwcBundle,
        toQName: targetId,
        toLabel: isField ? NodeLabel.Field : NodeLabel.SObject,
        confidence: Confidence.Resolved,
        ...(sourceLine !== undefined ? { sourceLine } : {}),
        properties: { sourceFile, scopedKind: "schema" },
      });
      break;
    }
    case "label": {
      const sourceLine = firstLineOfLocations(ref.locations);
      result.edges.push({
        edgeType: EdgeType.LwcUsesLabel,
        fromQName: bundleQName,
        fromLabel: NodeLabel.LwcBundle,
        toQName: targetId,
        toLabel: NodeLabel.CustomLabel,
        confidence: Confidence.Resolved,
        ...(sourceLine !== undefined ? { sourceLine } : {}),
        properties: { sourceFile, scopedKind: "label" },
      });
      break;
    }
    case "resourceUrl": {
      const sourceLine = firstLineOfLocations(ref.locations);
      result.edges.push({
        edgeType: EdgeType.LwcUsesResource,
        fromQName: bundleQName,
        fromLabel: NodeLabel.LwcBundle,
        toQName: targetId,
        toLabel: NodeLabel.StaticResource,
        confidence: Confidence.Resolved,
        ...(sourceLine !== undefined ? { sourceLine } : {}),
        properties: { sourceFile, scopedKind: "resourceUrl" },
      });
      break;
    }
    case "apex":
    case "apexContinuation":
    case "accessCheck":
    case "client":
    case "codeHosts":
    case "community":
    case "component":
    case "contentAssetUrl":
    case "customPermission":
    case "dynamicComponent":
    case "featureFlag":
    case "messageChannel":
    case "i18n":
    case "gate":
    case "lds":
    case "metric":
    case "internal":
    case "site":
    case "slds":
    case "user":
    case "userPermission":
    case "komaci":
    case "webstore":
      // v0.2 doesn't model these distinct edge types. Capture as a generic note on the bundle
      // node properties (no edge emitted). Future phases may promote any of these to dedicated
      // edge types if there's analytical value.
      break;
  }
}

function firstLineOfLocations(locations: { startLine?: number }[] | undefined): number | undefined {
  if (locations === undefined || locations.length === 0) return undefined;
  const first = locations[0];
  return first?.startLine;
}

function pushDiagnosticWarning(
  result: ParseResult,
  sourceFile: string,
  diag: unknown,
): void {
  // @lwc/metadata diagnostics carry an optional location with a startLine. We type as unknown
  // because the CompilerDiagnostic interface is not currently part of the public exports.
  const d = diag as { location?: { startLine?: number }; message?: string };
  const line = d.location?.startLine ?? 0;
  const msg = d.message ?? "LWC diagnostic (no message)";
  result.warnings.push({ message: `[${sourceFile}] ${msg}`, line });
}

// Structural-type guards. @lwc/metadata discriminates files by fileType but the union member
// types live in separate modules; instanceof doesn't work for plain interfaces. These guards
// check the fileType and downcast.

function isScriptFileLike(file: { fileType: string }): file is ScriptFile {
  return file.fileType === "js" || file.fileType === "ts";
}

function isTemplateFileLike(file: { fileType: string }): file is HTMLTemplateFile {
  return file.fileType === "html";
}
