// File discovery for SFDX projects. Walks every packageDirectory listed in
// sfdx-project.json and yields files classified by metadata type. Each kind is parsed by
// a domain-specific parser in pass 1.

import { createHash } from "node:crypto";
import { type Dirent, readFileSync, statSync } from "node:fs";
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

// Single-file type folders. Each folder name maps to the file suffix and kind it yields.
// Matching files are found in the folder and in its subfolders at any depth.
const APEX_SPECS: { suffix: string; kind: DiscoveredFileKind }[] = [
  { suffix: APEX_CLASS_SUFFIX, kind: "apex-class" },
  { suffix: APEX_TRIGGER_SUFFIX, kind: "apex-trigger" },
];
const SINGLE_FILE_TYPES: Record<string, { suffix: string; kind: DiscoveredFileKind }[]> = {
  // As before, classes/ and triggers/ both accept .cls and .trigger files.
  classes: APEX_SPECS,
  triggers: APEX_SPECS,
  flexipages: [{ suffix: ".flexipage-meta.xml", kind: "flexipage" }],
  layouts: [{ suffix: ".layout-meta.xml", kind: "layout" }],
  flows: [{ suffix: ".flow-meta.xml", kind: "flow" }],
  staticresources: [{ suffix: ".resource-meta.xml", kind: "static-resource" }],
  permissionsets: [{ suffix: ".permissionset-meta.xml", kind: "permission-set" }],
  permissionsetgroups: [{ suffix: ".permissionsetgroup-meta.xml", kind: "permission-set-group" }],
  profiles: [{ suffix: ".profile-meta.xml", kind: "profile" }],
  labels: [{ suffix: ".labels-meta.xml", kind: "custom-labels" }],
  pages: [{ suffix: ".page", kind: "vf-page" }],
  components: [{ suffix: ".component", kind: "vf-component" }],
};

// Type folders that need their own handling (child structure or bundles).
const SPECIAL_TYPES = new Set(["objects", "email", "aura", "lwc"]);

function isTypeFolder(name: string): boolean {
  return name in SINGLE_FILE_TYPES || SPECIAL_TYPES.has(name);
}

function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

export async function discoverApexFiles(projectRoot: string): Promise<DiscoveredFile[]> {
  const manifest = readProjectManifest(projectRoot);
  const out: DiscoveredFile[] = [];
  // Overlapping package directories reach the same file twice; the absolute path is the key.
  const seen = new Set<string>();

  const add = (file: DiscoveredFile): void => {
    if (seen.has(file.absolutePath)) return;
    seen.add(file.absolutePath);
    out.push(file);
  };
  const addFile = (
    kind: DiscoveredFileKind,
    absolutePath: string,
    extra: { parentSObject?: string } = {},
  ): void => {
    add({
      kind,
      absolutePath,
      relativePath: toRelative(projectRoot, absolutePath),
      contentHash: hashContent(readFileSync(absolutePath)),
      ...extra,
    });
  };

  // Find type folders at any depth. A type folder is processed by its type rules and is not
  // searched for further type folders.
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await sortedEntries(dir)) {
      if (!entry.isDirectory() || isSkippedDirectory(entry.name)) continue;
      const child = join(dir, entry.name);
      if (isTypeFolder(entry.name)) await processTypeFolder(entry.name, child);
      else await walk(child);
    }
  };

  const processTypeFolder = async (name: string, dir: string): Promise<void> => {
    const specs = SINGLE_FILE_TYPES[name];
    if (specs) {
      for (const file of await filesBelow(dir)) {
        for (const { suffix, kind } of specs) {
          if (file.endsWith(suffix)) addFile(kind, file);
        }
      }
    } else if (name === "objects") await processObjects(dir);
    else if (name === "email") await processEmail(dir);
    else await processBundles(dir, name === "lwc" ? "lwc-bundle" : "aura-bundle");
  };

  // objects/<Name>/<Name>.object-meta.xml + fields/ + validationRules/ + recordTypes/
  const processObjects = async (objectsDir: string): Promise<void> => {
    for (const objEntry of await sortedEntries(objectsDir)) {
      if (!objEntry.isDirectory()) continue;
      const objectName = objEntry.name;
      const objectRoot = join(objectsDir, objectName);
      const objMeta = join(objectRoot, `${objectName}.object-meta.xml`);
      if (safeIsFile(objMeta)) addFile("sobject-meta", objMeta);
      for (const [childDir, suffix, kind] of [
        ["fields", ".field-meta.xml", "field-meta"],
        ["validationRules", ".validationRule-meta.xml", "validation-rule-meta"],
        ["recordTypes", ".recordType-meta.xml", "record-type-meta"],
      ] as const) {
        for (const file of await directFiles(join(objectRoot, childDir), suffix)) {
          addFile(kind, file, { parentSObject: objectName });
        }
      }
    }
  };

  // email/<folder>[/<subfolder>...]/<name>.email-meta.xml. The folder path below email/ goes
  // in parentSObject; the email template parser reads it as the template folder.
  const processEmail = async (emailRoot: string): Promise<void> => {
    const visit = async (dir: string, folderPath: string): Promise<void> => {
      for (const entry of await sortedEntries(dir)) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!isSkippedDirectory(entry.name)) {
            await visit(abs, folderPath === "" ? entry.name : `${folderPath}/${entry.name}`);
          }
        } else if (folderPath !== "" && entry.isFile() && entry.name.endsWith(".email-meta.xml")) {
          // The parser also scans the sibling body file, so the hash must cover both.
          // Without the body, an edit to the body alone is not seen as a change.
          const hasher = createHash("sha1");
          hasher.update(readFileSync(abs));
          const bodyPath = abs.replace(/\.email-meta\.xml$/, ".email");
          if (safeIsFile(bodyPath)) hasher.update(readFileSync(bodyPath));
          add({
            kind: "email-template",
            absolutePath: abs,
            relativePath: toRelative(projectRoot, abs),
            contentHash: hasher.digest("hex"),
            parentSObject: folderPath,
          });
        }
      }
    };
    await visit(emailRoot, "");
  };

  // lwc/<name>/ and aura/<name>/. Each direct child directory is one bundle; only its direct
  // files are bundle files (subdirectories such as __tests__ are ignored).
  const processBundles = async (
    bundlesDir: string,
    kind: "lwc-bundle" | "aura-bundle",
  ): Promise<void> => {
    for (const entry of await sortedEntries(bundlesDir)) {
      if (!entry.isDirectory()) continue;
      const bundleDir = join(bundlesDir, entry.name);
      const bundleFiles: BundleFile[] = [];
      const hasher = createHash("sha1");
      for (const fe of await sortedEntries(bundleDir)) {
        if (!fe.isFile() || fe.name.startsWith(".")) continue;
        const abs = join(bundleDir, fe.name);
        hasher.update(fe.name);
        hasher.update(readFileSync(abs));
        bundleFiles.push({ absolutePath: abs, fileName: fe.name });
      }
      if (bundleFiles.length === 0) continue;
      add({
        kind,
        absolutePath: bundleDir,
        relativePath: toRelative(projectRoot, bundleDir),
        contentHash: hasher.digest("hex"),
        bundleFiles,
        bundleName: entry.name,
      });
    }
  };

  for (const pkg of manifest.packageDirectories) {
    const pkgRoot = join(projectRoot, pkg.path);
    if (!safeIsDirectory(pkgRoot)) continue;
    await walk(pkgRoot);
  }

  return out;
}

// Directory entries sorted by name, so discovery order does not depend on the file system.
async function sortedEntries(dir: string): Promise<Dirent[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Non-dot files directly in dir whose name ends with suffix.
async function directFiles(dir: string, suffix: string): Promise<string[]> {
  if (!safeIsDirectory(dir)) return [];
  const files: string[] = [];
  for (const entry of await sortedEntries(dir)) {
    if (entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(suffix)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

// Non-dot files in dir and in its subfolders at any depth. Dot directories and node_modules
// are not entered.
async function filesBelow(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await sortedEntries(dir)) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(entry.name)) files.push(...(await filesBelow(abs)));
    } else if (entry.isFile() && !entry.name.startsWith(".")) {
      files.push(abs);
    }
  }
  return files;
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
