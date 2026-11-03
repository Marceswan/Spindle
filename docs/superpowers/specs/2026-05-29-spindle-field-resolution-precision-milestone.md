# Milestone — Field-Resolution Precision (Advanced Flow + Full SOQL)

**Status:** Approved 2026-05-29 (proceed; recommended decisions accepted unless flagged)`)
**Phase:** v1.0 of the design-doc roadmap (lifts v0.6+ "Advanced Flow extraction" and v1.1+ "full SOQL parser replacement"; also lifts NG4's deferral of full SOQL semantics)
**Author:** spec-drafting agent, 2026-05-29
**Branch:** `feat/workbench-ui`

---

## 1. Why these two together

`get_field_usage` is Spindle's headline tool. Its accuracy is gated by two coarse
parsers that both feed the *same* consumer:

- **Flow** today only knows the SObject a Flow touches (`FLOW_DML_ON`,
  SObject-level), so Flow hits land in the `flows` bucket marked **indirect**.
- **Apex SOQL** today is regex-based and only captures simple bare identifiers in
  the **SELECT** clause; WHERE / ORDER BY / GROUP BY / relationship paths /
  subqueries / `TYPEOF` are dropped. Those feed `REFERENCES_FIELD` (per-field) and
  fall back to `SOQL_QUERIES` (per-SObject, indirect).

Both work items move buckets in `get_field_usage` from **indirect** to
**authoritative** and increase per-field precision. They share the same
resolution machinery (pass2's `nodeByLabelAndQName` full-qname match plus the
v0.8 `__SHORTNAME__` field-disambiguation fallback) and the same testing harness
(`test/fixtures/sample-sfdx-project/` + snapshot tests). They are otherwise
**independent**: either can ship without the other.

---

## 2. Document structure

`DECISION (review): three files — one milestone overview (this file) plus two
standalone specs — rather than one combined spec.`
— *Why:* the two subsystems touch disjoint parsers (`metadata-xml/flow.ts` vs
`apex/soql-extract.ts` + `apex/parse.ts`), have independent phasing, and the SOQL
work carries a heavyweight build-vs-buy fork that would bury the (much smaller)
Flow spec if combined. Two specs let each ship and be reviewed on its own cadence.
The overview captures the shared resolution/testing strategy once so neither spec
repeats it.
— *Alternative:* a single milestone spec with two parts (matches the existing
`2026-05-29-spindle-workbench-ui-design.md` single-file convention). Rejected
because that spec is one cohesive feature; this milestone is two separable ones.
Override by merging the two child specs into this file if you prefer one PR.

| File | Scope |
|------|-------|
| `2026-05-29-spindle-field-resolution-precision-milestone.md` (this) | Shared context, resolution strategy, schema-bump analysis, combined `get_field_usage` impact, cross-cutting open questions. |
| `2026-05-29-spindle-advanced-flow-extraction-design.md` | Subsystem 1: per-field Flow refs. |
| `2026-05-29-spindle-full-soql-parser-design.md` | Subsystem 2: real SOQL parser. |

---

## 3. Shared resolution strategy (read once, applied by both specs)

Both new per-field edges resolve through the **existing pass2 `inFileEdges`
loop** in `src/pipeline/pass2-intra-domain.ts`. Pass3 is still a no-op stub; no
new pass is introduced.

`DECISION (review): reuse pass2's existing two-tier field resolution verbatim; do
NOT add logic to pass3.`
— *Why:* every cross-domain field edge today (`VALIDATION_REFERENCES_FIELD`,
`FLEXIPAGE_REFERENCES_FIELD`, LWC/VF field edges, SOQL `REFERENCES_FIELD`,
v0.8/v0.9 DML-write edges) already resolves in pass2 against
`sym.nodeByLabelAndQName` (full `Object.Field` qname) with the
`__SHORTNAME__:` fallback for cases where the SObject is unknown at parse time.
Pass3 has never been wired up. Following the established path means zero new
pipeline plumbing.
— *Alternative:* finally implement pass3 for "true" cross-domain refs. Rejected
as scope creep — it would change the orchestrator and every parser's contract.

The two tiers, restated:

1. **Full-qname tier (confident).** Parser emits `toQName = "Object__c.Field__c"`,
   `toLabel = Field`. Pass2 matches `nodeByLabelAndQName` directly. If the Field
   node exists, the edge is written; if not (standard object, unmodelled field),
   the edge is dropped and the coarse SObject-level edge remains as fallback.
   This is the v0.9 constructor-arg precedent.
2. **Short-name tier (disambiguated).** Parser emits
   `toQName = "__SHORTNAME__:Field__c"` when it knows the field name but not the
   owning SObject. Pass2 resolves via `sym.fieldsByShortName`: one candidate →
   confident; many candidates → keep only the one whose `parentSObject` matches
   the source element's SObject context; still ambiguous → drop (precision-first).
   This is the v0.8 DML-write precedent.

**Both new subsystems prefer tier 1.** Flow `recordLookups`/`recordUpdates`/etc.
elements carry an explicit `<object>`, so the SObject context is almost always
known at parse time — tier 1 applies. SOQL has an explicit `FROM` object and
resolvable relationship roots, so SELECT/WHERE/ORDER/GROUP fields are tier 1; only
truly object-less formula-resource references in Flow fall to tier 2.

---

## 4. Schema-version bump: NOT required (confirmed)

`DECISION (review): no schema_version bump for either subsystem.`
— *Why:* `src/graph/schema.ts` defines `nodes.label` and `edges.edge_type` as
plain `TEXT` columns (verified: `schema.ts` lines around the `nodes`/`edges`
DDL). New node labels and edge-type strings are *data*, not DDL. The store's
forward-migration check (`store.ts` ~lines 62-82) only cares about the integer
`CURRENT_SCHEMA_VERSION` (currently `2`); adding labels/edges does not touch any
column, index, or table. The Workbench spec's `tool_invocation` migration is the
only thing in flight that bumps the version, and it is unrelated.
— *Alternative:* bump anyway "to be safe." Rejected — a no-op migration that
changes no DDL is noise, and CLAUDE.md's storage rule only requires a migration
"even if it's a no-op" *when `schema_version` is bumped*, not when new edge
strings appear. Both subsystems are label/edge-type-only, so neither bumps.

The one caveat: both specs add entries to `src/model/node-labels.ts` and
`src/model/edge-types.ts` (the single source of truth). That is a code change,
not a schema change.

---

## 5. Combined `get_field_usage` impact

After both subsystems ship, the `coverage` object in
`src/tools/get-field-usage.ts` changes as follows:

| Bucket | Today | After this milestone |
|--------|-------|----------------------|
| `flows` | `indirect` (SObject-level `FLOW_DML_ON`) | `authoritative` for per-field hits via `FLOW_REFERENCES_FIELD`; SObject-level retained as `indirect` fallback under `include_indirect` |
| `apex_methods` (SOQL) | mix: `REFERENCES_FIELD` from SELECT (authoritative) + `SOQL_QUERIES` (indirect) | `REFERENCES_FIELD` now covers SELECT + WHERE + ORDER BY + GROUP BY + relationship roots + subqueries; SObject-level `SOQL_QUERIES` retained as `indirect` fallback |

`DECISION (review): keep the SObject-level coarse edges (FLOW_DML_ON,
SOQL_QUERIES) even after per-field edges exist; surface them only under
include_indirect=true.`
— *Why:* per-field edges can miss (dynamic SOQL strings, `FIELDS(ALL)`, formula
resources Spindle can't resolve, standard-object fields not in the graph). The
coarse edge is the safety net that keeps recall high when precision tooling
whiffs. The tool already does exactly this for SOQL (see the `include_indirect`
block and `dedupeUsages` ranking in `get-field-usage.ts`).
— *Alternative:* drop coarse edges once per-field lands. Rejected — recall
regressions on dynamic/unparseable SOQL would be silent and dangerous for impact
analysis.

The `dedupeUsages` context-ranking in `get-field-usage.ts` gains the new contexts.
`DECISION (review): rank precision as
SOQL_SELECT > SOQL_WHERE > SOQL_ORDERBY > SOQL_GROUPBY > CONSTRUCTOR_ARG >
DML_WRITE > DML > SOQL (coarse).`
— *Why:* a field named in SELECT is more certainly "used" than one in a coarse
SObject query; the ranking just decides which `context` label survives the dedupe
for a method that hits the field multiple ways. — *Alternative:* a single
`SOQL_FIELD` context for all clauses (simpler, less granular). Pick this if the UI
doesn't need clause-level detail.

---

## 6. Cross-cutting open questions

1. **Standard-object fields.** Both subsystems will emit `Account.Name`,
   `Customer__c.OwnerId`, etc. Spindle only indexes Field nodes for custom fields
   present in metadata XML, so these edges drop in pass2. Do we want synthetic
   Field nodes for referenced-but-unmodelled standard fields (improves recall,
   costs node bloat)? Affects both specs identically — decide once here.
   `DECISION (review): do NOT synthesize standard-field nodes in this milestone;
   coarse SObject edges cover them.` Override if standard-field impact mapping is a
   demo requirement.
2. **Confidence tiering.** Flow/SOQL field edges resolved by a real parser deserve
   higher confidence than the regex tier (`0.6`). Proposal: parser-AST-derived
   edges = `Confidence.Resolved` (1.0) when the SObject is known at parse time,
   `Confidence.Heuristic` (0.8) when short-name-disambiguated. Confirm.
3. **Ship order.** SOQL is the bigger lift (build-vs-buy fork). Flow is small and
   self-contained. `DECISION (review): ship Flow first, SOQL second` — Flow
   de-risks the shared resolution path on a smaller surface before SOQL stresses
   it. Override to parallelize if two people are available.
4. **`FLOW_USES_FIELD` already exists** in `edge-types.ts` (line 46) but is
   unused. The Flow spec must decide whether to use it or add a new
   `FLOW_REFERENCES_FIELD` — see that spec's §4. Resolve before either lands.

---

## 7. Design-doc reconciliation (deferred — another process owns the design doc)

These specs do NOT edit `sfdx-graph-mcp-design.md`. When the owning process
updates it, the following need to change: §14 roadmap (move "Advanced Flow
extraction" and "full SOQL parser replacement" to shipped), §5.3 edge-type table
(add the new edges), NG4 (note full SOQL semantics now supported for field
resolution). Flagged here so the design-doc owner picks it up.
