---
type: llm
weight: 2
---

PASS if the response gives both of these connections from the flow Customer_Onboarding to the Account object:
1. A direct one: the flow reads Account records itself (a get-records or select element, find_related_accounts).
2. An indirect one: the flow invokes the Apex class AccountService, whose method cleanup() calls purge(), which queries Account.
FAIL if one of the two is missing, or if the response says that the flow is triggered by Account or updates Account (it is triggered by Customer__c and updates Customer__c).
