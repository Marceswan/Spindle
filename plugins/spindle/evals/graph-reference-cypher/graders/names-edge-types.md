---
type: regex
pattern: '(?=.*GRANTS_FIELD_ACCESS)(?=.*LAYOUT_INCLUDES_FIELD)(?=.*FLOW_DML_ON)(?=.*VF_USES_APEX)'
flags: is
match: contains
target: last_message
weight: 1
---
