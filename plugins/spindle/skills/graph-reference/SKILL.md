---
name: graph-reference
description: Use when writing a query_graph Cypher query for Spindle, when a Spindle tool returns an empty result, a parse error or "No node has the qualified name", or when the exact qualified name, node label, edge type or edge direction of Salesforce metadata in the graph is necessary.
---

# Spindle graph reference

Names are exact, and an edge goes from the thing that refers to the thing it refers to. Most empty results come from a name in the wrong form or a query in the wrong direction. Check both before you report "nothing found". `get_schema` gives the labels and edge types that a project has, with counts.

## Qualified names

| Label | Form | Example |
|---|---|---|
| ApexClass, ApexInterface, ApexEnum | `Name`, inner: `Outer.Inner` | `AccountService.AccountWrapper` |
| ApexMethod | `Class.method(ParamType, ParamType)`; generic arguments are dropped | `Worker.handle(List)`, `AccountService.cleanup()` |
| ApexProperty | `Class.name` | `AccountWrapper.record` |
| ApexTrigger | `Name` | `AccountTrigger` |
| SObject | API name | `Customer__c` |
| Field | `Object.Field` | `Customer__c.Email__c` |
| ValidationRule, RecordType | `Object.Name` | `Customer__c.Email_Required` |
| LwcBundle | `c/name` | `c/customerCard` |
| AuraBundle | `name` | `customerPanel` |
| UiBundle (a React UI bundle, `uiBundles/<name>/`) | `name` | `customerPortal` |
| VisualforcePage, VisualforceComponent, Flow, FlexiPage, StaticResource | API name | `Customer_Onboarding` |
| Layout | `Object-Layout Name` | `Customer__c-Customer Layout` |
| PermissionSet, Profile, PermissionSetGroup | file name with no suffix | `Spindle_Reader` |
| CustomLabel | `c.Name` | `c.Greeting` |
| EmailTemplate | `folder/name` | `Marketing/CustomerWelcome` |

If you do not know the name: `search_graph` with `name_pattern` (a regular expression on the short name) and, if you know it, `label`.

## Edge types

Read each row as source -> target.

| Edge | Source -> target | Notes |
|---|---|---|
| `CALLS` | ApexMethod or ApexTrigger -> ApexMethod | Static and unqualified calls. A call on a variable is not resolved. |
| `INSTANTIATES` | ApexMethod or ApexTrigger -> ApexClass | |
| `EXTENDS`, `IMPLEMENTS` | ApexClass -> ApexClass or ApexInterface | |
| `DEFINES_METHOD`, `DEFINES_PROPERTY` | ApexClass -> member | Structure, not a dependency. |
| `TRIGGERS_ON` | ApexTrigger -> SObject | |
| `SOQL_QUERIES`, `SOSL_QUERIES` | ApexMethod or ApexTrigger -> SObject | |
| `REFERENCES_FIELD` | Apex -> Field (`context`: `SOQL_SELECT`, `SOQL_WHERE`, ...); LwcBundle -> SObject for an object import | |
| `LWC_USES_APEX`, `AURA_USES_APEX` | bundle -> ApexMethod (0.8) | Aura with no controller JS -> ApexClass |
| `LWC_USES_FIELD`, `LWC_USES_LABEL`, `LWC_USES_RESOURCE` | LwcBundle -> Field, CustomLabel, StaticResource | |
| `LWC_INCLUDES_COMPONENT`, `AURA_INCLUDES_COMPONENT` | bundle -> bundle | |
| `UI_BUNDLE_USES_OBJECT` | UiBundle -> SObject | One edge for each UI API GraphQL operation. `operation`: `query`, `aggregate`, `create`, `update`, `delete`, `describe`. `runtime: true` when a variable holds the filter or the mutation input, so the fields are not known. |
| `UI_BUNDLE_USES_FIELD` | UiBundle -> Field | A field in a GraphQL selection, filter, order, group or inline mutation input. `context`: `select`, `filter`, `orderBy`, `groupBy`, `input`. |
| `UI_BUNDLE_USES_APEX` | UiBundle -> ApexClass (0.8) | An Apex REST path (`apexRestPath`). The class is found from its `@RestResource` `urlMapping` (the class property `restUrlMapping`), not from its name. |
| `VF_USES_APEX` | page -> ApexClass (controller, extensions) | No edge to the method of an action binding. |
| `VF_USES_FIELD`, `VF_INCLUDES_COMPONENT` | page -> Field (0.6), component | |
| `INVOCABLE_FROM_FLOW` | Flow -> ApexClass (0.8) | The Flow is the source. |
| `FLOW_DML_ON` | Flow -> SObject | `operation`: `trigger`, `insert`, `update`, `delete`, `select` |
| `FLOW_USES_FIELD`, `FLOW_INVOKES_FLOW` | Flow -> Field, Flow | |
| `LAYOUT_INCLUDES_FIELD`, `FLEXIPAGE_REFERENCES_FIELD`, `FLEXIPAGE_INCLUDES_COMPONENT` | Layout or FlexiPage -> Field, bundle | |
| `VALIDATION_REFERENCES_FIELD`, `EMAIL_REFERENCES_FIELD` | rule or template -> Field (0.6) | |
| `GRANTS_APEX_ACCESS`, `GRANTS_OBJECT_ACCESS`, `GRANTS_FIELD_ACCESS`, `GRANTS_VISUALFORCE_ACCESS`, `GRANTS_RECORDTYPE_ACCESS` | PermissionSet or Profile -> target | Flags are edge properties: `read`, `edit`, `create`, `delete`, `enabled`. A grant with `false` flags is still an edge. |
| `INCLUDES_PERMSET` | PermissionSetGroup -> PermissionSet | |

Confidence: 1.0 resolved, 0.8 name match, 0.6 text scan. `min_confidence` is inclusive and its default is 0.6, so all three levels are returned.

## Cypher subset of `query_graph`

Supported: `MATCH (n:Label)`, `(a)-[r:TYPE]->(b)`, `(a)<-[r:TYPE]-(b)`, more than one `MATCH`, `OPTIONAL MATCH`, `WITH ... AS`, `WHERE` with `=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN [...]`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, parentheses; `RETURN` of variables, properties, `count(*)`, `count(n)`, `DISTINCT`, `AS`; `ORDER BY` one key; `SKIP`, `LIMIT`.

| Not supported | Use |
|---|---|
| `type(r)` | `r.edge_type` |
| `(n:Label {name: 'x'})` | `MATCH (n:Label) WHERE n.name = 'x'` |
| `(a)-[r]-(b)` (no direction) | One query for each direction |
| `-[*1..3]->` | One `MATCH` clause for each hop, or `trace_references` with `depth` |
| `<>`, `<`, `>`, `NOT` | `IN [...]`, `IS NULL`, or filter the rows yourself |
| `collect`, `sum`, `min`, `max`, a function call | `count(*)`, or count the rows yourself |
| `MATCH (a), (b)` | One `MATCH` clause for each pattern |

Node properties: `label`, `name`, `qualified_name`, `file_path`, `start_line`, `end_line`. Edge properties: `edge_type`, `confidence`, `source_line`. Other names read the parser properties: `m.isStatic`, `m.isAuraEnabled`, `m.isTestMethod`, `c.sharing`, `f.type`, `n.isPlaceholder`, `r.operation`, `r.context`, `r.sourceFile`, `r.apexRestPath`, `r.runtime`, `g.edit`. String comparison is case-sensitive. With no `LIMIT`, the result has at most 1000 rows and `truncated` is true when rows were cut.

```cypher
MATCH (a)-[r]->(b) RETURN r.edge_type, count(*) ORDER BY r.edge_type
MATCH (m:ApexMethod) WHERE m.isAuraEnabled = true RETURN m.qualified_name
MATCH (f:Flow)-[r:FLOW_DML_ON]->(o:SObject) RETURN f.name, r.operation, o.name
MATCH (p:PermissionSet)-[g:GRANTS_FIELD_ACCESS]->(f:Field) WHERE g.edit = true RETURN p.name, f.qualified_name
MATCH (b:UiBundle)-[r:UI_BUNDLE_USES_OBJECT]->(o:SObject) WHERE r.operation IN ['create', 'update', 'delete'] RETURN b.name, r.operation, o.name
MATCH (c:ApexClass) OPTIONAL MATCH (p)-[g:GRANTS_APEX_ACCESS]->(c) RETURN c.name, count(p) AS grants
```

## What the graph does not have

- Apex: calls on a variable (`svc.run()`), DML statements, dynamic SOQL, interface method nodes, references in property accessors and field initializers
- Visualforce: the method of `action="{!method}"`
- UI bundle: a query, a filter or a mutation input that is built at run time; an Apex REST path with a namespace prefix; the `CustomApplication` that shows the bundle
- Formula field bodies; `$Label` references in validation rules
- A node for a standard object or field with no metadata file is a placeholder (`isPlaceholder: true`, no `file_path`). It exists only when a resolved reference points at it.
- Reports, dashboards, workflow rules, approval processes, sharing rules, custom metadata records, and all that exists only in the org

`get_source_snippet` reads one file. An LWC, Aura or UI bundle node is a directory: read its files with Read. For a UI bundle, the edge property `sourceFile` and `source_line` give the file and the line.
