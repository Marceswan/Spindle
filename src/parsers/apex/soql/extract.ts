// Extract from ANTLR contexts, preserving identifier and quoted-literal boundaries.
// Plain source is accepted for callers outside the Apex walker. Whitespace-stripped text
// is ambiguous and is deliberately not repaired with substring heuristics.
import { ApexLexer, ApexParser, CaseInsensitiveInputStream, SoqlLiteralContext, FieldNameContext,
  FromNameListContext, SubQueryContext, WhereClauseContext, OrderByClauseContext, GroupByClauseContext } from "@apexdevtools/apex-parser";
import { CharStreams, CommonTokenStream, ParserRuleContext } from "antlr4ts";

export type SoqlClause =
  | "SOQL_SELECT"
  | "SOQL_WHERE"
  | "SOQL_ORDERBY"
  | "SOQL_GROUPBY"
  | "SOQL_HAVING"
  | "SOQL_SUBQUERY";

export type SoqlFieldRef = {
  leaf: string; // final path segment, e.g. "Name"
  path: string[]; // full dotted path, e.g. ["Account", "Owner", "Name"]
  clause: SoqlClause;
};

export function extractSoqlFieldRefs(input: string | SoqlLiteralContext): SoqlFieldRef[] {
  let tree: SoqlLiteralContext;
  if (typeof input === "string") {
    const lexer = new ApexLexer(new CaseInsensitiveInputStream(CharStreams.fromString(input)));
    lexer.removeErrorListeners();
    const parser = new ApexParser(new CommonTokenStream(lexer));
    parser.removeErrorListeners();
    tree = parser.soqlLiteral();
    if (parser.numberOfSyntaxErrors > 0) return [];
  } else tree = input;
  const refs = new Map<string, SoqlFieldRef>();
  function walk(node: ParserRuleContext, clause: SoqlClause, subquery = false): void {
    if (node instanceof FromNameListContext) return;
    if (node instanceof SubQueryContext) subquery = true;
    if (node instanceof WhereClauseContext) clause = "SOQL_WHERE";
    if (node instanceof OrderByClauseContext) clause = "SOQL_ORDERBY";
    if (node instanceof GroupByClauseContext) clause = "SOQL_GROUPBY";
    if (node instanceof FieldNameContext) {
      const path = node.soqlId().map((part) => part.text);
      if (path.length) {
        const context = subquery ? "SOQL_SUBQUERY" : clause;
        refs.set(`${context}:${path.join(".")}`, { path, leaf: path[path.length - 1]!, clause: context });
      }
      return;
    }
    const having = node instanceof GroupByClauseContext ? node.HAVING()?.symbol.tokenIndex : undefined;
    for (const child of node.children ?? []) {
      if (child instanceof ParserRuleContext) {
        walk(child, having !== undefined && child.start.tokenIndex > having ? "SOQL_HAVING" : clause, subquery);
      }
    }
  }
  walk(tree, "SOQL_SELECT");
  return [...refs.values()];
}
