// v1 SOQL/SOSL extraction strategy: regex. See section 6.4 of the design doc.
// Returns the FROM-clause SObject name.

// node.text in ANTLR strips all whitespace from the token stream, producing strings like
// "[SELECTId,NameFROMAccount]". The regex must handle both spaced and unspaced forms.
// SObject names are followed by SOQL continuation keywords (WHERE, ORDER, LIMIT, etc.) or
// end of string. We use a lookahead to stop the capture before the next keyword.
// The (?=...) lookahead matches the known SOQL keywords that can follow the SObject name.
const SOQL_FROM =
  /FROM\s*([A-Za-z_][A-Za-z0-9_]*)(?=\s|WHERE|ORDER|GROUP|LIMIT|OFFSET|HAVING|WITH|FOR|UPDATE|USING|TYPEOF|\]|$)/gi;
const SOSL_RETURNING =
  /RETURNING\s*([A-Za-z_][A-Za-z0-9_]*)(?=\s|\(|,|\]|$)/gi;

export type SoqlInfo = {
  fromObject: string;
};

// Field-list capture: match between `SELECT` and the first `FROM`. Robust to ANTLR's
// whitespace-stripped node.text (e.g. "SELECTId,NameFROMCustomer__c"). Non-greedy capture
// stops at the first FROM — subqueries land in v0.3 with a proper SOQL parser.
const SOQL_SELECT_BLOCK = /SELECT\s*(.+?)\s*FROM/i;

export function extractSoqlFromObject(soqlLiteral: string): SoqlInfo | null {
  // soqlLiteral may include leading/trailing brackets and whitespace.
  // ANTLR's node.text concatenates tokens without spaces, so we receive strings like
  // "[SELECTId,NameFROMAccountWHEREIsDeleted=FALSE]" or properly spaced source.
  // We find all FROM<identifier> occurrences and take the last one (handles subqueries).
  const inner = soqlLiteral.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  // Reset lastIndex since SOQL_FROM is a global regex.
  SOQL_FROM.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = SOQL_FROM.exec(inner)) !== null) {
    lastMatch = m;
  }
  if (lastMatch === null) return null;
  const fromObject = lastMatch[1];
  if (fromObject === undefined) return null;
  return { fromObject };
}

/**
 * Returns the simple bare-identifier field list from a SELECT clause. Filters out aggregates
 * (COUNT(Id), MAX(Field), …), subquery shapes, and dotted relationship traversals
 * (Account.Owner.Name) — those land in v0.3 with a proper SOQL parser. The aim of v0.2 is
 * to feed REFERENCES_FIELD edges for the dominant simple case.
 *
 * Works on both whitespace-preserved source and ANTLR's whitespace-stripped node.text
 * (e.g. "[SELECTId,NameFROMCustomer__c]").
 */
export function extractSoqlSelectFields(soqlLiteral: string): string[] {
  const inner = soqlLiteral.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  SOQL_SELECT_BLOCK.lastIndex = 0;
  const matched = SOQL_SELECT_BLOCK.exec(inner);
  if (matched === null) return [];
  const rawList = matched[1];
  if (rawList === undefined) return [];

  // Split on commas at paren depth 0.
  const fields: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of rawList) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) fields.push(current);

  const out: string[] = [];
  for (const raw of fields) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Reject dotted (relationship traversal) and parenthesized (aggregate / subquery) forms.
    if (trimmed.includes(".") || trimmed.includes("(")) continue;
    // Allow a trailing alias: "Email__c emailField" — keep only the first token.
    const firstTok = trimmed.split(/\s+/)[0];
    if (firstTok === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(firstTok)) continue;
    out.push(firstTok);
  }
  return out;
}

export function extractSoslReturningObjects(soslLiteral: string): string[] {
  const inner = soslLiteral.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  const out: string[] = [];
  let matched: RegExpExecArray | null;
  while ((matched = SOSL_RETURNING.exec(inner)) !== null) {
    const name = matched[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}
