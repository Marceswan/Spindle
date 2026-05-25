// Simple token walker for Salesforce formula expressions. Per design §6.7, this is the v1
// strategy: identifier-following-dot is a reference candidate; full formula AST is a future
// improvement. Confidence on extracted edges is 0.6 (Regex tier).
//
// Patterns we recognize:
//   - FieldName__c                  -> reference on the containing object
//   - Object__c.FieldName__c        -> cross-object via lookup
//   - $Label.LabelName              -> custom label (returned as "$Label.LabelName"; the
//                                     caller emits the appropriate edge type)
//   - $CustomMetadata.X__mdt.Y.Z__c -> custom metadata; returned as the full path
//
// Returned references are absolute qualified names (`Parent.Field` or `$Label.X`). The
// caller decides which edge type to emit per kind.

const IDENT_TOKEN = /\$?[A-Za-z_][A-Za-z0-9_]*/g;

export type FormulaReference = string;

export function extractFormulaFieldReferences(
  formula: string,
  defaultParent: string,
): FormulaReference[] {
  const out = new Set<FormulaReference>();
  const tokens = formula.match(IDENT_TOKEN) ?? [];
  const ranges = matchAllRanges(formula, IDENT_TOKEN);

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range === undefined) continue;
    const token = formula.slice(range.start, range.end);

    if (/^\d/.test(token)) continue;
    if (RESERVED.has(token.toUpperCase())) continue;

    if (token.startsWith("$")) {
      const chain = collectDotChain(formula, tokens, ranges, i);
      out.add(chain.full);
      i += chain.consumedTokens - 1;
      continue;
    }

    const prev = previousNonSpaceChar(formula, range.start);
    if (prev === ".") continue;

    const chain = collectDotChain(formula, tokens, ranges, i);
    const parts = chain.full.split(".");
    if (parts.length === 1) {
      out.add(`${defaultParent}.${parts[0]}`);
    } else {
      out.add(chain.full);
    }
    i += chain.consumedTokens - 1;
  }

  return [...out];
}

type Range = { start: number; end: number };

function matchAllRanges(src: string, pattern: RegExp): Range[] {
  const out: Range[] = [];
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let matched: RegExpExecArray | null;
  while ((matched = re.exec(src)) !== null) {
    out.push({ start: matched.index, end: matched.index + matched[0].length });
    if (matched.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function previousNonSpaceChar(src: string, idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === undefined) return null;
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return ch;
  }
  return null;
}

function collectDotChain(
  src: string,
  tokens: string[],
  ranges: Range[],
  startIdx: number,
): { full: string; consumedTokens: number } {
  const parts: string[] = [];
  const firstToken = tokens[startIdx];
  if (firstToken === undefined) return { full: "", consumedTokens: 0 };
  parts.push(firstToken);
  let cur = startIdx;
  while (cur + 1 < ranges.length) {
    const currentEnd = ranges[cur]?.end;
    const nextStart = ranges[cur + 1]?.start;
    if (currentEnd === undefined || nextStart === undefined) break;
    const between = src.slice(currentEnd, nextStart).replace(/\s+/g, "");
    if (between !== ".") break;
    const nextToken = tokens[cur + 1];
    if (nextToken === undefined) break;
    parts.push(nextToken);
    cur++;
  }
  return { full: parts.join("."), consumedTokens: cur - startIdx + 1 };
}

// Conservative reserved-word filter. Salesforce formula functions and constants we should
// not treat as field references. Not exhaustive — we err on the side of false positives.
const RESERVED = new Set<string>([
  "TRUE", "FALSE", "NULL",
  "AND", "OR", "NOT", "IF", "CASE",
  "ISBLANK", "ISNULL", "ISNUMBER", "ISCHANGED", "ISNEW", "ISPICKVAL",
  "TEXT", "VALUE", "ABS", "ROUND", "CEILING", "FLOOR", "MAX", "MIN", "MOD", "SQRT",
  "BEGINS", "CONTAINS", "FIND", "LEFT", "RIGHT", "MID", "LEN", "LOWER", "UPPER",
  "TRIM", "LPAD", "RPAD", "SUBSTITUTE", "REGEX",
  "TODAY", "NOW", "YEAR", "MONTH", "DAY", "DATEVALUE", "DATETIMEVALUE",
  "ADDMONTHS", "WEEKDAY", "HOUR", "MINUTE", "SECOND", "MILLISECOND",
  "IMAGE", "HYPERLINK", "INCLUDES", "MULTI", "PRIORVALUE",
  "BLANKVALUE", "NULLVALUE", "DISTANCE", "GEOLOCATION",
]);
