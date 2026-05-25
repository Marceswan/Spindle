// Shared AST types for the Cypher subset parser.
// Covers the v0.5 supported subset: MATCH, WHERE, RETURN, ORDER BY, LIMIT, SKIP.

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export type StringLiteral = { kind: "string"; value: string };
export type NumberLiteral = { kind: "number"; value: number };
export type BooleanLiteral = { kind: "boolean"; value: boolean };
export type NullLiteral = { kind: "null" };
export type ListLiteral = { kind: "list"; items: (StringLiteral | NumberLiteral | BooleanLiteral)[] };

export type Literal = StringLiteral | NumberLiteral | BooleanLiteral | NullLiteral | ListLiteral;

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

// e.g., n.name   n.properties.sharing   n.qualified_name
export type PropAccess = { kind: "prop"; variable: string; property: string };

// ---------------------------------------------------------------------------
// WHERE predicates
// ---------------------------------------------------------------------------

export type EqPredicate = {
  kind: "eq";
  left: PropAccess;
  right: Literal;
};

export type ContainsPredicate = {
  kind: "contains";
  left: PropAccess;
  right: StringLiteral;
};

export type StartsWithPredicate = {
  kind: "startsWith";
  left: PropAccess;
  right: StringLiteral;
};

export type EndsWithPredicate = {
  kind: "endsWith";
  left: PropAccess;
  right: StringLiteral;
};

export type InPredicate = {
  kind: "in";
  left: PropAccess;
  right: ListLiteral;
};

export type IsNullPredicate = {
  kind: "isNull";
  left: PropAccess;
  negated: boolean; // true = IS NOT NULL
};

export type AndPredicate = { kind: "and"; left: WherePredicate; right: WherePredicate };
export type OrPredicate = { kind: "or"; left: WherePredicate; right: WherePredicate };

export type WherePredicate =
  | EqPredicate
  | ContainsPredicate
  | StartsWithPredicate
  | EndsWithPredicate
  | InPredicate
  | IsNullPredicate
  | AndPredicate
  | OrPredicate;

// ---------------------------------------------------------------------------
// MATCH clause
// ---------------------------------------------------------------------------

// (n:Label) or (n) when label is undefined
export type NodePattern = {
  variable: string;     // e.g., "n"
  label?: string;       // e.g., "ApexClass"
};

// Direction of the relationship from the perspective of the MATCH clause.
// "outgoing" = (n)-[r]->(m), "incoming" = (n)<-[r]-(m)
export type RelationshipDirection = "outgoing" | "incoming";

export type RelPattern = {
  variable: string;     // e.g., "r" or "" for anonymous
  edgeType?: string;    // e.g., "EXTENDS" or undefined for any
};

export type SimpleNodeMatch = {
  kind: "nodeOnly";
  node: NodePattern;
};

export type RelationshipMatch = {
  kind: "relationship";
  left: NodePattern;
  rel: RelPattern;
  right: NodePattern;
  direction: RelationshipDirection;
};

export type MatchPattern = SimpleNodeMatch | RelationshipMatch;

// ---------------------------------------------------------------------------
// RETURN clause
// ---------------------------------------------------------------------------

// RETURN n  — whole node binding
export type ReturnVariable = { kind: "variable"; name: string };

// RETURN n.name  — single property projection
export type ReturnProp = { kind: "prop"; variable: string; property: string };

// RETURN count(*) or count(n)
export type ReturnCount = { kind: "count"; arg: string };

export type ReturnItem = ReturnVariable | ReturnProp | ReturnCount;

// ---------------------------------------------------------------------------
// ORDER BY
// ---------------------------------------------------------------------------

export type OrderByClause = {
  prop: PropAccess;
  direction: "ASC" | "DESC";
};

// ---------------------------------------------------------------------------
// Full query
// ---------------------------------------------------------------------------

export type CypherQuery = {
  match: MatchPattern;
  where?: WherePredicate;
  returnItems: ReturnItem[];
  orderBy?: OrderByClause;
  limit?: number;
  skip?: number;
};

// ---------------------------------------------------------------------------
// Parse error
// ---------------------------------------------------------------------------

export type ParseError = {
  message: string;
  column: number;
};
