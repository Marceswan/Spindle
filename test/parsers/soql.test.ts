import { expect, test } from "bun:test";
import { parseSoql } from "../../src/parsers/apex/soql-extract.ts";
import { parseApex } from "../../src/parsers/apex/parse.ts";
test("SOQL scopes root FROM, children and semi joins", () => {
 const p = parseSoql(`[SELECT Id, (SELECT Email FROM Contacts WHERE LastName = 'FROM Fake') FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email = :email) ORDER BY Name]`);
 expect(p?.fromObject).toBe("Account");
 expect(p?.queries.map(q => [q.fromObject,q.relationship])).toEqual([["Account",false],["Contacts",true],["Contact",false]]);
 expect(p?.queries[0]?.fields.map(f=>f.path)).toEqual(["Id","Id","Name"]);
 expect(p?.queries[2]?.fields.map(f=>f.path)).toEqual(["AccountId","Email"]);
});
test("aliases, aggregates and clause fields", () => {
 const p = parseSoql("SELECT a.Owner.Name, SUM(a.Amount__c) total FROM Account a WHERE a.Active__c = true GROUP BY a.Owner.Name HAVING SUM(a.Amount__c) > 10 ORDER BY a.Owner.Name");
 expect(p?.queries[0]?.fields.map(f=>[f.path,f.context])).toEqual([["Owner.Name","SOQL_SELECT"],["Amount__c","SOQL_SELECT"],["Active__c","SOQL_WHERE"],["Owner.Name","SOQL_GROUP_BY"],["Amount__c","SOQL_HAVING"],["Owner.Name","SOQL_ORDER_BY"]]);
});
test("TYPEOF concrete branches and ambiguous else", () => {
 expect(parseSoql("SELECT TYPEOF What WHEN Account THEN Industry WHEN Opportunity THEN Amount ELSE Name END FROM Event")?.queries[0]?.fields).toEqual([{path:"Industry",context:"SOQL_SELECT",object:"Account"},{path:"Amount",context:"SOQL_SELECT",object:"Opportunity"},{path:"What.Name",context:"SOQL_SELECT"}]);
});
test("invalid queries fail closed", () => {
 expect(parseSoql("SELECTIdFROMAccount")).toBeNull();
 expect(parseSoql("SELECT Id FROM Account rubbish trailing")).toBeNull();
});
test("Apex preserves source and grammar confidence", () => {
 const p = parseApex("Example.cls", "public class Example { void run() { List<Account> a = [SELECT Id FROM Account WHERE Name = 'FROM Fake']; } }");
 expect(p.edges.find(e=>e.edgeType==="SOQL_QUERIES")?.properties?.raw).toBe("[SELECT Id FROM Account WHERE Name = 'FROM Fake']");
 expect(p.edges.find(e=>e.edgeType==="SOQL_QUERIES")?.confidence).toBe(1);
});
test("nested queries, functions, bind properties, and aggregate aliases stay scoped", () => {
 const p = parseSoql("SELECT CALENDAR_YEAR(CreatedDate) yr, COUNT(Id) total, (SELECT Name, (SELECT Email FROM Contacts) FROM Children__r) FROM Account WHERE OwnerId = :input.ownerId GROUP BY CALENDAR_YEAR(CreatedDate) ORDER BY total");
 expect(p?.queries.map(q=>q.fromObject)).toEqual(["Account","Children__r","Contacts"]);
 expect(p?.queries[0]?.fields.map(f=>f.path)).toEqual(["CreatedDate","Id","OwnerId","CreatedDate"]);
});
test("comments and escaped strings cannot inject field references", () => {
 const p = parseSoql("SELECT /* comment FROM Fake */ Id FROM Account WHERE Name = 'Bob\\'s FROM Fake' AND CreatedDate = LAST_N_DAYS:30 LIMIT :rowLimit");
 expect(p?.fromObject).toBe("Account");
 expect(p?.queries[0]?.fields.map(f=>f.path)).toEqual(["Id","Name","CreatedDate"]);
});
test("dynamic SOQL produces diagnostics instead of fabricated references", () => {
 const p = parseApex("Dynamic.cls", "class Dynamic { void run(String query) { Database.query(query); } }");
 expect(p.warnings.some(w=>w.message.includes("Dynamic SOQL"))).toBe(true);
 expect(p.edges.some(e=>e.edgeType==="SOQL_QUERIES")).toBe(false);
});
test("FIELDS wildcard parses and reports schema-dependent expansion", () => {
 const p = parseSoql("SELECT FIELDS(ALL) FROM Account LIMIT 200");
 expect(p?.fromObject).toBe("Account");
 expect(p?.queries[0]?.fields).toEqual([]);
 expect(p?.warnings[0]).toContain("org schema");
});
