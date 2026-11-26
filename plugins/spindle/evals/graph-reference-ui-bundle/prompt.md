---
description: "A query_graph question on a React UI bundle: its node label, its qualified name and its edge types"
tags: [graph-reference, ui-bundle]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

The current directory is a Salesforce SFDX project.

Use one Spindle `query_graph` Cypher query for each question, and show me the queries. First: which fields does the React UI bundle in this project refer to? Second: which Apex classes does it call, and how sure is the graph of each call? Third: on which objects does it do a create, an update or a delete?
