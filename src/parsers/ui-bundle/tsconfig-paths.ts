// Read tsconfig.json from a uiBundle and produce a path-alias resolver. We DO NOT use the
// TypeScript compiler API — parsing a small JSON-with-comments file ourselves keeps the
// runtime dependency surface flat (Bun-compiled binary stays small).
//
// Supports the subset of tsconfig that real uiBundles emit:
//   - compilerOptions.baseUrl   (default ".")
//   - compilerOptions.paths     ({ "@/*": ["./src/*"], "@api/*": ["./src/api/*"], ... })
//
// We strip block and line comments before JSON.parse since tsconfig.json is "JSONC" in
// practice (Microsoft writes it with comments routinely).

import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export type TsconfigPaths = {
  baseUrl: string; // absolute
  // Each alias is { prefix, suffix?, targets[] } parsed from the original "@/*": ["./src/*"] map.
  // suffix is "" for exact aliases (no trailing *).
  aliases: PathAlias[];
};

export type PathAlias = {
  prefix: string;
  suffix: string;
  targets: { prefix: string; suffix: string }[]; // each relative to baseUrl
  isWildcard: boolean;
};

export function loadTsconfigPaths(tsconfigAbsPath: string, bundleDir: string): TsconfigPaths {
  const baseUrlDefault = bundleDir;
  try {
    const raw = readFileSync(tsconfigAbsPath, "utf8");
    const json = parseJsonc(raw);
    const co = (json as Record<string, unknown>).compilerOptions as Record<string, unknown> | undefined;
    if (co === undefined) return { baseUrl: baseUrlDefault, aliases: [] };

    const baseUrlRaw = typeof co.baseUrl === "string" ? co.baseUrl : ".";
    const baseUrl = isAbsolute(baseUrlRaw) ? baseUrlRaw : normalize(join(bundleDir, baseUrlRaw));

    const aliases: PathAlias[] = [];
    const paths = co.paths as Record<string, unknown> | undefined;
    if (paths !== undefined && typeof paths === "object") {
      for (const [aliasKey, targetsRaw] of Object.entries(paths)) {
        if (!Array.isArray(targetsRaw)) continue;
        const targets: { prefix: string; suffix: string }[] = [];
        for (const t of targetsRaw) {
          if (typeof t !== "string") continue;
          const split = splitWildcard(t);
          targets.push(split);
        }
        if (targets.length === 0) continue;
        const key = splitWildcard(aliasKey);
        aliases.push({
          prefix: key.prefix,
          suffix: key.suffix,
          targets,
          isWildcard: key.suffix !== "" || aliasKey.includes("*"),
        });
      }
    }
    return { baseUrl, aliases };
  } catch {
    return { baseUrl: baseUrlDefault, aliases: [] };
  }
}

function splitWildcard(spec: string): { prefix: string; suffix: string } {
  const star = spec.indexOf("*");
  if (star === -1) return { prefix: spec, suffix: "" };
  return { prefix: spec.slice(0, star), suffix: spec.slice(star + 1) };
}

// Resolve a module specifier (e.g. "@/components/ui/button") against the paths map.
// Returns the absolute resolved path with NO extension, or null if no alias matches.
// Callers append .ts/.tsx/.js/.jsx/index.* themselves when probing the filesystem.
export function resolvePathAlias(spec: string, cfg: TsconfigPaths): string[] {
  const matches: string[] = [];
  for (const alias of cfg.aliases) {
    if (!spec.startsWith(alias.prefix)) continue;
    const rest = spec.slice(alias.prefix.length);
    if (alias.isWildcard) {
      // For wildcards the alias suffix is "" in the common @/* case; for "@foo*" or "@foo/*"
      // suffix is "" or "/" — either way we treat the captured portion as `rest`.
      if (alias.suffix !== "" && !rest.endsWith(alias.suffix)) continue;
      const captured = alias.suffix === "" ? rest : rest.slice(0, rest.length - alias.suffix.length);
      for (const target of alias.targets) {
        const filled = target.suffix === ""
          ? target.prefix + captured
          : target.prefix + captured + target.suffix;
        const abs = isAbsolute(filled) ? filled : normalize(join(cfg.baseUrl, filled));
        matches.push(abs);
      }
    } else {
      if (rest !== "") continue; // exact alias must match exactly
      for (const target of alias.targets) {
        const abs = isAbsolute(target.prefix)
          ? target.prefix
          : normalize(join(cfg.baseUrl, target.prefix));
        matches.push(abs);
      }
    }
  }
  return matches;
}

// Strip /* ... */ and // ... comments from JSONC. Naive but sufficient for tsconfig files:
// we don't tokenize strings, so a `// inside a "string"` would be wrongly stripped, but tsconfig
// files don't contain such constructs in practice.
function parseJsonc(text: string): unknown {
  // Remove block comments first, then line comments, then trailing commas.
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/(^|[^:])\/\/[^\n]*$/gm, (m, p1) => p1);
  const noTrailingCommas = noLine.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailingCommas);
}
