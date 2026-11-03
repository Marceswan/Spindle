// v0.7: GraphQL operation extraction. Takes a chunk of GraphQL source text (from a
// .graphql file or a `gql\`...\`` tagged template) and returns the operations, fragments,
// and per-operation top-level field selections it contains.
//
// Cross-domain mapping to SFDX metadata is name-based: when a query selects from a top
// level type whose name matches an existing SObject node, pass2 connects them. SFDC
// CRM GraphQL API exposes custom objects under their API name (`Customer__c` ↔ GraphQL
// type `Customer__c`), so the name-match heuristic works for the common case.
//
// What v0.7 captures:
//   - Operation: name, type (query|mutation|subscription), root selection field name
//   - Top-level field selections under each operation (depth-1 SelectionSet)
//   - Fragment definitions (name + on type)
// What v0.7 deliberately doesn't model:
//   - Variable resolution
//   - Spread fragment expansion
//   - Schema-aware type inference for nested selections (would need an introspection blob)
//   - GraphQL directives beyond capturing their names

import { parse, type DocumentNode, type DefinitionNode, type OperationDefinitionNode, type FragmentDefinitionNode, type SelectionNode, type FieldNode } from "graphql";

export type GraphqlOperationInfo = {
  name: string;                // anonymous operations are named "_anon_<line>"
  operationType: "query" | "mutation" | "subscription";
  // Top-level root selections — the names directly under the operation's root selection set.
  // For `query GetX { account { id name } }` the rootSelections are ["account"]; nested
  // fields are reported under fieldSelections keyed by their parent name.
  rootSelections: string[];
  // (rootSelectionName) -> [field names selected directly under it]. v0.7 walks depth 1 only.
  fieldSelections: Record<string, string[]>;
  startLine: number;
};

export type GraphqlFragmentInfo = {
  name: string;
  onType: string;             // `fragment Foo on Account` -> onType = "Account"
  fieldSelections: string[];  // depth-1 field names selected on the type
  startLine: number;
};

export type GraphqlParseResult = {
  operations: GraphqlOperationInfo[];
  fragments: GraphqlFragmentInfo[];
  // True if the input wasn't valid GraphQL. We swallow errors so a broken inline gql
  // template doesn't fail the whole bundle index — the parser surfaces a warning instead.
  parseError: string | null;
};

export function parseGraphqlSource(source: string): GraphqlParseResult {
  const result: GraphqlParseResult = {
    operations: [],
    fragments: [],
    parseError: null,
  };

  // Strip our `\$VARn` interpolation placeholders so the parser doesn't choke on them.
  // walk-ast.ts inserts these in place of template expressions; they're typically used in
  // GraphQL queries for argument interpolation, which we treat as opaque blobs.
  const cleaned = source.replace(/\\\$VAR\d+/g, "1");

  let doc: DocumentNode;
  try {
    doc = parse(cleaned, { noLocation: false });
  } catch (err) {
    result.parseError = (err as Error).message;
    return result;
  }

  for (const def of doc.definitions) {
    extractDefinition(def, result);
  }
  return result;
}

function extractDefinition(def: DefinitionNode, out: GraphqlParseResult): void {
  if (def.kind === "OperationDefinition") {
    out.operations.push(extractOperation(def));
  } else if (def.kind === "FragmentDefinition") {
    out.fragments.push(extractFragment(def));
  }
  // SchemaDefinition / TypeSystemDefinition / etc. — we don't care for v0.7.
}

function extractOperation(op: OperationDefinitionNode): GraphqlOperationInfo {
  const line = op.loc?.startToken.line ?? 0;
  const name = op.name?.value ?? `_anon_${line}`;
  const rootSelections: string[] = [];
  const fieldSelections: Record<string, string[]> = {};
  for (const sel of op.selectionSet.selections) {
    if (sel.kind === "Field") {
      const fieldName = sel.name.value;
      rootSelections.push(fieldName);
      const nested = childFieldNames(sel);
      if (nested.length > 0) fieldSelections[fieldName] = nested;
    }
  }
  return {
    name,
    operationType: op.operation,
    rootSelections,
    fieldSelections,
    startLine: line,
  };
}

function extractFragment(frag: FragmentDefinitionNode): GraphqlFragmentInfo {
  const line = frag.loc?.startToken.line ?? 0;
  return {
    name: frag.name.value,
    onType: frag.typeCondition.name.value,
    fieldSelections: childFieldNames({ selectionSet: frag.selectionSet } as unknown as FieldNode),
    startLine: line,
  };
}

function childFieldNames(field: FieldNode): string[] {
  const out: string[] = [];
  const ss = field.selectionSet;
  if (ss === undefined) return out;
  for (const sel of ss.selections) {
    pushFieldSelection(sel, out);
  }
  return out;
}

function pushFieldSelection(sel: SelectionNode, out: string[]): void {
  if (sel.kind === "Field") {
    out.push(sel.name.value);
  }
  // FragmentSpread / InlineFragment — out of v0.7 scope. The fragment's own definition
  // contributes its fields via its own GraphqlFragment node.
}
