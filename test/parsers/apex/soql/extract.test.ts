import { test, expect } from "bun:test";
import { extractSoqlFieldRefs } from "../../../../src/parsers/apex/soql/extract.ts";

function byClause(refs: ReturnType<typeof extractSoqlFieldRefs>, clause: string): string[] {
  return refs.filter((r) => r.clause === clause).map((r) => r.path.join(".")).sort();
}

test("extracts SELECT, WHERE, ORDER BY fields (spaced source)", () => {
  const refs = extractSoqlFieldRefs(
    "[SELECT Id, Name, Email__c FROM Customer__c WHERE Tier__c = 'Gold' ORDER BY Name DESC]",
  );
  expect(byClause(refs, "SOQL_SELECT")).toEqual(["Email__c", "Id", "Name"]);
  expect(byClause(refs, "SOQL_WHERE")).toEqual(["Tier__c"]);
  expect(byClause(refs, "SOQL_ORDERBY")).toEqual(["Name"]);
});

test("ambiguous whitespace-stripped text is rejected rather than inventing fields", () => {
  const refs = extractSoqlFieldRefs("[SELECTId,Email__cFROMCustomer__cWHERETier__c='Gold']");
  expect(refs).toEqual([]);
});

test("GROUP BY + HAVING + aggregate args", () => {
  const refs = extractSoqlFieldRefs(
    "[SELECT Tier__c, COUNT(Id) FROM Customer__c GROUP BY Tier__c HAVING COUNT(Id) > 5]",
  );
  expect(byClause(refs, "SOQL_SELECT")).toEqual(["Id", "Tier__c"]);
  expect(byClause(refs, "SOQL_GROUPBY")).toEqual(["Tier__c"]);
  expect(byClause(refs, "SOQL_HAVING")).toEqual(["Id"]);
});

test("relationship path captured with full dotted path", () => {
  const refs = extractSoqlFieldRefs("[SELECT Account__r.Name FROM Customer__c]");
  const sel = refs.filter((r) => r.clause === "SOQL_SELECT");
  expect(sel).toHaveLength(1);
  expect(sel[0]!.path).toEqual(["Account__r", "Name"]);
  expect(sel[0]!.leaf).toBe("Name");
});

test("child subquery fields are tagged SOQL_SUBQUERY", () => {
  const refs = extractSoqlFieldRefs(
    "[SELECT Name, (SELECT Email__c FROM Contacts) FROM Account]",
  );
  expect(byClause(refs, "SOQL_SELECT")).toEqual(["Name"]);
  expect(byClause(refs, "SOQL_SUBQUERY")).toEqual(["Email__c"]);
});

test("ignores bind vars, string/number literals, and keywords", () => {
  const refs = extractSoqlFieldRefs(
    "[SELECT Id FROM Customer__c WHERE Email__c = :acctEmail AND Tier__c IN ('Gold','Silver') AND Score__c > 10]",
  );
  expect(byClause(refs, "SOQL_WHERE")).toEqual(["Email__c", "Score__c", "Tier__c"]);
});

test("date literals are not treated as fields", () => {
  const refs = extractSoqlFieldRefs(
    "[SELECT Id FROM Customer__c WHERE CreatedDate = LAST_N_DAYS:30 AND Active__c = true]",
  );
  expect(byClause(refs, "SOQL_WHERE")).toEqual(["Active__c", "CreatedDate"]);
});

test('clause words in identifiers and literals never split a query', () => {
  const refs=extractSoqlFieldRefs("[SELECT Limit__c FROM Customer__c WHERE Name='WHERE' AND Tier__c='Gold' ORDER BY Email__c DESC NULLS LAST]");
  expect(byClause(refs,'SOQL_SELECT')).toEqual(['Limit__c']);
  expect(byClause(refs,'SOQL_WHERE')).toEqual(['Name','Tier__c']);
  expect(byClause(refs,'SOQL_ORDERBY')).toEqual(['Email__c']);
});
