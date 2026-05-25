// Tokenizer for the Cypher subset supported in v0.5.
// Produces a flat token stream consumed by the recursive-descent parser.

export const enum TokenKind {
  // Keywords
  KwMatch = "MATCH",
  KwWhere = "WHERE",
  KwReturn = "RETURN",
  KwOrderBy = "ORDER_BY",   // ORDER BY treated as one keyword after scanning
  KwAsc = "ASC",
  KwDesc = "DESC",
  KwLimit = "LIMIT",
  KwSkip = "SKIP",
  KwAnd = "AND",
  KwOr = "OR",
  KwNot = "NOT",
  KwIn = "IN",
  KwIs = "IS",
  KwNull = "NULL",
  KwTrue = "TRUE",
  KwFalse = "FALSE",
  KwContains = "CONTAINS",
  KwStartsWith = "STARTS_WITH",   // STARTS WITH (two words)
  KwEndsWith = "ENDS_WITH",       // ENDS WITH (two words)
  KwCount = "COUNT",
  KwOptionalMatch = "OPTIONAL_MATCH",

  // Identifiers and literals
  Ident = "IDENT",
  StringLit = "STRING",
  NumberLit = "NUMBER",

  // Punctuation / operators
  LParen = "(",
  RParen = ")",
  LBracket = "[",
  RBracket = "]",
  Colon = ":",
  Dot = ".",
  Comma = ",",
  Star = "*",
  Dash = "-",
  Arrow = "->",
  LeftArrow = "<-",
  Pipe = "|",
  Eq = "=",
  LAngle = "<",
  RAngle = ">",

  EOF = "EOF",
}

export type Token = {
  kind: TokenKind;
  text: string;
  column: number;
};

// Two-word keyword sequences we collapse into a single token.
const TWO_WORD_KEYWORDS: Record<string, TokenKind> = {
  "ORDER BY": TokenKind.KwOrderBy,
  "STARTS WITH": TokenKind.KwStartsWith,
  "ENDS WITH": TokenKind.KwEndsWith,
  "IS NOT": TokenKind.KwIs,   // handled specially; we emit IS and NOT separately
  "OPTIONAL MATCH": TokenKind.KwOptionalMatch,
} as const;
void TWO_WORD_KEYWORDS; // referenced below

const RESERVED: Record<string, TokenKind> = {
  MATCH: TokenKind.KwMatch,
  WHERE: TokenKind.KwWhere,
  RETURN: TokenKind.KwReturn,
  ORDER: TokenKind.KwOrderBy,   // We'll merge "BY" below
  ASC: TokenKind.KwAsc,
  DESC: TokenKind.KwDesc,
  LIMIT: TokenKind.KwLimit,
  SKIP: TokenKind.KwSkip,
  AND: TokenKind.KwAnd,
  OR: TokenKind.KwOr,
  NOT: TokenKind.KwNot,
  IN: TokenKind.KwIn,
  IS: TokenKind.KwIs,
  NULL: TokenKind.KwNull,
  TRUE: TokenKind.KwTrue,
  FALSE: TokenKind.KwFalse,
  CONTAINS: TokenKind.KwContains,
  STARTS: TokenKind.KwStartsWith,  // will merge with WITH
  ENDS: TokenKind.KwEndsWith,      // will merge with WITH
  COUNT: TokenKind.KwCount,
  OPTIONAL: TokenKind.KwOptionalMatch, // will merge with MATCH
  BY: TokenKind.KwOrderBy,   // placeholder; always consumed by ORDER
  WITH: TokenKind.KwContains, // placeholder; consumed by STARTS/ENDS
} as const;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  function peek(): string {
    return pos < input.length ? input[pos]! : "";
  }

  function advance(): string {
    return input[pos++] ?? "";
  }

  function col(): number {
    return pos + 1;
  }

  while (pos < input.length) {
    // Skip whitespace
    if (/\s/.test(peek())) {
      advance();
      continue;
    }

    const startCol = pos + 1;
    const ch = peek();

    // String literal: single or double quotes
    if (ch === "'" || ch === '"') {
      const quote = advance();
      let value = "";
      while (pos < input.length && peek() !== quote) {
        if (peek() === "\\") {
          advance();
          const esc = advance();
          switch (esc) {
            case "n": value += "\n"; break;
            case "t": value += "\t"; break;
            case "r": value += "\r"; break;
            default: value += esc;
          }
        } else {
          value += advance();
        }
      }
      advance(); // closing quote
      tokens.push({ kind: TokenKind.StringLit, text: value, column: startCol });
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(input[pos + 1] ?? ""))) {
      let num = advance();
      while (pos < input.length && /[0-9.]/.test(peek())) {
        num += advance();
      }
      tokens.push({ kind: TokenKind.NumberLit, text: num, column: startCol });
      continue;
    }

    // Identifiers and keywords
    if (/[A-Za-z_$]/.test(ch)) {
      let ident = "";
      while (pos < input.length && /[A-Za-z0-9_$]/.test(peek())) {
        ident += advance();
      }
      const upper = ident.toUpperCase();
      const kind = RESERVED[upper] ?? TokenKind.Ident;
      tokens.push({ kind, text: ident, column: startCol });
      continue;
    }

    // Arrow ->
    if (ch === "-" && input[pos + 1] === ">") {
      advance(); advance();
      tokens.push({ kind: TokenKind.Arrow, text: "->", column: startCol });
      continue;
    }

    // Left arrow <-
    if (ch === "<" && input[pos + 1] === "-") {
      advance(); advance();
      tokens.push({ kind: TokenKind.LeftArrow, text: "<-", column: startCol });
      continue;
    }

    // Single-char tokens
    const singles: Record<string, TokenKind> = {
      "(": TokenKind.LParen,
      ")": TokenKind.RParen,
      "[": TokenKind.LBracket,
      "]": TokenKind.RBracket,
      ":": TokenKind.Colon,
      ".": TokenKind.Dot,
      ",": TokenKind.Comma,
      "*": TokenKind.Star,
      "-": TokenKind.Dash,
      "=": TokenKind.Eq,
      "<": TokenKind.LAngle,
      ">": TokenKind.RAngle,
      "|": TokenKind.Pipe,
    };
    if (ch in singles) {
      advance();
      tokens.push({ kind: singles[ch]!, text: ch, column: startCol });
      continue;
    }

    // Unknown character: skip with no error (best-effort)
    advance();
  }

  // Post-process: collapse multi-word keywords in sequence.
  // ORDER <BY> -> ORDER_BY (we already mapped ORDER -> KwOrderBy but need to eat the BY)
  // STARTS <WITH> -> KwStartsWith
  // ENDS <WITH> -> KwEndsWith
  // OPTIONAL <MATCH> -> KwOptionalMatch
  const merged: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const next = tokens[i + 1];

    if (t.kind === TokenKind.KwOrderBy && next !== undefined && next.text.toUpperCase() === "BY") {
      // ORDER + BY -> single ORDER_BY token
      merged.push({ kind: TokenKind.KwOrderBy, text: "ORDER BY", column: t.column });
      i += 2;
      continue;
    }

    if (t.kind === TokenKind.KwStartsWith && next !== undefined && next.text.toUpperCase() === "WITH") {
      merged.push({ kind: TokenKind.KwStartsWith, text: "STARTS WITH", column: t.column });
      i += 2;
      continue;
    }

    if (t.kind === TokenKind.KwEndsWith && next !== undefined && next.text.toUpperCase() === "WITH") {
      merged.push({ kind: TokenKind.KwEndsWith, text: "ENDS WITH", column: t.column });
      i += 2;
      continue;
    }

    if (t.kind === TokenKind.KwOptionalMatch && next !== undefined && next.text.toUpperCase() === "MATCH") {
      merged.push({ kind: TokenKind.KwOptionalMatch, text: "OPTIONAL MATCH", column: t.column });
      i += 2;
      continue;
    }

    // Standalone BY is not a real keyword; treat as identifier if it appears alone
    if (t.text.toUpperCase() === "BY") {
      merged.push({ kind: TokenKind.Ident, text: t.text, column: t.column });
      i++;
      continue;
    }

    // Standalone WITH is not a real keyword; treat as identifier if it appears alone
    if (t.text.toUpperCase() === "WITH") {
      merged.push({ kind: TokenKind.Ident, text: t.text, column: t.column });
      i++;
      continue;
    }

    merged.push(t);
    i++;
  }

  merged.push({ kind: TokenKind.EOF, text: "", column: col() });
  return merged;
}
