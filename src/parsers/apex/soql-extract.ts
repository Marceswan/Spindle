// SOQL uses the same ANTLR grammar as Apex; never recover boundaries with regex.
import { ApexLexer, ApexParser, CaseInsensitiveInputStream, QueryContext, SubQueryContext,
  FieldNameContext, SoqlFunctionContext, FromNameListContext, GroupByClauseContext, BoundExpressionContext, TypeOfContext } from "@apexdevtools/apex-parser";
import { CharStreams, CommonTokenStream, ParserRuleContext, Token } from "antlr4ts";
import { Interval } from "antlr4ts/misc/Interval";

export type SoqlField = { path: string; context: string; object?: string };
export type SoqlQuery = {
  fromObject: string;
  relationship: boolean;
  parent: number | null;
  fields: SoqlField[];
};
export type SoqlInfo = { fromObject: string; queries: SoqlQuery[]; warnings: string[] };

/** Original character interval, including whitespace and comments skipped by the lexer. */
export function originalText(node: ParserRuleContext): string {
  return node.start.inputStream?.getText(Interval.of(node.start.startIndex, node.stop?.stopIndex ?? node.start.stopIndex)) ?? "";
}

/** Parse complete SOQL, with or without Apex brackets. Invalid input fails closed. */
export function parseSoql(source: string): SoqlInfo | null {
  const trimmed = source.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  let errors = 0;
  const lexer = new ApexLexer(new CaseInsensitiveInputStream(CharStreams.fromString(inner)));
  lexer.removeErrorListeners();
  lexer.addErrorListener({ syntaxError: () => { errors++; } });
  const tokens = new CommonTokenStream(lexer);
  const parser = new ApexParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener({ syntaxError: () => { errors++; } });
  try {
    const tree = parser.query();
    if (errors || tokens.LA(1) !== Token.EOF) return null;
    return extractQueryTree(tree);
  } catch { return null; }
}

function extractQueryTree(tree: QueryContext): SoqlInfo | null {
  const queries: SoqlQuery[] = [];
  const warnings: string[] = [];
  function query(node: QueryContext | SubQueryContext, parent: number | null, relationship: boolean): void {
    const from = node.fromNameList();
    const fromObject = from.fieldName(0).text;
    if (from.fieldName().length > 1) warnings.push("Multiple FROM sources are parsed, but references outside the first source require metadata alias resolution");
    const alias = from.soqlId()[0]?.text;
    const index = queries.length;
    const selected = node instanceof QueryContext ? node.selectList().selectEntry() : node.subFieldList().subFieldEntry();
    const resultAliases = new Set(selected.map(entry => entry.soqlId()?.text.toLowerCase()).filter((name): name is string => name !== undefined));
    const scope: SoqlQuery = { fromObject, parent, relationship, fields: [] };
    queries.push(scope);
    const add = (path: string, context: string, object?: string): void => {
      if (context !== "SOQL_SELECT" && resultAliases.has(path.toLowerCase())) return;
      const parts = path.split(".");
      if (parts.length > 1 && (parts[0]?.toLowerCase() === alias?.toLowerCase() || parts[0]?.toLowerCase() === fromObject.toLowerCase())) parts.shift();
      const field: SoqlField = {path: parts.join("."), context, ...(object ? {object} : {})};
      if (!scope.fields.some(f => f.path.toLowerCase() === field.path.toLowerCase() && f.context === context && f.object === object)) scope.fields.push(field);
    };
    function walk(ctx: ParserRuleContext, context: string): void {
      if (ctx instanceof FromNameListContext || ctx instanceof BoundExpressionContext) return;
      if (ctx instanceof SoqlFunctionContext && ctx.FIELDS()) {
        warnings.push("FIELDS expansion depends on org schema; individual field references are not enumerated");
        return;
      }
      if (ctx instanceof QueryContext || ctx instanceof SubQueryContext) {
        query(ctx, index, context === "SOQL_SELECT");
        return;
      }
      if (ctx instanceof GroupByClauseContext) {
        const list = ctx.selectList();
        if (list) for (const entry of list.selectEntry()) walk(entry,"SOQL_GROUP_BY");
        for (const field of ctx.fieldName()) add(field.text,"SOQL_GROUP_BY");
        const having = ctx.logicalExpression();
        if (having) walk(having,"SOQL_HAVING");
        return;
      }
      if (ctx instanceof TypeOfContext) {
        for (const branch of ctx.whenClause()) {
          for (const field of branch.fieldNameList().fieldName()) add(field.text, context, branch.fieldName().text);
        }
        for (const field of ctx.elseClause()?.fieldNameList().fieldName() ?? []) add(`${ctx.fieldName().text}.${field.text}`, context);
        return;
      }
      if (ctx instanceof FieldNameContext) { add(ctx.text, context); return; }
      const name = ctx.constructor.name;
      const clauses: Record<string,string> = {SelectListContext:"SOQL_SELECT",SubFieldListContext:"SOQL_SELECT",WhereClauseContext:"SOQL_WHERE",GroupByClauseContext:"SOQL_GROUP_BY",HavingClauseContext:"SOQL_HAVING",OrderByClauseContext:"SOQL_ORDER_BY"};
      const next = clauses[name] ?? context;
      for (let i=0; i<ctx.childCount; i++) {
        const child = ctx.getChild(i);
        if (child instanceof ParserRuleContext) walk(child,next);
      }
    }
    for (let i=0;i<node.childCount;i++) {
      const child = node.getChild(i);
      if (child instanceof ParserRuleContext) walk(child,"SOQL_SELECT");
    }
  }
  query(tree,null,false);
  const root = queries[0];
  return root ? {fromObject:root.fromObject,queries,warnings} : null;
}

export function extractSoqlFromObject(source: string): SoqlInfo | null { return parseSoql(source); }
export function extractSoqlSelectFields(source: string): string[] {
  return parseSoql(source)?.queries[0]?.fields.filter(f=>f.context === "SOQL_SELECT").map(f=>f.path) ?? [];
}

// SOSL is a separate language; retained independently from the SOQL parser.
export function extractSoslReturningObjects(source: string): string[] {
  const out: string[] = [];
  const pattern = /RETURNING\s*([A-Za-z_][A-Za-z0-9_]*)(?=\s|\(|,|\]|$)/gi;
  for (const match of source.matchAll(pattern)) if (match[1]) out.push(match[1]);
  return out;
}
