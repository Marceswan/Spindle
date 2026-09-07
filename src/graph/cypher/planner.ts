// Compile the read-only Cypher subset into parameterized SQLite CTEs. Each
// clause consumes a row scope and produces the next; OPTIONAL MATCH joins the
// complete candidate pattern so a failed predicate nulls all new bindings.
import type { CypherQuery, Literal, MatchClause, ProjectionClause, PropAccess, ReturnItem, WherePredicate } from "./types.ts";

export type ColumnKind = "node" | "edge" | "scalar";
type Binding = { expr: string; kind: ColumnKind; idExpr?: string };
type Scope = Map<string, Binding>;
export type SqlPlan = {
  sql: string;
  params: (string | number | null)[];
  columns: string[];
  columnKinds: ColumnKind[];
  variableAliases: Map<string, string>;
};
const NODE_COLUMNS = ["id", "project_id", "label", "name", "qualified_name", "file_path", "start_line", "end_line", "properties", "content_hash"];
const EDGE_COLUMNS = ["id", "project_id", "source_id", "target_id", "edge_type", "confidence", "properties", "source_file", "source_line"];
function binding(scope: Scope, name: string): Binding {
  const value = scope.get(name);
  if (!value) throw new Error(`Variable '${name}' is not in scope`);
  return value;
}
function access(prop: PropAccess, scope: Scope): string {
  const value = binding(scope, prop.variable);
  if (!prop.property) return value.expr;
  if (value.kind === "scalar") throw new Error(`Cannot access property on scalar '${prop.variable}'`);
  // Identifiers come from the tokenizer, never from string literals.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prop.property)) throw new Error("Invalid property identifier");
  const columns = value.kind === "node" ? NODE_COLUMNS : EDGE_COLUMNS;
  return columns.includes(prop.property)
    ? `json_extract(${value.expr}, '$.${prop.property}')`
    : `json_extract(json_extract(${value.expr}, '$.properties'), '$.${prop.property}')`;
}
function literal(lit: Literal, params: SqlPlan["params"]): string {
  if (lit.kind === "null") return "NULL";
  if (lit.kind === "list") return `(${lit.items.map(item => literal(item, params)).join(", ")})`;
  params.push(lit.kind === "boolean" ? Number(lit.value) : lit.value);
  return "?";
}
function predicate(pred: WherePredicate, scope: Scope, params: SqlPlan["params"]): string {
  if (pred.kind === "and" || pred.kind === "or") {
    return `(${predicate(pred.left, scope, params)} ${pred.kind.toUpperCase()} ${predicate(pred.right, scope, params)})`;
  }
  const lhs = access(pred.left, scope);
  switch (pred.kind) {
    case "eq": return `${lhs} = ${literal(pred.right, params)}`;
    case "isNull": return `${lhs} IS ${pred.negated ? "NOT " : ""}NULL`;
    case "in": return `${lhs} IN ${literal(pred.right, params)}`;
    case "contains": params.push(pred.right.value); return `instr(${lhs}, ?) > 0`;
    case "startsWith": params.push(pred.right.value, pred.right.value); return `substr(${lhs}, 1, length(?)) = ?`;
    case "endsWith": params.push(pred.right.value, pred.right.value); return `substr(${lhs}, length(${lhs}) - length(?) + 1) = ?`;
  }
}
function itemName(item: ReturnItem): string {
  return item.alias ?? (item.kind === "variable" ? item.name : item.kind === "prop" ? `${item.variable}.${item.property}` : `count(${item.arg})`);
}
function itemValue(item: ReturnItem, scope: Scope): Binding {
  if (item.kind === "variable") return binding(scope, item.name);
  if (item.kind === "prop") return { expr: access(item, scope), kind: "scalar" };
  return { expr: item.arg === "*" ? "COUNT(*)" : `COUNT(${binding(scope, item.arg).expr})`, kind: "scalar" };
}
function entity(alias: string, kind: ColumnKind): string {
  const columns = kind === "node" ? NODE_COLUMNS : EDGE_COLUMNS;
  return `json_object(${columns.map(col => `'${col}', ${alias}.${col}`).join(", ")})`;
}

export function planQuery(query: CypherQuery): SqlPlan {
  // One project parameter, reused by every entity in every clause, including
  // both endpoints of an edge. Even malformed cross-project edges cannot leak.
  const params: SqlPlan["params"] = [0];
  const ctes = ["project_scope AS (SELECT ? AS id)", "q0 AS (SELECT 1 AS unit)"];
  let previous = "q0";
  let scope: Scope = new Map();
  let counter = 0;
  let columns: string[] = [];
  let columnKinds: ColumnKind[] = [];
  const addStage = (sql: string): void => {
    previous = `q${ctes.length - 1}`;
    ctes.push(`${previous} AS (${sql})`);
  };

  function match(clause: MatchClause): void {
    const pattern = clause.pattern;
    const local: Scope = new Map();
    const candidateColumns: string[] = [];
    const candidateBindings: Scope = new Map();
    const conditions: string[] = [];
    const joins: string[] = [];
    let source: string;
    const register = (name: string, alias: string, kind: ColumnKind): void => {
      conditions.push(`${alias}.project_id = (SELECT id FROM project_scope)`);
      if (!name) return;
      const existing = local.get(name);
      if (existing) {
        if (existing.kind !== kind) throw new Error(`Variable '${name}' cannot be both a node and an edge`);
        conditions.push(`${alias}.id = ${existing.idExpr}`);
        return;
      }
      const col = `c${counter++}`;
      candidateColumns.push(`${entity(alias, kind)} AS ${col}`, `${alias}.id AS id_${col}`);
      local.set(name, { expr: entity(alias, kind), kind, idExpr: `${alias}.id` });
      candidateBindings.set(name, { expr: `p.${col}`, kind, idExpr: `p.id_${col}` });
      const prior = scope.get(name);
      if (prior && prior.kind !== kind) throw new Error(`Pattern variable '${name}' must be a ${kind}`);
      if (prior) joins.push(`p.id_${col} = ${prior.idExpr}`);
    };
    if (pattern.kind === "nodeOnly") {
      source = "nodes n";
      register(pattern.node.variable, "n", "node");
      if (pattern.node.label) { conditions.push("n.label = ?"); params.push(pattern.node.label); }
    } else {
      const out = pattern.direction === "outgoing";
      source = `nodes l JOIN edges e ON e.${out ? "source_id" : "target_id"} = l.id JOIN nodes r ON r.id = e.${out ? "target_id" : "source_id"}`;
      register(pattern.left.variable, "l", "node");
      register(pattern.rel.variable, "e", "edge");
      register(pattern.right.variable, "r", "node");
      if (pattern.left.label) { conditions.push("l.label = ?"); params.push(pattern.left.label); }
      if (pattern.right.label) { conditions.push("r.label = ?"); params.push(pattern.right.label); }
      if (pattern.rel.edgeType) { conditions.push("e.edge_type = ?"); params.push(pattern.rel.edgeType); }
    }
    const candidates = `SELECT ${candidateColumns.join(", ") || "1 AS unit"} FROM ${source} WHERE ${conditions.join(" AND ")}`;
    // Rebind candidate variables to their generated subquery column.
    const merged = new Map(scope);
    const additions: string[] = [];
    for (const [name, value] of candidateBindings) {
      if (!scope.has(name)) {
        merged.set(name, value);
        additions.push(`${value.expr} AS ${value.expr.slice(2)}`, `${value.idExpr} AS ${value.idExpr!.slice(2)}`);
      }
    }
    if (clause.where) joins.push(predicate(clause.where, merged, params));
    addStage(`SELECT s.*${additions.length ? ", " + additions.join(", ") : ""} FROM ${previous} s ${clause.optional ? "LEFT" : "INNER"} JOIN (${candidates}) p ON ${joins.join(" AND ") || "1"}`);
    scope = new Map([...merged].map(([name, value]) => [name, { ...value, expr: value.expr.replace(/^p\./, "s."), ...(value.idExpr ? { idExpr: value.idExpr.replace(/^p\./, "s.") } : {}) }]));
  }

  function project(clause: ProjectionClause): void {
    const next: Scope = new Map();
    const expressions: string[] = [];
    const groups: string[] = [];
    const items: ReturnItem[] = clause.items.flatMap(item => {
      if (item.kind !== "variable" || item.name !== "*") return [item];
      if (item.alias) throw new Error("Wildcard projections cannot have aliases");
      return [...scope.keys()].map(name => ({ kind: "variable" as const, name }));
    });
    if (!items.length) throw new Error("Wildcard projection has no variables in scope");
    const hasCount = items.some(item => item.kind === "count");
    columns = items.map(itemName);
    columnKinds = [];
    for (const [i, item] of items.entries()) {
      if (clause.kind === "with" && item.kind !== "variable" && !item.alias) throw new Error("WITH expressions require an AS alias");
      const value = itemValue(item, scope);
      const col = `c${counter++}`;
      const name = columns[i]!;
      if (next.has(name)) throw new Error(`Duplicate projection name '${name}'; use distinct AS aliases`);
      const idExpr = value.idExpr && clause.kind === "with" ? `s.id_${col}` : undefined;
      next.set(name, { kind: value.kind, expr: `s.${col}`, ...(idExpr ? { idExpr } : {}) });
      if (idExpr) expressions.push(`${value.idExpr} AS id_${col}`);
      expressions.push(`${value.expr} AS ${col}`);
      columnKinds.push(value.kind);
      if (item.kind !== "count") groups.push(value.expr);
    }
    let sql = `SELECT ${clause.distinct ? "DISTINCT " : ""}${expressions.join(", ")} FROM ${previous} s`;
    if (hasCount && groups.length) sql += ` GROUP BY ${groups.join(", ")}`;
    // For RETURN only, ORDER BY can still refer to input bindings. Projection
    // aliases also work; WITH orders after projection to enforce its scope.
    if (clause.kind === "return" && clause.orderBy) {
      const orderScope = new Map(scope);
      for (const [name, value] of next) orderScope.set(name, { ...value, expr: value.expr.slice(2) });
      sql += ` ORDER BY ${access(clause.orderBy.prop, orderScope)} ${clause.orderBy.direction}`;
    }
    addStage(sql);
    scope = next;
    if (clause.where) addStage(`SELECT s.* FROM ${previous} s WHERE ${predicate(clause.where, scope, params)}`);
    let tail = "";
    if (clause.kind === "with" && clause.orderBy) tail += ` ORDER BY ${access(clause.orderBy.prop, scope)} ${clause.orderBy.direction}`;
    if (clause.limit !== undefined || clause.skip !== undefined) tail += ` LIMIT ${clause.limit ?? -1} OFFSET ${clause.skip ?? 0}`;
    if (tail) addStage(`SELECT s.* FROM ${previous} s${tail}`);
  }
  for (const clause of query.clauses) {
    if (clause.kind === "match") match(clause); else project(clause);
  }
  return { sql: `WITH ${ctes.join(", ")} SELECT * FROM ${previous}`, params, columns, columnKinds,
    variableAliases: new Map([...scope].map(([name, value]) => [name, value.expr])) };
}
