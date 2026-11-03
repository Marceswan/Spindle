# Full SOQL Parser — clause-complete field extraction

**Status:** Approved 2026-05-29 (proceed; recommended decisions accepted unless flagged)`)
**Phase:** v1.0 roadmap item ("full SOQL parser replacement", previously v1.1+
pending); lifts NG4's deferral of full SOQL semantics for field resolution
**Parent:** `2026-05-29-spindle-field-resolution-precision-milestone.md`
**Author:** spec-drafting agent, 2026-05-29

---

## 1. Summary

Replace the regex SOQL extraction in `src/parsers/apex/soql-extract.ts` (which
captures the `FROM` object and *simple bare-identifier SELECT fields only*) with a
real SOQL parser that captures field references in **SELECT** (including
relationship paths `Account.Name`, `Parent__r.Owner.Name`), **WHERE**, **ORDER
BY**, **GROUP BY**, **HAVING**, child **subqueries** (`SELECT … FROM child__r`),
and polymorphic **TYPEOF … WHEN**. Each resolved field becomes a
`REFERENCES_FIELD` edge from the enclosing Apex method to the `Field` node, raising
`get_field_usage`'s Apex precision and recall and lifting NG4.

The parser is consumed by `parseApex` at the existing `SoqlLiteralContext` call
site; it stays pure and emits the same `REFERENCES_FIELD` edge shape already used
for SELECT fields today.

---

## 2. Goals / non-goals

### Goals
- One reusable function `parseSoql(soqlText) => SoqlAst | null` (null on parse
  failure → caller falls back to today's regex `extractSoqlFromObject`).
- Extract field references from every clause listed in §1, resolved to
  `Object.Field` qnames where the owning SObject is determinable.
- Resolve relationship traversals to their *terminal* SObject+field where the
  relationship chain is resolvable; otherwise emit the root reference and a
  lower-confidence terminal candidate.
- Handle child subqueries: fields inside `(SELECT … FROM Contacts)` resolve
  against the child relationship's SObject, not the outer FROM.
- Robust to ANTLR's whitespace-stripped `node.text`
  (`"[SELECTId,NameFROMAccountWHEREIsDeleted=FALSE]"`) — the current code's hard
  constraint (see `soql-extract.ts` header comment).
- Graceful degradation: any unparseable construct returns `null` and the existing
  regex path runs, so we never regress current behavior.

### Non-goals
- SOSL parsing (keep the regex `extractSoslReturningObjects`).
- Dynamic SOQL built from string concatenation / `Database.query(str)` — the
  literal isn't statically known. Out of scope; coarse `SOQL_QUERIES` covers it.
- Binding `:apexVar` bind expressions to anything. We tokenize and skip them.
- Full semantic validation (we are not a SOQL linter); we extract references.
- `FIELDS(STANDARD|CUSTOM|ALL)` field-set expansion to concrete fields (we record
  the `FIELDS()` marker but don't enumerate). `DECISION (review): record a
  FIELDS(ALL) reference as a coarse marker, not per-field.` — Override if the org
  uses `FIELDS()` heavily and per-field expansion is wanted (needs the object's
  full field list, which Spindle has from metadata).

---

## 3. Build vs. buy — three approaches

### Approach A — hand-rolled tokenizer + recursive-descent parser (in-house)
Mirror the existing Cypher layer in `src/graph/cypher/` (`tokenizer.ts`,
`parser.ts`, `types.ts`) — a `const enum TokenKind`, a tokenizer that handles the
two-word keywords (`ORDER BY`, `GROUP BY`, `NULLS LAST`) the same way Cypher
handles `STARTS WITH`, and a recursive-descent parser producing a small typed AST.

- **Pros:** zero new dependency (CLAUDE.md: "every dep ships inside the final
  binary"; v0.1 keeps the tree small on purpose). Full control over the
  whitespace-stripped-text quirk. Proven in-house pattern (Cypher shipped v0.5).
  Pure, Bun-native, no Node-API risk.
- **Cons:** SOQL grammar is large (TYPEOF, date literals `LAST_N_DAYS:90`, geo
  `DISTANCE()`, `GROUP BY ROLLUP/CUBE`, `WITH SECURITY_ENFORCED`, format/convertCurrency).
  We don't need to *evaluate* these, only skip them and find field tokens, but the
  parser must not choke. More test surface.

### Approach B — add a pure-JS SOQL parser dependency
Candidate libraries exist in the JS ecosystem (e.g. `soql-parser-js`, MIT,
pure-JS, no native deps).

- **Pros:** complete grammar coverage maintained upstream; less code to own.
- **Cons:** new runtime dependency baked into every release binary — violates the
  "ask before adding a dependency" rule and the small-tree stance. Must verify it
  works under `bun build --compile` (some parsers use generated code / `eval` /
  `Function` constructors that the compiler dislikes). Must verify it tolerates the
  ANTLR whitespace-stripped `node.text` — most SOQL parsers assume well-formed
  spaced source and will fail on `"SELECTIdFROMAccount"`, which is our dominant
  input. That single incompatibility likely disqualifies it without a
  pre-normalization step.
- **Bun/compile risk:** must pass `bun test` AND a `bun build --compile` smoke run
  before adoption (CLAUDE.md gotcha discipline).

### Approach C — hybrid: regex tokenizer + lightweight clause splitter (extend current)
Keep the regex spirit but add clause-aware splitting: find clause keyword
boundaries (`SELECT`/`FROM`/`WHERE`/`ORDER BY`/`GROUP BY`/`HAVING`/subquery parens),
then run a field-token scan per clause segment, reusing the paren-depth comma
split already in `extractSoqlSelectFields`.

- **Pros:** smallest diff; reuses existing whitespace-robust logic; no AST, no new
  dep; incremental — ship clause by clause.
- **Cons:** not a "real parser" (NG4 asked for one); relationship-path and TYPEOF
  resolution get hairy with regex; subquery nesting needs real paren-matching
  anyway (halfway to a parser). Risks the same maintenance smell the milestone is
  trying to retire.

### Recommendation

`DECISION (review): Approach A — hand-roll a tokenizer + recursive-descent SOQL
parser under src/parsers/apex/soql/, modeled on src/graph/cypher/.`
— *Why:* it satisfies the single-binary / no-new-dep policy with certainty,
matches an already-proven in-house pattern (the Cypher parser), and is the only
option that cleanly handles the whitespace-stripped `node.text` input that *is*
our primary feed. Approach B's dependency + compile + whitespace risks are three
ways to lose; Approach C is a local maximum that still needs real paren-matching
for subqueries, so we'd be writing most of a parser anyway without the clean AST.
— *Alternatives:* take **B** only if a vetted parser passes the `bun build
--compile` smoke test *and* a normalization shim re-spaces `node.text` reliably
(then the upstream grammar is a real win); take **C** as a fast interim if
schedule pressure forces shipping WHERE-clause coverage before a full parser.

`DECISION (review): on any parseSoql failure, fall back to the existing regex
extractSoqlFromObject so the FROM object and coarse SOQL_QUERIES edge always
emit.` — *Why:* never regress current recall. — *Alternative:* drop the query
entirely on parse failure; rejected.

---

## 4. New node labels + edge types

### Node labels
**None.** SObjects and Fields already exist. Relationship traversals resolve to
existing `Field` nodes.

### Edge types
**None new for the primary path.** Field references continue to use the existing
`REFERENCES_FIELD` (`edge-types.ts` line 25), exactly as the current SELECT-field
extraction does (`parse.ts` ~line 657). We extend *coverage and context*, not the
edge vocabulary.

`DECISION (review): reuse REFERENCES_FIELD for all SOQL clauses, distinguishing
clause via the edge's properties.context (SOQL_SELECT | SOQL_WHERE | SOQL_ORDERBY
| SOQL_GROUPBY | SOQL_HAVING | SOQL_TYPEOF | SOQL_SUBQUERY).`
— *Why:* `get_field_usage`'s direct-edge query already `IN`-lists
`REFERENCES_FIELD`; reusing it means the tool picks up WHERE/ORDER/etc. fields
with zero query change, and the existing `dedupeUsages` context-ranking extends
naturally (milestone §5). — *Alternative:* per-clause edge types
(`SOQL_WHERE_REFERENCES_FIELD`, …). Rejected — edge-type explosion for no query
benefit; the clause is metadata, not topology.

`SOQL_QUERIES` (SObject-level) is retained as the `include_indirect` fallback
(milestone §5).

---

## 5. AST shape (Approach A)

Minimal typed AST — only what field extraction needs. Under
`src/parsers/apex/soql/types.ts`:

```ts
export type SoqlAst = {
  fromObject: string;
  selectFields: FieldRef[];          // includes aggregate args and relationship paths
  whereFields: FieldRef[];
  orderByFields: FieldRef[];
  groupByFields: FieldRef[];
  havingFields: FieldRef[];
  typeOfFields: FieldRef[];          // WHEN <SObject> THEN <fields>, carries when-type
  subqueries: SoqlAst[];             // each has its own fromObject = child relationship name
  fieldsMacro: "ALL" | "STANDARD" | "CUSTOM" | null;  // FIELDS() marker, unexpanded
};

export type FieldRef = {
  raw: string;                       // "Account.Owner.Name"
  path: string[];                    // ["Account","Owner","Name"]
  clause: SoqlClause;
  whenType?: string;                 // for TYPEOF WHEN branches
};
```

`parseSoql(text) => SoqlAst | null`. Pure. Tokenizer handles two-word keywords and
the unspaced-`node.text` case (scan keyword *substrings* the way the current
regex lookahead does, but token-by-token).

---

## 6. Field-reference resolution (parser → qname → pass2)

The Apex parser (`parse.ts`, `SoqlLiteralContext` branch) calls `parseSoql`. For
each `FieldRef`, it computes a target qname:

| FieldRef shape | Owning SObject | Emitted toQName | Tier |
|----------------|----------------|-----------------|------|
| bare `Name` (len-1 path) | the clause's FROM object (outer or subquery) | `<from>.Name` | 1 |
| `Account.Name` (relationship.field) | terminal object of the relationship | terminal-obj.`Name` if resolvable, else `__SHORTNAME__:Name` | 1 or 2 |
| `Parent__r.Owner.Name` (multi-hop) | terminal object after walking `__r`/standard rel | terminal qname if all hops resolve, else short-name on last segment | 1 or 2 |
| subquery field, FROM `Contacts` | the child-relationship's SObject | resolve `Contacts` child-rel → `Contact`, then `Contact.<field>` | 1 if child-rel resolvable, else 2 |
| `TYPEOF What WHEN Account THEN Name` | the `WHEN` SObject | `Account.Name` | 1 |
| aggregate arg `COUNT(Id)`, `MAX(Amount)` | FROM object | `<from>.Id`, `<from>.Amount` | 1 |

`DECISION (review): relationship-path resolution is best-effort. The PARSER emits
the field's short name + the relationship root as edge properties; the SObject-walk
to a terminal object happens in pass2 where the relationship metadata (Field nodes
with type=Lookup/MasterDetail and their referenceTo) is available.`
— *Why:* the parser is pure and single-file; it cannot know that `Account__r`
points to `Account__c` — that's cross-object metadata only the graph has. This is
exactly the tier-1/tier-2 split the milestone established. — *Alternative:* resolve
relationships in the parser by passing it the schema (breaks parser purity) —
rejected. Or: don't resolve relationship paths at all, only their leaf short name
(simpler, slightly lower precision) — acceptable fallback if pass2 relationship
walking is deemed too much for this phase.

`DECISION (review): for multi-hop relationship paths, emit BOTH a high-confidence
edge to the resolved terminal field (if pass2 resolves the chain) AND, on failure,
a short-name edge to the leaf field name.` — *Why:* recall safety net. —
*Alternative:* terminal-only; drops the field entirely if any hop is unresolvable.

### pass2 changes
- Bare and subquery fields with full qnames: **no change** — existing
  `nodeByLabelAndQName` match.
- Relationship-path resolution: new pass2 helper `resolveRelationshipPath(rootObj,
  path)` that walks `Field` nodes of type Lookup/MasterDetail using their
  `referenceTo`/`relationshipName` properties (already parsed by
  `metadata-xml/field.ts` — confirm those properties exist; if not, that parser
  needs the `referenceTo` added, a small change scoped into this work).
  `DECISION (review): if field.ts does not currently store referenceTo /
  relationshipName, add them — relationship resolution is impossible without
  them.` Verify against `metadata-xml/field.ts` during phase 1.
- Short-name leaf fields: existing `fieldsByShortName` disambiguation, using the
  enclosing Apex method's SObject context (already implemented for DML-writes).

pass3 remains a stub.

---

## 7. `get_field_usage` changes

Minimal, because the edge type is unchanged:
- No query change needed — `REFERENCES_FIELD` is already in the direct-edge
  `IN (...)` list and routes `ApexMethod` rows to `apex_methods` with context
  `SOQL_SELECT`. WHERE/ORDER/GROUP fields arrive on the same edge with their new
  `context` value and land in the same bucket automatically.
- Extend `dedupeUsages` ranking to include the new contexts (milestone §5).
- `coverage`: `apex_methods` stays effectively authoritative for direct refs; the
  coarse `SOQL_QUERIES` path under `include_indirect` is unchanged as the net.

---

## 8. Testing

1. **Tokenizer tests** (`test/parsers/apex/soql/tokenizer.test.ts`): spaced source
   AND whitespace-stripped `node.text`; two-word keywords; string/date/number
   literals; bind vars `:x`; nested parens.
2. **Parser AST tests** (`soql.test.ts`): one assertion per clause —
   SELECT w/ relationship path, WHERE, ORDER BY … NULLS LAST, GROUP BY + HAVING,
   child subquery, TYPEOF, aggregate args, `FIELDS(ALL)` marker, and a deliberately
   malformed query asserting `parseSoql` returns `null`.
3. **Apex-parser integration** (extend `test/parsers/apex/parse.test.ts`): a
   fixture Apex class/method containing each query shape; snapshot the emitted
   `REFERENCES_FIELD` edges with their `context` properties; assert the coarse
   `SOQL_QUERIES` edge still emits.
4. **Relationship-resolution pipeline test**: fixture with `Account__c` lookup on
   `Customer__c`; a SOQL `SELECT Account__r.Name FROM Customer__c`; assert
   `get_field_usage("Account__c.Name")` returns the method (terminal resolved) and,
   if the chain is unresolvable, that the leaf short-name path fires instead.
5. **Regression/fallback test**: feed `Database.query` dynamic-string call (no
   literal) and a malformed literal; assert no crash and coarse `SOQL_QUERIES`
   still present.
6. **Fixtures** live under `test/fixtures/sample-sfdx-project/` per existing
   convention; add SOQL-heavy methods to an existing Apex fixture class or a new
   `SoqlQueryShapes.cls`. `DECISION (review): new fixture class to avoid churning
   existing snapshot counts` (same rationale as the Flow spec).

---

## 9. Phased task breakdown

1. **Spike + decision lock.** Confirm Approach A; verify `metadata-xml/field.ts`
   stores `referenceTo`/`relationshipName` (add if missing). Confirm no SOQL
   parser dep will be used. (If revisiting Approach B, run the `bun build
   --compile` + whitespace smoke test here and record the result.)
2. **Tokenizer** (`src/parsers/apex/soql/tokenizer.ts`) + tests. Model on
   `cypher/tokenizer.ts`.
3. **Parser + AST** (`parser.ts`, `types.ts`) + AST tests. SELECT/FROM/WHERE first,
   then ORDER/GROUP/HAVING, then subqueries + TYPEOF.
4. **Wire into `parseApex`.** Replace the SELECT-only extraction at the
   `SoqlLiteralContext` site with `parseSoql`; emit per-clause `REFERENCES_FIELD`
   edges; keep regex fallback on `null`. Snapshot tests.
5. **pass2 relationship resolution.** `resolveRelationshipPath`; tier-1/tier-2
   emission. Pipeline tests.
6. **`get_field_usage` dedupe ranking + coverage doc.** Regression tests.

Steps 1-4 deliver clause-complete *flat* field extraction (the bulk of the win);
5 adds relationship-path precision; 6 polishes the consumer.

---

## 10. Open questions

1. **Relationship metadata availability** — does `metadata-xml/field.ts` already
   persist `referenceTo` and `relationshipName`? If not, phase-1 scope grows
   slightly. Blocking for §6 relationship resolution.
2. **Dynamic SOQL** — confirmed out of scope, but quantify: what fraction of the
   target org's queries are `Database.query(string)`? If high, the coarse fallback
   is doing most of the work and the parser's marginal value drops. Worth a bench
   measurement before committing the full phase.
3. **`FIELDS(ALL)` expansion** — marker vs. per-field expansion (§2). Expansion
   needs the object's full field list from the graph; decide if the demo needs it.
4. **Confidence values** — relationship-resolved terminal fields: `Resolved` or a
   new mid-tier? `node.text` parse is exact, but relationship referenceTo can be
   polymorphic. Proposal: `Resolved` for single-target lookups, `Heuristic` for
   polymorphic/`TYPEOF`. Confirm against milestone §6 Q2.
5. **Performance** — `parseSoql` runs once per SOQL literal during indexing; must
   stay within the §11 budget (100 classes < 5s). Recursive descent on short query
   strings is cheap, but verify on a SOQL-dense corpus; cache nothing (queries are
   distinct).

---

## Implementation note (2026-05-29, as built)

Shipped in `feat(soql): clause-aware field extraction`. **Approach C, not the recommended
Approach A.** Rationale discovered during implementation: ANTLR's `node.text` is
whitespace-stripped (`"SELECTId,NameFROMAccountWHERETier__c='Gold'"`), which makes a clean
from-scratch tokenizer (Approach A) high-risk — keyword boundaries are ambiguous when glued.
A clause-aware extractor (`src/parsers/apex/soql/extract.ts`) handles glued and spaced input
uniformly and delivers the actual value: per-field `REFERENCES_FIELD` edges across SELECT /
WHERE / ORDER BY / GROUP BY / HAVING and child subqueries, each tagged with `properties.context`
(`SOQL_SELECT|SOQL_WHERE|SOQL_ORDERBY|SOQL_GROUPBY|SOQL_HAVING|SOQL_SUBQUERY`). No new edge
type (reuses `REFERENCES_FIELD`), no schema bump. Regex `extractSoqlFromObject` retained for
the coarse `SOQL_QUERIES` edge so recall never regresses.

**Deferred (open for a follow-up phase if wanted):**
- Full recursive-descent AST per Approach A (current module is a clause-aware extractor).
- pass2 relationship-path terminal resolution (`Account__r.Name` -> `Account__c.Name`):
  relationship paths and subquery fields currently resolve to their **leaf short-name**
  (tier-2), which pass2's `fieldsByShortName` places or drops. The `field.ts`
  `referenceTo`/`relationshipName` check (spec §6) was therefore not needed yet.
- TYPEOF per-branch WHEN-object resolution and `FIELDS()` expansion (markers only).
