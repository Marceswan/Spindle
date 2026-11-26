---
type: llm
weight: 2
---

PASS if the response does both of these:
1. It says that the Apex calls have confidence 0.8, and that the class is found from its `@RestResource` URL mapping (not from its name).
2. It says that the bundle does a create on `Customer__c`, an update on `Order__c` and a delete on `Invoice__c`, and it does not list a query or an aggregate as a create, an update or a delete.
FAIL if one of the two is missing or wrong.
