// A reader for GraphQL documents, for the queries in a UI bundle. It reads the structure
// only: operations, fragments, selections, arguments and directives. It does not validate
// the document against a schema. The project keeps its dependency tree small, so this is a
// hand-written reader and not the `graphql` package.

export type GqlValue =
  | { kind: "scalar"; value: string | number | boolean | null }
  | { kind: "enum"; value: string }
  | { kind: "variable"; name: string }
  | { kind: "list"; items: GqlValue[] }
  | { kind: "object"; fields: Record<string, GqlValue> };

export type GqlField = {
  kind: "field";
  name: string;
  alias?: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
  // 1-based line in the document text.
  line: number;
};

export type GqlSelection =
  | GqlField
  | { kind: "spread"; name: string; line: number }
  | { kind: "inline"; typeCondition: string | null; selections: GqlSelection[]; line: number };

export type GqlOperation = {
  kind: "query" | "mutation" | "subscription";
  name: string | null;
  selections: GqlSelection[];
  line: number;
};

export type GqlFragment = { name: string; typeCondition: string; selections: GqlSelection[]; line: number };

export type GqlDocument = { operations: GqlOperation[]; fragments: GqlFragment[] };

type Token = { type: "punct" | "name" | "string" | "number"; text: string; line: number };

const PUNCTUATION = new Set(["{", "}", "(", ")", "[", "]", ":", "=", "!", "$", "@", "|", "&"]);

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\n") {
      line++;
      i++;
    } else if (ch === " " || ch === "\t" || ch === "\r" || ch === "," || ch === "﻿") {
      i++;
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("...", i)) {
      tokens.push({ type: "punct", text: "...", line });
      i += 3;
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end === -1) return null;
      const body = text.slice(i + 3, end);
      tokens.push({ type: "string", text: body, line });
      line += body.split("\n").length - 1;
      i = end + 3;
    } else if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\n") return null;
        if (text[j] === "\\" && j + 1 < text.length) {
          j++;
          const escaped = text[j] as string;
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        } else {
          value += text[j];
        }
        j++;
      }
      if (j >= text.length) return null;
      tokens.push({ type: "string", text: value, line });
      i = j + 1;
    } else if (PUNCTUATION.has(ch)) {
      tokens.push({ type: "punct", text: ch, line });
      i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j++;
      tokens.push({ type: "name", text: text.slice(i, j), line });
      i = j;
    } else if (/[-0-9]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j] as string)) j++;
      tokens.push({ type: "number", text: text.slice(i, j), line });
      i = j;
    } else {
      return null;
    }
  }
  return tokens;
}

class Failure extends Error {}

/** Returns the document, or null when the text is not a GraphQL document. */
export function parseGraphql(text: string): GqlDocument | null {
  const tokens = tokenize(text);
  if (tokens === null || tokens.length === 0) return null;
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isPunct = (value: string): boolean => peek()?.type === "punct" && peek()?.text === value;
  const fail = (): never => {
    throw new Failure();
  };
  const expectPunct = (value: string): Token => {
    if (!isPunct(value)) fail();
    return tokens[pos++] as Token;
  };
  const expectName = (): Token => {
    if (peek()?.type !== "name") fail();
    return tokens[pos++] as Token;
  };

  const value = (): GqlValue => {
    const token = peek();
    if (token === undefined) return fail();
    if (isPunct("$")) {
      pos++;
      return { kind: "variable", name: expectName().text };
    }
    if (isPunct("[")) {
      pos++;
      const items: GqlValue[] = [];
      while (!isPunct("]")) items.push(value());
      pos++;
      return { kind: "list", items };
    }
    if (isPunct("{")) {
      pos++;
      const fields: Record<string, GqlValue> = {};
      while (!isPunct("}")) {
        const key = expectName().text;
        expectPunct(":");
        fields[key] = value();
      }
      pos++;
      return { kind: "object", fields };
    }
    pos++;
    if (token.type === "string") return { kind: "scalar", value: token.text };
    if (token.type === "number") return { kind: "scalar", value: Number(token.text) };
    if (token.type === "name") {
      if (token.text === "true" || token.text === "false") return { kind: "scalar", value: token.text === "true" };
      if (token.text === "null") return { kind: "scalar", value: null };
      return { kind: "enum", value: token.text };
    }
    return fail();
  };

  const args = (): Record<string, GqlValue> => {
    const out: Record<string, GqlValue> = {};
    if (!isPunct("(")) return out;
    pos++;
    while (!isPunct(")")) {
      const key = expectName().text;
      expectPunct(":");
      out[key] = value();
    }
    pos++;
    return out;
  };

  const directives = (): void => {
    while (isPunct("@")) {
      pos++;
      expectName();
      args();
    }
  };

  const selectionSet = (): GqlSelection[] => {
    expectPunct("{");
    const out: GqlSelection[] = [];
    while (!isPunct("}")) {
      if (isPunct("...")) {
        const line = (tokens[pos++] as Token).line;
        const next = peek();
        if (next?.type === "name" && next.text !== "on") {
          pos++;
          directives();
          out.push({ kind: "spread", name: next.text, line });
        } else {
          let typeCondition: string | null = null;
          if (next?.type === "name") {
            pos++;
            typeCondition = expectName().text;
          }
          directives();
          out.push({ kind: "inline", typeCondition, selections: selectionSet(), line });
        }
        continue;
      }
      const first = expectName();
      let name = first.text;
      let alias: string | undefined;
      if (isPunct(":")) {
        pos++;
        alias = name;
        name = expectName().text;
      }
      const fieldArgs = args();
      directives();
      const selections = isPunct("{") ? selectionSet() : [];
      out.push({ kind: "field", name, ...(alias !== undefined ? { alias } : {}), args: fieldArgs, selections, line: first.line });
    }
    pos++;
    return out;
  };

  // `($a: Int = 1, $b: [ID!]!)`. Only the balance of the brackets matters.
  const variableDefinitions = (): void => {
    if (!isPunct("(")) return;
    let depth = 0;
    do {
      const token = tokens[pos++];
      if (token === undefined) fail();
      else if (token.type === "punct" && token.text === "(") depth++;
      else if (token.type === "punct" && token.text === ")") depth--;
    } while (depth > 0);
  };

  const doc: GqlDocument = { operations: [], fragments: [] };
  try {
    while (pos < tokens.length) {
      const token = peek() as Token;
      if (isPunct("{")) {
        doc.operations.push({ kind: "query", name: null, selections: selectionSet(), line: token.line });
      } else if (token.type === "name" && token.text === "fragment") {
        pos++;
        const name = expectName().text;
        if (expectName().text !== "on") fail();
        const typeCondition = expectName().text;
        directives();
        doc.fragments.push({ name, typeCondition, selections: selectionSet(), line: token.line });
      } else if (token.type === "name" && (token.text === "query" || token.text === "mutation" || token.text === "subscription")) {
        pos++;
        const name = peek()?.type === "name" ? expectName().text : null;
        variableDefinitions();
        directives();
        doc.operations.push({ kind: token.text, name, selections: selectionSet(), line: token.line });
      } else {
        return null;
      }
    }
  } catch (err) {
    if (err instanceof Failure) return null;
    throw err;
  }
  return doc;
}
