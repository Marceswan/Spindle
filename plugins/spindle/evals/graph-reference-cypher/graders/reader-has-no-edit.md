---
type: llm
weight: 1
---

PASS if the response says that Spindle_Editor has edit access to Customer__c.Email__c and Customer__c.Tier__c, and does not say that Spindle_Reader has edit access to a field.
FAIL if the response says that Spindle_Reader can edit a field, or if it gives no answer to the edit-access question.
