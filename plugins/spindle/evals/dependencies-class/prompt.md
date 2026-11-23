---
description: "Everything that depends on a class, including callers of its methods from other metadata types"
tags: [dependencies, smoke]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

The current directory is a Salesforce SFDX project.

What depends on the Apex class `AccountService`? I want everything, not only Apex.
