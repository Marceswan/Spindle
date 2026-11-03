// Classify an import specifier into one of:
//   - { kind: "local",       absolutePath }   resolved to a real file inside the bundle
//   - { kind: "sf-apex",     namespace?, className, methodName }
//   - { kind: "sf-schema",   sobject, field? }   field is undefined for whole-object imports
//   - { kind: "sf-label",    namespace?, label }
//   - { kind: "sf-resource", namespace?, name }
//   - { kind: "external",    moduleName }      everything else (npm packages, bare specifiers)
//   - { kind: "unresolved",  spec }             relative/alias specifier that we couldn't find
//
// All resolved-local paths are returned without extension probe failures collapsed silently —
// the caller is expected to handle "unresolved" by emitting a low-confidence edge or skipping.

import { statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import type { TsconfigPaths } from "./tsconfig-paths.ts";
import { resolvePathAlias } from "./tsconfig-paths.ts";

export type ResolvedImport =
  | { kind: "local"; absolutePath: string }
  | { kind: "sf-apex"; namespace: string | undefined; className: string; methodName: string }
  | { kind: "sf-schema"; sobject: string; field: string | undefined }
  | { kind: "sf-label"; namespace: string | undefined; label: string }
  | { kind: "sf-resource"; namespace: string | undefined; name: string }
  | { kind: "external"; moduleName: string }
  | { kind: "unresolved"; spec: string };

// Extensions we probe when a specifier has no extension. Order matters: .ts before .tsx
// before .d.ts (TypeScript bundler resolution falls back to .d.ts when no runtime file
// exists). Also include .js/.jsx for JS-only specifiers and .mjs/.cjs for ESM variants.
const CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];

export function resolveImport(
  spec: string,
  fromFileAbs: string,
  tsconfig: TsconfigPaths,
  bundleFilePaths: Set<string>,
): ResolvedImport {
  // 1. @salesforce/* LWC-compatible patterns. These are virtual modules in the LWC compiler
  //    and may or may not show up in a uiBundle — we still parse them defensively.
  const sf = parseSalesforceSpecifier(spec);
  if (sf !== null) return sf;

  // 2. Relative or absolute path specifier.
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
    const fromDir = dirname(fromFileAbs);
    const candidate = isAbsolute(spec) ? spec : normalize(join(fromDir, spec));
    const probed = probeFile(candidate, bundleFilePaths);
    if (probed !== null) return { kind: "local", absolutePath: probed };
    return { kind: "unresolved", spec };
  }

  // 3. tsconfig path alias.
  const aliasMatches = resolvePathAlias(spec, tsconfig);
  for (const candidate of aliasMatches) {
    const probed = probeFile(candidate, bundleFilePaths);
    if (probed !== null) return { kind: "local", absolutePath: probed };
  }

  // 4. Bare specifier — npm package or other external module. Strip subpath; keep the
  //    top-level package name (handles "@scope/pkg/sub/path" -> "@scope/pkg").
  return { kind: "external", moduleName: packageNameOf(spec) };
}

function probeFile(candidate: string, bundleFilePaths: Set<string>): string | null {
  // Exact match (with extension).
  if (bundleFilePaths.has(candidate)) return candidate;
  // Try real fs as fallback in case tests pass an empty bundleFilePaths set.
  if (bundleFilePaths.size === 0 && safeIsFile(candidate)) return candidate;

  // Try with appended extensions.
  for (const ext of CANDIDATE_EXTS) {
    const withExt = candidate + ext;
    if (bundleFilePaths.has(withExt)) return withExt;
    if (bundleFilePaths.size === 0 && safeIsFile(withExt)) return withExt;
  }
  // Try /index.* for directory imports.
  for (const ext of CANDIDATE_EXTS) {
    const idx = join(candidate, "index" + ext);
    if (bundleFilePaths.has(idx)) return idx;
    if (bundleFilePaths.size === 0 && safeIsFile(idx)) return idx;
  }
  return null;
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function packageNameOf(spec: string): string {
  if (spec.startsWith("@")) {
    // @scope/pkg or @scope/pkg/subpath -> @scope/pkg
    const parts = spec.split("/");
    if (parts.length >= 2) return parts[0] + "/" + parts[1];
    return spec;
  }
  const slash = spec.indexOf("/");
  return slash === -1 ? spec : spec.slice(0, slash);
}

// Recognize the four LWC virtual module forms. Returns null if the specifier isn't one of them.
//   @salesforce/apex/Foo.bar
//   @salesforce/apex/ns__Foo.bar
//   @salesforce/schema/Account.Name
//   @salesforce/schema/Account
//   @salesforce/label/c.MyLabel
//   @salesforce/label/MyLabel
//   @salesforce/resourceUrl/MyResource
function parseSalesforceSpecifier(spec: string): ResolvedImport | null {
  if (!spec.startsWith("@salesforce/")) return null;
  const rest = spec.slice("@salesforce/".length);

  // @salesforce/apex/<[ns__]Class>.<method>
  if (rest.startsWith("apex/")) {
    const body = rest.slice("apex/".length);
    const dot = body.indexOf(".");
    if (dot === -1) return null;
    const classPart = body.slice(0, dot);
    const method = body.slice(dot + 1);
    const nsSplit = classPart.split("__");
    const hasNs = nsSplit.length === 2 && nsSplit[0] !== undefined && nsSplit[1] !== undefined;
    const namespace = hasNs ? (nsSplit[0] as string) : undefined;
    const className = hasNs ? (nsSplit[1] as string) : classPart;
    return { kind: "sf-apex", namespace, className, methodName: method };
  }

  // @salesforce/schema/<SObject>[.<Field>]
  if (rest.startsWith("schema/")) {
    const body = rest.slice("schema/".length);
    const dot = body.indexOf(".");
    if (dot === -1) {
      return { kind: "sf-schema", sobject: body, field: undefined };
    }
    return { kind: "sf-schema", sobject: body.slice(0, dot), field: body.slice(dot + 1) };
  }

  // @salesforce/label/[ns.]Label
  if (rest.startsWith("label/")) {
    const body = rest.slice("label/".length);
    const dot = body.indexOf(".");
    if (dot === -1) {
      return { kind: "sf-label", namespace: undefined, label: body };
    }
    return { kind: "sf-label", namespace: body.slice(0, dot), label: body.slice(dot + 1) };
  }

  // @salesforce/resourceUrl/[ns__]Name
  if (rest.startsWith("resourceUrl/")) {
    const body = rest.slice("resourceUrl/".length);
    const nsSplit = body.split("__");
    if (nsSplit.length === 2 && nsSplit[0] !== undefined && nsSplit[1] !== undefined) {
      return { kind: "sf-resource", namespace: nsSplit[0], name: nsSplit[1] };
    }
    return { kind: "sf-resource", namespace: undefined, name: body };
  }

  // Other @salesforce/* (platform-sdk, agentforce-conversation-client, ui-bundle, etc.) are
  // treated as external npm packages — the package name *is* the @salesforce/<pkg> prefix.
  return null;
}
