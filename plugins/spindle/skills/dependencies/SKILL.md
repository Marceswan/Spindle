---
name: dependencies
description: Use when the user asks what depends on, uses, calls, references or is connected to a piece of Salesforce metadata in an SFDX project, what a component depends on, how two components are connected, or which Apex methods have no callers.
argument-hint: "[component name, or two names for a path]"
---

# Dependency questions on the Spindle graph

An edge goes from the thing that refers to the thing it refers to: `Orchestrator.run()` -CALLS-> `AccountService.cleanup()`. Thus "what depends on X" is an inbound question, and "what does X depend on" is an outbound question.

First call `list_projects` and take the `project_id`. If the project is not listed, call `index_project` with its absolute path. Find exact names with `search_graph` (`name_pattern`); for name formats and edge types, see the `graph-reference` skill.

## Which call

| Question | Call |
|---|---|
| What depends on class X or object X | `trace_references`: inbound, depth 1, `include_members: true` |
| What depends on method, field, flow or component X | `trace_references`: inbound, depth 1 |
| What does X depend on | `trace_references`: outbound, depth 1 (depth 2 or 3 for the transitive set) |
| Who can access X | `get_permission_access` |
| Where is field F used | `get_field_usage` |
| How is A connected to B | Path recipe below |
| Which methods have no callers | Unused recipe below |
| A count, a group, a filter on a property | `query_graph` |

`include_members` matters. A reference to a method targets the method, and a reference to a field targets the field. A trace from the class or object alone does not find them.

`trace_references` returns `nodes` and `edges`. Join them on node `id` (`sourceId`, `targetId`) to say which node refers to which, and with which `edgeType`. Do not list the nodes with no edge type.

## Path between A and B

There are no variable-length paths. Do this:

1. `trace_references` from A: outbound, `depth: 3`. If B is in `nodes`, read the path from `edges`.
2. If B is not there, trace from B: outbound, `depth: 3`, and look for A. The connection can go in the opposite direction.
3. If neither finds it, the two share a neighbour at most. Say that there is no dependency path, and name the shared neighbour only as a shared neighbour.

To show one path with its edge types, use one `MATCH` clause for each hop:

```cypher
MATCH (a:Flow)-[r1]->(m) MATCH (m)-[r2]->(n) MATCH (n)-[r3]->(b:SObject)
WHERE a.name = 'Customer_Onboarding' AND b.name = 'Account'
RETURN a.name, r1.edge_type, m.qualified_name, r2.edge_type, n.qualified_name, r3.edge_type, b.name
```

Report a direct edge and an indirect path as two different answers.

## Methods with no callers

```json
{"project_id": 1, "label": "ApexMethod", "exclude_entry_points": true,
 "relationship": {"edge_type": "CALLS", "direction": "inbound", "min_degree": 0, "max_degree": 0}}
```

`min_degree: 0` is necessary; the default is 1. The result is a list of candidates, not of dead code. The graph does not resolve a call on a variable (`svc.doThing()`), so a method that is called only in that manner is in the list. Search the project for the method name before you call it unused.

## Report

Group the answer by metadata type (Apex, LWC, Aura, Visualforce, Flow, layout, permission). For each item give the edge type, the confidence when it is below 1, and `file:line` when the tool returns it. Separate direct dependencies from second-hop dependencies. If `truncated` is true, say that the list is incomplete.
