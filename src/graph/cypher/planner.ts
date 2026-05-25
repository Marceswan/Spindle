// Translates a CypherQuery AST into a SQL execution plan against the
// nodes + edges schema in SQLite.
//
// Schema reminder:
//   nodes(id, project_id, label, name, qualified_name, file_path,
//         start_line, end_line, properties JSON, content_hash)
//   edges(id, project_id, source_id, target_id, edge_type,
//         confidence, properties JSON, source_file, source_line)
//
// Property access strategy:
//   n.name            -> n.name  (direct column)
//   n.qualified_name  -> n.qualified_name  (direct column)
//   n.label           -> n.label  (direct column)
//   n.file_path       -> n.file_path  (direct column)
//   n.start_line      -> n.start_line  (direct column)
//   n.end_line        -> n.end_line  (direct column)
//   n.id              -> n.id  (direct column)
//   anything else     -> json_extract(n.properties, '$.fieldName')

import type {
  CypherQuery,
  MatchPattern,
  WherePredicate,
  PropAccess,
  Literal,
  ReturnItem,
  OrderByClause,
  SimpleNodeMatch,
  RelationshipMatch,
} from "./types.ts";

export type SqlPlan = {
  sql: string;
  params: (string | number | null)[];
  // Column aliases in result order, matching CypherQuery.returnItems
  columns: string[];
  // Variable bindings used in this plan (e.g., which alias maps to which SQL alias)
  variableAliases: Map<string, string>; // cypher var -> sql table alias
};

// Direct columns on the nodes table.
const NODE_DIRECT_COLUMNS = new Set([
  "id",
  "name",
  "qualified_name",
  "label",
  "file_path",
  "start_line",
  "end_line",
  "content_hash",
  "project_id",
]);

// Direct columns on the edges table.
const EDGE_DIRECT_COLUMNS = new Set([
  "id",
  "source_id",
  "target_id",
  "edge_type",
  "confidence",
  "source_file",
  "source_line",
  "project_id",
]);

function nodePropExpr(tableAlias: string, property: string): string {
  if (NODE_DIRECT_COLUMNS.has(property)) {
    return `${tableAlias}.${property}`;
  }
  return `json_extract(${tableAlias}.properties, '$.${property}')`;
}

function edgePropExpr(tableAlias: string, property: string): string {
  if (EDGE_DIRECT_COLUMNS.has(property)) {
    return `${tableAlias}.${property}`;
  }
  return `json_extract(${tableAlias}.properties, '$.${property}')`;
}

function literalToSql(lit: Literal, params: (string | number | null)[]): string {
  switch (lit.kind) {
    case "string":
      params.push(lit.value);
      return "?";
    case "number":
      params.push(lit.value);
      return "?";
    case "boolean":
      params.push(lit.value ? 1 : 0);
      return "?";
    case "null":
      return "NULL";
    case "list":
      // IN (?, ?, ?) — the list items become individual params
      const placeholders = lit.items.map((item) => {
        if (item.kind === "string") { params.push(item.value); return "?"; }
        if (item.kind === "number") { params.push(item.value); return "?"; }
        params.push(item.value ? 1 : 0);
        return "?";
      });
      return `(${placeholders.join(", ")})`;
  }
}

// Translate a WHERE predicate into a SQL fragment.
// nodeAliases: map from cypher variable name -> { tableAlias, isEdge }
function predicateToSql(
  pred: WherePredicate,
  variableAliases: Map<string, { alias: string; isEdge: boolean }>,
  params: (string | number | null)[],
): string {
  switch (pred.kind) {
    case "eq": {
      const expr = resolveAccess(pred.left, variableAliases);
      const rhs = literalToSql(pred.right, params);
      if (pred.right.kind === "null") {
        return `${expr} IS NULL`;
      }
      return `${expr} = ${rhs}`;
    }
    case "contains": {
      const expr = resolveAccess(pred.left, variableAliases);
      params.push(`%${pred.right.value}%`);
      return `${expr} LIKE ?`;
    }
    case "startsWith": {
      const expr = resolveAccess(pred.left, variableAliases);
      params.push(`${pred.right.value}%`);
      return `${expr} LIKE ?`;
    }
    case "endsWith": {
      const expr = resolveAccess(pred.left, variableAliases);
      params.push(`%${pred.right.value}`);
      return `${expr} LIKE ?`;
    }
    case "in": {
      const expr = resolveAccess(pred.left, variableAliases);
      const rhs = literalToSql(pred.right, params);
      return `${expr} IN ${rhs}`;
    }
    case "isNull": {
      const expr = resolveAccess(pred.left, variableAliases);
      return pred.negated ? `${expr} IS NOT NULL` : `${expr} IS NULL`;
    }
    case "and": {
      const l = predicateToSql(pred.left, variableAliases, params);
      const r = predicateToSql(pred.right, variableAliases, params);
      return `(${l} AND ${r})`;
    }
    case "or": {
      const l = predicateToSql(pred.left, variableAliases, params);
      const r = predicateToSql(pred.right, variableAliases, params);
      return `(${l} OR ${r})`;
    }
  }
}

function resolveAccess(
  prop: PropAccess,
  variableAliases: Map<string, { alias: string; isEdge: boolean }>,
): string {
  const binding = variableAliases.get(prop.variable);
  if (binding === undefined) {
    // Unknown variable — fallback to treating it as the left/first node alias
    // This is a best-effort safety hatch; the executor will still fail if this is wrong.
    return `${prop.variable}.${prop.property}`;
  }
  if (binding.isEdge) {
    return edgePropExpr(binding.alias, prop.property);
  }
  return nodePropExpr(binding.alias, prop.property);
}

// Build the SELECT list for RETURN items.
function buildSelectList(
  returnItems: ReturnItem[],
  variableAliases: Map<string, { alias: string; isEdge: boolean }>,
  params: (string | number | null)[],
): { selectExprs: string[]; columnNames: string[] } {
  const selectExprs: string[] = [];
  const columnNames: string[] = [];

  for (const item of returnItems) {
    switch (item.kind) {
      case "variable": {
        const binding = variableAliases.get(item.name);
        if (binding === undefined) {
          // Return NULL for unknown variable
          selectExprs.push("NULL");
          columnNames.push(item.name);
          break;
        }
        if (binding.isEdge) {
          // Return edge columns as a JSON object
          const alias = binding.alias;
          selectExprs.push(
            `json_object('id', ${alias}.id, 'source_id', ${alias}.source_id, 'target_id', ${alias}.target_id, 'edge_type', ${alias}.edge_type, 'confidence', ${alias}.confidence, 'properties', ${alias}.properties, 'source_file', ${alias}.source_file, 'source_line', ${alias}.source_line)`,
          );
          columnNames.push(item.name);
        } else {
          // Return node columns as a JSON object
          const alias = binding.alias;
          selectExprs.push(
            `json_object('id', ${alias}.id, 'project_id', ${alias}.project_id, 'label', ${alias}.label, 'name', ${alias}.name, 'qualified_name', ${alias}.qualified_name, 'file_path', ${alias}.file_path, 'start_line', ${alias}.start_line, 'end_line', ${alias}.end_line, 'properties', ${alias}.properties, 'content_hash', ${alias}.content_hash)`,
          );
          columnNames.push(item.name);
        }
        break;
      }
      case "prop": {
        const binding = variableAliases.get(item.variable);
        let expr: string;
        if (binding === undefined) {
          expr = `${item.variable}.${item.property}`;
        } else if (binding.isEdge) {
          expr = edgePropExpr(binding.alias, item.property);
        } else {
          expr = nodePropExpr(binding.alias, item.property);
        }
        selectExprs.push(expr);
        columnNames.push(`${item.variable}.${item.property}`);
        break;
      }
      case "count": {
        void params; // params not needed for count
        if (item.arg === "*") {
          selectExprs.push("COUNT(*)");
          columnNames.push("count(*)");
        } else {
          const binding = variableAliases.get(item.arg);
          if (binding !== undefined) {
            selectExprs.push(`COUNT(${binding.alias}.id)`);
          } else {
            selectExprs.push("COUNT(*)");
          }
          columnNames.push(`count(${item.arg})`);
        }
        break;
      }
    }
  }

  return { selectExprs, columnNames };
}

function buildOrderByExpr(
  ob: OrderByClause,
  variableAliases: Map<string, { alias: string; isEdge: boolean }>,
): string {
  const binding = variableAliases.get(ob.prop.variable);
  let expr: string;
  if (binding === undefined) {
    expr = `${ob.prop.variable}.${ob.prop.property}`;
  } else if (binding.isEdge) {
    expr = edgePropExpr(binding.alias, ob.prop.property);
  } else {
    expr = nodePropExpr(binding.alias, ob.prop.property);
  }
  return `${expr} ${ob.direction}`;
}

// ---------------------------------------------------------------------------
// Main planning functions
// ---------------------------------------------------------------------------

function planNodeOnly(
  match: SimpleNodeMatch,
  query: CypherQuery,
): SqlPlan {
  const params: (string | number | null)[] = [];
  const node = match.node;
  const nodeAlias = "n0";

  const variableAliases = new Map<string, { alias: string; isEdge: boolean }>();
  if (node.variable) {
    variableAliases.set(node.variable, { alias: nodeAlias, isEdge: false });
  }

  const whereClauses: string[] = [`${nodeAlias}.project_id = ?`];
  params.push(0); // projectId placeholder (index 0, overwritten by executor)

  if (node.label !== undefined) {
    whereClauses.push(`${nodeAlias}.label = ?`);
    params.push(node.label);
  }

  if (query.where !== undefined) {
    const whereFragment = predicateToSql(query.where, variableAliases, params);
    whereClauses.push(whereFragment);
  }

  const { selectExprs, columnNames } = buildSelectList(query.returnItems, variableAliases, params);

  const isCount = query.returnItems.every((r) => r.kind === "count");

  // Alias each projection with a stable col_N name so the SQLite row object has one key per
  // expression. Without this, `RETURN s.name, t.name` collapses both into a single "name" key.
  const aliasedSelect = selectExprs.map((expr, idx) => `${expr} AS col_${idx}`).join(", ");
  let sql = `SELECT ${aliasedSelect} FROM nodes ${nodeAlias} WHERE ${whereClauses.join(" AND ")}`;

  if (!isCount && query.orderBy !== undefined) {
    sql += ` ORDER BY ${buildOrderByExpr(query.orderBy, variableAliases)}`;
  }

  if (!isCount) {
    if (query.skip !== undefined) {
      if (query.limit !== undefined) {
        sql += ` LIMIT ${query.limit} OFFSET ${query.skip}`;
      } else {
        sql += ` LIMIT -1 OFFSET ${query.skip}`;
      }
    } else if (query.limit !== undefined) {
      sql += ` LIMIT ${query.limit}`;
    }
  }

  return {
    sql,
    params,
    columns: columnNames,
    variableAliases: new Map(
      node.variable ? [[node.variable, nodeAlias]] : [],
    ),
  };
}

function planRelationship(
  match: RelationshipMatch,
  query: CypherQuery,
): SqlPlan {
  const params: (string | number | null)[] = [];
  const leftAlias = "n0";
  const edgeAlias = "e0";
  const rightAlias = "n1";

  // direction: outgoing = (left)-[r]->(right) means source=left, target=right
  //            incoming = (left)<-[r]-(right) means source=right, target=left
  const isOutgoing = match.direction === "outgoing";

  const variableAliases = new Map<string, { alias: string; isEdge: boolean }>();
  if (match.left.variable) variableAliases.set(match.left.variable, { alias: leftAlias, isEdge: false });
  if (match.rel.variable) variableAliases.set(match.rel.variable, { alias: edgeAlias, isEdge: true });
  if (match.right.variable) variableAliases.set(match.right.variable, { alias: rightAlias, isEdge: false });

  const whereClauses: string[] = [
    `${edgeAlias}.project_id = ?`,
    // JOIN conditions (these are in the FROM/JOIN, not WHERE, but we build them into the WHERE for simplicity)
  ];
  params.push(0); // projectId placeholder

  // Label filters
  if (match.left.label !== undefined) {
    whereClauses.push(`${leftAlias}.label = ?`);
    params.push(match.left.label);
  }
  if (match.right.label !== undefined) {
    whereClauses.push(`${rightAlias}.label = ?`);
    params.push(match.right.label);
  }
  if (match.rel.edgeType !== undefined) {
    whereClauses.push(`${edgeAlias}.edge_type = ?`);
    params.push(match.rel.edgeType);
  }

  if (query.where !== undefined) {
    const whereFragment = predicateToSql(query.where, variableAliases, params);
    whereClauses.push(whereFragment);
  }

  const { selectExprs, columnNames } = buildSelectList(query.returnItems, variableAliases, params);

  const isCount = query.returnItems.every((r) => r.kind === "count");

  // JOIN structure depends on direction.
  // outgoing: (left)-[r]->(right)  =>  source=left, target=right
  //           nodes n0 JOIN edges e0 ON e0.source_id = n0.id JOIN nodes n1 ON n1.id = e0.target_id
  // incoming: (left)<-[r]-(right)  =>  source=right, target=left
  //           nodes n0 JOIN edges e0 ON e0.target_id = n0.id JOIN nodes n1 ON n1.id = e0.source_id
  let sql_from: string;
  if (isOutgoing) {
    sql_from = `
      nodes ${leftAlias}
      JOIN edges ${edgeAlias}
        ON ${edgeAlias}.source_id = ${leftAlias}.id
      JOIN nodes ${rightAlias}
        ON ${rightAlias}.id = ${edgeAlias}.target_id
    `.trim();
  } else {
    // incoming: left is the target, right is the source
    sql_from = `
      nodes ${leftAlias}
      JOIN edges ${edgeAlias}
        ON ${edgeAlias}.target_id = ${leftAlias}.id
      JOIN nodes ${rightAlias}
        ON ${rightAlias}.id = ${edgeAlias}.source_id
    `.trim();
  }

  const aliasedSelect = selectExprs.map((expr, idx) => `${expr} AS col_${idx}`).join(", ");
  let sql = `SELECT ${aliasedSelect} FROM ${sql_from} WHERE ${whereClauses.join(" AND ")}`;

  if (!isCount && query.orderBy !== undefined) {
    sql += ` ORDER BY ${buildOrderByExpr(query.orderBy, variableAliases)}`;
  }

  if (!isCount) {
    if (query.skip !== undefined) {
      if (query.limit !== undefined) {
        sql += ` LIMIT ${query.limit} OFFSET ${query.skip}`;
      } else {
        sql += ` LIMIT -1 OFFSET ${query.skip}`;
      }
    } else if (query.limit !== undefined) {
      sql += ` LIMIT ${query.limit}`;
    }
  }

  return {
    sql,
    params,
    columns: columnNames,
    variableAliases: new Map<string, string>(
      [
        ...(match.left.variable ? [[match.left.variable, leftAlias]] : []),
        ...(match.rel.variable ? [[match.rel.variable, edgeAlias]] : []),
        ...(match.right.variable ? [[match.right.variable, rightAlias]] : []),
      ] as [string, string][],
    ),
  };
}

export function planQuery(query: CypherQuery): SqlPlan {
  const match = query.match;
  if (match.kind === "nodeOnly") {
    return planNodeOnly(match, query);
  }
  return planRelationship(match, query);
}
