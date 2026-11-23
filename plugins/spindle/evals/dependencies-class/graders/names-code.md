---
type: regex
pattern: '(?=.*Orchestrator)(?=.*AccountTrigger)'
flags: is
match: contains
target: last_message
weight: 1
---
