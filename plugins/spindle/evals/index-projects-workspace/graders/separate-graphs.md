---
type: llm
weight: 2
---

PASS if the response says that three SFDX projects were indexed (the root project, billing and legacy-org) and gives a project id, or a table row, for each one.
FAIL if it reports fewer than three projects, or if it says that it indexed the project in node_modules.
