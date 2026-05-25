// File discovery for SFDX projects. Walks every packageDirectory listed in
// sfdx-project.json and yields files classified by metadata type. Each kind is parsed by
// a domain-specific parser in pass 1.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export type DiscoveredFileKind =
  | "apex-class"
  | "apex-trigger"
  | "sobject-meta"
  | "field-meta"
  | "validation-rule-meta"
  | "record-type-meta"
  | "lwc-bundle"
  | "aura-bundle"
  | "vf-page"
  | "vf-component"
  | "custom-labels"
  | "permission-set"
  | "permission-set-group"
  | "profile"
  | "flexipage"
  | "layout"
  | "flow"
  | "static-resource"
  | "email-template";

export type BundleFile = {
  // Absolute path of the file on disk.
  absolutePath: string;
  // File name (basename) — what @lwc/metadata wants in BundleConfig.files.
  fileName: string;
};

export type DiscoveredFile = {
  kind: DiscoveredFileKind;
  // For single-file kinds this is the file on disk.
  // For bundle kinds (lwc-bundle, future aura-bundle), this is the bundle directory.
  absolutePath: string;
  // Path relative to project root, normalized to forward slashes.
  relativePath: string;
  // SHA-1 of the raw bytes (single file) or composite SHA-1 of all bundle files.
  contentHash: string;
  // For metadata XML nested under objects/, this is the parent SObject API name.
  parentSObject?: string;
  // For bundle kinds, the list of files in the bundle directory.
  bundleFiles?: BundleFile[];
  // For bundle kinds, the bundle name (LWC component name, Aura component name).
  bundleName?: string;
};

export type ProjectManifest = {
  packageDirectories: { path: string; default?: boolean }[];
  namespace?: string;
  sourceApiVersion?: string;
};

const APEX_CLASS_SUFFIX = ".cls";
const APEX_TRIGGER_SUFFIX = ".trigger";

export function readProjectManifest(projectRoot: string): ProjectManifest {
  const manifestPath = join(projectRoot, "sfdx-project.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read sfdx-project.json at ${manifestPath}: ${(err as Error).message}`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
  if (!Array.isArray(parsed.packageDirectories) || parsed.packageDirectories.length === 0) {
    throw new Error(`sfdx-project.json is missing packageDirectories at ${manifestPath}`);
  }
  return {
    packageDirectories: parsed.packageDirectories,
    ...(parsed.namespace !== undefined ? { namespace: parsed.namespace } : {}),
    ...(parsed.sourceApiVersion !== undefined
      ? { sourceApiVersion: parsed.sourceApiVersion }
      : {}),
  };
}

export async function discoverApexFiles(projectRoot: string): Promise<DiscoveredFile[]> {
  const manifest = readProjectManifest(projectRoot);
  const out: DiscoveredFile[] = [];

  for (const pkg of manifest.packageDirectories) {
    const pkgRoot = join(projectRoot, pkg.path);
    if (!safeIsDirectory(pkgRoot)) {
      continue;
    }
    const defaultDir = join(pkgRoot, "main", "default");

    // Apex: classes/ and triggers/
    for (const subdir of ["classes", "triggers"] as const) {
      const dir = join(defaultDir, subdir);
      if (!safeIsDirectory(dir)) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;

        let kind: DiscoveredFileKind | null = null;
        if (entry.name.endsWith(APEX_CLASS_SUFFIX)) kind = "apex-class";
        else if (entry.name.endsWith(APEX_TRIGGER_SUFFIX)) kind = "apex-trigger";
        if (kind === null) continue;

        const absolutePath = join(dir, entry.name);
        out.push({
          kind,
          absolutePath,
          relativePath: toRelative(projectRoot, absolutePath),
          contentHash: hashContent(readFileSync(absolutePath)),
        });
      }
    }

    // Object metadata: objects/<Name>/<Name>.object-meta.xml + fields/ + validationRules/ + recordTypes/
    const objectsDir = join(defaultDir, "objects");
    if (safeIsDirectory(objectsDir)) {
      const objectEntries = await readdir(objectsDir, { withFileTypes: true });
      for (const objEntry of objectEntries) {
        if (!objEntry.isDirectory()) continue;
        const objectName = objEntry.name;
        const objectRoot = join(objectsDir, objectName);

        // <Name>.object-meta.xml
        const objMeta = join(objectRoot, `${objectName}.object-meta.xml`);
        if (safeIsFile(objMeta)) {
          out.push({
            kind: "sobject-meta",
            absolutePath: objMeta,
            relativePath: toRelative(projectRoot, objMeta),
            contentHash: hashContent(readFileSync(objMeta)),
          });
        }

        // fields/<Field>.field-meta.xml
        await collectXmlChildren(out, projectRoot, objectName, join(objectRoot, "fields"), ".field-meta.xml", "field-meta");
        // validationRules/<Rule>.validationRule-meta.xml
        await collectXmlChildren(out, projectRoot, objectName, join(objectRoot, "validationRules"), ".validationRule-meta.xml", "validation-rule-meta");
        // recordTypes/<RT>.recordType-meta.xml
        await collectXmlChildren(out, projectRoot, objectName, join(objectRoot, "recordTypes"), ".recordType-meta.xml", "record-type-meta");
      }
    }

    // FlexiPages, Layouts, Flows, StaticResources. Each is a single XML file.
    for (const [dirName, suffix, kind] of [
      ["flexipages", ".flexipage-meta.xml", "flexipage"] as const,
      ["layouts", ".layout-meta.xml", "layout"] as const,
      ["flows", ".flow-meta.xml", "flow"] as const,
      ["staticresources", ".resource-meta.xml", "static-resource"] as const,
    ]) {
      const dir = join(defaultDir, dirName);
      if (!safeIsDirectory(dir)) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        if (!entry.name.endsWith(suffix)) continue;
        const abs = join(dir, entry.name);
        out.push({
          kind,
          absolutePath: abs,
          relativePath: toRelative(projectRoot, abs),
          contentHash: hashContent(readFileSync(abs)),
        });
      }
    }

    // Permission sets, permission set groups, profiles. Each is a single XML file.
    for (const [dirName, suffix, kind] of [
      ["permissionsets", ".permissionset-meta.xml", "permission-set"] as const,
      ["permissionsetgroups", ".permissionsetgroup-meta.xml", "permission-set-group"] as const,
      ["profiles", ".profile-meta.xml", "profile"] as const,
    ]) {
      const dir = join(defaultDir, dirName);
      if (!safeIsDirectory(dir)) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        if (!entry.name.endsWith(suffix)) continue;
        const abs = join(dir, entry.name);
        out.push({
          kind,
          absolutePath: abs,
          relativePath: toRelative(projectRoot, abs),
          contentHash: hashContent(readFileSync(abs)),
        });
      }
    }

    // Email templates: email/<folder>/<name>.email-meta.xml (Salesforce stores templates one
    // folder deep). The associated body file is <name>.email next to the meta XML.
    const emailRoot = join(defaultDir, "email");
    if (safeIsDirectory(emailRoot)) {
      const folders = await readdir(emailRoot, { withFileTypes: true });
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        const folderPath = join(emailRoot, folder.name);
        const inside = await readdir(folderPath, { withFileTypes: true });
        for (const entry of inside) {
          if (!entry.isFile() || !entry.name.endsWith(".email-meta.xml")) continue;
          const abs = join(folderPath, entry.name);
          out.push({
            kind: "email-template",
            absolutePath: abs,
            relativePath: toRelative(projectRoot, abs),
            contentHash: hashContent(readFileSync(abs)),
            // Reuse parentSObject as "folder" — the email template parser knows what to do with it.
            parentSObject: folder.name,
          });
        }
      }
    }

    // Custom labels: labels/CustomLabels.labels-meta.xml (one file holds many labels).
    const labelsDir = join(defaultDir, "labels");
    if (safeIsDirectory(labelsDir)) {
      const labelEntries = await readdir(labelsDir, { withFileTypes: true });
      for (const labelEntry of labelEntries) {
        if (!labelEntry.isFile() || !labelEntry.name.endsWith(".labels-meta.xml")) continue;
        const abs = join(labelsDir, labelEntry.name);
        out.push({
          kind: "custom-labels",
          absolutePath: abs,
          relativePath: toRelative(projectRoot, abs),
          contentHash: hashContent(readFileSync(abs)),
        });
      }
    }

    // Visualforce pages and components: pages/<name>.page, components/<name>.component
    for (const [dirName, suffix, kind] of [
      ["pages", ".page", "vf-page"] as const,
      ["components", ".component", "vf-component"] as const,
    ]) {
      const vfDir = join(defaultDir, dirName);
      if (!safeIsDirectory(vfDir)) continue;
      const vfEntries = await readdir(vfDir, { withFileTypes: true });
      for (const vfEntry of vfEntries) {
        if (!vfEntry.isFile() || vfEntry.name.startsWith(".")) continue;
        if (!vfEntry.name.endsWith(suffix)) continue;
        const abs = join(vfDir, vfEntry.name);
        out.push({
          kind,
          absolutePath: abs,
          relativePath: toRelative(projectRoot, abs),
          contentHash: hashContent(readFileSync(abs)),
        });
      }
    }

    // Aura bundles: aura/<bundleName>/ containing <bundleName>.cmp + controller/helper JS.
    const auraDir = join(defaultDir, "aura");
    if (safeIsDirectory(auraDir)) {
      const auraEntries = await readdir(auraDir, { withFileTypes: true });
      for (const auraEntry of auraEntries) {
        if (!auraEntry.isDirectory()) continue;
        const bundleName = auraEntry.name;
        const bundleDir = join(auraDir, bundleName);
        const bundleFiles: BundleFile[] = [];
        const fileEntries = await readdir(bundleDir, { withFileTypes: true });
        const hasher = createHash("sha1");
        for (const fe of fileEntries) {
          if (!fe.isFile() || fe.name.startsWith(".")) continue;
          const abs = join(bundleDir, fe.name);
          const contents = readFileSync(abs);
          hasher.update(fe.name);
          hasher.update(contents);
          bundleFiles.push({ absolutePath: abs, fileName: fe.name });
        }
        if (bundleFiles.length === 0) continue;
        out.push({
          kind: "aura-bundle",
          absolutePath: bundleDir,
          relativePath: toRelative(projectRoot, bundleDir),
          contentHash: hasher.digest("hex"),
          bundleFiles,
          bundleName,
        });
      }
    }

    // LWC bundles: lwc/<componentName>/ containing <componentName>.{js,html,css,js-meta.xml}.
    const lwcDir = join(defaultDir, "lwc");
    if (safeIsDirectory(lwcDir)) {
      const lwcEntries = await readdir(lwcDir, { withFileTypes: true });
      for (const lwcEntry of lwcEntries) {
        if (!lwcEntry.isDirectory()) continue;
        const bundleName = lwcEntry.name;
        const bundleDir = join(lwcDir, bundleName);
        const bundleFiles: BundleFile[] = [];
        const fileEntries = await readdir(bundleDir, { withFileTypes: true });
        const hasher = createHash("sha1");
        for (const fe of fileEntries) {
          if (!fe.isFile() || fe.name.startsWith(".")) continue;
          const abs = join(bundleDir, fe.name);
          const contents = readFileSync(abs);
          hasher.update(fe.name);
          hasher.update(contents);
          bundleFiles.push({ absolutePath: abs, fileName: fe.name });
        }
        if (bundleFiles.length === 0) continue;
        out.push({
          kind: "lwc-bundle",
          absolutePath: bundleDir,
          relativePath: toRelative(projectRoot, bundleDir),
          contentHash: hasher.digest("hex"),
          bundleFiles,
          bundleName,
        });
      }
    }
  }

  return out;
}

async function collectXmlChildren(
  out: DiscoveredFile[],
  projectRoot: string,
  parentSObject: string,
  dir: string,
  suffix: string,
  kind: DiscoveredFileKind,
): Promise<void> {
  if (!safeIsDirectory(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(suffix)) continue;
    const absolutePath = join(dir, entry.name);
    out.push({
      kind,
      absolutePath,
      relativePath: toRelative(projectRoot, absolutePath),
      contentHash: hashContent(readFileSync(absolutePath)),
      parentSObject,
    });
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function hashContent(buf: Buffer | string): string {
  const h = createHash("sha1");
  h.update(buf);
  return h.digest("hex");
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toRelative(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).split("\\").join("/");
}
