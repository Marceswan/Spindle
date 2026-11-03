# Advanced Flow Extraction — per-field Flow references

**Status:** Approved 2026-05-29 (proceed; recommended decisions accepted unless flagged)`)
**Phase:** v1.0 roadmap item ("Advanced Flow extraction", previously v0.6+ pending)
**Parent:** `2026-05-29-spindle-field-resolution-precision-milestone.md`
**Author:** spec-drafting agent, 2026-05-29

---

## 1. Summary

Extend `src/parsers/metadata-xml/flow.ts` from "which SObjects does this Flow
touch" to "which **fields** does this Flow touch." Today the parser emits only
`FLOW_DML_ON` (SObject-level) + `INVOCABLE_FROM_FLOW` + `FLOW_INVOKES_FLOW`, so
`get_field_usage`'s `flows` bucket is coarse and marked **indirect**. This spec
adds a per-field edge (`FLOW_REFERENCES_FIELD`) emitted from Flow element
field references — `inputAssignments`, `outputAssignments`, `filters`, query
field lists, `assignmentItems`, `decisions`, and formula resources — so Flow
field hits become **authoritative**, analogous to `VALIDATION_REFERENCES_FIELD`.

The parser stays pure (`(filePath, source) => ParseResult`); cross-file
resolution stays in pass2 via the shared two-tier strategy (milestone §3).

---

## 2. Goals / non-goals

### Goals
- Per-field `FLOW_REFERENCES_FIELD` edges from the Flow elements that carry field
  references (enumerated in §3).
- SObject context determined per element so most edges resolve tier-1
  (full `Object.Field` qname), not short-name.
- Variable→SObject binding table built within the parser so
  `myCustomerVar.Email__c` references resolve to `Customer__c.Email__c`.
- `get_field_usage` `flows` bucket promoted to `authoritative`, coarse
  `FLOW_DML_ON` retained as the `indirect` fallback.
- Snapshot tests over an expanded Flow fixture.

### Non-goals
- Full Flow control-flow graph (connectors, fault paths, loops as edges). Out of
  scope; we extract *field references*, not execution order.
- Screen component property bindings beyond field references (e.g. visibility
  rules referencing non-field resources).
- Resolving `$Record__Prior`, `$Flow`, `$Setup`, `$User` global references to
  fields. `DECISION (review): resolve $Record.Field to the trigger SObject's
  field; treat other $-globals as out of scope this phase.` — *Why:* `$Record` is
  the dominant case in record-triggered flows and its SObject is known from
  `<start><object>`. — *Alternative:* model `$User`/`$Setup` too (more recall,
  more reserved-word handling); defer.
- Formula-resource full AST. We reuse the existing `extractFormulaFieldReferences`
  token walker from `formula.ts` (same as validation rules).

---

## 3. Flow XML elements that yield field references

The current parser handles `actionCalls`, `recordCreates/Updates/Deletes/Lookups`
(SObject only), and `subflows`. This spec adds field-level extraction from:

| Flow element | Where fields live | SObject context source | Resolution tier |
|--------------|-------------------|------------------------|-----------------|
| `recordLookups` | `<queriedFields>` (list), `<filters><field>`, `<sortField>` | element's own `<object>` | tier 1 |
| `recordCreates` | `<inputAssignments><field>` | element's `<object>` (or var type) | tier 1 |
| `recordUpdates` | `<inputAssignments><field>`, `<filters><field>` | element's `<object>` | tier 1 |
| `recordDeletes` | `<filters><field>` | element's `<object>` | tier 1 |
| `assignments` | `<assignmentItems><assignToReference>` and value `<elementReference>` | variable→SObject binding | tier 1 if var bound, else tier 2 |
| `decisions` | `<rules><conditions><leftValueReference>` | variable→SObject binding | tier 1 if var bound, else tier 2 |
| `formulas` | `<expression>` (formula resource) | variable→SObject binding of referenced vars | tier 1/tier 2 |
| `variables` | `<objectType>` — does NOT itself reference a field; builds the binding table | n/a | n/a |
| `start` (record-triggered) | `<filterLogic>`/`<filters><field>` (entry criteria) + `$Record.Field` refs | `<start><object>` | tier 1 |
| `recordRollbacks`, `screens` field components | deferred | — | non-goal |

### 3.1 Variable→SObject binding (the key new mechanism)

`<variables>` and `<recordLookups>`/`<recordCreates>` that store results into a
variable establish a `variableName → SObjectApiName` map. A reference like
`myCust.Email__c` in an `assignmentItem` or `decision` condition is then
resolved: split on the first `.`, look up the root in the binding table, and emit
`Customer__c.Email__c`.

```
binding sources, in priority order:
  1. <variables><name>X</name><objectType>Customer__c</objectType><isCollection>…
  2. <recordLookups><name>L</name><object>Customer__c</object>  (the lookup's output var
     is typically the element name or an <outputReference>)
  3. <recordCreates>/<recordUpdates> output variables
```

`DECISION (review): build the binding table in a first pass over the parsed Flow
object, before emitting field edges, entirely inside the parser (still pure — no
I/O).` — *Why:* the binding is intra-file; everything needed is in the one Flow
XML. Keeping it in the parser avoids leaking Flow-specific state into pass2.
— *Alternative:* emit raw `var.Field` unresolved refs and bind in pass2. Rejected
— pass2 has no Flow-shaped resolver and the binding is purely local.

References whose root variable is not in the binding table fall to **tier 2**
(`__SHORTNAME__:Field__c`), letting pass2's `fieldsByShortName` disambiguation try
to place them. References to a bound *collection of primitives* or to a non-field
resource are dropped.

---

## 4. New node labels + edge types

### Node labels
**None.** The `Flow` node already exists (`node-labels.ts` line 37). Field nodes
come from object metadata. No new labels.

### Edge types

`DECISION (review): add ONE new edge type FLOW_REFERENCES_FIELD; do NOT reuse the
existing-but-unused FLOW_USES_FIELD constant.`
— *Why:* the milestone's authoritative-per-field edges are consistently named
`*_REFERENCES_FIELD` (`VALIDATION_REFERENCES_FIELD`, `FORMULA_REFERENCES_FIELD`,
`FLEXIPAGE_REFERENCES_FIELD`, Apex `REFERENCES_FIELD`). `FLOW_REFERENCES_FIELD`
slots into that family and reads correctly in `get_field_usage`'s direct-edge
query (which `IN`-lists all the `*REFERENCES_FIELD` edges). `FLOW_USES_FIELD`
breaks the naming convention and was never emitted, so nothing depends on it.
— *Alternative A:* reuse `FLOW_USES_FIELD` (it exists, costs no new constant).
Rejected on naming-consistency grounds; if you prefer fewer constants, rename
`FlowUsesField` → value `FLOW_REFERENCES_FIELD` and keep the key, but that's a
confusing key/value mismatch.
— *Alternative B:* overload `FLOW_DML_ON` with a `field` property. Rejected — it
would force `get_field_usage` to JSON-extract per-field from a SObject edge, which
defeats the indexed `target_id = Field` join the direct-edge query relies on.

Add to `src/model/edge-types.ts` under the `// Flow` group:

```ts
FlowReferencesField: "FLOW_REFERENCES_FIELD",   // Flow -> Field (per-field, authoritative)
```

Edge shape (matches `VALIDATION_REFERENCES_FIELD`):
- `fromQName` = Flow name, `fromLabel` = `Flow`
- `toQName` = `Object__c.Field__c` (tier 1) or `__SHORTNAME__:Field__c` (tier 2),
  `toLabel` = `Field`
- `confidence` = `Resolved` (1.0) when SObject known at parse time;
  `Heuristic` (0.8) when short-name-bound; (milestone §6 Q2)
- `properties`: `{ flowElementName, operation, clause }` where `clause` ∈
  `inputAssignment | queriedField | filter | sortField | assignment | decision |
  formula | entryCriteria`, and `operation` mirrors the element type
  (`insert|update|delete|select|assign|decision|formula`).

---

## 5. Parser changes (kept pure)

`parseFlow` in `flow.ts` gains:

1. Widen the `FlowXml` type and `XMLParser` `isArray` set to include the new
   array-shaped children: `variables`, `assignments`, `decisions`, `formulas`,
   and the nested `inputAssignments`, `outputAssignments`, `filters`,
   `queriedFields`, `assignmentItems`, `rules`, `conditions`.
   `DECISION (review): keep fast-xml-parser with attributes ignored; Flow field
   refs live in element text, not attributes.` — confirmed by the current parser's
   config and the fixture. Override only if a Flow form uses attribute-borne
   fields (none known).
2. `buildVariableBindings(flow): Map<string,string>` — pure helper producing the
   variable→SObject table (§3.1).
3. `emitRecordElementFields(...)` — for each `recordLookups/Creates/Updates/
   Deletes`, walk its field-bearing children and emit `FLOW_REFERENCES_FIELD`
   with `toQName = "<element.object>.<field>"` (tier 1).
4. `emitAssignmentAndDecisionFields(...)` — resolve `var.Field` references via the
   binding table; tier 1 if bound, else tier 2 `__SHORTNAME__:`.
5. `emitFormulaFields(...)` — feed each `<formulas><expression>` through the
   existing `extractFormulaFieldReferences(expr, defaultParent)` from
   `formula.ts`, where `defaultParent` is the trigger SObject (or the bound var's
   SObject if the formula clearly references one variable). Emit one edge per ref.
   `DECISION (review): reuse formula.ts's token walker rather than a Flow-specific
   formula parser.` — *Why:* identical pattern to validation rules; one walker to
   maintain. — *Alternative:* dedicated Flow-formula handling for `$Record`/
   `$GlobalConstant`; defer (non-goal).
6. The existing coarse `FLOW_DML_ON` edges and the record-triggered
   `FLOW_DML_ON operation="trigger"` edge are **retained unchanged** (milestone
   §5 fallback policy).

The parser returns the new edges in `result.edges`; `unresolved` is unused for
these (binding is local). No new `unresolvedRefs` kinds are introduced.
`DECISION (review): tier-2 short-name edges go through the EXISTING in-file-edge
__SHORTNAME__ path in pass2, not a new unresolved kind.` — *Why:* that path
already exists and was built for exactly this (v0.8). — *Alternative:* a Flow
`unresolved` kind handled in pass2; redundant.

---

## 6. pass2 / pass3 resolution

No pass2 code change is strictly required: `FLOW_REFERENCES_FIELD` is an in-file
edge with `toLabel = Field`, so it flows through the existing `inFileEdges` loop —
tier-1 qnames hit `nodeByLabelAndQName`; tier-2 `__SHORTNAME__:` hits the
`fieldsByShortName` fallback. The only nuance:

`DECISION (review): the v0.8 short-name disambiguation uses the SOURCE method's
SOQL/DML SObject context (getMethodSObjectContext). For Flow, the source is a
Flow node, which has FLOW_DML_ON edges to SObjects — extend (or generalize)
getMethodSObjectContext to also read FLOW_DML_ON when the source is a Flow.`
— *Why:* a Flow that writes `Status__c` and has `FLOW_DML_ON → Inbound_Staging__c`
disambiguates the same way an Apex method does. — *Alternative:* drop all
ambiguous Flow short-name edges (simpler, lower recall). Acceptable fallback if
generalizing the helper is deemed risky; most Flow refs are tier-1 anyway so the
loss is small. **This is the single most reviewable decision in this spec.**

pass3 remains a stub.

---

## 7. `get_field_usage` changes

In `src/tools/get-field-usage.ts`:
- Add `EdgeType.FlowReferencesField` to the direct-edge `IN (...)` list in the
  `directRows` query (alongside `ValidationReferencesField` etc.).
- In the row dispatch, `row.source_label === NodeLabel.Flow` already routes to
  `report.flows` — confirm the new direct rows land there with their `clause`
  context.
- Move `flows` from `coverage.indirect` to `coverage.authoritative`. Keep the
  coarse `FLOW_DML_ON` query in the `include_indirect` block as the fallback; its
  results merge into `report.flows` and are deduped (add `flows` dedupe ranking so
  a per-field hit outranks a coarse `FLOW_DML` hit).
  `DECISION (review): dedupe flows by (qualified_name) keeping the most specific
  clause context.` — mirrors the existing apex dedupe.

---

## 8. Testing

Mirror the existing parser-test pattern (snapshot of emitted nodes/edges against a
fixture).

1. **Expand the fixture** `test/fixtures/sample-sfdx-project/.../flows/
   Customer_Onboarding.flow-meta.xml` (or add a second
   `Customer_Field_Refs.flow-meta.xml` to avoid disturbing existing snapshots).
   `DECISION (review): add a NEW fixture flow rather than editing the existing
   one.` — *Why:* the existing flow has snapshot tests asserting exact edge
   counts; editing it churns those. A new fixture isolates the new assertions.
   — *Alternative:* edit in place and update the existing snapshot. Override if
   you prefer one canonical flow fixture.
   The new fixture must cover: a `recordLookups` with `queriedFields` + a
   `filters` field; a `recordUpdates` with `inputAssignments`; a `decisions` rule
   referencing a bound variable's field; a `variables` of `objectType`
   `Customer__c`; a `formulas` expression referencing `Email__c`; and one
   reference to an *unbound* variable (to exercise tier-2 drop/disambiguation).
2. **Parser snapshot test** under `test/parsers/metadata-xml/flow.test.ts`:
   assert the exact `FLOW_REFERENCES_FIELD` edges (qnames + clause property), and
   that legacy `FLOW_DML_ON`/`INVOCABLE_FROM_FLOW`/`FLOW_INVOKES_FLOW` edges are
   unchanged.
3. **Binding-table unit test**: `buildVariableBindings` over a Flow with all three
   binding sources.
4. **Pipeline test**: ingest the fixture project, then assert
   `get_field_usage("Customer__c.Email__c")` returns the Flow in
   `flows` with `coverage.authoritative` including `flows`, and that an
   `include_indirect=false` call still returns the per-field Flow hit (proving
   it's direct, not coarse).
5. **Disambiguation test**: a field name present on two fixture SObjects,
   referenced by an unbound Flow variable, asserts the precision-first drop (or
   the FLOW_DML_ON-context match if §6 generalization is taken).

---

## 9. Phased task breakdown

1. **Constant + types.** Add `FlowReferencesField` to `edge-types.ts`. Widen
   `FlowXml` type + `isArray` set in `flow.ts`. (No behavior yet.)
2. **Binding table.** `buildVariableBindings` + unit test.
3. **Record-element field extraction.** `recordLookups/Creates/Updates/Deletes`
   → tier-1 edges. Snapshot test.
4. **Assignment/decision/formula extraction.** Variable resolution + tier-2
   fallback. Reuse `formula.ts`. Snapshot test.
5. **pass2 generalization (optional, §6).** Extend `getMethodSObjectContext` to
   read `FLOW_DML_ON` for Flow sources, OR accept the precision-first drop.
6. **`get_field_usage` wiring.** Add edge to direct query, flip coverage, dedupe.
   Pipeline + disambiguation tests.

Steps 1-4 are shippable as "Flow per-field, tier-1 only"; 5-6 complete the story.

---

## 10. Open questions

1. **§6 generalization** (Flow short-name disambiguation via `FLOW_DML_ON`) — take
   it or accept the drop? Most-reviewable item.
2. **Screen/loop field references** — confirmed non-goal, but if Flows in the
   target org bind screen components to fields heavily, recall suffers. Validate
   against a real org Flow corpus before finalizing.
3. **`$Record.Field` in non-triggered flows** — `$Record` is only meaningful in
   record-triggered flows; in screen flows it's absent. Confirm we only resolve
   `$Record` when `<start><triggerType>` is present.
4. **Output-reference shapes vary by Flow API version** — `recordLookups` can use
   `<outputReference>`, `<outputAssignments>`, or auto-store (`storeOutputAutomatically`).
   Enumerate which shapes the binding table must handle; the fixture should pin at
   least the auto-store and explicit-outputReference forms.

---

## Implementation note (2026-05-29, as built)

Shipped in `feat(flow): per-field FLOW_REFERENCES_FIELD extraction`. Built per spec:
new `FlowReferencesField` edge; `buildVariableBindings` (variables + record-element
outputs); per-field extraction from recordLookups/Creates/Updates/Deletes
(queriedFields/sortField/filters/inputAssignments), start entry-criteria, assignments,
decisions, and formula resources (reusing `formula.ts`); tier-1 for bound vars / element
objects / `$Record`, tier-2 `__SHORTNAME__:` otherwise; `get_field_usage` `flows` promoted
to `coverage.authoritative`.

**Deviation — §6 `getMethodSObjectContext` generalization SKIPPED.** During pass2 all
in-file edges are batched and flushed at the end, so a Flow's `FLOW_DML_ON` edges are not
yet committed when its `FLOW_REFERENCES_FIELD` short-name edges resolve — the generalization
would read an empty set and add nothing. (The same latent ordering limit applies to the
existing Apex DML-write disambiguation; the high-value cases are tier-1 fully-qualified and
unaffected.) Tier-2 Flow short-names therefore resolve only when a single candidate field
exists, else drop (precision-first) — the spec's acceptable fallback. Revisit only if pass2
is reworked to commit structural edges before reference edges.
