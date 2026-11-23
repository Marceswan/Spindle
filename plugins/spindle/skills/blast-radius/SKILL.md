---
name: blast-radius
description: Use when the user plans to change, rename, retype, delete or deprecate Salesforce metadata in an SFDX project (a field, object, Apex class or method, Flow, LWC, Aura or Visualforce component, label, permission set) and asks what breaks, what is affected, what to retest, or if the change is safe. Use it also before you make such a change yourself.
argument-hint: "[Object.Field | Object | Class | Class.method | Flow | c/lwcName]"
---

# Blast radius of a metadata change

The Spindle graph answers "what refers to this" for the metadata it models. A blast radius has three parts: what the graph shows, what the graph cannot show, and what exists only in the org. Report all three. A list of graph hits alone is not a blast radius.

## Steps

1. **Project.** Call `list_projects`. Use the project whose `rootPath` contains the metadata. If it is not listed, or the index is older than the files, call `index_project` with the absolute path. Each SFDX project is a separate graph.
2. **Exact name.** Names are exact. Find the node with `search_graph` (`name_pattern`). For name formats, see the `graph-reference` skill.
3. **References.** Use the row for the kind of target:

| Target | Calls |
|---|---|
| Field | `get_field_usage`, then `get_permission_access` with type `Field`. `get_field_usage` does not list permission grants. |
| Object | `trace_references`: inbound, depth 1, `include_members: true`. Then `get_permission_access` with type `SObject`. |
| Apex class or interface | `trace_references`: inbound, depth 1, `include_members: true`. Then `get_permission_access` with type `ApexClass`. |
| Apex method | `trace_references` from `Class.method(ParamType)`: inbound, depth 1. |
| Flow, LWC, Aura, Visualforce, label, static resource | `trace_references`: inbound, depth 1. |

`include_members` is necessary for a class or object: an LWC or Aura caller refers to the method, and a layout refers to the field, not to the parent.

4. **Second hop.** Depth 1 is the set that can break. For "what is reachable from there", run depth 2 as a separate call and report it as second hop.
5. **Truncation.** If `truncated` is true, the result is incomplete. Add `edge_types`, or raise `limit`, and say so if it stays incomplete.
6. **Text search for what the graph does not model.** For a rename or a delete, search the project for the short name (`cleanup`, `Email__c`) with Grep. The graph does not have:
   - Apex calls on a variable (`svc.doThing()`), DML statements, dynamic SOQL and names in strings
   - Interface method declarations (`void cleanup();`)
   - Visualforce action bindings (`action="{!cleanup}"`): the page links to the class only
   - Formula field bodies
   - Metadata types that are not indexed: reports, workflow rules, approval processes, sharing rules, custom metadata records
7. **Classify and report.**

## Report

Use these headings, in this order. Give `file:line` where the tool returns it.

- **Change together**: items that fail to compile or deploy if they do not change with the target.
- **Retest**: items that still deploy, where behavior can change.
- **Access**: permission sets, profiles and permission set groups that grant the target.
- **Not in the graph**: what the text search found, and what must be checked in the org.
- **Confidence**: name each hit with confidence below 1. 0.8 is a name match, 0.6 is a text scan; read the source before you rely on it. An entry with `scope: "object"` is a possible usage: the source reads or writes the object, and no field reference is known.

## Common mistakes

| Mistake | Correction |
|---|---|
| Trace from a class with no `include_members` | Callers of its methods are missing. Set `include_members: true`. |
| Inbound trace with depth 3 or more from a method | `DEFINES_METHOD` pulls in the full class and its neighbours. Use depth 1, then depth 2. |
| "No references" after an empty result | Confirm the name with `search_graph` first. Then do the text search. |
| Field report with no permissions | Call `get_permission_access` too. |
| Only the root project examined | `list_projects` shows each project. A nested project has its own copy of the metadata. |
