---
type: llm
weight: 2
---

PASS if the response does all three of these:
1. It separates what must be edited from what only needs a retest.
2. It names the permission sets or the profile that grant access to the field.
3. It says that some dependencies cannot be seen in the indexed source (for example items that exist only in the org, or metadata types that are not indexed).
FAIL if one of the three is missing, or if the response says that the list is complete with no such limit.
