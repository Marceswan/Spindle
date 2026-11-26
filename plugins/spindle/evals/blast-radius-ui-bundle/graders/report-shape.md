---
type: llm
weight: 2
---

PASS if the response does all three of these:
1. It says that the React UI bundle `customerPortal` calls `PortalAuthResource` through an Apex REST path (a path that starts with `/services/apexrest/auth`), and that this call fails after the delete.
2. It says that the UI bundle reads `Order__c.Amount__c` in a GraphQL query, in two places: directly on `Order__c`, and through the child relationship of `Customer__c`.
3. It says that some dependencies cannot be seen in the indexed source (for example a query or a path that is built at run time, or items that exist only in the org).
FAIL if one of the three is missing.
