// Per-file parser dispatch. Pass 1 calls this to convert a discovered file (or bundle) into
// a ParseResult without knowing which parser is appropriate. For single-file kinds the
// dispatcher reads the source itself; for bundle kinds the parser reads its own file list.
// Add a new branch here when a new DiscoveredFileKind goes live.

import { readFileSync } from "node:fs";

import { parseApex } from "../parsers/apex/parse.ts";
import { parseObjectMeta } from "../parsers/metadata-xml/object.ts";
import { parseFieldMeta } from "../parsers/metadata-xml/field.ts";
import { parseValidationRuleMeta } from "../parsers/metadata-xml/validation-rule.ts";
import { parseRecordTypeMeta } from "../parsers/metadata-xml/record-type.ts";
import { parseCustomLabels } from "../parsers/metadata-xml/custom-labels.ts";
import { parsePermissionSetOrProfile } from "../parsers/metadata-xml/permission-set.ts";
import { parsePermissionSetGroup } from "../parsers/metadata-xml/permission-set-group.ts";
import { parseFlexiPage } from "../parsers/metadata-xml/flexipage.ts";
import { parseLayout } from "../parsers/metadata-xml/layout.ts";
import { parseFlow } from "../parsers/metadata-xml/flow.ts";
import { parseStaticResource } from "../parsers/metadata-xml/static-resource.ts";
import { parseEmailTemplate } from "../parsers/metadata-xml/email-template.ts";
import { parseLwcBundle } from "../parsers/lwc/parse.ts";
import { parseAuraBundle } from "../parsers/aura/parse.ts";
import { parseVisualforce } from "../parsers/vf/parse.ts";
import type { ParseResult } from "../parsers/apex/types.ts";
import type { DiscoveredFile } from "./discover.ts";

export function parseFile(file: DiscoveredFile): ParseResult {
  switch (file.kind) {
    case "apex-class":
    case "apex-trigger":
      return parseApex(file.absolutePath, readSource(file));

    case "sobject-meta":
      return parseObjectMeta(
        file.absolutePath,
        readSource(file),
        sobjectNameFromObjectMetaPath(file.absolutePath),
      );

    case "field-meta":
      return parseFieldMeta(file.absolutePath, readSource(file), requireParentSObject(file, "field-meta"));

    case "validation-rule-meta":
      return parseValidationRuleMeta(
        file.absolutePath,
        readSource(file),
        requireParentSObject(file, "validation-rule-meta"),
      );

    case "record-type-meta":
      return parseRecordTypeMeta(
        file.absolutePath,
        readSource(file),
        requireParentSObject(file, "record-type-meta"),
      );

    case "lwc-bundle":
      return parseLwcBundle(file);

    case "aura-bundle":
      return parseAuraBundle(file);

    case "vf-page":
      return parseVisualforce(file.absolutePath, readSource(file), "vf-page");

    case "vf-component":
      return parseVisualforce(file.absolutePath, readSource(file), "vf-component");

    case "custom-labels":
      return parseCustomLabels(file.absolutePath, readSource(file));

    case "permission-set":
      return parsePermissionSetOrProfile(file.absolutePath, readSource(file), "permission-set");

    case "profile":
      return parsePermissionSetOrProfile(file.absolutePath, readSource(file), "profile");

    case "permission-set-group":
      return parsePermissionSetGroup(file.absolutePath, readSource(file));

    case "flexipage":
      return parseFlexiPage(file.absolutePath, readSource(file));

    case "layout":
      return parseLayout(file.absolutePath, readSource(file));

    case "flow":
      return parseFlow(file.absolutePath, readSource(file));

    case "static-resource":
      return parseStaticResource(file.absolutePath, readSource(file));

    case "email-template":
      return parseEmailTemplate(
        file.absolutePath,
        readSource(file),
        file.parentSObject ?? "unfiled",
      );
  }
}

function readSource(file: DiscoveredFile): string {
  return readFileSync(file.absolutePath, "utf8");
}

function requireParentSObject(file: DiscoveredFile, kind: string): string {
  if (file.parentSObject === undefined) {
    throw new Error(
      `parseFile: discovered file of kind ${kind} is missing parentSObject (path=${file.relativePath})`,
    );
  }
  return file.parentSObject;
}

function sobjectNameFromObjectMetaPath(absPath: string): string {
  const parts = absPath.split(/[/\\]/);
  const objectsIdx = parts.lastIndexOf("objects");
  if (objectsIdx === -1 || objectsIdx + 1 >= parts.length) {
    const fileName = parts[parts.length - 1] ?? "";
    return fileName.replace(/\.object-meta\.xml$/, "");
  }
  return parts[objectsIdx + 1] ?? "";
}
