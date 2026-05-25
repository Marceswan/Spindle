// Recursive-descent parser for the v0.5 Cypher subset.
// Produces a CypherQuery AST or throws a ParseError-shaped Error.

import { tokenize, TokenKind } from "./tokenizer.ts";
import type { Token } from "./tokenizer.ts";
import type {
  CypherQuery,
  MatchPattern,
  NodePattern,
  RelPattern,
  RelationshipDirection,
  WherePredicate,
  PropAccess,
  Literal,
  StringLiteral,
  NumberLiteral,
  BooleanLiteral,
  ListLiteral,
  ReturnItem,
  OrderByClause,
} from "./types.ts";

// Attach column info to parse errors.
class ParseFailure extends Error {
  readonly column: number;
  constructor(message: string, column: number) {
    super(message);
    this.column = column;
  }
}

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  // --- Token stream helpers ------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: TokenKind.EOF, text: "", column: 0 };
  }

  private peek2(): Token {
    return this.tokens[this.pos + 1] ?? { kind: TokenKind.EOF, text: "", column: 0 };
  }

  private advance(): Token {
    const t = this.peek();
    if (t.kind !== TokenKind.EOF) this.pos++;
    return t;
  }

  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new ParseFailure(
        `Expected ${kind} but got '${t.text}' (${t.kind})`,
        t.column,
      );
    }
    return this.advance();
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private checkIdent(name: string): boolean {
    const t = this.peek();
    return t.kind === TokenKind.Ident && t.text.toUpperCase() === name.toUpperCase();
  }

  // Consume a token if it matches, else return null.
  private tryConsume(kind: TokenKind): Token | null {
    if (this.check(kind)) return this.advance();
    return null;
  }

  private currentCol(): number {
    return this.peek().column;
  }

  // ---------------------------------------------------------------------------
  // Top-level query
  // ---------------------------------------------------------------------------

  parse(): CypherQuery {
    const match = this.parseMatch();

    let where: WherePredicate | undefined;
    if (this.check(TokenKind.KwWhere)) {
      this.advance();
      where = this.parseWherePredicate();
    }

    this.expect(TokenKind.KwReturn);
    const returnItems = this.parseReturnItems();

    let orderBy: OrderByClause | undefined;
    if (this.check(TokenKind.KwOrderBy)) {
      this.advance();
      orderBy = this.parseOrderBy();
    }

    let skip: number | undefined;
    if (this.check(TokenKind.KwSkip)) {
      this.advance();
      const t = this.expect(TokenKind.NumberLit);
      skip = parseInt(t.text, 10);
    }

    let limit: number | undefined;
    if (this.check(TokenKind.KwLimit)) {
      this.advance();
      const t = this.expect(TokenKind.NumberLit);
      limit = parseInt(t.text, 10);
    }

    if (!this.check(TokenKind.EOF)) {
      const t = this.peek();
      throw new ParseFailure(
        `Unexpected token '${t.text}' after query end`,
        t.column,
      );
    }

    const query: CypherQuery = {
      match,
      returnItems,
      ...(where !== undefined ? { where } : {}),
      ...(orderBy !== undefined ? { orderBy } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(skip !== undefined ? { skip } : {}),
    };
    return query;
  }

  // ---------------------------------------------------------------------------
  // MATCH clause
  // ---------------------------------------------------------------------------

  private parseMatch(): MatchPattern {
    const t = this.peek();

    // Detect OPTIONAL MATCH upfront and reject it.
    if (t.kind === TokenKind.KwOptionalMatch) {
      throw new ParseFailure(
        "Unsupported: OPTIONAL MATCH is not implemented in v0.5. Use regular MATCH.",
        t.column,
      );
    }

    this.expect(TokenKind.KwMatch);
    this.expect(TokenKind.LParen);

    const leftVar = this.parseVariableName();
    const leftLabel = this.tryParseLabel();
    const leftNode: NodePattern = {
      variable: leftVar,
      ...(leftLabel !== undefined ? { label: leftLabel } : {}),
    };

    this.expect(TokenKind.RParen);

    // Check if there is a relationship pattern.
    if (this.check(TokenKind.Dash) || this.check(TokenKind.LeftArrow)) {
      return this.parseRelationshipPattern(leftNode);
    }

    return { kind: "nodeOnly", node: leftNode };
  }

  private parseRelationshipPattern(left: NodePattern): MatchPattern {
    let direction: RelationshipDirection;

    if (this.check(TokenKind.LeftArrow)) {
      // (left)<-[r]-(right)
      this.advance(); // consume <-
      direction = "incoming";
    } else {
      // (left)-[r]->(right)
      this.expect(TokenKind.Dash);
      direction = "outgoing";
    }

    this.expect(TokenKind.LBracket);

    // Relationship variable (may be anonymous)
    let relVar = "";
    let relType: string | undefined;

    if (this.check(TokenKind.Ident)) {
      relVar = this.advance().text;
    }

    if (this.check(TokenKind.Colon)) {
      this.advance();
      const typeTok = this.peek();
      if (typeTok.kind !== TokenKind.Ident) {
        throw new ParseFailure(
          `Expected edge type identifier after ':' in relationship pattern`,
          typeTok.column,
        );
      }
      relType = this.advance().text.toUpperCase();
    }

    this.expect(TokenKind.RBracket);

    if (direction === "incoming") {
      // Expect just - at end: ...[r]-(right)
      this.expect(TokenKind.Dash);
    } else {
      // Expect -> at end: ...[r]->(right)
      this.expect(TokenKind.Arrow);
    }

    this.expect(TokenKind.LParen);
    const rightVar = this.parseVariableName();
    const rightLabel = this.tryParseLabel();
    const right: NodePattern = {
      variable: rightVar,
      ...(rightLabel !== undefined ? { label: rightLabel } : {}),
    };
    this.expect(TokenKind.RParen);

    const rel: RelPattern = {
      variable: relVar,
      ...(relType !== undefined ? { edgeType: relType } : {}),
    };

    return { kind: "relationship", left, rel, right, direction };
  }

  // Returns "" when no variable (anonymous)
  private parseVariableName(): string {
    if (this.check(TokenKind.Ident)) {
      return this.advance().text;
    }
    // Anonymous node / relationship is fine
    return "";
  }

  private tryParseLabel(): string | undefined {
    if (!this.check(TokenKind.Colon)) return undefined;
    this.advance();
    const t = this.peek();
    if (t.kind !== TokenKind.Ident) {
      throw new ParseFailure(`Expected label name after ':'`, t.column);
    }
    return this.advance().text;
  }

  // ---------------------------------------------------------------------------
  // WHERE clause
  // ---------------------------------------------------------------------------

  private parseWherePredicate(): WherePredicate {
    return this.parseOr();
  }

  private parseOr(): WherePredicate {
    let left = this.parseAnd();
    while (this.check(TokenKind.KwOr)) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): WherePredicate {
    let left = this.parseAtom();
    while (this.check(TokenKind.KwAnd)) {
      this.advance();
      const right = this.parseAtom();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseAtom(): WherePredicate {
    if (this.check(TokenKind.LParen)) {
      this.advance();
      const inner = this.parseWherePredicate();
      this.expect(TokenKind.RParen);
      return inner;
    }

    const prop = this.parsePropAccess();

    // IS NULL / IS NOT NULL
    if (this.check(TokenKind.KwIs)) {
      this.advance();
      const negated = this.tryConsume(TokenKind.KwNot) !== null;
      this.expect(TokenKind.KwNull);
      return { kind: "isNull", left: prop, negated };
    }

    // IN [...]
    if (this.check(TokenKind.KwIn)) {
      this.advance();
      const list = this.parseListLiteral();
      return { kind: "in", left: prop, right: list };
    }

    // CONTAINS
    if (this.check(TokenKind.KwContains)) {
      this.advance();
      const s = this.parseStringLiteral();
      return { kind: "contains", left: prop, right: s };
    }

    // STARTS WITH
    if (this.check(TokenKind.KwStartsWith)) {
      this.advance();
      const s = this.parseStringLiteral();
      return { kind: "startsWith", left: prop, right: s };
    }

    // ENDS WITH
    if (this.check(TokenKind.KwEndsWith)) {
      this.advance();
      const s = this.parseStringLiteral();
      return { kind: "endsWith", left: prop, right: s };
    }

    // = <literal>
    if (this.check(TokenKind.Eq)) {
      this.advance();
      const lit = this.parseLiteral();
      return { kind: "eq", left: prop, right: lit };
    }

    throw new ParseFailure(
      `Expected comparison operator after property access '${prop.variable}.${prop.property}'`,
      this.currentCol(),
    );
  }

  // Parse n.prop — requires identifier DOT identifier
  private parsePropAccess(): PropAccess {
    const varTok = this.peek();
    if (varTok.kind !== TokenKind.Ident) {
      throw new ParseFailure(
        `Expected variable name, got '${varTok.text}'`,
        varTok.column,
      );
    }
    this.advance();
    this.expect(TokenKind.Dot);
    const propTok = this.peek();
    if (propTok.kind !== TokenKind.Ident) {
      throw new ParseFailure(
        `Expected property name after '.', got '${propTok.text}'`,
        propTok.column,
      );
    }
    this.advance();
    return { kind: "prop", variable: varTok.text, property: propTok.text };
  }

  private parseLiteral(): Literal {
    const t = this.peek();
    if (t.kind === TokenKind.StringLit) {
      this.advance();
      return { kind: "string", value: t.text };
    }
    if (t.kind === TokenKind.NumberLit) {
      this.advance();
      return { kind: "number", value: parseFloat(t.text) };
    }
    if (t.kind === TokenKind.KwTrue) {
      this.advance();
      return { kind: "boolean", value: true };
    }
    if (t.kind === TokenKind.KwFalse) {
      this.advance();
      return { kind: "boolean", value: false };
    }
    if (t.kind === TokenKind.KwNull) {
      this.advance();
      return { kind: "null" };
    }
    throw new ParseFailure(`Expected a literal value, got '${t.text}'`, t.column);
  }

  private parseStringLiteral(): StringLiteral {
    const t = this.expect(TokenKind.StringLit);
    return { kind: "string", value: t.text };
  }

  private parseListLiteral(): ListLiteral {
    this.expect(TokenKind.LBracket);
    const items: (StringLiteral | NumberLiteral | BooleanLiteral)[] = [];
    while (!this.check(TokenKind.RBracket) && !this.check(TokenKind.EOF)) {
      const lit = this.parseLiteral();
      if (lit.kind !== "string" && lit.kind !== "number" && lit.kind !== "boolean") {
        throw new ParseFailure(
          `List members must be string, number, or boolean literals`,
          this.currentCol(),
        );
      }
      items.push(lit);
      if (!this.check(TokenKind.Comma)) break;
      this.advance();
    }
    this.expect(TokenKind.RBracket);
    return { kind: "list", items };
  }

  // ---------------------------------------------------------------------------
  // RETURN clause
  // ---------------------------------------------------------------------------

  private parseReturnItems(): ReturnItem[] {
    const items: ReturnItem[] = [];
    items.push(this.parseReturnItem());
    while (this.check(TokenKind.Comma)) {
      this.advance();
      items.push(this.parseReturnItem());
    }
    return items;
  }

  private parseReturnItem(): ReturnItem {
    const t = this.peek();

    // count(*) or count(n)
    if (t.kind === TokenKind.KwCount) {
      this.advance();
      this.expect(TokenKind.LParen);
      let arg = "*";
      if (!this.check(TokenKind.Star)) {
        if (this.check(TokenKind.Ident)) {
          arg = this.advance().text;
        }
      } else {
        this.advance(); // *
      }
      this.expect(TokenKind.RParen);
      return { kind: "count", arg };
    }

    if (t.kind !== TokenKind.Ident) {
      throw new ParseFailure(`Expected return item, got '${t.text}'`, t.column);
    }
    const varName = this.advance().text;

    // n.prop
    if (this.check(TokenKind.Dot)) {
      this.advance();
      const propTok = this.peek();
      if (propTok.kind !== TokenKind.Ident) {
        throw new ParseFailure(
          `Expected property name after '.' in return clause`,
          propTok.column,
        );
      }
      const prop = this.advance().text;
      return { kind: "prop", variable: varName, property: prop };
    }

    return { kind: "variable", name: varName };
  }

  // ---------------------------------------------------------------------------
  // ORDER BY
  // ---------------------------------------------------------------------------

  private parseOrderBy(): OrderByClause {
    const prop = this.parsePropAccess();
    let direction: "ASC" | "DESC" = "ASC";
    if (this.check(TokenKind.KwAsc)) {
      this.advance();
      direction = "ASC";
    } else if (this.check(TokenKind.KwDesc)) {
      this.advance();
      direction = "DESC";
    }
    return { prop, direction };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; query: CypherQuery }
  | { ok: false; message: string; column: number };

export function parseCypher(input: string): ParseResult {
  try {
    const p = new Parser(input);
    const query = p.parse();
    return { ok: true, query };
  } catch (err) {
    if (err instanceof ParseFailure) {
      return { ok: false, message: err.message, column: err.column };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg, column: 0 };
  }
}
