---
type: llm
weight: 2
---

PASS if the response lists all of these as places that refer to the method name and must change (or must be decided on) with the rename:
- the Apex class Orchestrator
- the Lightning web component customerCard
- the Aura component customerPanel (its controller JavaScript)
- the Visualforce page CustomerEditor (the action binding)
- the interface Cleanable, which declares cleanup()
FAIL if one of them is missing, or if the response says that the trigger AccountTrigger must change because of the rename (it does not call cleanup()).
